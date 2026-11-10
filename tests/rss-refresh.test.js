"use strict";

// Entirely offline: short real timers exercise a pending native-operation mock.
// No Zotero profile, RSS/HTTP connection, model call or SMTP message is used.
const assert = require("node:assert/strict");
const Core = require("../chrome/content/core.js");
const Strings = require("../chrome/content/strings.js");
require("../chrome/content/main.js");
const tests = [];
const test = (name, run) => tests.push({ name, run });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const turn = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function bounded(promise, milliseconds = 1500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("offline test watchdog expired")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function harness({ feeds = [], itemsGetAll = async () => [] } = {}) {
  const preferences = new Map();
  const dialogs = [];
  const messages = [];
  const mainWindow = {
    closed: false,
    openDialog() {
      const dialog = { closed: false, closes: 0, close() { this.closed = true; this.closes++; } };
      dialogs.push(dialog);
      return dialog;
    },
  };
  const Zotero = {
    Prefs: {
      get: (key) => preferences.get(key) || "",
      set: (key, value) => preferences.set(key, value),
      clear: (key) => preferences.delete(key),
    },
    // Skip the normal 2-second item-save settle delay. The native-operation
    // timeout implementation must own its timers independently of this fake.
    Promise: { delay: () => Promise.resolve() },
    Feeds: { getAll: () => feeds },
    Items: { getAll: itemsGetAll, get: () => null },
    getMainWindow: () => mainWindow,
    getMainWindows: () => [mainWindow],
    logError() {},
    FeedRankEmail: { loadConfig: () => ({ maximumPapers: 10 }) },
  };
  const Services = { prompt: { alert() {} } };
  const Notify = { info: () => true, warn: () => true, error: () => true };
  const service = globalThis.FeedRankerMain.create({ Zotero, Services, Core, Strings, Notify });
  service.feedWaitLimits = { updateMs: 30, dataMs: 20, totalMs: 600, pollMs: 2 };
  let skipCurrent = null;
  const progress = { cancelled: false, update: (message) => messages.push(String(message)),
    setSkipCurrentFeed: (handler) => { skipCurrent = handler; },
    skipCurrentFeed: () => skipCurrent?.(),
  };
  return { service, Zotero, mainWindow, dialogs, progress, messages };
}

function item(id, libraryID = 1) {
  return {
    id, key: "PAPER" + id, libraryID,
    isRegularItem: () => true,
    isAttachment: () => false,
    isNote: () => false,
    isAnnotation: () => false,
    getDisplayTitle: () => "Offline RSS paper " + id,
    getCreators: () => [],
    getField: (field) => ({ date: Core.localDay(), DOI: "10.1000/rss" + id,
      url: "https://example.test/rss/" + id, abstractNote: "Offline metadata" }[field] || ""),
  };
}

const codeIs = (code) => (error) => {
  assert.equal(error?.code, code, error?.stack || String(error));
  return true;
};

for (const stage of ["load", "read-before", "update", "read-after", "scan", "settle"]) {
  test("a never-completing " + stage + " operation has a finite deadline", async () => {
    const { service, progress, messages } = harness();
    const pending = deferred();
    let started = 0;
    try {
      await assert.rejects(bounded(service.waitForFeedOperation(() => {
        started++; return pending.promise;
      }, { feed: { libraryID: 1, name: "Stalled RSS source" }, stage,
        workflow: {}, progress, context: service.createFeedRefreshContext(),
        current: 0, total: 1, timeoutMs: 20 })), codeIs("FEED_TIMEOUT"));
      assert.equal(started, 1);
      assert.ok(messages.some((message) => message.includes("Stalled RSS source")),
        "the pending feed must be identifiable in progress");
    } finally { pending.resolve(); service.shuttingDown = true; }
  });
}

test("an overall refresh deadline wins over a longer per-feed deadline", async () => {
  const { service, progress } = harness();
  service.feedWaitLimits = { updateMs: 200, dataMs: 200, totalMs: 20, pollMs: 2 };
  const context = service.createFeedRefreshContext();
  await assert.rejects(bounded(service.waitForFeedOperation(() => new Promise(() => {}), {
    feed: { libraryID: 1, name: "Run budget source" }, stage: "update", context,
    workflow: {}, progress, timeoutMs: 200,
  })), codeIs("FEED_RUN_TIMEOUT"));
  assert.equal(context.exhausted, true);
});

test("Cancel interrupts a wait without waiting for the native operation to settle", async () => {
  const { service, progress } = harness();
  service.feedWaitLimits = { updateMs: 500, dataMs: 500, totalMs: 1000, pollMs: 2 };
  const workflow = { cancelled: false };
  const timer = setTimeout(() => { workflow.cancelled = true; }, 8);
  try {
    await assert.rejects(bounded(service.waitForFeedOperation(() => new Promise(() => {}), {
      feed: { libraryID: 1, name: "Cancelled source" }, stage: "load", workflow,
      progress, context: service.createFeedRefreshContext(),
    })), /cancel/i);
  } finally { clearTimeout(timer); service.shuttingDown = true; }
});

test("closing/cancelling progress also interrupts an unresolved native wait", async () => {
  const { service, progress } = harness();
  service.feedWaitLimits = { updateMs: 500, dataMs: 500, totalMs: 1000, pollMs: 2 };
  const timer = setTimeout(() => { progress.cancelled = true; }, 8);
  try {
    await assert.rejects(bounded(service.waitForFeedOperation(() => new Promise(() => {}), {
      feed: { libraryID: 1, name: "Closed progress source" }, stage: "read-before",
      workflow: {}, progress, context: service.createFeedRefreshContext(),
    })), /cancel/i);
  } finally { clearTimeout(timer); service.shuttingDown = true; }
});

test("shutdown interrupts an unresolved native wait", async () => {
  const { service, progress } = harness();
  service.feedWaitLimits = { updateMs: 500, dataMs: 500, totalMs: 1000, pollMs: 2 };
  const waiting = service.waitForFeedOperation(() => new Promise(() => {}), {
    feed: { libraryID: 1, name: "Shutdown source" }, stage: "scan", workflow: {},
    progress, context: service.createFeedRefreshContext(),
  });
  const shuttingDown = setTimeout(() => { service.shutdown().catch(() => {}); }, 8);
  try { await assert.rejects(bounded(waiting), /cancel/i); }
  finally { clearTimeout(shuttingDown); service.shuttingDown = true; }
});

test("native synchronous exceptions and asynchronous rejections remain failures", async () => {
  const { service } = harness();
  for (const operation of [() => { throw new Error("native sync failure"); },
    () => Promise.reject(new Error("native async failure"))]) {
    await assert.rejects(bounded(service.waitForFeedOperation(operation, {
      feed: { libraryID: 1, name: "Rejected source" }, stage: "load",
      context: service.createFeedRefreshContext(),
    })), /native (sync|async) failure/);
  }
});

test("settled operations stop progress timers and preserve their result", async () => {
  const { service, progress, messages } = harness();
  assert.equal(await bounded(service.waitForFeedOperation(() => Promise.resolve("native value"), {
    feed: { libraryID: 1, name: "Fast source" }, stage: "scan", workflow: {}, progress,
    context: service.createFeedRefreshContext(),
  })), "native value");
  const settledMessageCount = messages.length;
  await sleep(35);
  assert.equal(messages.length, settledMessageCount, "a settled wait must not keep repainting progress");
});

test("timed-out native updates are not restarted by another wrapper for the same library", async () => {
  const { service, progress } = harness();
  const pending = deferred();
  let updates = 0;
  const feed = { libraryID: 7, name: "Pending native feed", updateFeed() { updates++; return pending.promise; } };
  try {
    await assert.rejects(bounded(service.refreshFeedWithinDeadline(feed, {
      progress, workflow: {}, context: service.createFeedRefreshContext(),
    })), codeIs("FEED_TIMEOUT"));
    await assert.rejects(bounded(service.refreshFeedWithinDeadline({ ...feed }, {
      progress, workflow: {}, context: service.createFeedRefreshContext(),
    })), codeIs("FEED_BUSY"));
    assert.equal(updates, 1, "a timeout must not launch a parallel duplicate native refresh");
    pending.resolve();
    await turn();
    await bounded(service.refreshFeedWithinDeadline(feed, {
      progress, workflow: {}, context: service.createFeedRefreshContext(),
    }));
    assert.equal(updates, 2, "a genuinely settled native refresh can be requested again");
  } finally { pending.resolve(); service.shuttingDown = true; }
});

test("late rejection of an abandoned native update is observed and releases the busy guard", async () => {
  const { service } = harness();
  const pending = deferred();
  let updates = 0;
  const feed = { libraryID: 8, name: "Late rejection feed", updateFeed() {
    updates++; return updates === 1 ? pending.promise : Promise.resolve();
  } };
  const unhandled = [];
  const listener = (error) => unhandled.push(error);
  process.on("unhandledRejection", listener);
  try {
    await assert.rejects(bounded(service.refreshFeedWithinDeadline(feed, {
      context: service.createFeedRefreshContext(),
    })), codeIs("FEED_TIMEOUT"));
    pending.reject(new Error("late native failure"));
    await turn();
    await sleep(10);
    assert.deepEqual(unhandled, []);
    await bounded(service.refreshFeedWithinDeadline(feed, { context: service.createFeedRefreshContext() }));
    assert.equal(updates, 2);
  } finally { process.removeListener("unhandledRejection", listener); service.shuttingDown = true; }
});

test("a timed-out updater does not discard a subsequent healthy feed or mutate a completed summary", async () => {
  const pending = deferred();
  let healthyUpdated = false, lateUpdated = false;
  const feeds = [
    { libraryID: 1, name: "Timed-out source", updateFeed() {
      return pending.promise.then(() => { lateUpdated = true; });
    } },
    { libraryID: 2, name: "Healthy source", async updateFeed() { healthyUpdated = true; } },
  ];
  const { service, mainWindow, progress } = harness({ feeds, itemsGetAll: async (libraryID) =>
    libraryID === 2 ? (healthyUpdated ? [item(22, 2)] : []) : (lateUpdated ? [item(11, 1)] : []) });
  try {
    const result = await bounded(service.refreshAndCollect(mainWindow, service.loadConfig(), {}, progress));
    assert.deepEqual(result.candidates.map((entry) => entry.id), ["2:PAPER22"]);
    assert.ok(result.refresh.failedFeeds.some((entry) => entry.name === "Timed-out source"));
    assert.ok(result.refresh.successfulFeeds.some((entry) => entry.name === "Healthy source"));
    const completed = JSON.stringify(result);
    pending.resolve();
    await turn();
    await sleep(10);
    assert.equal(JSON.stringify(result), completed, "late native completion cannot change an already completed run");
  } finally { pending.resolve(); service.shuttingDown = true; }
});

test("N-day collection bounds a stalled data loader and continues with healthy stored items", async () => {
  const feeds = [
    { libraryID: 1, name: "Stalled data loader", waitForDataLoad: () => new Promise(() => {}) },
    { libraryID: 2, name: "Stored healthy feed", async waitForDataLoad() {} },
  ];
  const { service, progress } = harness({ feeds, itemsGetAll: async (libraryID) => libraryID === 2 ? [item(2, 2)] : [] });
  const result = await bounded(service.collectFeedItemsWithinDays(7, {}, null, progress));
  assert.deepEqual(result.candidates.map((entry) => entry.id), ["2:PAPER2"]);
  assert.ok(result.refresh.failedFeeds.some((entry) => entry.name === "Stalled data loader"));
});

test("N-day collection also bounds a never-completing stored-items read", async () => {
  const feeds = [{ libraryID: 1, name: "Stalled local read", async waitForDataLoad() {} }];
  const { service, progress } = harness({ feeds, itemsGetAll: () => new Promise(() => {}) });
  const result = await bounded(service.collectFeedItemsWithinDays(7, {}, null, progress));
  assert.equal(result.candidates.length, 0);
  assert.ok(result.refresh.failedFeeds.some((entry) => entry.name === "Stalled local read"));
});

test("the post-refresh settle read is bounded without losing papers already collected", async () => {
  let reads = 0;
  const feeds = [{ libraryID: 1, name: "Settle read stalled", async updateFeed() {} }];
  const { service, mainWindow, progress } = harness({ feeds, itemsGetAll: () => {
    reads++;
    if (reads === 1) return Promise.resolve([]);
    if (reads === 2) return Promise.resolve([item(1)]);
    return new Promise(() => {});
  } });
  const result = await bounded(service.refreshAndCollect(mainWindow, service.loadConfig(), {}, progress));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.refresh.newItemCount, 1);
  assert.ok(result.refresh.failedFeeds.some((entry) => entry.name === "Settle read stalled"),
    "the incomplete settle stage must be reported rather than silently treated as success");
});

