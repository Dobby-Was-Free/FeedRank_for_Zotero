"use strict";

/*
 * Service-level tests for the scheduled run's reporting
 * (chrome/content/main.js).
 *
 * These exist because of three reports from live use, in this order:
 *
 *   1. "nothing appears on the weekly run time" -- the schedule fired and left no
 *      trace the user could see, so "it did not run" and "I did not see it" were
 *      indistinguishable.
 *   2. "popup not working, previously you have warning windows, use that" -- the
 *      passive Zotero panel has never been seen on that machine, so the channel a
 *      scheduled run reports through has to be the modal window.
 *   3. "close the feedrank result window then" -- an unattended run must not leave
 *      its results dialog on screen for papers nobody selected.
 *
 * Everything here is local and offline. `main.js` is loaded as the add-on loads
 * it (it publishes `FeedRankerMain` on the global object), the Zotero and Services
 * environments are fakes, and the assertions are about what actually reached the
 * user's screen: the exact window text, whether a window was opened at all, and
 * what was written to the durable schedule log.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Core = require("../chrome/content/core.js");
require("../chrome/content/main.js");

const Main = globalThis.FeedRankerMain;
const TOOL_NAME = "FeedRank for Zotero";

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

/*
 * A Zotero stand-in with a real preference map, so `saveState`/`loadState` go
 * through the shipped sharding code rather than a copy of it.
 */
function createHarness({ promptAvailable = true, confirmAnswer = 0 } = {}) {
  const preferences = new Map();
  const prompts = [];
  const logErrors = [];
  const notices = [];
  // The stand-in for Zotero's main window. It is only ever passed back to
  // `Services.prompt.alert`, so it needs no members of its own beyond `closed`.
  const mainWindow = { fake: "zotero-main-window", closed: false, browsingContext: {} };

  const credentialCalls = [];
  const emailConfigStore = { transport: "smtp", maximumPapers: 10 };
  // Set by a test to represent a saved SMTP credential.
  let emailCredential = null;
  const journalConfigStore = { lookupEnabled: false };
  const launched = [];
  const copied = [];
  const PREF_PREFIX = "extensions.zotero.";
  const prefsDouble = {
    // clearUserPref() throws when the preference has no user value. That is the behaviour the reset
    // has to survive, so the double reproduces it instead of smoothing it out.
    clearUserPref: (absoluteKey) => {
      if (!preferences.has(absoluteKey)) {
        throw new Error("NS_ERROR_UNEXPECTED: preference " + absoluteKey + " has no user value");
      }
      preferences.delete(absoluteKey);
    },
    prefHasUserValue: (absoluteKey) => preferences.has(absoluteKey),
    getStringPref: (absoluteKey, fallback) =>
      (preferences.has(absoluteKey) ? preferences.get(absoluteKey) : fallback),
  };
  const Zotero = {
    Prefs: {
      // Zotero.Prefs adds the namespace itself, which is exactly how the doubled name was born.
      get: (key) => (preferences.has(PREF_PREFIX + key) ? preferences.get(PREF_PREFIX + key) : ""),
      set: (key, value) => preferences.set(PREF_PREFIX + key, value),
      prefHasUserValue: (key) => preferences.has(PREF_PREFIX + key),
      clear: (key) => prefsDouble.clearUserPref(PREF_PREFIX + key),
    },
    FeedRankEmail: {
      loadConfig: () => ({ ...emailConfigStore }),
      saveConfig: (next) => {
        Object.assign(emailConfigStore, next);
        return { ...emailConfigStore };
      },
      clearCredentials: async () => {
        credentialCalls.push("clearCredentials");
        return { cleared: true, persistentCleared: true, storage: "none" };
      },
      // The connection lives in the credential record, exactly as in the real service.
      credentialSummary: async () => (emailCredential
        ? { configured: true, storage: "login-manager", persistent: true, ...emailCredential }
        : { configured: false, storage: "none", persistent: false, host: "", port: 0, username: "", from: "", to: "" }),
      exportStoredSecret: async () => (emailCredential
        ? { ciphertext: "oskv1:" + "unit-test-ciphertext-value".repeat(3) }
        : null),
    },
    FeedRankJournal: {
      loadConfig: () => ({ ...journalConfigStore }),
      saveConfig: (next) => {
        Object.assign(journalConfigStore, next);
        return { ...journalConfigStore };
      },
      clearSecretKey: async () => {
        credentialCalls.push("clearSecretKey");
        return { cleared: true, persistentCleared: true };
      },
    },
    // Zotero's own entry points: launchFile() carries the platform fallbacks, and the clipboard
    // helper works in a chrome window. The add-on must go through both, not around them.
    launchFile: (file) => launched.push(file),
    Utilities: { Internal: { copyTextToClipboard: (text) => copied.push(text) } },
    // Where the connection log is written, as the real Zotero exposes it.
    DataDirectory: { dir: "C:\\data" },
    logError: (error) => logErrors.push(String(error?.message || error)),
    Promise: { delay: () => Promise.resolve() },
    getMainWindow: () => mainWindow,
    getMainWindows: () => [mainWindow],
  };
  const Services = {
    prefs: prefsDouble,
    prompt: promptAvailable
      ? {
        BUTTON_POS_0: 1,
        BUTTON_POS_1: 256,
        BUTTON_TITLE_IS_STRING: 127,
        BUTTON_TITLE_CANCEL: 1,
        BUTTON_TITLE_YES: 0,
        BUTTON_TITLE_NO: 2,
        alert(parentWindow, title, text) {
          prompts.push({ parentWindow, title, text });
          return 0;
        },
        // 0 is the first button, which is the one that means "yes, reset".
        confirmEx(parentWindow, title, text) {
          prompts.push({ parentWindow, title, text, confirmEx: true });
          return confirmAnswer;
        },
      }
      : undefined,
  };
  const Notify = {
    info: (message) => {
      notices.push({ kind: "info", message });
      return true;
    },
    warn: (message) => {
      notices.push({ kind: "warn", message });
      return true;
    },
    error: (message) => {
      notices.push({ kind: "error", message });
      return true;
    },
    begin: (message) => {
      notices.push({ kind: "begin", message });
      return { active: true, update: () => true, close: () => true };
    },
  };

  const fileContents = new Map();
  Zotero.File = {
    getContentsAsync: async (filePath) => {
      if (!fileContents.has(filePath)) throw new Error("no such file: " + filePath);
      return fileContents.get(filePath);
    },
    putContentsAsync: async (filePath, text) => {
      fileContents.set(filePath, text);
    },
    pathToFile: (filePath) => ({ path: filePath, exists: () => fileContents.has(filePath) }),
  };
  const pickerAnswers = { result: 0, path: "" };
  const Components = {
    interfaces: {
      nsIFilePicker: { modeOpen: 0, modeSave: 1, returnOK: 0, returnCancel: 1, returnReplace: 2, filterAll: 1 },
      nsILoginInfo: {},
    },
    classes: {
      "@mozilla.org/filepicker;1": {
        createInstance: () => ({
          init: () => {},
          appendFilter: () => {},
          appendFilters: () => {},
          open: (callback) => callback(pickerAnswers.result),
          file: { get path() { return pickerAnswers.path; } },
          defaultExtension: "",
          defaultString: "",
        }),
      },
    },
    Constructor: function Constructor() {
      return function LoginInfo() {};
    },
  };

  const service = Main.create({
    Zotero,
    Services,
    rootURI: "resource://feed-ranker/",
    Core,
    Notify,
    // The same module bootstrap loads: production always supplies it, so a harness
    // without it would assert on raw keys instead of the text a reader sees.
    Strings: require("../chrome/content/strings.js"),
    // The shipped module, not a double: the reset's scope and its sentence come from there.
    SettingsFile: require("../chrome/content/settings-file.js"),
    Components,
  });
  // No test may leave a real one-minute interval running behind it. Tests that care
  // about the re-arm override this with a counter.
  service.startWeeklyScheduler = async () => {};
  return {
    service,
    prompts,
    notices,
    logErrors,
    prefs: prefsDouble,
    prefStore: preferences,
    credentialCalls,
    launched,
    copied,
    pickerAnswers,
    fileContents,
    setEmailCredential: (connection) => { emailCredential = connection; },
    mainWindow,
  };
}

