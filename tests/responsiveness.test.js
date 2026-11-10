"use strict";

// Offline only: no live profile, provider, SMTP socket or model request.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../chrome/content/core.js");
const Strings = require("../chrome/content/strings.js");
const Journal = require("../chrome/content/journal.js");
const JournalService = require("../chrome/content/journal-service.js");
const Email = require("../chrome/content/email.js");
const EmailService = require("../chrome/content/email-service.js");
const StateSnapshot = require("../tools/state-snapshot.js");
require("../chrome/content/main.js");
const tests = [];
const test = (name, run) => tests.push({ name, run });

function harness() {
  const preferences = new Map();
  const mainWindow = { closed: false };
  const Zotero = {
    Prefs: {
      get: (key) => preferences.get(key) || "",
      set: (key, value) => preferences.set(key, value),
      clear: (key) => preferences.delete(key),
    },
    Promise: { delay: () => Promise.resolve() },
    Feeds: { getAll: () => [] },
    Items: { getAll: async () => [], get: () => null },
    getMainWindow: () => mainWindow,
    getMainWindows: () => [mainWindow],
    logError() {},
    FeedRankEmail: { loadConfig: () => ({ maximumPapers: 10 }) },
  };
  const Services = { prompt: { alert() {} } };
  const Notify = { info: () => true, warn: () => true, error: () => true };
  const service = globalThis.FeedRankerMain.create({ Zotero, Services, Core, Strings, Notify });
  return { service, Zotero, Services, mainWindow, preferences };
}

function progressWindows(mainWindow) {
  const dialogs = [];
  mainWindow.openDialog = (_url, _name, _features, args) => {
    const events = new Map();
    const elements = new Map(["message", "usage", "progress", "cancel", "skip-current"].map((id) => [id, {
      textContent: "", disabled: false,
      addEventListener(type, listener) { this[type] = listener; },
    }]));
    const dialog = {
      arguments: [args], closed: false, closes: 0,
      addEventListener(type, listener, options = {}) {
        events.set(type, [...(events.get(type) || []), { listener, once: options.once }]);
      },
      emit(type) {
        const listeners = events.get(type) || [];
        events.set(type, listeners.filter((entry) => !entry.once));
        for (const entry of listeners) entry.listener();
      },
      close() { this.closes++; this.closed = true; this.emit("unload"); },
      elements,
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../chrome/content/progress.js"), "utf8"), {
      window: dialog, document: { getElementById: (id) => elements.get(id) },
    });
    dialogs.push(dialog);
    return dialog;
  };
  return dialogs;
}

function ranks(service, count = 200) {
  const config = service.loadConfig();
  return Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const record = {
      id: "1:PAPER" + index, itemID: index + 1, libraryID: 1,
      title: "Paper " + index, source: "Synthetic feed", date: Core.localDay(),
      doi: "10.1000/paper" + index, score: 70 + index % 31, confidence: "high",
      reason: "Stored explanation & <escaped content> ".repeat(20),
      rankedAt: "2026-10-05T00:00:00.000Z",
    };
    record.fingerprint = Core.cacheFingerprint(record, config);
    record.configFingerprint = Core.rankingConfigFingerprint(config);
    return [record.id, record];
  }));
}

function seed(service, count) {
  const records = ranks(service, count);
  service.saveState({ ranks: records, lastCandidates: Object.values(records), lastRefresh: {}, lastUsageCalls: [] });
  return records;
}

function generation(storage, kind) { return storage[kind].generation || storage.generation; }

test("completion closes once without cancelling or aborting, even with late load", () => {
  const { service, mainWindow } = harness();
  const dialogs = progressWindows(mainWindow);
  const workflow = {};
  const progress = service.beginWorkflowProgress(mainWindow, workflow, "Scoring");
  let aborts = 0;
  progress.attachXHR({ abort: () => aborts++ });
  dialogs[0].emit("load");
  service.endWorkflowProgress(workflow, progress);
  service.endWorkflowProgress(workflow, progress);
  progress.close();
  dialogs[0].emit("load");
  assert.equal(dialogs[0].closes, 1);
  assert.equal(progress.cancelled, false);
  assert.equal(aborts, 0);
  assert.equal(service.activeProgress, null);
  assert.equal(workflow.progress, null);

  const early = service.createProgress(mainWindow, "Finishes before load");
  early.close();
  dialogs[1].emit("load");
  assert.equal(early.cancelled, false);
  assert.equal(dialogs[1].closes, 1);
});