test("fallback collection cannot hang again on a feed after a quiet refresh", async () => {
  let dataLoads = 0;
  const feeds = [{ libraryID: 1, name: "Fallback data stalled", waitForDataLoad() {
    dataLoads++;
    return dataLoads === 1 ? Promise.resolve() : new Promise(() => {});
  }, async updateFeed() {} }];
  const { service, mainWindow, progress } = harness({ feeds });
  const result = await bounded(service.refreshAndCollect(mainWindow, service.loadConfig(), {}, progress));
  assert.equal(result.candidates.length, 0);
  assert.equal(result.refresh.fallbackUsed, true);
  assert.ok(result.refresh.failedFeeds.some((entry) => entry.name === "Fallback data stalled"));
});

test("the scheduled run releases workflow and progress when the refresh-wide budget expires", async () => {
  const feeds = [{ libraryID: 1, name: "Whole refresh stalled", updateFeed: () => new Promise(() => {}) }];
  const { service, dialogs } = harness({ feeds });
  service.feedWaitLimits = { updateMs: 300, dataMs: 100, totalMs: 25, pollMs: 2 };
  service.waitForAwesomeGPT = async () => {};
  service.confirmWeeklyEmailDelivery = async () => ({ approved: false });
  service.sendWeeklyDigestFromCache = async () => null;
  const contexts = [];
  const create = service.createFeedRefreshContext.bind(service);
  service.createFeedRefreshContext = () => { const context = create(); contexts.push(context); return context; };
  await bounded(service.runWeekly(new Date(), { manual: true }));
  await service.stateMutationQueue;
  assert.ok(contexts.some((context) => context.exhausted));
  assert.equal(service.activeRun, null);
  assert.equal(service.activeProgress, null);
  assert.equal(service.weeklyStarted, false);
  assert.equal(service.runState?.active, false);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].closed, true);
});