function weeklySummary() {
  return {
    candidates: [{ id: "1:AAAA" }, { id: "1:BBBB" }],
    refresh: {
      totalFeeds: 22,
      successfulFeeds: new Array(22).fill({ name: "feed" }),
      failedFeeds: [],
      newItemCount: 2,
    },
  };
}

// ---------------------------------------------------------------------------
// The log is durable, and it accumulates
// ---------------------------------------------------------------------------

test("the schedule log survives a save and accumulates instead of being overwritten", async () => {
  const harness = createHarness();
  const { service } = harness;

  service.weeklyLog("schedule armed: every Wednesday at 16:50");
  service.weeklyLog("due (2026-09-30): starting the weekly job");
  service.weeklyLog("run finished: completed");
  // Three separate writes have to have happened by now, in order.
  await service.stateMutationQueue;

  const stored = service.loadState().weeklyLog;
  assert.equal(stored.length, 3);
  assert.match(stored[0], /schedule armed/);
  assert.match(stored[2], /run finished/);
  // The bug this pins: `loadState` rebuilt the state from a fixed list of keys and
  // `weeklyLog` was not on it, so every line erased the one before it and the log
  // could only ever hold the most recent event.
  const reloaded = service.loadState();
  assert.equal(reloaded.weeklyLog.length, 3, "the log must survive a reload");
  assert.deepEqual(service.weeklyLogLines().slice(-3), stored);
});

test("the stored schedule log is bounded to twenty lines", async () => {
  const harness = createHarness();
  const { service } = harness;
  for (let index = 0; index < 25; index += 1) service.weeklyLog("line " + index);
  await service.stateMutationQueue;
  const stored = service.loadState().weeklyLog;
  assert.equal(stored.length, 20);
  assert.match(stored[19], /line 24/);
  assert.match(stored[0], /line 5/);
});

// ---------------------------------------------------------------------------
// A run reports through the notice and the log, and opens no window
// ---------------------------------------------------------------------------

test("a scheduled run opens no window at all, before or after", async () => {
  // Asked for directly, once the schedule and the notices were both working:
  // "remove the popup window before and after the weekly schedule. It was for testing
  // only." The windows were built to prove a channel that could not be seen; what is
  // left is the corner notice and the durable log.
  const harness = createHarness();
  const { service } = harness;
  assert.equal(typeof service.runAlert, "undefined", "the window channel must be gone");
  assert.equal(typeof service.showScheduledRunPopup, "undefined");
  assert.equal(typeof service.testSchedulePopup, "undefined");

  // A due run starts and says so through the log, with no prompt anywhere.
  service.loadConfig = () => ({ ...Core.DEFAULT_CONFIG, weeklyRunDay: 3, weeklyRunTime: "00:01" });
  service.loadState = () => ({ weeklyPromptWeek: "", weeklyLog: [] });
  const runs = [];
  service.runWeekly = async (now) => runs.push(now);
  await service.runWeeklyIfDue(new Date(2026, 8, 30, 17, 0, 0));
  assert.equal(runs.length, 1, "the due run must still start");
  assert.equal(harness.prompts.length, 0, "and must open no window");
  assert.match(service.weeklyLogLines().slice(-1)[0], /due \(2026-09-30\): starting the scheduled job/);
});

test("the due check starts exactly one run and never stacks another", async () => {
  const harness = createHarness();
  const { service } = harness;
  service.loadConfig = () => ({ ...Core.DEFAULT_CONFIG, weeklyRunDay: 3, weeklyRunTime: "00:01" });
  service.loadState = () => ({ weeklyPromptWeek: "", weeklyLog: [] });
  const runs = [];
  // `runWeekly` is the real owner of the in-flight latch: it sets `weeklyStarted` for
  // the duration of the attempt and releases it in `finally`. Stubbing the run means
  // standing in for both halves of that contract.
  service.runWeekly = async (now) => {
    runs.push(now);
    service.weeklyStarted = true;
    try {
      return await Promise.resolve();
    } finally {
      service.weeklyStarted = false;
    }
  };

  const now = new Date(2026, 8, 30, 17, 0, 0);
  await service.runWeeklyIfDue(now);
  assert.equal(runs.length, 1);
  // A poll that lands while the first run is still in flight does nothing: the week is
  // still due and the anchor is written by the run itself, so the latch is what stops
  // a second one from starting on top of it.
  service.weeklyStarted = true;
  await service.runWeeklyIfDue(new Date(2026, 8, 30, 17, 1, 0));
  assert.equal(runs.length, 1, "a second run must not start behind the first");
  // Once the latch is released the next poll may act again.
  service.weeklyStarted = false;
  await service.runWeeklyIfDue(new Date(2026, 8, 30, 17, 2, 0));
  assert.equal(runs.length, 2);
  assert.equal(harness.prompts.length, 0, "no window is opened at any point");
});

// ---------------------------------------------------------------------------
// What the run says about the email
// ---------------------------------------------------------------------------