test("the title-bar close and Cancel button still cancel an active operation once", () => {
  for (const action of ["close", "button"]) {
    const { service, mainWindow } = harness();
    const dialogs = progressWindows(mainWindow);
    const progress = service.createProgress(mainWindow, "Active");
    dialogs[0].emit("load");
    let aborts = 0;
    progress.attachXHR({ abort: () => aborts++ });
    if (action === "close") dialogs[0].close();
    else {
      dialogs[0].elements.get("cancel").click();
      dialogs[0].elements.get("cancel").click();
    }
    assert.equal(progress.cancelled, true);
    assert.equal(aborts, 1);
    assert.throws(() => service.throwIfCancelled({}, progress), /cancel/i);
    progress.close();
    assert.equal(aborts, 1);
  }
});

test("Skip current feed is enabled only for its active stage and repeated clicks cannot skip the next feed", () => {
  const { service, mainWindow } = harness();
  const dialogs = progressWindows(mainWindow);
  const progress = service.createProgress(mainWindow, "Refreshing feeds");
  let skipped = 0;
  progress.setSkipCurrentFeed(() => { skipped++; });
  dialogs[0].emit("load");
  const skip = dialogs[0].elements.get("skip-current");
  assert.equal(skip.hidden, false, "late dialog load replays the active skip state");
  assert.equal(skip.disabled, false);
  assert.equal(skip.textContent, "Skip current feed");
  skip.click();
  skip.click();
  assert.equal(skipped, 1);
  assert.equal(skip.disabled, true);
  assert.equal(progress.cancelled, false);
  assert.equal(progress.skipCurrentFeed(), false);
  progress.setSkipCurrentFeed(() => { skipped++; });
  assert.equal(skip.disabled, true, "a second click cannot carry across a native promise turn into the next feed");
  assert.equal(progress.skipCurrentFeed(), false);
  const realNow = Date.now;
  try {
    Date.now = () => progress.skipAllowedAt + 1;
    progress.setSkipCurrentFeed(() => { skipped++; });
    assert.equal(skip.disabled, false, "another deliberate skip is available after the short debounce");
  } finally { Date.now = realNow; }
  progress.setSkipCurrentFeed(null);
  assert.equal(skip.hidden, true, "the button is absent during scoring/email work");
  progress.setSkipCurrentFeed(() => { skipped++; });
  progress.cancel();
  assert.equal(skip.disabled, true);
  assert.equal(progress.skipCurrentFeed(), false);
  assert.equal(skipped, 1);
  progress.close();
});

test("every scheduled exit closes its progress window and releases both run latches", async () => {
  for (const outcome of ["cache", "scoring", "startup-failure", "refresh-failure", "cancel", "served"]) {
    const { service, mainWindow } = harness();
    const dialogs = progressWindows(mainWindow);
    service.waitForAwesomeGPT = async () => {
      if (outcome === "startup-failure") throw new Error("mock startup failure");
    };
    service.refreshAndCollect = async (_window, _config, workflow) => {
      if (outcome === "refresh-failure") throw new Error("mock refresh failure");
      if (outcome === "cancel") { workflow.cancel(); service.throwIfCancelled(workflow); }
      return { candidates: outcome === "scoring" ? [{ id: "1:ONE" }] : [], refresh: {} };
    };
    service.confirmWeeklyEmailDelivery = async () => ({ approved: false });
    service.sendWeeklyDigestFromCache = async () => ({ recorded: true });
    service.rankAndDisplay = async (_window, _candidates, { progress }) => {
      assert.equal(progress.completed, false, "parent keeps progress until the workflow finishes");
    };
    const now = new Date(2026, 9, 5, 12, 30);
    if (outcome === "served") await service.mutateState((state) => { state.weeklyPromptWeek = service.currentRunAnchor(now); });
    await service.runWeekly(now);
    await service.stateMutationQueue;
    assert.equal(dialogs.length, 1, outcome);
    assert.equal(dialogs[0].closed, true, outcome);
    assert.equal(dialogs[0].closes, 1, outcome);
    assert.equal(service.activeProgress, null, outcome);
    assert.equal(service.activeRun, null, outcome);
    assert.equal(service.weeklyStarted, false, outcome);
  }
});