test("Skip current rejects only the pending feed wait without cancelling the workflow", async () => {
  const { service, progress } = harness();
  service.feedWaitLimits = { updateMs: 500, dataMs: 500, totalMs: 1000, pollMs: 2 };
  const workflow = { cancelled: false };
  const context = service.createFeedRefreshContext();
  const timer = setTimeout(() => { progress.skipCurrentFeed(); }, 8);
  try {
    await assert.rejects(bounded(service.waitForFeedOperation(() => new Promise(() => {}), {
      feed: { libraryID: 1, name: "Manually skipped source" }, stage: "update",
      progress, workflow, context,
    })), codeIs("FEED_SKIPPED"));
    assert.equal(workflow.cancelled, false);
    assert.equal(progress.cancelled, false);
    assert.ok(context.skippedFeeds.has(1) || context.skippedFeeds.has("1"));
  } finally { clearTimeout(timer); service.shuttingDown = true; }
});

test("Skip current continues healthy feeds and does not re-wait the skipped feed during fallback", async () => {
  const pending = deferred();
  let progress;
  let skipTimer;
  let badReads = 0, badLoads = 0, badUpdates = 0, healthyUpdated = false;
  const feeds = [
    { libraryID: 1, name: "Skipped native source", async waitForDataLoad() { badLoads++; },
      updateFeed() {
        badUpdates++;
        skipTimer = setTimeout(() => { progress.skipCurrentFeed(); }, 8);
        return pending.promise;
      } },
    { libraryID: 2, name: "Healthy after skip", async updateFeed() { healthyUpdated = true; } },
  ];
  const fixture = harness({ feeds, itemsGetAll: async (libraryID) => {
    if (libraryID === 1) { badReads++; return []; }
    return healthyUpdated ? [item(22, 2)] : [];
  } });
  progress = fixture.progress;
  const { service, mainWindow } = fixture;
  service.feedWaitLimits = { updateMs: 500, dataMs: 100, totalMs: 1200, pollMs: 2 };
  const workflow = { cancelled: false };
  try {
    const result = await bounded(service.refreshAndCollect(mainWindow,
      { ...service.loadConfig(), includePeriodBacklog: true }, workflow, progress));
    assert.deepEqual(result.candidates.map((entry) => entry.id), ["2:PAPER22"]);
    assert.ok(result.refresh.failedFeeds.some((entry) => entry.name === "Skipped native source"));
    assert.ok(result.refresh.successfulFeeds.some((entry) => entry.name === "Healthy after skip"));
    assert.equal(badUpdates, 1);
    assert.equal(badLoads, 1, "fallback must not reload a user-skipped source in the same run");
    assert.equal(badReads, 1, "settle/fallback must not re-read the skipped native source");
    assert.equal(workflow.cancelled, false);
    assert.equal(progress.cancelled, false);
  } finally { clearTimeout(skipTimer); pending.resolve(); service.shuttingDown = true; }
});

