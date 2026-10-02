"use strict";

/*
 * Tests for FeedRank's text and language layer (chrome/content/strings.js).
 *
 * Asked for as two things in one message: "Do a final check of all display/notice/popup
 * texts. Make all text concise and precise" and "Add a chinese version too. switch based on
 * system language." These tests hold the two halves together: the dictionary must be
 * complete in both languages, and the settings panes must not contain a control that would
 * stay English in the middle of a Chinese pane.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Strings = require("../chrome/content/strings.js");

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

const ROOT = path.join(__dirname, "..");
const PANES = ["chrome/content/preferences.xhtml", "chrome/content/settings.xhtml"];

test("both languages define exactly the same messages", () => {
  const en = Object.keys(Strings.STRINGS["en-US"]).sort();
  const zh = Object.keys(Strings.STRINGS["zh-CN"]).sort();
  assert.deepEqual(zh, en, "a key present in one language and not the other shows a raw key");
  assert.ok(en.length >= 100, "expected the full message set, found " + en.length);
  for (const [locale, table] of Object.entries(Strings.STRINGS)) {
    for (const [key, value] of Object.entries(table)) {
      assert.equal(typeof value, "string", locale + " " + key + " must be a string");
      assert.ok(value.trim(), locale + " " + key + " must not be empty");
      // The placeholders must match across languages, or a translated line loses data.
      const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      assert.deepEqual(
        placeholders(value),
        placeholders(Strings.STRINGS["en-US"][key] || value),
        locale + " " + key + " must use the same placeholders as English",
      );
    }
  }
});

test("the language follows the system locale, with English as the fallback", () => {
  assert.equal(Strings.normalizeLocale("zh-CN"), "zh-CN");
  assert.equal(Strings.normalizeLocale("zh-Hans-CN"), "zh-CN");
  assert.equal(Strings.normalizeLocale("ZH"), "zh-CN");
  assert.equal(Strings.normalizeLocale("en-GB"), "en-US");
  assert.equal(Strings.normalizeLocale("de"), "en-US");
  assert.equal(Strings.normalizeLocale(""), "en-US");
  assert.equal(Strings.normalizeLocale(null), "en-US");

  // Zotero's own UI locale is what a reader has already chosen for the application.
  assert.equal(Strings.detectLocale({ Zotero: { locale: "zh-CN" } }), "zh-CN");
  assert.equal(Strings.detectLocale({ Zotero: { locale: "en-US" } }), "en-US");
  assert.equal(Strings.detectLocale({ Zotero: { locale: "" }, navigator: { language: "zh-CN" } }), "zh-CN");
  assert.equal(Strings.detectLocale({}), "en-US");
  assert.equal(Strings.detectLocale(), "en-US");
});

test("a message renders in the active language, with {placeholders} filled", () => {
  const en = Strings.create({ locale: "en-US" });
  const zh = Strings.create({ locale: "zh-CN" });
  assert.equal(en.locale, "en-US");
  assert.equal(zh.locale, "zh-CN");
  assert.equal(en.t("menu.refresh"), "Refresh and score");
  assert.equal(zh.t("menu.refresh"), "刷新并评分");
  assert.equal(
    en.t("email.sent", { to: "reader@example.test" }),
    "Email: SENT to reader@example.test.",
  );
  assert.match(zh.t("email.sent", { to: "reader@example.test" }), /reader@example\.test/);
  // An unknown key is visible rather than empty, and a missing language falls back.
  assert.equal(en.t("no.such.key"), "no.such.key");
  assert.equal(Strings.create({ locale: "fr" }).locale, "en-US");
  // A placeholder that was not supplied is left alone rather than becoming "undefined".
  assert.equal(en.t("email.sent", {}), "Email: SENT to {to}.");
});

test("every control in both settings panes has a Chinese label or hint", () => {
  const zh = Strings.PANE_TEXT["zh-CN"];
  for (const rel of PANES) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const ids = new Set();
    for (const match of source.matchAll(/<(?:html:)?(?:input|select|textarea|button)[^>]*\bid="([^"]+)"/g)) {
      ids.add(match[1]);
    }
    assert.ok(ids.size > 20, rel + " should have many controls, found " + ids.size);
    for (const id of ids) {
      assert.ok(zh[id], rel + " control #" + id + " would stay English in a Chinese pane");
      assert.ok(
        zh[id].label || zh[id].hint,
        rel + " control #" + id + " has neither a label nor a hint",
      );
    }
  }
  // And the reverse: an entry that names no control is dead weight that hides a typo.
  const known = new Set();
  for (const rel of PANES) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const match of source.matchAll(/id="([^"]+)"/g)) known.add(match[1]);
  }
  for (const id of Object.keys(zh)) {
    assert.ok(known.has(id), "PANE_TEXT names a control that no pane has: " + id);
  }
});

test("English pane text is the markup, so there is only one copy of it", () => {
  // Nothing to translate into English means nothing to drift: the XHTML is the English
  // source and `applyPane` is a no-op for en-US.
  assert.equal(Strings.PANE_TEXT["en-US"], undefined);
  const strings = Strings.create({ locale: "en-US" });
  assert.equal(strings.applyPane(null), false);
  const zh = Strings.create({ locale: "zh-CN" });
  // A pane that is a version behind must not throw: unknown ids are skipped.
  const fake = {
    querySelector: () => null,
  };
  assert.equal(zh.applyPane(fake), false);
});

test("the shipped package carries no personal data", () => {
  // Asked for directly: "发布的版本不应保存我的个人信息，需要从本地获取之前保存的记录". The
  // release used to ship the author's own research profile as DEFAULT_PROFILE, which silently
  // became the question every new installation scored against. A reader's profile belongs in
  // Zotero's preferences, where it is loaded from and never overwritten by an upgrade.
  const shipped = [
    "bootstrap.js", "manifest.json", "chrome.manifest",
    "chrome/content/core.js", "chrome/content/main.js", "chrome/content/email.js",
    "chrome/content/email-service.js", "chrome/content/email-smtp.js",
    "chrome/content/journal.js", "chrome/content/journal-service.js",
    "chrome/content/diagnostics.js", "chrome/content/notify.js", "chrome/content/strings.js",
    "chrome/content/preferences.js", "chrome/content/settings.js",
    "chrome/content/rankedFeeds.js", "chrome/content/email-preview.js",
    "chrome/content/progress.js", "chrome/content/preferences.xhtml",
    "chrome/content/settings.xhtml",
    "locale/en-US/feed-ranker.ftl",
    "locale/zh-CN/feed-ranker.ftl",
  ];
  /*
   * The patterns are deliberately GENERIC. A privacy check that lists the exact identifiers it
   * forbids publishes them: an earlier revision of this test carried a local Zotero profile name
   * and a user-name prefix, which is precisely the material it exists to keep out.
   */
  const forbidden = [
    { pattern: /[\w.+-]+@(?:[\w-]+\.)+(?:com|cn|net|org|edu)\b/, what: "an email address" },
    { pattern: /[A-Za-z]:[\\/]{1,2}(?:Users|Documents and Settings)[\\/]/i, what: "an absolute user path" },
    { pattern: /\b\d{2}[a-z0-9]{5}\.default\b/i, what: "a local Zotero profile directory" },
    { pattern: /CV-?QKD|PPLN|squeezed and entangled/i, what: "a personal research profile" },
  ];
  // Tests, documentation and tools are published too: an identifier in a fixture is as public as
  // one in the runtime. The scan walks the whole tree rather than a hand-kept list, which is how
  // context in test files escaped it before.
  const skipDirectories = new Set([".git", "node_modules", "dist", "private"]);
  const walk = (dir) => {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirectories.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { found.push(...walk(full)); continue; }
      // The file that defines the patterns contains them as text, so it cannot be scanned by them.
      if (full.endsWith("strings.test.js")) continue;
      if (/\.(js|mjs|xhtml|ftl|json|md|ps1|txt)$/i.test(entry.name)) found.push(full);
    }
    return found;
  };
  for (const full of walk(ROOT)) {
    const rel = path.relative(ROOT, full).replace(/\\/g, "/");
    const source = fs.readFileSync(full, "utf8");
    for (const { pattern, what } of forbidden) {
      assert.doesNotMatch(source, pattern, rel + " must not ship " + what);
    }
  }
  // And the neutral default says what it is for.
  const Core = require("../chrome/content/core.js");
  assert.match(Core.DEFAULT_PROFILE, /Describe your research interests/i);
  assert.ok(Core.DEFAULT_PROFILE.length < 500, "the default profile is a prompt, not a profile");
});