test("scoring leaves adopted progress open for the digest but closes its own window", async () => {
  for (const adopted of [true, false]) {
    const { service, mainWindow } = harness();
    const dialogs = progressWindows(mainWindow);
    service.refreshJournalForScoring = async () => null;
    const workflow = {};
    const progress = adopted ? service.beginWorkflowProgress(mainWindow, workflow, "Refresh & email") : null;
    await service.rankAndDisplay(mainWindow, [], { workflow, progress, showResults: false });
    assert.equal(dialogs[0].closed, !adopted);
    if (adopted) {
      assert.equal(service.isCancelled(workflow, progress), false);
      service.endWorkflowProgress(workflow, progress);
    }
    assert.equal(dialogs[0].closes, 1);
  }
});

test("a progress-window creation failure does not disable the scheduled run", async () => {
  const { service, mainWindow } = harness();
  mainWindow.openDialog = () => { throw new Error("mock dialog creation failure"); };
  await service.runWeekly(new Date(2026, 9, 5, 12, 30));
  await service.stateMutationQueue;
  assert.equal(service.weeklyStarted, false);
  assert.equal(service.activeRun, null);
  assert.equal(service.activeProgress, null);
});

test("manual refresh-email closes progress after digest building without cancelling its preview", async () => {
  for (const outcome of ["ready", "failure", "cancel"]) {
    const { service, Zotero, mainWindow } = harness();
    const dialogs = progressWindows(mainWindow);
    service.refreshAndCollect = async () => ({ candidates: [], refresh: {} });
    let previews = 0;
    service.rebuildWeeklyDigest = async () => {
      assert.equal(dialogs[0].closed, false, "progress remains visible during digest work");
      if (outcome === "failure") throw new Error("mock digest failure");
      if (outcome === "cancel") {
        dialogs[0].emit("load");
        dialogs[0].elements.get("cancel").click();
      }
      return { available: true, articleCount: 2 };
    };
    Zotero.FeedRankEmail.openPreview = async () => {
      assert.equal(dialogs[0].closed, true);
      previews++;
      return { previewOnly: true };
    };
    const result = await service.runRefreshAndEmail(mainWindow);
    await service.stateMutationQueue;
    assert.equal(dialogs[0].closes, 1);
    assert.equal(previews, outcome === "ready" ? 1 : 0);
    assert.equal(service.activeProgress, null);
    assert.equal(service.activeRun, null);
    if (outcome === "ready") assert.equal(result.previewReady, true);
    if (outcome === "cancel") assert.equal(result.cancelled, true);
  }
});

test("email-only saves reuse score/candidate shards and retain the column lookup", async () => {
  const { service, Zotero } = harness();
  seed(service, 200);
  const previous = service.loadState().stateStorage;
  const lookup = service.matchingRankLookup();
  const writes = [], cleared = [];
  const set = Zotero.Prefs.set, clear = Zotero.Prefs.clear;
  Zotero.Prefs.set = (key, value) => { writes.push(key); return set(key, value); };
  Zotero.Prefs.clear = (key) => { cleared.push(key); return clear(key); };
  await service.mutateState((state) => {
    state.emailDelivery = { exact: "Digest HTML / Unicode 论文 & ".repeat(8000) };
  }, { returnState: false });
  const saved = service.loadState();
  for (const kind of ["ranks", "candidates"]) {
    assert.equal(generation(saved.stateStorage, kind), generation(previous, kind));
    assert.equal(saved.stateStorage[kind].contentHash, previous[kind].contentHash);
  }
  assert.ok(writes.some((key) => key.includes(".email.")));
  assert.equal(writes.filter((key) => /\.(ranks|candidates)\./.test(key)).length, 0);
  assert.equal(cleared.filter((key) => /\.(ranks|candidates)\./.test(key)).length, 0);
  assert.equal(service.rankLookup, lookup);
  assert.equal(Object.keys(saved.ranks).length, 200);
  assert.equal(saved.lastCandidates.length, 200);
  assert.equal(saved.stateIntegrityError, "");

  writes.length = 0;
  await service.mutateState((state) => { state.weeklyLog = ["metadata-only change"]; }, { returnState: false });
  assert.deepEqual(writes, ["feedranker.state"]);
  assert.deepEqual(service.loadState().stateStorage, saved.stateStorage);
});