test("the three ways a digest can end without a send are kept apart", () => {
  const harness = createHarness();
  const { service } = harness;

  assert.match(
    service.digestOutcomeLine({ sent: true, to: "reader@example.test" }),
    /^Email: SENT to reader@example\.test\.$/,
  );
  assert.match(
    service.digestOutcomeLine({ sent: false, message: "the negotiated protocol is unknown" }),
    /^Email: NOT SENT — the negotiated protocol is unknown\.$/,
  );
  assert.match(service.digestOutcomeLine(null), /no digest was prepared/);

  const unapproved = service.digestRunOutcome({}, { autoSendApproved: false, approvalReason: "automatic sending is switched off in FeedRank settings" });
  assert.equal(unapproved.sent, false);
  assert.match(unapproved.message, /automatic sending is switched off/);

  const missingService = service.digestRunOutcome(null, { autoSendApproved: true });
  assert.match(missingService.message, /email service did not answer/);

  const failed = service.digestRunOutcome(
    { autoResult: { sent: false, message: "simulated refusal" } },
    { autoSendApproved: true },
  );
  assert.equal(failed.sent, false);
  assert.match(failed.message, /simulated refusal/);
});

test("a finished scheduled run reports feeds, articles and the email in one notice", () => {
  const harness = createHarness();
  const { service } = harness;
  service.lastRunSplit = { mode: "score", reused: 3, newlyScored: 2, replaced: 0 };
  service.lastDigestOutcome = { sent: true, to: "reader@example.test" };

  const text = service.reportScheduledRun(weeklySummary(), { manual: false });

  assert.equal(harness.prompts.length, 0, "no window, before or after");
  assert.match(text, /Feeds: 22 of 22 updated\./);
  assert.match(text, /Articles: 2 newly scored, 3 already current\./);
  assert.match(text, /Email: SENT to reader@example\.test\./);
  assert.equal(harness.notices.filter((entry) => entry.kind === "info").length, 1);
  // The panel is a few lines tall, so the notice collapses the line structure the log
  // keeps; the words are the same.
  assert.equal(harness.notices.slice(-1)[0].message, text.replace(/\n/g, " "));
  // The same sentence is what a reader finds in the durable log afterwards.
  assert.match(service.weeklyLogLines().slice(-1)[0], /outcome \(scheduled\): .*Email: SENT/);
});

test("a run with nothing to score says so instead of claiming articles", () => {
  const harness = createHarness();
  const { service } = harness;
  service.lastRunSplit = null;
  service.lastDigestOutcome = {
    sent: false,
    message: "there was nothing eligible to email (no article reached the minimum score)",
  };
  const text = service.reportScheduledRun({ candidates: [], refresh: weeklySummary().refresh }, { manual: false });
  assert.match(text, /Articles: nothing new needed scoring\./);
  assert.match(text, /nothing eligible to email/);
});

test("a hand-started weekly run reports through the notice, with no window", () => {
  const harness = createHarness();
  const { service } = harness;
  service.lastRunSplit = { mode: "score", reused: 0, newlyScored: 1, replaced: 0 };
  service.lastDigestOutcome = { sent: true, to: "reader@example.test" };
  const text = service.reportScheduledRun(weeklySummary(), { manual: true });
  // The on-demand command exists so the scheduled path can be exercised without waiting
  // for the schedule, and it reports the email outcome the same way a scheduled run does.
  assert.equal(harness.prompts.length, 0, "no window, before or after");
  assert.equal(harness.notices.filter((entry) => entry.kind === "info").length, 1);
  assert.match(harness.notices.slice(-1)[0].message, /Email: SENT/);
  assert.match(text, /1 newly scored/);
  assert.match(text, /Email: SENT/);
  assert.match(service.weeklyLogLines().slice(-1)[0], /outcome \(manual\)/);
});

test("a finished scheduled run reports through the notice and the durable log", () => {
  const harness = createHarness();
  const { service } = harness;
  service.lastRunSplit = { mode: "score", reused: 3, newlyScored: 2, replaced: 0 };
  service.lastDigestOutcome = { sent: true, to: "reader@example.test" };
  const text = service.reportScheduledRun(weeklySummary(), { manual: false });
  assert.equal(harness.prompts.length, 0, "the before/after windows are gone");
  const info = harness.notices.filter((entry) => entry.kind === "info");
  assert.equal(info.length, 1, "the outcome is still said, in the corner");
  assert.match(info[0].message, /Email: SENT to reader@example\.test\./);
  // The same sentence is what Check schedule prints afterwards.
  assert.match(service.weeklyLogLines().slice(-1)[0], /outcome \(scheduled\): .*Email: SENT/);
  assert.match(text, /Feeds: 22 of 22 updated\./);
});

// ---------------------------------------------------------------------------
// Repeat frequency: daily, weekly, monthly
// ---------------------------------------------------------------------------

test("the digest span follows the repeat frequency", async () => {
  // Asked for directly: "the email digest time span should follow the repeat
  // frequency", after "maybe make an option for repeat frequency. some may want daily
  // some may want monthly."
  const harness = createHarness();
  const { service } = harness;
  const dayString = (offsetDays) => {
    const date = new Date();
    date.setDate(date.getDate() - offsetDays);
    return date.getFullYear() + "-" +
      String(date.getMonth() + 1).padStart(2, "0") + "-" +
      String(date.getDate()).padStart(2, "0");
  };
  service.isCurrentScoreRecord = () => true;
  service.withLocalPriority = (record) => record;
  // A record without a fingerprint is dropped by the state compactor, which is what
  // the first version of this test forgot.
  const seeded = (id, offsetDays) => ({
    id, score: 90, date: dayString(offsetDays), title: "seeded",
    fingerprint: Core.cacheFingerprint({ id, title: "seeded", date: dayString(offsetDays) }, Core.DEFAULT_CONFIG),
    configFingerprint: Core.rankingConfigFingerprint(Core.DEFAULT_CONFIG),
    fingerprintScheme: 2,
    rankedAt: new Date().toISOString(),
  });
  await service.mutateState((state) => {
    state.ranks = {
      "1:TODAY": seeded("1:TODAY", 0),
      "1:WEEK": seeded("1:WEEK", 3),
      "1:MONTH": seeded("1:MONTH", 20),
    };
    return state;
  });

  const selectionFor = async (frequency) => {
    service.saveConfig({ runFrequency: frequency, weeklyRunTime: "09:00" });
    await service.stateMutationQueue;
    return service.weeklyDigestSelection();
  };

  const daily = await selectionFor("daily");
  assert.equal(daily.lookbackDays, 1);
  assert.deepEqual(daily.records.map((record) => record.id), ["1:TODAY"]);
  assert.equal(daily.window.from, daily.window.to, "one day is one date");

  const weekly = await selectionFor("weekly");
  assert.equal(weekly.lookbackDays, 7);
  // Newest first, as the digest orders them.
  assert.deepEqual(weekly.records.map((record) => record.id), ["1:TODAY", "1:WEEK"]);

  const monthly = await selectionFor("monthly");
  assert.equal(monthly.lookbackDays, 30);
  assert.deepEqual(
    monthly.records.map((record) => record.id).sort(),
    ["1:MONTH", "1:TODAY", "1:WEEK"],
  );

  // The report states the span, so the cadence is visible before a run happens.
  for (const [frequency, days] of [["daily", 1], ["weekly", 7], ["monthly", 30]]) {
    service.saveConfig({ runFrequency: frequency, weeklyRunTime: "09:00" });
    await service.stateMutationQueue;
    const report = service.scheduleReport();
    assert.equal(report.frequency, frequency);
    assert.equal(report.lookbackDays, days);
    assert.equal(service.scheduleReport().lookbackDays, days);
  }
});

