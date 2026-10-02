"use strict";

/*
 * Tests for FeedRank's passive notice channel (chrome/content/notify.js).
 *
 * The report behind these: "popup not working, previously you have warning
 * windows, use that." The passive Zotero panel has never appeared on the machine
 * this add-on is developed against, and the caller's fallback to a real window
 * only fires when this module ADMITS that nothing was shown. `Zotero.
 * ProgressWindow.show()` answers exactly that question, so these tests pin the
 * contract: "true" means the panel was opened, "false" means the caller must use
 * its own channel, and a notice never throws into the operation that produced it.
 */

const assert = require("node:assert/strict");
const Notify = require("../chrome/content/notify.js");

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function fakeZotero({ opens = true } = {}) {
  const panels = [];
  function ProgressWindow(options = {}) {
    const panel = {
      options,
      headline: null,
      descriptions: [],
      closeTimer: null,
      closed: false,
      changeHeadline(text) {
        this.headline = text;
      },
      addDescription(text) {
        this.descriptions.push(text);
      },
      show() {
        panels.push(this);
        return opens;
      },
      startCloseTimer(ms, requireMouseOver) {
        this.closeTimer = { ms, requireMouseOver };
      },
      close() {
        this.closed = true;
      },
    };
    return panel;
  }
  return { Zotero: { ProgressWindow }, panels };
}

test("a notice is shown through Zotero's own panel and closes itself", () => {
  const harness = fakeZotero();
  const notify = Notify.create({ Zotero: harness.Zotero });
  assert.equal(notify.info("Scoring finished.\nTwo articles were scored."), true);
  assert.equal(harness.panels.length, 1);
  assert.equal(harness.panels[0].headline, "Scoring finished.");
  assert.deepEqual(harness.panels[0].descriptions, ["Two articles were scored."]);
  // requireMouseOver: false -- the panel must go away without being touched.
  assert.deepEqual(harness.panels[0].closeTimer, { ms: Notify.DEFAULT_DELAY_MS, requireMouseOver: false });
});

test("a panel that refuses to open is reported as NOT shown", () => {
  const harness = fakeZotero({ opens: false });
  const notify = Notify.create({ Zotero: harness.Zotero });
  // This is the whole contract: `notify()` in main.js falls back to a modal
  // warning window exactly when this returns false. Reporting success for a panel
  // that never opened is what made the schedule silent.
  assert.equal(notify.info("nothing to see"), false);
  assert.equal(harness.panels[0].closed, true, "the refused panel is cleaned up");
});

test("a sticky notice handle is inactive when its panel cannot open", () => {
  const refusing = Notify.create({ Zotero: fakeZotero({ opens: false }).Zotero });
  const handle = refusing.begin("FeedRank weekly run: starting");
  assert.equal(handle.active, false);
  assert.equal(handle.update("stage two"), false);

  const working = fakeZotero();
  const sticky = Notify.create({ Zotero: working.Zotero }).begin("FeedRank weekly run: starting");
  assert.equal(sticky.active, true);
  assert.equal(sticky.update("FeedRank weekly run: refreshing feeds"), true);
  // An update opens a fresh panel: Zotero's panel cannot clear its own lines.
  assert.equal(working.panels.length, 2);
  assert.equal(working.panels[0].closed, true);
  assert.equal(sticky.close("FeedRank weekly run finished.", { delay: 4000 }), true);
  assert.equal(sticky.active, false);
  assert.equal(working.panels[2].closeTimer.ms, 4000);
});

test("no Zotero, and a panel that throws, are both reported rather than raised", () => {
  assert.equal(Notify.create({}).info("no host"), false);
  assert.equal(Notify.create({ Zotero: {} }).info("no panel class"), false);
  const throwing = {
    Zotero: {
      ProgressWindow: function ProgressWindow() {
        return {
          changeHeadline() {},
          addDescription() {},
          show() {
            throw new Error("simulated panel failure");
          },
          close() {},
        };
      },
    },
  };
  assert.equal(Notify.create(throwing).error("boom"), false);
});

test("a message is split into a bounded headline and detail lines", () => {
  const split = Notify.splitMessage(["one", "two", "three"].join("\n"));
  assert.equal(split.headline, "one");
  assert.deepEqual(split.lines, ["two", "three"]);
  assert.deepEqual(Notify.splitMessage(""), { headline: "", lines: [] });
  assert.equal(Notify.splitMessage("x".repeat(400)).headline.length, Notify.MAX_HEADLINE);
  assert.equal(Notify.splitMessage(new Array(20).fill("line").join("\n")).lines.length, Notify.MAX_LINES);
  // Control characters cannot reach a panel that renders them as garbage.
  assert.equal(Notify.text("a\u0000b\tc"), "a b c");
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
  process.stdout.write("\n" + (tests.length - failures) + "/" + tests.length + " notify tests passed\n");
  if (failures) process.exitCode = 1;
})();