test("changing scores cleans only replaced shards after commit, preserving frozen email bytes", async () => {
  const { service, Zotero } = harness();
  seed(service, 160);
  await service.mutateState((state) => {
    state.emailSubmissions = { retained: { status: "unknown", message: "frozen MIME\r\n论文".repeat(6000) } };
  });
  const previous = service.loadState();
  const cleared = [];
  const clear = Zotero.Prefs.clear;
  Zotero.Prefs.clear = (key) => {
    assert.notEqual(service.loadState().stateStorage.generation, previous.stateStorage.generation);
    cleared.push(key); return clear(key);
  };
  await service.mutateState((state) => { state.ranks["1:PAPER0"].score = 1; }, { returnState: false });
  const saved = service.loadState();
  assert.ok(cleared.length > 0);
  assert.ok(cleared.every((key) => key.includes(".ranks.")));
  assert.equal(generation(saved.stateStorage, "email"), generation(previous.stateStorage, "email"));
  assert.equal(generation(saved.stateStorage, "candidates"), generation(previous.stateStorage, "candidates"));
  assert.deepEqual(saved.emailSubmissions, previous.emailSubmissions);
  assert.equal(service.rankLookup, null);
  assert.equal(saved.ranks["1:PAPER0"].score, 1);
});

test("a missing retained shard or invalid descriptor still blocks mutations", async () => {
  const { service, Zotero } = harness();
  seed(service, 2);
  await service.mutateState((state) => { state.emailDelivery = { exact: "first digest" }; });
  const storage = service.loadState().stateStorage;
  const key = service.stateShardKey(generation(storage, "ranks"), "ranks", 0);
  const original = Zotero.Prefs.get(key);
  const pointer = Zotero.Prefs.get("feedranker.state");
  Zotero.Prefs.clear(key);
  assert.match(service.loadState().stateIntegrityError, /integrity/);
  await assert.rejects(service.mutateState((state) => { state.emailDelivery = {}; }), /integrity/);
  assert.equal(Zotero.Prefs.get("feedranker.state"), pointer);
  Zotero.Prefs.set(key, original);
  const invalid = JSON.parse(pointer);
  invalid.stateStorage.ranks.generation = "../invalid";
  Zotero.Prefs.set("feedranker.state", JSON.stringify(invalid));
  assert.match(service.loadState().stateIntegrityError, /integrity/);
  await assert.rejects(service.mutateState(() => {}), /integrity/);
});

test("failure after staging a changed kind keeps the legacy global pointer intact", async () => {
  const { service, Zotero } = harness();
  seed(service, 2);
  const legacy = JSON.parse(Zotero.Prefs.get("feedranker.state"));
  for (const kind of ["ranks", "candidates", "email"]) delete legacy.stateStorage[kind].generation;
  Zotero.Prefs.set("feedranker.state", JSON.stringify(legacy));
  const pointer = Zotero.Prefs.get("feedranker.state");
  const previous = service.loadState();
  const set = Zotero.Prefs.set;
  Zotero.Prefs.set = (key, value) => {
    if (key === "feedranker.state") throw new Error("mock pointer failure");
    return set(key, value);
  };
  await assert.rejects(service.mutateState((state) => { state.emailDelivery = { exact: "new staged digest" }; }), /pointer failure/);
  assert.equal(Zotero.Prefs.get("feedranker.state"), pointer);
  assert.deepEqual(service.loadState().ranks, previous.ranks);
  assert.equal(service.loadState().stateIntegrityError, "");
});