test("a scheduled run collects the span its cadence digests", async () => {
  for (const [frequency, expected] of [["daily", 1], ["weekly", 7], ["monthly", 30]]) {
    const harness = createHarness();
    const { service } = harness;
    service.loadConfig = () => ({
      ...Core.DEFAULT_CONFIG,
      runFrequency: frequency,
      weeklyRunDay: new Date().getDay(),
      monthlyRunDay: 1,
      weeklyRunTime: "00:01",
    });
    service.loadState = () => ({ weeklyPromptWeek: "", weeklyLog: [] });
    service.createProgress = () => ({
      cancelled: false, update() {}, setTitle() {}, close() {}, reportUsage() {},
    });
    service.waitForAwesomeGPT = async () => ({ window: harness.mainWindow, request: async () => "" });
    let seen = null;
    service.refreshAndCollect = async (_window, config) => {
      seen = config;
      return { candidates: [], refresh: { totalFeeds: 0, successfulFeeds: [], failedFeeds: [] } };
    };
    service.recordCompletedDigest = async () => null;

    await service.runWeekly(new Date(), { manual: true });
    assert.equal(seen.lookbackDays, expected, frequency + " must collect " + expected + " days");
  }
});

test("daily and monthly cadences are due once a period, and know their next moment", async () => {
  const harness = createHarness();
  const { service } = harness;
  let marker = "";
  service.loadState = () => ({ weeklyPromptWeek: marker, weeklyLog: [] });

  // Daily: 2026-09-30 at 09:00, due after the minute, once.
  service.saveConfig({ runFrequency: "daily", weeklyRunTime: "09:00" });
  await service.stateMutationQueue;
  assert.equal(service.isWeeklyRunDue(new Date(2026, 8, 30, 8, 59)), false, "before its minute");
  assert.equal(service.isWeeklyRunDue(new Date(2026, 8, 30, 9, 0)), true);
  marker = service.currentRunAnchor(new Date(2026, 8, 30, 9, 0));
  assert.equal(marker, "2026-09-30");
  assert.equal(service.isWeeklyRunDue(new Date(2026, 8, 30, 23, 0)), false, "once a day");
  assert.equal(service.isWeeklyRunDue(new Date(2026, 9, 1, 9, 0)), true, "tomorrow is a new period");
  assert.equal(
    service.scheduleReport(new Date(2026, 8, 30, 9, 30)).nextRun.toLocaleDateString(),
    new Date(2026, 9, 1, 9, 0).toLocaleDateString(),
  );

  // Monthly on the 15th: due only from the 15th, and the next one is next month.
  service.saveConfig({ runFrequency: "monthly", monthlyRunDay: 15, weeklyRunTime: "09:00" });
  await service.stateMutationQueue;
  marker = "";
  assert.equal(service.isWeeklyRunDue(new Date(2026, 8, 14, 9, 0)), false);
  assert.equal(service.isWeeklyRunDue(new Date(2026, 8, 15, 9, 0)), true);
  marker = service.currentRunAnchor(new Date(2026, 8, 15, 9, 0));
  assert.equal(marker, "2026-09-15");
  assert.equal(service.isWeeklyRunDue(new Date(2026, 8, 30, 9, 0)), false, "once a month");
  assert.equal(service.isWeeklyRunDue(new Date(2026, 9, 15, 9, 0)), true);
  const nextMonthly = service.scheduleReport(new Date(2026, 8, 20, 9, 0)).nextRun;
  assert.equal(nextMonthly.getMonth(), 9, "October");
  assert.equal(nextMonthly.getDate(), 15);

  // A 31st schedule is served on the last day of a short month rather than skipped.
  service.saveConfig({ runFrequency: "monthly", monthlyRunDay: 31, weeklyRunTime: "09:00" });
  await service.stateMutationQueue;
  marker = "";
  const april = service.currentRunAnchor(new Date(2027, 3, 30, 12, 0));
  assert.equal(april, "2027-04-30", "April has no 31st, so the 30th serves it");
  assert.equal(service.isWeeklyRunDue(new Date(2027, 3, 30, 12, 0)), true);

  // The pane sentence names the cadence and the day.
  assert.match(service.scheduleDescription(), /monthly on the 31st at 09:00/);
  service.saveConfig({ runFrequency: "daily", weeklyRunTime: "07:05" });
  await service.stateMutationQueue;
  assert.equal(service.scheduleDescription(), "daily at 07:05");
  service.saveConfig({ runFrequency: "weekly", weeklyRunDay: 3, weeklyRunTime: "16:50" });
  await service.stateMutationQueue;
  assert.equal(service.scheduleDescription(), "weekly on Wednesday at 16:50");
});

test("both panes offer the repeat, and only the day control it uses", () => {
  const root = path.join(__dirname, "..");
  for (const [rel, frequencyId, monthlyId] of [
    ["chrome/content/preferences.xhtml", "feed-ranker-run-frequency", "feed-ranker-monthly-day"],
    ["chrome/content/settings.xhtml", "run-frequency", "monthly-day"],
  ]) {
    const source = fs.readFileSync(path.join(root, rel), "utf8");
    assert.match(source, new RegExp('id="' + frequencyId + '"'), rel + " must offer a repeat");
    assert.match(source, new RegExp('id="' + monthlyId + '"'), rel + " must offer a monthly day");
    for (const value of ["daily", "weekly", "monthly"]) {
      assert.match(source, new RegExp('value="' + value + '"'), rel + " must offer " + value);
    }
  }
  // The scripts must both save the cadence and show only the relevant day control.
  for (const [rel, frequencyId, monthlyId] of [
    ["chrome/content/preferences.js", "runFrequency", "monthlyRunDay"],
    ["chrome/content/settings.js", "runFrequency", "monthlyRunDay"],
  ]) {
    const source = fs.readFileSync(path.join(root, rel), "utf8");
    assert.match(source, new RegExp(frequencyId), rel + " must read the repeat");
    assert.match(source, new RegExp(monthlyId), rel + " must read the monthly day");
    assert.match(source, /display/, rel + " must hide the day control the repeat does not use");
  }
});

// ---------------------------------------------------------------------------
// The results window
// ---------------------------------------------------------------------------