test("every visible string in both panes has a Chinese counterpart", () => {
  // The earlier check only walked controls that have an id, and that is exactly why headings,
  // descriptions, subheads and the action-row captions stayed English: the user's report was
  // "设置菜单里面还有一部分没有对应中文". This walks the TEXT instead of the controls.
  const zhLabels = Strings.PANE_TEXT["zh-CN"];
  const zhStatic = Strings.PANE_STATIC["zh-CN"];
  const missing = [];

  for (const rel of PANES) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const line of source.split("\n")) {
      // Headings, descriptions, subheads, action-row captions and value lines must carry a
      // data-i18n key, and that key must have a Chinese entry.
      for (const match of line.matchAll(
        /<(?:html:)?(?:h2|description|span|div)([^>]*class="[^"]*(?:feed-ranker-subhead|feed-ranker-action-label|feed-ranker-group-head|feed-ranker-value|value)[^"]*"[^>]*)>([^<]*)</g,
      )) {
        const visible = String(match[2] || "").replace(/\s+/g, " ").trim();
        if (!visible) continue;
        const key = (match[1].match(/data-i18n="([^"]+)"/) || [])[1];
        if (!key) {
          missing.push(rel + " has visible text with no data-i18n key: " + visible.slice(0, 60));
        } else if (!zhStatic[key]) {
          missing.push(rel + " key " + key + " has no Chinese entry: " + visible.slice(0, 60));
        }
      }
      // Labels with a `for=` are matched to their control's dictionary entry.
      for (const match of line.matchAll(/<html:label[^>]*for="([^"]+)"[^>]*>([^<]*)<\/html:label>/g)) {
        const visible = String(match[2] || "").replace(/\s+/g, " ").trim();
        if (!visible) continue;
        if (!zhLabels[match[1]]?.label) {
          missing.push(rel + " label for #" + match[1] + " has no Chinese entry: " + visible.slice(0, 60));
        }
      }
    }
  }
  assert.deepEqual(missing, [], missing.join("; "));

  // And the reverse: no Chinese entry is dead weight.
  const known = new Set();
  for (const rel of PANES) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const match of source.matchAll(/data-i18n="([^"]+)"/g)) known.add(match[1]);
  }
  for (const key of Object.keys(zhStatic)) {
    assert.ok(known.has(key), "PANE_STATIC names a key no pane uses: " + key);
  }
});