test("incremental hashes match the legacy UTF-16 JSON hashes exactly", () => {
  const { service } = harness();
  for (const entries of [[], ["论文", "astral 🌌", "lone \ud800", null, { quote: "\"\\\r\n" }],
    Array.from({ length: 200 }, (_, index) => [String(index), "significance 重要 ".repeat(300)])]) {
    assert.equal(service.stateEntriesHash(entries), "fnv1a-v1:" + Core.fnv1a(JSON.stringify(entries)));
  }
});

test("large workflow transactions yield, keep every paper and serialize queued updates", async () => {
  const { service } = harness();
  const records = ranks(service, 1000);
  let yields = 0;
  service.delay = async () => { yields++; await new Promise((resolve) => setImmediate(resolve)); };
  const first = service.mutateState((state) => {
    state.ranks = records;
    state.lastCandidates = Object.values(records);
  }, { returnState: false });
  const second = service.mutateState((state) => {
    assert.equal(Object.keys(state.ranks).length, 1000, "second transaction loads only after first commits");
    state.emailDelivery = { exact: "queued digest" };
  }, { returnState: false });
  assert.equal(await first, undefined);
  assert.equal(await second, undefined);
  assert.ok(yields > 30, "state loops must give the event loop many redraw opportunities");
  const state = service.loadState();
  assert.equal(Object.keys(state.ranks).length, 1000);
  assert.equal(state.lastCandidates.length, 1000);
  assert.equal(state.emailDelivery.exact, "queued digest");
});

test("cancellation at the cooperative commit boundary keeps preceding scores active", async () => {
  const { service, Zotero } = harness();
  seed(service, 2);
  const pointer = Zotero.Prefs.get("feedranker.state");
  const workflow = { cancelled: false };
  const set = Zotero.Prefs.set;
  let staged = false;
  Zotero.Prefs.set = (key, value) => {
    if (key.includes(".ranks.")) { staged = true; workflow.cancelled = true; }
    return set(key, value);
  };
  await assert.rejects(service.mutateState((state) => {
    state.ranks = ranks(service, 300);
  }, { returnState: false, beforeCommit: () => service.throwIfCancelled(workflow) }), /cancel/i);
  assert.equal(staged, true);
  assert.equal(Zotero.Prefs.get("feedranker.state"), pointer);
  assert.equal(Object.keys(service.loadState().ranks).length, 2);
});

test("a cooperative reader retries when a concurrent commit retires its captured shards", async () => {
  const { service } = harness();
  seed(service, 150);
  let replaced = false;
  service.delay = async () => {
    if (replaced) return;
    replaced = true;
    const state = service.loadState();
    state.ranks = ranks(service, 151);
    service.saveState(state);
  };
  const state = await service.loadStateAsync();
  assert.equal(replaced, true);
  assert.equal(state.stateIntegrityError, "");
  assert.equal(Object.keys(state.ranks).length, 151);
});

test("journal misses read only primary metadata and see newly stored entries immediately", async () => {
  const { service, Zotero, Services } = harness();
  seed(service, 300);
  const reads = [];
  const get = Zotero.Prefs.get;
  Zotero.Prefs.get = (key) => { reads.push(key); return get(key); };
  const journal = JournalService.create({ Zotero, Services, Journal, State: {
    load: () => { throw new Error("full score/email load must not be used for journal misses"); },
    loadJournalCache: () => service.loadJournalCache(),
  } });
  for (let index = 0; index < 300; index++) assert.equal(journal.cachedResult("Unknown journal " + index), null);
  assert.ok(reads.every((key) => key === "feedranker.state"));
  const snapshot = service.journalCacheSnapshot;
  assert.equal(service.loadJournalCache(), snapshot.cache);
  await service.mutateState((state) => {
    state.journalCache[Journal.publicationCacheKey("Unknown journal 0")] = {
      cacheKey: Journal.publicationCacheKey("Unknown journal 0"), found: true,
      journalName: "Unknown journal 0", retrievedAt: 1000,
      metrics: [{ key: "sciif", label: "Impact factor", value: "12.3" }],
    };
  }, { returnState: false });
  assert.equal(journal.cachedResult("Unknown journal 0").impactFactor, "12.3");
  assert.notEqual(service.journalCacheSnapshot, snapshot);
});