test("cancelling a native refresh releases the manual workflow instead of waiting for RSS", async () => {
  let cancelTimer;
  let service;
  const feeds = [{ libraryID: 1, name: "Cancelled native refresh", updateFeed() {
    cancelTimer = setTimeout(() => { service.activeRun?.cancel(); }, 8);
    return new Promise(() => {});
  } }];
  const fixture = harness({ feeds });
  service = fixture.service;
  const { mainWindow, dialogs } = fixture;
  service.feedWaitLimits = { updateMs: 500, dataMs: 200, totalMs: 1000, pollMs: 2 };
  service.waitForAwesomeGPTWithProgress = () => { throw new Error("cancelled RSS must not reach scoring"); };
  const running = service.runManualRefresh(mainWindow);
  try { await assert.rejects(bounded(running), /cancel/i); }
  finally { clearTimeout(cancelTimer); service.shuttingDown = true; }
  assert.equal(service.activeRun, null);
  assert.equal(service.activeProgress, null);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].closed, true);
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); process.stdout.write("ok   " + name + "\n"); }
    catch (error) { failures++; process.stdout.write("FAIL " + name + "\n" + String(error?.stack || error) + "\n"); }
  }
  process.stdout.write("\n" + (tests.length - failures) + "/" + tests.length + " RSS refresh tests passed\n");
  if (failures) process.exitCode = 1;
})();