test("the build names the artifact FeedRank plus the version", () => {
  // Asked for: "FeedRank 未来的文件名都用这个加版本号". The version is read from manifest.json so
  // the name and the package cannot disagree, and the rule is asserted here so a future edit
  // to the build script cannot quietly go back to a fixed name.
  const build = fs.readFileSync(path.join(ROOT, "tools", "build.ps1"), "utf8");
  assert.match(build, /dist\\FeedRank-' \+ \$version \+ '\.xpi/,
    "the artifact must be named FeedRank-<version>.xpi");
  assert.match(build, /manifest\.json[\s\S]{0,200}ConvertFrom-Json/,
    "the version must come from manifest.json rather than a second copy");
  // No shipped file may still name the old artifact: a reader following the docs would hunt
  // for a file the build no longer produces.
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;
  assert.match(version, /^\d+\.\d+\.\d+$/, "the manifest version must be the one in the file name");
  /*
   * The INSTALL step must name the build this checkout produces.
   *
   * This used to forbid an older file name anywhere in the docs, which fights the other rule:
   * "keep all history versions". History sections legitimately write down the file a given
   * release shipped, so only the installation instruction is checked, and it is checked
   * against manifest.json rather than against a literal that goes stale every release.
   */
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.ok(readme.includes("dist/FeedRank-" + version + ".xpi"),
    "README's install step must name dist/FeedRank-" + version + ".xpi");
  assert.match(readme, /FeedRank-<version>\.xpi/,
    "README must state the naming rule itself, not only one example");

  // Dist may hold any number of builds -- they are kept on purpose -- but each one has to
  // follow the naming rule, so a stray file cannot be mistaken for a release.
  const dist = path.join(ROOT, "dist");
  if (fs.existsSync(dist)) {
    for (const entry of fs.readdirSync(dist)) {
      if (!entry.endsWith(".xpi")) continue;
      assert.match(entry, /^FeedRank-\d+\.\d+\.\d+\.xpi$/,
        "dist/" + entry + " does not follow FeedRank-<version>.xpi");
    }
  }
});