test("a run that is not allowed to show results opens no results window", async () => {
  const harness = createHarness();
  const { service } = harness;
  const opened = [];
  service.openResults = (...args) => opened.push(args);
  // The smallest run that reaches the results stage: every candidate is a cache
  // hit, so nothing is sent to the model and the digest is recorded from the cache.
  const cachedRecord = { id: "1:AAAA", score: 90, date: "2026-09-30", title: "Paper" };
  service.loadState = () => ({ ranks: { "1:AAAA": cachedRecord }, weeklyLog: [], stateStorage: {}, schema: 3 });
  service.loadConfig = () => ({ promptVersion: 1, profile: "", explanationLanguage: "en" });
  service.matchesCurrentScore = () => true;
  service.withLocalPriority = (record) => record;
  service.refreshJournalForScoring = async () => ({ attempted: false });
  service.recordCompletedDigest = async () => null;

  const workflow = { cancelled: false, progress: null };
  const progress = { update: () => {}, setTitle: () => {}, close: () => {} };
  const candidates = [{ id: "1:AAAA", rank: { score: 90 } }];

  await service.rankAndDisplay(harness.mainWindow, candidates, {
    workflow,
    progress,
    showResults: false,
    digestRun: { runID: "weekly:1", localDay: "2026-09-30", weekStart: "2026-09-24" },
  });
  assert.equal(opened.length, 0, "a scheduled run must leave no results window");

  await service.rankAndDisplay(harness.mainWindow, candidates, {
    workflow,
    progress,
    digestRun: null,
  });
  assert.equal(opened.length, 1, "an explicit run still shows its results");
});

// ---------------------------------------------------------------------------
// Setting a time has to be able to fire
// ---------------------------------------------------------------------------

test("changing the weekly time clears the completed-week marker so the new moment can fire", async () => {
  const harness = createHarness();
  const { service } = harness;
  let rearmed = 0;
  service.startWeeklyScheduler = async () => { rearmed += 1; };

  // The state the user was actually in: the week of Wednesday 2026-09-30 had
  // already been served by "Run weekly job now", and then they set 18:19.
  await service.mutateState((state) => {
    state.weeklyPromptWeek = "2026-09-30";
    return state;
  });
  assert.equal(
    service.isWeeklyRunDue(new Date(2026, 8, 30, 18, 30, 0)),
    false,
    "with the marker set, the rest of the day can never fire",
  );

  service.saveConfig({ weeklyRunDay: 3, weeklyRunTime: "18:19" });
  await service.stateMutationQueue;

  assert.equal(service.loadState().weeklyPromptWeek, "", "the marker is cleared by the change");
  assert.equal(rearmed, 1, "the scheduler is re-armed for the new moment");
  assert.match(service.weeklyLogLines().slice(-2).join(" | "), /schedule changed: .*18:19/);
  assert.equal(
    service.isWeeklyRunDue(new Date(2026, 8, 30, 18, 30, 0)),
    true,
    "the newly set moment is due now",
  );
});

test("saving an unchanged schedule does not clear the marker", async () => {
  const harness = createHarness();
  const { service } = harness;
  service.saveConfig({ weeklyRunDay: 3, weeklyRunTime: "18:19" });
  await service.stateMutationQueue;
  await service.mutateState((state) => {
    state.weeklyPromptWeek = "2026-09-30";
    return state;
  });
  // Editing the profile must not re-run the week that was already served.
  service.saveConfig({ weeklyRunDay: 3, weeklyRunTime: "18:19", profile: "changed profile" });
  await service.stateMutationQueue;
  assert.equal(service.loadState().weeklyPromptWeek, "2026-09-30");
});

test("the settings pane is told when the next run is, not just that it saved", async () => {
  const harness = createHarness();
  const { service } = harness;
  assert.match(
    service.nextRunSummary(new Date(2026, 8, 30, 18, 0)),
    /No automatic run is scheduled/,
  );

  service.saveConfig({ weeklyRunDay: 3, weeklyRunTime: "18:19" });
  await service.stateMutationQueue;
  assert.match(service.nextRunSummary(new Date(2026, 8, 30, 18, 30)), /Due now/);

  await service.mutateState((state) => {
    state.weeklyPromptWeek = "2026-09-30";
    return state;
  });
  const done = service.nextRunSummary(new Date(2026, 8, 30, 18, 30));
  assert.match(done, /already done/);
  assert.match(done, /Next automatic run:/);

  // ...and the one-line pane flag says it too, instead of only naming the last week.
  assert.match(service.runStateSummary(), /already done this week|already done/);
});

test("every poll is counted, so a live timer is visible", async () => {
  const harness = createHarness();
  const { service } = harness;
  service.loadConfig = () => ({ ...Core.DEFAULT_CONFIG, weeklyRunDay: 3, weeklyRunTime: "23:59" });
  assert.equal(Number(service.scheduleChecks) || 0, 0);
  await service.runWeeklyIfDue(new Date(2026, 8, 30, 18, 30, 0));
  await service.runWeeklyIfDue(new Date(2026, 8, 30, 18, 31, 0));
  assert.equal(service.scheduleChecks, 2);
  assert.ok(service.lastScheduleCheckAt > 0);
  assert.match(service.scheduleReportText(), /Checks: 2, last at /);
});

// ---------------------------------------------------------------------------
// A dialog must not be buried by a refresh
// ---------------------------------------------------------------------------