test("asynchronous digest selection yields and matches the synchronous selection", async () => {
  const { service } = harness();
  seed(service, 400);
  const expected = service.weeklyDigestSelection();
  assert.equal(expected.records.length, 400);
  let yields = 0;
  service.delay = async () => { yields++; };
  assert.deepEqual(await service.weeklyDigestSelectionAsync(), expected);
  assert.ok(yields > 6);
});

test("N-day feed scans yield without changing the paper count and remain cancellable", async () => {
  const { service, Zotero } = harness();
  const feed = { libraryID: 1, name: "Large feed" };
  Zotero.Feeds.getAll = () => [feed];
  Zotero.Items.getAll = async () => Array.from({ length: 200 }, (_, index) => ({ id: index + 1 }));
  service.isRankableItem = () => true;
  service.toCandidate = (item) => ({ id: "1:SCAN" + item.id, itemID: item.id, libraryID: 1,
    title: "Unique title " + item.id, doi: "10.1000/scan" + item.id, date: Core.localDay(), source: feed.name });
  let yields = 0;
  service.delay = async () => { yields++; };
  const scanned = await service.collectFeedItemsWithinDays(7, {});
  assert.equal(scanned.candidates.length, 200);
  assert.equal(scanned.refresh.scannedItemCount, 200);
  assert.ok(yields >= 6);
  const workflow = {};
  service.delay = async () => { workflow.cancelled = true; };
  await assert.rejects(service.collectFeedItemsWithinDays(7, workflow), /cancel/i);
});

test("email pane status performs one cooperative integrity-checked read per poll", async () => {
  const { Zotero, Services } = harness();
  let reads = 0;
  const email = EmailService.create({ Zotero, Services, Email, SMTP: {}, State: {
    load: () => { throw new Error("synchronous pane poll should use loadAsync instead"); },
    loadAsync: async () => { reads++; return { emailDelivery: {}, emailSubmissions: {} }; },
  } });
  email.credentialSummary = async () => ({ configured: false });
  const status = await email.getStatus();
  assert.equal(reads, 1);
  assert.equal(status.snapshot, null);
  await email.previewCurrentDigest();
  assert.equal(reads, 2);
  email.State.loadAsync = async () => ({ stateIntegrityError: "mock integrity failure" });
  await assert.rejects(email.getStatus(), /integrity failure/);
});

test("the offline snapshot helper recognizes reused score generations and ignores staged duplicates", async () => {
  const { service, Zotero, preferences } = harness();
  seed(service, 2);
  const old = service.loadState().stateStorage;
  await service.mutateState((state) => { state.emailDelivery = { exact: "new digest" }; });
  Zotero.Prefs.set("feedranker.state.v1-staged-unused.ranks.0", JSON.stringify([
    ["1:PAPER0", { id: "1:PAPER0", score: 1 }],
  ]));
  const values = new Map([...preferences].map(([key, value]) => ["extensions.zotero." + key, value]));
  const snapshot = StateSnapshot.snapshot("synthetic-profile", { values, mtime: "2026-10-05", file: "mock-prefs.js" });
  assert.equal(snapshot.state.rankCount, 2);
  assert.equal(snapshot.records["1:PAPER0"].active, true);
  assert.equal(snapshot.records["1:PAPER0"].generation, generation(old, "ranks"));
  assert.equal(snapshot.records["1:PAPER0"].score, 70);
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); process.stdout.write("ok   " + name + "\n"); }
    catch (error) { failures++; process.stdout.write("FAIL " + name + "\n" + String(error?.stack || error) + "\n"); }
  }
  process.stdout.write("\n" + (tests.length - failures) + "/" + tests.length + " responsiveness tests passed\n");
  if (failures) process.exitCode = 1;
})();