test("every button is wired the way its element kind dispatches", () => {
  /*
   * A XUL <button label="..."/> fires "command"; an <html:button> fires "click". Wiring the wrong
   * one produces a button that renders correctly, looks clickable, and does nothing at all -- which
   * is exactly what the three settings-file buttons did in the Zotero preferences pane. A binding on
   * an id the markup does not contain is worse: it throws, and every binding after it in the file is
   * silently never installed.
   */
  const panes = [
    { name: "preferences", script: "chrome/content/preferences.js", markup: "chrome/content/preferences.xhtml" },
    { name: "settings", script: "chrome/content/settings.js", markup: "chrome/content/settings.xhtml" },
  ];
  const problems = [];
  for (const pane of panes) {
    const script = fs.readFileSync(pane.script, "utf8");
    const markup = fs.readFileSync(pane.markup, "utf8");
    const ids = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
    const bindings = [
      ...script.matchAll(/(?:field\("([^"]+)"\)|querySelector\("#([^"]+)"\))\??\.addEventListener\("([a-z]+)"/g),
    ];
    assert.ok(bindings.length > 5, pane.name + " must bind more than a handful of controls");
    for (const binding of bindings) {
      const id = binding[1] || binding[2];
      const event = binding[3];
      if (!ids.has(id)) {
        problems.push(pane.name + ": binds #" + id + " but the markup has no such element");
        continue;
      }
      const htmlButton = new RegExp('<html:button[^>]*id="' + id + '"').test(markup);
      const xulButton = new RegExp('<button[^>]*id="' + id + '"').test(markup);
      if (htmlButton && event !== "click") {
        problems.push(pane.name + ": #" + id + " is an <html:button> but listens for \"" + event + "\"");
      }
      if (xulButton && event !== "command") {
        problems.push(pane.name + ": #" + id + " is a XUL <button> but listens for \"" + event + "\"");
      }
    }
  }
  assert.deepEqual(problems, []);

  // The three settings-file buttons, in both panes, in their own convention.
  const preferences = fs.readFileSync("chrome/content/preferences.xhtml", "utf8");
  for (const id of ["feed-ranker-settings-export", "feed-ranker-settings-import", "feed-ranker-settings-reset"]) {
    assert.match(preferences, new RegExp('<button id="' + id + '" label="[^"]+"/>'),
      id + " must be a XUL button with a label, so the pane's command listener fires and the Chinese label applies");
  }
  const settings = fs.readFileSync("chrome/content/settings.xhtml", "utf8");
  for (const id of ["settings-export", "settings-import", "settings-reset"]) {
    assert.match(settings, new RegExp('<html:button id="' + id + '">'), id + " belongs to the standalone window's html:button convention");
  }
  // Chinese pane text arrives as a label attribute, so no pane button may be an html:button there.
  assert.equal(/<html:button/.test(preferences), false, "the preferences pane uses XUL buttons only");
});

test("the settings-file buttons open the dialog the way this Zotero can, and report where the user looks", () => {
  /*
   * Two failures that both looked like a dead button:
   *   1. nsIFilePicker.show() no longer exists in this Gecko. Zotero's own filePicker.mjs opens the
   *      dialog with open(callback); calling show() threw, and the error went to a status line in a
   *      different group, so the user saw nothing at all.
   *   2. The status line for these three buttons lived in the email group, far from the buttons.
   */
  const main = fs.readFileSync("chrome/content/main.js", "utf8");
  assert.match(main, /showFilePicker\(picker\)\s*{/, "the picker must be opened through one helper");
  assert.match(main, /picker\.open\(\(result\) => resolve\(result\)\)/, "the helper must use open()");
  assert.match(main, /typeof picker\?\.show === "function"/, "show() stays only as a fallback");
  assert.equal(/await picker\.show\(\)/.test(main), false, "no call site may still await picker.show()");
  assert.equal((main.match(/await this\.showFilePicker\(picker\);/g) || []).length, 2,
    "both the save and the load path must wait through the helper");
  // A picker with no browsing context is a dialog that never appears: refuse loudly instead.
  assert.match(main, /if \(!context\) throw new Error\("No window is available to show the file dialog"\)/);

  const panes = [
    { script: "chrome/content/preferences.js", markup: "chrome/content/preferences.xhtml", id: "feed-ranker-settings-file-status" },
    { script: "chrome/content/settings.js", markup: "chrome/content/settings.xhtml", id: "settings-file-status" },
  ];
  for (const pane of panes) {
    const script = fs.readFileSync(pane.script, "utf8");
    const markup = fs.readFileSync(pane.markup, "utf8");
    assert.match(markup, new RegExp('id="' + pane.id + '"'), pane.markup + " needs its own status line");
    assert.ok(script.includes(pane.id), pane.script + " must write to " + pane.id);
    // The three operations report there; the email group keeps its own line.
    assert.ok(script.includes("settingsFileStatus") || script.includes("setSettingsFileStatus"),
      pane.script + " must route the settings-file result to its own line");
    // A reset that left something behind must say so where the user is looking.
    // The log is written by the service, through the API this build has.
    assert.equal(/file-output-stream/.test(script), false,
      pane.script + " must not build its own file output stream");
    assert.match(script, /writeConnectionLog/, pane.script + " must delegate the write");
    assert.match(script, /settings\.importedApplied/,
      pane.script + " must name what an import applied");
    assert.match(script, /settings\.resetPartial/,
      pane.script + " must name what a partial reset left behind");
    assert.ok(/setEmailStatus\(root,|(?<!File)emailStatus\(/.test(script),
      pane.script + " still needs the email status line for the email group");
  }
});

test("each pane script only calls functions it defines, or that the DOM provides", () => {
  /*
   * settings.js called populate() -- a function that file never defines. Both the import and the
   * reset handler threw a ReferenceError at that line, so a settings import reached the preferences
   * and the window never changed: from the outside, the button did nothing at all.
   */
  const keywords = new Set([
    "catch", "if", "for", "while", "switch", "return", "typeof", "new", "await", "void", "do",
    "else", "try", "finally", "function", "in", "of", "delete", "instanceof", "yield", "throw",
    "async",
  ]);
  const provided = new Set([
    "parseInt", "parseFloat", "isNaN", "String", "Number", "Boolean", "Array", "Object", "JSON",
    "Math", "Date", "Promise", "Set", "Map", "Error", "RegExp", "Uint8Array", "TextDecoder",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval", "fetch", "structuredClone",
    "decodeURIComponent", "encodeURIComponent", "queueMicrotask", "requestAnimationFrame",
  ]);
  const problems = [];
  for (const scriptPath of ["chrome/content/preferences.js", "chrome/content/settings.js"]) {
    const raw = fs.readFileSync(scriptPath, "utf8");
    // Comments are prose, not code: an example call in a comment is not a call.
    const script = raw
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ")
      // A word inside a string is text, not a call: " journal(s) cached" is not a function.
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    const defined = new Set();
    for (const match of script.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) defined.add(match[1]);
    // Bindings of every shape this codebase uses: object methods (which need a body brace, or a
    // call would look like a definition), `name: value`, and arrows.
    for (const match of script.matchAll(/(?:^|[,\n])\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) defined.add(match[1]);
    for (const match of script.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) defined.add(match[1]);
    for (const match of script.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|function\b)/g)) defined.add(match[1]);
    for (const match of script.matchAll(/\(([^)]*)\)\s*=>/g)) {
      for (const part of match[1].split(",")) {
        const name = part.trim().replace(/=.*$/, "").trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name);
      }
    }
    for (const match of script.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) defined.add(match[1]);
    for (const call of script.matchAll(/(?<![.\w$])([a-z_$][\w$]*)\s*\(/g)) {
      const name = call[1];
      // `this.x()` and `Service.y()` are method calls on objects, which this check cannot follow.
      if (keywords.has(name) || provided.has(name) || defined.has(name)) continue;
      problems.push(scriptPath + " calls " + name + "() and never defines it");
    }
  }
  assert.deepEqual([...new Set(problems)], []);
});

test("the connection log is shown in a folded box, and there is no button to open a file", () => {
  /*
   * Asked for directly, after "Open log file" failed on a real machine for the third time: remove
   * the button, show the log in the pane instead. There is no file to find, no path to remember, no
   * system handler to invoke -- and nothing that can fail without saying so.
   */
  const panes = [
    { markup: "chrome/content/preferences.xhtml", script: "chrome/content/preferences.js", box: "feed-ranker-email-log", removed: "feed-ranker-email-open-diagnostics", filler: "showConnectionLog" },
    { markup: "chrome/content/settings.xhtml", script: "chrome/content/settings.js", box: "email-log", removed: "email-open-diagnostics", filler: "showLog" },
  ];
  for (const pane of panes) {
    const markup = fs.readFileSync(pane.markup, "utf8");
    const script = fs.readFileSync(pane.script, "utf8");
    assert.equal(markup.includes(pane.removed), false, pane.markup + " must not offer the button any more");
    assert.match(markup, new RegExp('id="' + pane.box + '"'), pane.markup + " must show the log");
    assert.match(markup, new RegExp('id="' + pane.box + '-path"'), pane.markup + " must name the file on disk");
    assert.ok(script.includes(pane.filler), pane.script + " must fill the box");
    assert.equal(script.includes(pane.removed), false, pane.script + " must not bind the removed button");
    // A log that was never written is a line of text in the box, never a dialog.
    const at = script.indexOf("No connection log has been written yet");
    assert.ok(at > 0, pane.script + " must say what is missing");
    const around = script.slice(Math.max(0, at - 200), at + 200);
    assert.equal(/alertUser/.test(around), false, pane.script + " must not open a dialog for it");
  }
  // The fold is the same mechanism the settings-file group already uses.
  const preferences = fs.readFileSync("chrome/content/preferences.xhtml", "utf8");
  assert.match(preferences, /<html:details class="feed-ranker-fold">/);
});

test("the update manifest matches the add-on it updates", () => {
  /*
   * Zotero updates an add-on by reading the URL in applications.zotero.update_url and comparing
   * versions. A manifest that names the wrong id, an older version, or a link that does not match
   * the release asset silently disables updates -- which is exactly the kind of failure nobody
   * notices until a release is out of date everywhere.
   */
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const updateURL = manifest.applications?.zotero?.update_url;
  assert.match(updateURL || "", /^https:\/\//, "an update URL must be https");
  assert.doesNotMatch(updateURL || "", /example\.invalid|localhost|TODO/i, "not a placeholder");

  const updates = JSON.parse(fs.readFileSync(path.join(ROOT, "updates.json"), "utf8"));
  const entry = updates.addons?.[manifest.applications.zotero.id];
  assert.ok(entry, "the update manifest must name this add-on id");
  assert.ok(Array.isArray(entry.updates) && entry.updates.length, "it must list at least one version");
  // Newest first, and never older than what is installed here.
  const newest = entry.updates[0];
  const compare = (a, b) => {
    const left = String(a).split(".").map(Number);
    const right = String(b).split(".").map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const diff = (left[i] || 0) - (right[i] || 0);
      if (diff) return diff;
    }
    return 0;
  };
  assert.ok(compare(newest.version, manifest.version) >= 0,
    "the newest update (" + newest.version + ") must not be older than the build (" + manifest.version + ")");
  // The asset name is deterministic, so a mismatch here means the release would 404.
  assert.match(newest.update_link, new RegExp("/v" + newest.version.replace(/\./g, "\\.") + "/FeedRank-" + newest.version.replace(/\./g, "\\.") + "\\.xpi$"),
    "the update link must point at the release asset for that version");
  assert.equal(newest.applications?.zotero?.strict_min_version, manifest.applications.zotero.strict_min_version);
});

test("the sanitized-log buttons ask the right service and never fall back to the raw report", () => {
  /*
   * The bug the reviewer found: preferences.js asked the EMAIL service, which does not define
   * sanitizeDiagnosticsReport, and `|| report` then displayed the raw log as sanitized.
   */
  for (const scriptPath of ["chrome/content/preferences.js", "chrome/content/settings.js"]) {
    const script = fs.readFileSync(scriptPath, "utf8");
    const at = script.indexOf("sanitizeDiagnosticsReport");
    assert.ok(at > 0, scriptPath + " must build a shareable report");
    // The handler, not a fixed window: the service is resolved several lines above the call.
    const handlerStart = Math.max(0, script.lastIndexOf("addEventListener", at));
    const around = script.slice(handlerStart, at + 600);
    assert.equal(/\|\|\s*report/.test(around), false,
      scriptPath + " must not fall back to the raw report");
    assert.match(around, /getService\(\)|mainService/,
      scriptPath + " must take the sanitizer from the service that defines it");
    assert.doesNotMatch(around, /getEmailService\(\)\?\.sanitizeDiagnosticsReport/,
      scriptPath + " must not ask the email service for the sanitizer");
  }
  // The raw copy is labelled as private, and the shareable one as allowlisted.
  const prefs = fs.readFileSync("chrome/content/preferences.js", "utf8");
  assert.match(prefs, /Copied a shareable report/);
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
  process.stdout.write("\n" + (tests.length - failures) + "/" + tests.length + " strings tests passed\n");
  if (failures) process.exitCode = 1;
})();