test("every FeedRank window is dependent, so a Zotero refresh cannot bury it", () => {
  // Reported from live use: "the main window would refresh and put the score related
  // window behind when I read it". Scoring refreshes the item tree and the item pane,
  // and Zotero raises its own window while it does that. `dependent=yes` makes each
  // dialog a child of the Zotero window that opened it, which is Zotero's own
  // convention (its ProgressWindow opens with "chrome,dialog=no,titlebar=no,dependent=yes").
  const directory = path.join(__dirname, "..", "chrome", "content");
  const features = [];
  for (const name of ["main.js", "email-service.js"]) {
    const source = fs.readFileSync(path.join(directory, name), "utf8");
    // The feature string is the third argument of openDialog, possibly preceded by
    // comments (either style) explaining why the window is opened the way it is.
    const pattern = new RegExp(
      'openDialog\\(\\s*"chrome:\\/\\/feedranker\\/[^"]+",\\s*"[^"]+",\\s*' +
      '(?:(?:\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*)\\s*)*' +
      '"([^"]+)"',
      "g",
    );
    for (const match of source.matchAll(pattern)) features.push({ name, feature: match[1] });
  }
  assert.ok(features.length >= 5, "expected every FeedRank dialog, found " + features.length);
  for (const { name, feature } of features) {
    assert.match(feature, /(^|,)dependent=yes(,|$)/, name + " opens a dialog that can be buried: " + feature);
  }
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

test("a reset removes the settings and the credentials even when a preference has no user value", async () => {
  const harness = createHarness();
  const { service, prefStore, credentialCalls } = harness;
  /*
   * The bug this pins: the reset looped over the three preferences and cleared them in one
   * expression, with the credential deletion after the loop. `clearUserPref` throws for a preference
   * that has no user value -- here that is the two the user never saved -- so the reset stopped on
   * the first of them: settings survived and the password and EasyScholar key stayed connected.
   */
  prefStore.set("extensions.zotero.feedranker.config", JSON.stringify({ profile: "kept until now", lookbackDays: 90 }));
  await service.mutateState((state) => {
    state.weeklyLog = ["a line the reset does not own"];
    state.weeklyPromptWeek = "2026-09-23";
    return state;
  });
  assert.equal(prefStore.has("extensions.zotero.feedranker.email.config"), false, "the fixture needs a preference with no user value");
  assert.equal(prefStore.has("extensions.zotero.feedranker.journal.config"), false);

  const result = await service.resetAllSettings(harness.mainWindow);
  assert.equal(result.reset, true, "a preference already at its default is not a failure");
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.credentialsCleared, ["SMTP password", "EasyScholar key"]);
  assert.deepEqual(credentialCalls, ["clearCredentials", "clearSecretKey"],
    "both credentials must be removed, and before anything that can throw");
  assert.deepEqual(result.cleared, ["extensions.zotero.feedranker.config"]);
  assert.equal(prefStore.has("extensions.zotero.feedranker.config"), false, "the saved settings must be gone");
  assert.equal(service.loadConfig().lookbackDays, Core.DEFAULT_CONFIG.lookbackDays, "the pane reads defaults again");

  // The caches are the one thing a reset keeps, because rebuilding them costs model calls.
  assert.deepEqual(result.kept, ["ranks", "journalCache", "lastCandidates"]);
  const state = service.loadState();
  assert.deepEqual(state.weeklyLog, ["a line the reset does not own"],
    "the reset must only touch the keys its own scope names");
  assert.equal(state.weeklyPromptWeek, "", "the completed-week marker is cleared");

  // Cancelling must change nothing at all.
  const cancelled = createHarness({ confirmAnswer: 1 });
  cancelled.prefStore.set("extensions.zotero.feedranker.config", JSON.stringify({ lookbackDays: 90 }));
  const stopped = await cancelled.service.resetAllSettings(cancelled.mainWindow);
  assert.equal(stopped.cancelled, true);
  assert.deepEqual(cancelled.credentialCalls, [], "a cancelled reset must not touch a credential");
  assert.equal(cancelled.prefStore.has("extensions.zotero.feedranker.config"), true);
});

test("a credential that cannot be removed is reported, and the settings are still reset", async () => {
  const harness = createHarness();
  const { service, prefStore } = harness;
  prefStore.set("extensions.zotero.feedranker.config", JSON.stringify({ lookbackDays: 90 }));
  // The one case where "reset worked" would be a lie: the key is still in the store.
  service.Zotero.FeedRankJournal.clearSecretKey = async () => ({ cleared: false });
  const result = await service.resetAllSettings(harness.mainWindow);
  assert.equal(result.reset, true);
  assert.deepEqual(result.credentialsCleared, ["SMTP password"]);
  assert.deepEqual(result.failures, ["EasyScholar key"], "the key that stayed connected is named");
  assert.equal(prefStore.has("extensions.zotero.feedranker.config"), false, "one failed credential must not block the settings");
});

test("a reset reaches the settings that live under the doubled namespace", async () => {
  const harness = createHarness();
  const { service, prefStore } = harness;
  /*
   * Reproduced from a real profile. FeedRank 0.1.3 handed a fully-qualified name to Zotero.Prefs,
   * which adds "extensions.zotero." itself, so the settings were written to
   * user_pref("extensions.zotero.extensions.zotero.feedranker.config", ...). loadConfig() still
   * reads that key as a fallback, so it is what the pane shows -- and a reset that cleared only
   * "extensions.zotero.feedranker.config" deleted nothing at all while reporting success.
   */
  const BROKEN = "extensions.zotero.extensions.zotero.feedranker.config";
  const CURRENT = "extensions.zotero.feedranker.config";
  prefStore.set(BROKEN, JSON.stringify({ profile: "the profile the user actually sees", lookbackDays: 300 }));
  assert.equal(prefStore.has(CURRENT), false, "the fixture needs the current key to be absent");
  assert.equal(service.loadConfig().lookbackDays, 300, "the doubled key is what loadConfig reads");

  const result = await service.resetAllSettings(harness.mainWindow);
  assert.equal(result.reset, true);
  assert.deepEqual(result.failures, [], "clearing a key that is already at its default is not a failure");
  assert.equal(prefStore.has(BROKEN), false, "the doubled-namespace key must be cleared");
  assert.equal(service.loadConfig().lookbackDays, Core.DEFAULT_CONFIG.lookbackDays,
    "the pane must read defaults again after the reset");
  assert.equal(service.loadConfig().profile, Core.DEFAULT_CONFIG.profile,
    "the profile text must be back at its default, not the user's");
  // The other two keys have no user value here, and that must not be reported as a failure.
  assert.equal(result.failures.includes(CURRENT), false);
});

test("a preference that cannot be cleared is named in the result instead of being hidden", async () => {
  const harness = createHarness();
  const { service, prefStore } = harness;
  prefStore.set("extensions.zotero.feedranker.config", JSON.stringify({ lookbackDays: 90 }));
  // A preference service that refuses everything: the credentials still come out, so this is a
  // partial reset, and the preference that survived has to be named.
  harness.service.Services.prefs.clearUserPref = () => {
    throw new Error("simulated preference service failure");
  };
  const result = await service.resetAllSettings(harness.mainWindow);
  assert.equal(result.reset, true, "the credentials were removed, so this is not a clean failure");
  assert.deepEqual(result.failures, ["extensions.zotero.feedranker.config"]);
  assert.equal(prefStore.has("extensions.zotero.feedranker.config"), true,
    "the preference really did survive, so claiming otherwise would be a lie");
  assert.equal(service.loadConfig().lookbackDays, 90, "the pane still reads the old value");
});

test("a scoring run that skips journal metrics for want of a key says so", () => {
  const harness = createHarness();
  const { service, notices } = harness;
  /*
   * The outcome of the journal step was discarded, so an enabled lookup with no key was completely
   * silent: the run scored without journal evidence and the user had no way to know why.
   */
  service.reportJournalOutcome({ attempted: false, reason: "no-key" });
  const said = notices.filter((notice) => /EasyScholar key/.test(notice.message || ""));
  assert.equal(said.length, 1, "the skipped lookup must be reported exactly once");
  assert.match(said[0].message, /no EasyScholar key is saved/);
  // Every other reason is either the user's own choice or already reported elsewhere.
  for (const reason of ["disabled", "unavailable", "nothing-to-do", "", undefined]) {
    const before = notices.length;
    service.reportJournalOutcome({ attempted: false, reason });
    assert.equal(notices.length, before, "reason " + reason + " must stay silent");
  }
});

test("opening a file and copying text go through Zotero's own helpers", () => {
  const harness = createHarness();
  const { service, launched, copied } = harness;
  assert.equal(service.openFileWithSystem("C:\\tmp\\feedrank-connection-log.txt"), true);
  assert.deepEqual(launched, ["C:\\tmp\\feedrank-connection-log.txt"],
    "Zotero.launchFile() is the entry point with the platform fallbacks");
  assert.equal(service.openFileWithSystem(""), false, "an empty path opens nothing");

  assert.equal(service.copyTextToClipboard("connection log"), true);
  assert.deepEqual(copied, ["connection log"]);
  assert.equal(service.copyTextToClipboard(""), false);

  // A Zotero without either helper must report failure rather than pretend it worked.
  const bare = createHarness();
  bare.service.Zotero.launchFile = undefined;
  bare.service.Zotero.File = undefined;
  assert.equal(bare.service.openFileWithSystem("C:\\tmp\\log.txt"), false);
  bare.service.Zotero.Utilities = undefined;
  assert.equal(bare.service.copyTextToClipboard("text"), false);
});

test("every value in a settings file is applied, not just the profile", async () => {
  const harness = createHarness();
  const { service, prefStore, pickerAnswers, fileContents } = harness;
  /*
   * Reproduced from a real import: only the research profile came through, and every other value --
   * numbers, other texts, the email and journal settings -- stayed as it was. The file itself parsed
   * perfectly, so the loss is in the apply step, and only an end-to-end test can see it.
   */
  const file = {
    kind: "feedrank-settings",
    schema: 1,
    config: {
      profile: "an imported research profile",
      explanationLanguage: "en",
      lookbackDays: 1,
      candidateLimit: 30,
      batchSize: 10,
      maxRetries: 1,
      batchConcurrency: 1,
      runFrequency: "weekly",
      weeklyRunDay: 1,
      monthlyRunDay: 1,
      weeklyRunTime: "",
      requestTimeoutMs: 120000,
      currency: "USD",
      inputPricePerMillion: 0.3,
      outputPricePerMillion: 1.2,
      bibliometricWeightPoints: 0,
      arxivSignificanceSignals: "",
    },
    email: { transport: "smtp", maximumPapers: 25, minimumRelevanceScore: 70 },
    journal: { lookupEnabled: true, refreshBeforeScoring: false },
  };
  const filePath = "C:\\tmp\\feedrank-settings.json";
  fileContents.set(filePath, JSON.stringify(file));
  pickerAnswers.result = 0;
  pickerAnswers.path = filePath;

  const before = service.loadConfig();
  assert.notEqual(before.lookbackDays, 1, "the fixture must start from a different value");

  const result = await service.importSettingsFromFile(harness.mainWindow);
  assert.equal(result.loaded, true, result.reason || "the import must succeed");

  const after = service.loadConfig();
  assert.equal(after.profile, "an imported research profile");
  assert.equal(after.explanationLanguage, "en", "another text value must be applied too");
  assert.equal(after.currency, "USD");
  assert.equal(after.lookbackDays, 1, "numbers must be applied, not only the profile");
  assert.equal(after.candidateLimit, 30);
  assert.equal(after.batchSize, 10);
  assert.equal(after.maxRetries, 1);
  assert.equal(after.runFrequency, "weekly");
  assert.equal(after.weeklyRunDay, 1);
  assert.equal(after.requestTimeoutMs, 120000);
  assert.equal(after.inputPricePerMillion, 0.3);
  assert.equal(after.outputPricePerMillion, 1.2);
  // And the other two sections, through the services' own save paths.
  assert.equal(service.Zotero.FeedRankEmail.loadConfig().maximumPapers, 25);
  assert.equal(service.Zotero.FeedRankJournal.loadConfig().lookupEnabled, true);
  // The pref holds all of it, not just the profile.
  const stored = JSON.parse(prefStore.get("extensions.zotero.feedranker.config"));
  assert.equal(stored.lookbackDays, 1);
  assert.equal(stored.explanationLanguage, "en");
  assert.deepEqual(result.applied, ["config", "email", "journal"]);
});

test("saving settings to a file includes the SMTP connection", async () => {
  const harness = createHarness();
  const { service, pickerAnswers, fileContents } = harness;
  /*
   * The digest options were in the file and the connection was not, so importing could restore the
   * EasyScholar key (which needs nothing else) and had no way to attach the SMTP password: the
   * credential's record needs a host, a port and an identity to belong to.
   */
  harness.setEmailCredential({
    host: "smtp.example.test",
    port: 994,
    tlsMode: "implicit",
    authMethod: "login",
    username: "digest@example.test",
    from: "digest@example.test",
    to: "reader@example.test",
  });
  const target = "C:\\tmp\\exported-settings.json";
  pickerAnswers.result = 0;
  pickerAnswers.path = target;

  const result = await service.exportSettingsToFile(harness.mainWindow);
  assert.equal(result.saved, true, result.reason || "the export must succeed");
  const written = JSON.parse(fileContents.get(target));
  assert.equal(written.email.host, "smtp.example.test", "the host must travel with the file");
  assert.equal(written.email.port, 994);
  assert.equal(written.email.username, "digest@example.test");
  assert.equal(written.email.from, "digest@example.test");
  assert.equal(written.email.to, "reader@example.test");
  assert.equal(written.email.tlsMode, "implicit");
  assert.equal(written.email.authMethod, "login");
  // The options stay too.
  assert.equal(written.email.transport, "smtp");

  // This harness's dialog answers yes, so the credential travels as CIPHERTEXT only -- and the
  // connection still travels either way, because it is not the secret.
  assert.match(written.credentials.email, /^oskv1:/);
  assert.equal(JSON.stringify(written).includes("digest-secret"), false);

  // Answering no leaves the credential out entirely; that is the real dialog's default answer.
  const declined = createHarness({ confirmAnswer: 1 });
  declined.setEmailCredential({
    host: "smtp.example.test",
    port: 994,
    tlsMode: "implicit",
    authMethod: "login",
    username: "digest@example.test",
    from: "digest@example.test",
    to: "reader@example.test",
  });
  declined.pickerAnswers.result = 0;
  declined.pickerAnswers.path = "C:\\\\tmp\\\\declined-settings.json";
  const declinedResult = await declined.service.exportSettingsToFile(declined.mainWindow);
  assert.equal(declinedResult.saved, true);
  const declinedFile = JSON.parse(declined.fileContents.get("C:\\\\tmp\\\\declined-settings.json"));
  assert.equal(declinedFile.credentials, undefined, "declining must leave the credential out");
  assert.equal(declinedFile.email.host, "smtp.example.test", "the connection is not a secret");
});

test("the connection log is written through the API that works, and a failure says why", async () => {
  const harness = createHarness();
  const { service, fileContents } = harness;
  /*
   * The log used to be written with nsIFileOutputStream's deprecated string write(), which throws in
   * this Gecko. Every attempt failed silently, the remembered path stayed empty, and "Open log file"
   * had nothing to open -- while "Copy log" worked, because it copies the text from memory.
   */
  const written = await service.writeConnectionLog("the report body");
  assert.equal(written.written, true, written.reason || "the write must succeed");
  assert.match(written.path, /feedrank-smtp-.*\.log$/);
  assert.equal(fileContents.get(written.path), "the report body");

  // A write that fails returns the reason: an empty answer is what made this invisible.
  service.Zotero.File.putContentsAsync = async () => {
    throw new Error("simulated write failure");
  };
  const failed = await service.writeConnectionLog("the report body");
  assert.equal(failed.written, false);
  assert.match(failed.reason, /simulated write failure/);

  // Nothing to write is its own answer, not a failure of the file system.
  assert.equal((await service.writeConnectionLog("")).written, false);
});

test("a missing EasyScholar key is a dialog when a window is involved, and never a lost message", () => {
  const harness = createHarness();
  const { service, prompts, notices } = harness;
  /*
   * The user's report: the notice never appeared. A panel notification is quiet by design, so the
   * one message that tells them why journal data is missing now goes through Zotero's modal prompt.
   */
  service.reportJournalOutcome({ reason: "no-key" }, { window: harness.mainWindow });
  assert.equal(prompts.length, 1, "a dialog is what the user asked for");
  assert.match(prompts[0].text, /no EasyScholar key is saved/);

  // A scheduled run has no window: quiet, because a modal at three in the morning blocks Zotero.
  prompts.length = 0;
  service.reportJournalOutcome({ reason: "no-key" });
  assert.equal(prompts.length, 0);
  assert.ok(notices.some((notice) => /no EasyScholar key is saved/.test(notice.message || "")),
    "the scheduled run still records it");

  // Other reasons stay silent: they are the user's own choice or already reported elsewhere.
  prompts.length = 0;
  for (const reason of ["disabled", "unavailable", "", undefined]) {
    service.reportJournalOutcome({ reason }, { window: harness.mainWindow });
  }
  assert.equal(prompts.length, 0);

  // A dialog that cannot be shown must not lose the message.
  const broken = createHarness();
  broken.service.Services.prompt.alert = () => {
    throw new Error("no window to attach the dialog to");
  };
  assert.equal(broken.service.alertUser(broken.mainWindow, "the message"), true);
  assert.ok(broken.notices.some((notice) => notice.message === "the message"),
    "the quiet notice is the fallback for a dialog that fails");
});

test("the shareable report is built by allowlist and carries none of the private material", () => {
  const harness = createHarness();
  const { service } = harness;
  /*
   * The reviewer of this add-on reproduced the old behaviour: the fallback returned the raw report
   * under a sanitized label, and redaction let unstructured server text, paths with spaces and UNC
   * paths through. Nothing is copied now: the shareable report is assembled from named fields.
   */
  const raw = [
    "FeedRank for Zotero \u2014 SMTP/TLS runtime diagnostics",
    "Report build 6. No secret is read or shown, and no socket is opened by this report.",
    "",
    "[this attempt]",
    "  host = smtp.internal." + "example" + ".edu",
    "  port = 994",
    "  tlsMode = implicit",
    "  authMethod = login",
    "  authStage = accepted",
    "  failure = none",
    "  username = " + "someone" + "@" + "example" + ".edu",
    "  ehloCapabilities = MAIL | AUTH | CORP-INTERNAL | X-SERVER-NAME",
    "  authReplies = 220 mail.corp.internal ESMTP ready",
    "  savedTo = " + "C:" + "\\" + "Users" + "\\" + "someone\\My Documents\\logs\\feedrank.log",
    "  share = \\\\fileserver\\private\\share",
    "  serverCert = CN=*.internal." + "example" + ".edu,O=Example University",
    "",
    "[evaluated checks]",
    "  sslVersionUsed = 772",
    "  protocolVersion = 4",
    "  cipherName = TLS_AES_128_GCM_SHA256",
    "  securityState = 2",
    "  failedCertChain = 0",
    "  succeededCertChain = 3",
    "  encrypted = true",
    "  protocolConfirmed = true",
    "  handshakeCompleted = true",
    "  plaintextFallbackUsed = false",
    "  securityInfoPresent = true",
    "  failedVerification = false",
    "  errorCodeString =   (empty)",
    "  totalElapsedMs = 782",
    "  timings = greeting 407ms, ehlo 62ms, authenticate 251ms, quit 62ms",
  ].join("\n");
  const safe = service.sanitizeDiagnosticsReport(raw);
  // Nothing private survives, not even as a fragment.
  for (const forbidden of [
    "smtp.internal." + "example" + ".edu", "someone" + "@" + "example" + ".edu", "example" + ".edu", "CORP-INTERNAL",
    "X-SERVER-NAME", "mail.corp.internal", "C:\\Users", "My Documents", "feedrank.log",
    "\\\\fileserver", "private\\share", "Example University", "internal.example",
  ]) {
    assert.equal(safe.includes(forbidden), false, "the shareable report must not contain " + forbidden);
  }
  // And the technical facts a maintainer needs are all still there.
  for (const expected of [
    "tlsMode = implicit", "authMethod = login", "authStage = accepted",
    "cipherName = TLS_AES_128_GCM_SHA256", "protocolVersion = 4", "sslVersionUsed = 772",
    "securityState = 2", "encrypted = true", "totalElapsedMs = 782", "greeting 407ms",
  ]) {
    assert.ok(safe.includes(expected), "the shareable report must keep " + expected);
  }
  // An empty or garbage input yields the header and nothing else, never the input.
  const garbage = service.sanitizeDiagnosticsReport("host = secret." + "example" + "\nusername = " + "me" + "@" + "example" + ".com");
  assert.equal(garbage.includes("secret." + "example"), false);
  assert.equal(garbage.includes("me" + "@" + "example" + ".com"), false);
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      process.stdout.write("ok   " + name + "\n");
    } catch (error) {
      failures += 1;
      process.stdout.write("FAIL " + name + "\n");
      process.stdout.write("     " + String(error?.stack || error).split("\n").join("\n     ") + "\n");
    }
  }
  process.stdout.write("\n" + (tests.length - failures) + "/" + tests.length + " main tests passed\n");
  if (failures) process.exitCode = 1;
})();
