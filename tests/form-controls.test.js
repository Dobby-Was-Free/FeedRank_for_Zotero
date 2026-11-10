"use strict";

// Offline DOM/service doubles only. No browser/app automation, real preferences,
// credential storage, RSS request, model call or SMTP action is used here.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const FormControls = require("../chrome/content/form-controls.js");
const Strings = require("../chrome/content/strings.js");
const Core = require("../chrome/content/core.js");
const tests = [];
const test = (name, run) => tests.push({ name, run });
const read = (name) => fs.readFileSync(path.join(__dirname, "../chrome/content", name), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function mockDOM(markup = "") {
  const fields = new Map();
  const document = { activeElement: null };
  function add(id, localName = "menulist") {
    let value = "", checked = false;
    const attributes = new Map([["id", id]]);
    const listeners = new Map();
    const field = {
      id, localName, tagName: localName, ownerDocument: document,
      style: {}, dataset: {}, children: [], textContent: "", disabled: false,
      open: false, writes: 0, checkWrites: 0,
      addEventListener(type, handler) {
        listeners.set(type, [...(listeners.get(type) || []), handler]);
      },
      listenerCount(type) { return (listeners.get(type) || []).length; },
      emit(type) {
        const results = (listeners.get(type) || []).map((handler) => handler({ type, target: field, currentTarget: field }));
        return Promise.all(results);
      },
      contains(node) { return node === field || field.children.includes(node); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      hasAttribute(name) { return attributes.has(name); },
      setAttribute(name, next) { attributes.set(name, String(next)); },
      remove() { fields.delete(id); },
      get value() { return value; },
      set value(next) {
        value = String(next ?? ""); field.writes++;
        // Model the troublesome behavior: even an identical value assignment
        // can dismiss a native popup. Programmatic selection is not command.
        if (field.localName === "menulist") {
          field.open = false;
          void field.emit("select");
          void field.emit("ValueChange");
        }
      },
      get checked() { return checked; },
      set checked(next) { checked = next === true; field.checkWrites++; },
    };
    fields.set(id, field);
    return field;
  }
  for (const match of markup.matchAll(/<([\w:-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    add(match[2], match[1].split(":").pop());
  }
  const querySelector = (selector) => selector.startsWith("#") ? fields.get(selector.slice(1)) || null : null;
  document.getElementById = (id) => fields.get(id) || null;
  document.querySelector = querySelector;
  document.querySelectorAll = () => [];
  const root = { ownerDocument: document, querySelector, querySelectorAll: () => [], dataset: {} };
  return { root, document, fields, add, field: (id) => fields.get(id) };
}

function emailStatus(overrides = {}) {
  return {
    config: { maximumPapers: 10, minimumRelevanceScore: 70, priorityCount: 5,
      readingListCount: 30, readingListEnabled: false, automaticSendingEnabled: false,
      tlsMode: "starttls", authMethod: "plain" },
    credentials: { configured: true, persistent: false, host: "smtp.example.test", port: 587,
      username: "mock-user", from: "sender@example.test", to: "reader@example.test",
      tlsMode: "starttls", authMethod: "plain" },
    snapshot: { text: "Mock digest" }, retryKey: "", sending: false,
    ...overrides,
  };
}

function paneHarness(surface = "preferences", { fallback = false } = {}) {
  const dom = mockDOM(read(surface + ".xhtml"));
  if (fallback) for (const field of dom.fields.values()) if (field.localName === "menulist") field.localName = "select";
  let config = { ...Core.DEFAULT_CONFIG, profile: "Unit-test research interests", runFrequency: "weekly" };
  let email = emailStatus();
  let journal = { config: { lookupEnabled: false, refreshBeforeScoring: false }, credentials: { configured: false } };
  const previews = [], saved = [];
  let deliveryListener = null;
  const mainService = {
    loadConfig: () => ({ ...config }),
    saveConfig: (next) => { config = { ...config, ...next }; saved.push(next); return { ...config }; },
    buildPromptPreview: (next) => { previews.push(next); return "Mock prompt " + next.explanationLanguage; },
    rebuildWeeklyDigest: async () => ({ available: false, reason: "Mock digest is unavailable" }),
    versionLabel: () => "FeedRank 0.3.2",
    nextRunSummary: () => "Mock schedule",
    applyPaneStrings() {},
    t: (key) => String(key),
    importSettingsFromFile: async () => ({ cancelled: true }),
    resetAllSettings: async () => ({ cancelled: true }),
  };
  const emailService = {
    getStatus: async () => email,
    loadConfig: () => email.config,
    saveConfig: (next) => { email = { ...email, config: { ...email.config, ...next } }; return email.config; },
    subscribeDelivery: (listener) => { deliveryListener = listener; return () => { deliveryListener = null; }; },
  };
  const journalService = {
    getStatus: async () => journal,
    loadConfig: () => journal.config,
    saveConfig: (next) => { journal = { ...journal, config: { ...journal.config, ...next } }; return journal.config; },
  };
  const events = new Map();
  const Zotero = { FeedRanker: mainService, FeedRankEmail: emailService, FeedRankJournal: journalService };
  const window = {
    Zotero, opener: { Zotero }, closed: false,
    arguments: [{ config: { ...config }, save: (next) => { saved.push(next); } }],
    addEventListener(type, callback) { events.set(type, [...(events.get(type) || []), callback]); },
    close() { this.closed = true; },
  };
  dom.root.ownerGlobal = window;
  const context = vm.createContext({ Zotero, window, document: dom.document, FeedRankFormControls: FormControls,
    Promise, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(read(surface + ".js"), context, { filename: surface + ".js" });
  const pane = surface === "preferences" ? Zotero.FeedRankerPreferencePane : null;
  return {
    ...dom, pane, window, mainService, emailService, journalService, previews, saved,
    config: (next) => { if (next) config = { ...config, ...next }; return config; },
    email: (next) => { if (next) email = next; return email; },
    delivery: () => deliveryListener?.(),
    async init() {
      if (pane) { pane.showConnectionLog = async () => {}; pane.init(dom.root); }
      else for (const callback of events.get("load") || []) callback();
      await flush();
    },
  };
}

test("both settings surfaces use native menus with unchanged values and accessible field labels", () => {
  const expected = {
    language: ["zh-CN", "en"], "run-frequency": ["daily", "weekly", "monthly"],
    "weekly-day": ["1", "2", "3", "4", "5", "6", "0"],
    "email-tls-mode": ["starttls", "implicit"], "email-auth-method": ["plain", "login", "xoauth2"],
  };
  for (const surface of ["preferences", "settings"]) {
    const source = read(surface + ".xhtml");
    assert.doesNotMatch(source, /<html:(?:select|option)\b/);
    for (const [suffix, values] of Object.entries(expected)) {
      const id = surface === "preferences" ? "feed-ranker-" + suffix : suffix;
      const menu = source.match(new RegExp('<menulist\\b([^>]*\\bid="' + id + '"[^>]*)>([\\s\\S]*?)</menulist>'));
      assert.ok(menu, surface + " " + id);
      assert.match(menu[1], /native="true"/);
      assert.match(menu[1], new RegExp('aria-labelledby="' + id + '-label"'));
      assert.match(source, new RegExp('<html:label[^>]*id="' + id + '-label"'));
      assert.deepEqual([...menu[2].matchAll(/<menuitem[^>]*\bvalue="([^"]+)"/g)].map((match) => match[1]), values);
      for (const item of menu[2].matchAll(/<menuitem\b[^>]*\bdata-i18n="([^"]+)"[^>]*\/>/g)) {
        assert.ok(Strings.PANE_STATIC["zh-CN"][item[1]], "native option has a Chinese label");
      }
    }
  }
  assert.ok(read("settings.xhtml").indexOf("form-controls.js") < read("settings.xhtml").indexOf("settings.js"));
});

test("Chinese native-option translation writes labels without replacing menu children or values", () => {
  const attributes = new Map([["data-i18n", "dropdown.frequency.weekly"], ["label", "Weekly"]]);
  const node = { localName: "menuitem", value: "weekly", children: [{ marker: true }],
    getAttribute: (name) => attributes.get(name), setAttribute: (name, value) => attributes.set(name, value),
    set textContent(_value) { throw new Error("native menu content must not be replaced"); } };
  const root = { querySelector: () => null, querySelectorAll: () => [node] };
  assert.equal(Strings.create({ locale: "zh-CN" }).applyPane(root), true);
  assert.equal(attributes.get("label"), "每周");
  assert.equal(node.value, "weekly");
  assert.equal(node.children.length, 1);
});

test("same-value writes never dismiss a native popup or redundantly assign a checkbox", () => {
  const dom = mockDOM(), menu = dom.add("mode"), box = dom.add("approved", "input");
  const form = FormControls.create(dom.root);
  form.bind(["mode", "approved"]);
  form.write("mode", "starttls");
  menu.open = true;
  const writes = menu.writes;
  assert.equal(form.write("mode", "starttls"), false);
  assert.equal(menu.writes, writes);
  assert.equal(menu.open, true);
  assert.equal(form.write("approved", false, { checked: true }), false);
  assert.equal(box.checkWrites, 0);
});

test("native programmatic select/ValueChange events do not count as user edits and bindings are idempotent", () => {
  const dom = mockDOM(), menu = dom.add("mode");
  const form = FormControls.create(dom.root);
  form.bind(["mode"]); form.bind(["mode"]);
  assert.equal(menu.listenerCount("command"), 1);
  assert.equal(menu.listenerCount("input"), 1);
  form.write("mode", "starttls");
  assert.notEqual(menu.__feedRankDirty, true);
  assert.equal(menu.listenerCount("select"), 0);
  assert.equal(menu.listenerCount("ValueChange"), 0);
  menu.value = "implicit";
  void menu.emit("command");
  assert.equal(menu.__feedRankDirty, true);
  assert.equal(form.write("mode", "starttls"), false);
  assert.equal(menu.value, "implicit");
});

test("first pointer, mouse, focus and keyboard interaction protect an open popup before a choice", () => {
  for (const event of ["pointerdown", "mousedown", "focusin", "keydown"]) {
    const dom = mockDOM(), menu = dom.add("mode"), form = FormControls.create(dom.root);
    form.bind(["mode"]); form.write("mode", "starttls");
    menu.open = true;
    void menu.emit(event);
    assert.equal(form.write("mode", "implicit"), false, event);
    assert.equal(menu.value, "starttls", event);
    assert.equal(menu.open, true, event);
  }
});

test("focused controls and focused native descendants are protected even without dirty events", () => {
  const dom = mockDOM(), menu = dom.add("mode"), child = {};
  const form = FormControls.create(dom.root);
  form.write("mode", "starttls");
  for (const active of [menu, child]) {
    menu.children = [child]; dom.document.activeElement = active;
    assert.equal(form.write("mode", "implicit"), false);
  }
  assert.equal(form.write("mode", "implicit", { force: true }), true);
});

test("checkbox drafts survive refresh and stale save acknowledgements do not clear newer edits", () => {
  const dom = mockDOM(), box = dom.add("approved", "input"), form = FormControls.create(dom.root);
  form.bind(["approved"]);
  const old = form.capture(["approved"]);
  box.checked = true; void box.emit("change");
  assert.equal(form.write("approved", false, { checked: true }), false);
  form.accept(["approved"], old);
  assert.equal(box.__feedRankDirty, true);
  form.accept(["approved"], form.capture(["approved"]));
  assert.equal(box.__feedRankDirty, false);
});

test("snapshot revisions reject late writes even when forced or the old dirty flag was cleared", () => {
  const dom = mockDOM(), menu = dom.add("mode"), form = FormControls.create(dom.root);
  form.bind(["mode"]); form.write("mode", "starttls");
  const snapshot = form.capture(["mode"]);
  menu.value = "implicit"; void menu.emit("command");
  form.clear(["mode"]);
  assert.equal(form.write("mode", "starttls", { force: true, snapshot }), false);
  assert.equal(menu.value, "implicit");
});

test("request tokens reject old responses, isolate groups and support explicit invalidation", () => {
  const form = FormControls.create(mockDOM().root);
  const old = form.begin("email"), journal = form.begin("journal"), latest = form.begin("email");
  assert.equal(form.isCurrent(old), false);
  assert.equal(form.isCurrent(latest), true);
  assert.equal(form.isCurrent(journal), true);
  form.invalidate("email");
  assert.equal(form.isCurrent(latest), false);
  assert.equal(form.isCurrent(journal), true);
  form.invalidate();
  assert.equal(form.isCurrent(journal), false);
});

test("missing fields are harmless and interaction state is isolated per form", () => {
  const a = mockDOM(), b = mockDOM();
  a.add("mode"); b.add("mode");
  const first = FormControls.create(a.root), second = FormControls.create(b.root);
  first.bind(["mode", "missing"]); second.bind(["mode"]);
  void a.field("mode").emit("command");
  assert.equal(first.write("mode", "implicit"), false);
  assert.equal(second.write("mode", "implicit"), true);
  assert.equal(first.write("missing", "ignored"), false);
});

test("preferences dirty wrappers bind actual prefixed email IDs and clear the same fields", () => {
  const h = paneHarness(), ids = ["tls-mode", "auth-method", "auto-enabled"];
  h.pane.markDirtyOnEdit(h.root, ids);
  for (const suffix of ids) {
    const field = h.field("feed-ranker-email-" + suffix);
    void field.emit("command");
    assert.equal(field.__feedRankDirty, true, suffix);
  }
  h.pane.clearDirty(h.root, ids);
  for (const suffix of ids) assert.equal(h.field("feed-ranker-email-" + suffix).__feedRankDirty, false);
});

test("preferences native commands update cadence visibility and prompt preview, with HTML fallback parity", async () => {
  for (const fallback of [false, true]) {
    const h = paneHarness("preferences", { fallback }); await h.init();
    const frequency = h.field("feed-ranker-run-frequency");
    frequency.value = "monthly";
    await frequency.emit(fallback ? "change" : "command");
    assert.equal(h.field("feed-ranker-weekly-day").style.display, "none");
    assert.equal(h.field("feed-ranker-monthly-day").style.display, "");
    frequency.value = "daily"; await frequency.emit(fallback ? "change" : "command");
    assert.equal(h.field("feed-ranker-weekly-day").style.display, "none");
    assert.equal(h.field("feed-ranker-monthly-day").style.display, "none");
    const previous = h.previews.length;
    h.field("feed-ranker-language").value = "en";
    await h.field("feed-ranker-language").emit(fallback ? "change" : "command");
    assert.ok(h.previews.length > previous);
    assert.equal(h.previews.at(-1).explanationLanguage, "en");
  }
});

test("reopening a preferences pane preserves unsaved main, SMTP and checkbox choices", async () => {
  const h = paneHarness(); await h.init();
  const language = h.field("feed-ranker-language"), tls = h.field("feed-ranker-email-tls-mode");
  const automatic = h.field("feed-ranker-email-auto-enabled");
  language.value = "en"; await language.emit("command");
  tls.value = "implicit"; await tls.emit("command");
  automatic.checked = true; await automatic.emit("change");
  h.pane.populate(h.root); await flush();
  assert.equal(language.value, "en");
  assert.equal(tls.value, "implicit");
  assert.equal(automatic.checked, true);
});

test("late email population cannot reset a popup first opened while status was pending", async () => {
  const h = paneHarness(); await h.init();
  const pending = deferred(); h.emailService.getStatus = () => pending.promise;
  const waiting = h.pane.populateEmail(h.root); await flush();
  const tls = h.field("feed-ranker-email-tls-mode");
  tls.open = true; await tls.emit("pointerdown");
  const writes = tls.writes;
  pending.resolve(emailStatus({ credentials: { ...emailStatus().credentials, tlsMode: "implicit" } }));
  await waiting;
  assert.equal(tls.value, "starttls");
  assert.equal(tls.writes, writes);
  assert.equal(tls.open, true);
});

test("unchanged final SMTP modes are not rewritten through transient option defaults", async () => {
  for (const surface of ["preferences", "settings"]) {
    const h = paneHarness(surface);
    h.email(emailStatus({ credentials: { ...emailStatus().credentials, tlsMode: "implicit", authMethod: "login" } }));
    await h.init();
    const id = surface === "preferences" ? "feed-ranker-email-tls-mode" : "email-tls-mode";
    const tls = h.field(id);
    assert.equal(tls.value, "implicit", surface);
    const writes = tls.writes;
    tls.open = true;
    if (h.pane) await h.pane.populateEmail(h.root);
    else { h.delivery(); await flush(); }
    assert.equal(tls.writes, writes, surface + " must write the final mode at most once, not default then credential mode");
    assert.equal(tls.open, true, surface);
  }
});

test("overlapping preferences email responses keep the latest form values and preview", async () => {
  const h = paneHarness(); await h.init();
  const old = deferred(), latest = deferred(); let calls = 0;
  h.emailService.getStatus = () => ++calls === 1 ? old.promise : latest.promise;
  const a = h.pane.populateEmail(h.root); await flush();
  const b = h.pane.populateEmail(h.root); await flush();
  latest.resolve(emailStatus({ credentials: { ...emailStatus().credentials, tlsMode: "implicit" }, snapshot: { text: "Latest digest" } }));
  await b;
  old.resolve(emailStatus({ snapshot: { text: "Outdated digest" } })); await a;
  assert.equal(h.field("feed-ranker-email-tls-mode").value, "implicit");
  assert.equal(h.field("feed-ranker-email-preview").value, "Latest digest");
});

test("an older email status error cannot replace a newer successful status", async () => {
  const h = paneHarness(); await h.init();
  const old = deferred(); let calls = 0;
  h.emailService.getStatus = () => ++calls === 1 ? old.promise : Promise.resolve(emailStatus());
  const a = h.pane.populateEmail(h.root); await flush();
  await h.pane.populateEmail(h.root);
  const status = h.field("feed-ranker-email-status").textContent;
  old.reject(new Error("obsolete mock error")); await a;
  assert.equal(h.field("feed-ranker-email-status").textContent, status);
});

test("saving main settings invalidates older email work without clearing a later SMTP draft", async () => {
  const h = paneHarness(); await h.init();
  const old = deferred(); let calls = 0;
  h.emailService.getStatus = () => ++calls === 1 ? old.promise : Promise.resolve(emailStatus());
  const waiting = h.pane.populateEmail(h.root); await flush();
  const language = h.field("feed-ranker-language");
  language.value = "en"; await language.emit("command");
  h.pane.save(h.root);
  const tls = h.field("feed-ranker-email-tls-mode");
  tls.value = "implicit"; await tls.emit("command");
  await flush();
  old.resolve(emailStatus({ snapshot: { text: "Outdated pre-save preview" } })); await waiting;
  assert.equal(language.value, "en");
  assert.equal(tls.value, "implicit");
  assert.equal(tls.__feedRankDirty, true);
  assert.notEqual(h.field("feed-ranker-email-preview").value, "Outdated pre-save preview");
});

test("explicit import resets old drafts but invalidates status work started before the import", async () => {
  const h = paneHarness(); await h.init();
  const old = deferred(); let calls = 0;
  h.emailService.getStatus = () => ++calls === 1 ? old.promise : Promise.resolve(emailStatus());
  const waiting = h.pane.populateEmail(h.root); await flush();
  h.field("feed-ranker-language").value = "en"; await h.field("feed-ranker-language").emit("command");
  h.field("feed-ranker-email-tls-mode").value = "implicit"; await h.field("feed-ranker-email-tls-mode").emit("command");
  h.mainService.importSettingsFromFile = async () => {
    h.config({ explanationLanguage: "zh-CN", runFrequency: "daily" });
    return { loaded: true, applied: ["explanationLanguage", "runFrequency"] };
  };
  await h.pane.loadSettingsFile(h.root); await flush();
  old.resolve(emailStatus({ credentials: { ...emailStatus().credentials, tlsMode: "implicit" }, snapshot: { text: "Old import preview" } }));
  await waiting;
  assert.equal(h.field("feed-ranker-language").value, "zh-CN");
  assert.equal(h.field("feed-ranker-run-frequency").value, "daily");
  assert.equal(h.field("feed-ranker-email-tls-mode").value, "starttls");
  assert.notEqual(h.field("feed-ranker-email-preview").value, "Old import preview");
});

test("explicit reset replaces old drafts while edits made after a forced refresh starts remain protected", async () => {
  const h = paneHarness(); await h.init();
  h.field("feed-ranker-language").value = "en"; await h.field("feed-ranker-language").emit("command");
  h.mainService.resetAllSettings = async () => { h.config({ explanationLanguage: "zh-CN" }); return { reset: true }; };
  await h.pane.resetSettings(h.root); await flush();
  assert.equal(h.field("feed-ranker-language").value, "zh-CN");
  const late = deferred(); h.emailService.getStatus = () => late.promise;
  const waiting = h.pane.populateEmail(h.root, { force: true }); await flush();
  const tls = h.field("feed-ranker-email-tls-mode");
  tls.value = "implicit"; await tls.emit("command");
  late.resolve(emailStatus()); await waiting;
  assert.equal(tls.value, "implicit");
  assert.equal(tls.__feedRankDirty, true);
});

test("saving digest options does not clear unsaved SMTP mode choices", async () => {
  const h = paneHarness(); await h.init();
  const tls = h.field("feed-ranker-email-tls-mode"), max = h.field("feed-ranker-email-max-papers");
  tls.value = "implicit"; await tls.emit("command");
  max.value = "12"; await max.emit("input");
  await h.pane.saveEmailOptions(h.root);
  assert.equal(tls.__feedRankDirty, true);
  assert.equal(max.__feedRankDirty, false);
  await h.pane.populateEmail(h.root);
  assert.equal(tls.value, "implicit");
});

test("journal checkbox drafts are protected from automatic journal status refresh", async () => {
  const h = paneHarness(); await h.init();
  const enabled = h.field("feed-ranker-easyscholar-enabled");
  enabled.checked = true; await enabled.emit("change");
  await h.pane.populateJournal(h.root);
  assert.equal(enabled.checked, true);
});

test("standalone native cadence changes are saved through command, including HTML fallback", async () => {
  for (const fallback of [false, true]) {
    const h = paneHarness("settings", { fallback }); await h.init();
    h.field("run-frequency").value = "monthly";
    await h.field("run-frequency").emit(fallback ? "change" : "command");
    assert.equal(h.field("weekly-day").style.display, "none");
    assert.equal(h.field("monthly-day").style.display, "");
    await h.field("save").emit("click");
    assert.equal(h.saved.at(-1).runFrequency, "monthly");
    assert.equal(h.window.closed, true);
  }
});

test("standalone delivery-status refresh preserves unsaved native and checkbox choices", async () => {
  const h = paneHarness("settings"); await h.init();
  const tls = h.field("email-tls-mode"), automatic = h.field("email-auto-enabled");
  tls.value = "implicit"; await tls.emit("command");
  automatic.checked = true; await automatic.emit("change");
  h.delivery(); await flush();
  assert.equal(tls.value, "implicit");
  assert.equal(automatic.checked, true);
});

test("standalone import and reset explicitly replace drafts without letting older status responses return", async () => {
  for (const action of ["import", "reset"]) {
    const h = paneHarness("settings"); await h.init();
    const old = deferred(); let calls = 0;
    h.emailService.getStatus = () => ++calls === 1 ? old.promise : Promise.resolve(emailStatus());
    h.delivery(); await flush();
    h.field("language").value = "en"; await h.field("language").emit("command");
    h.field("email-tls-mode").value = "implicit"; await h.field("email-tls-mode").emit("command");
    const apply = async () => {
      h.config({ explanationLanguage: "zh-CN", runFrequency: "daily" });
      return action === "import" ? { loaded: true, applied: ["explanationLanguage"] } : { reset: true };
    };
    if (action === "import") h.mainService.importSettingsFromFile = apply;
    else h.mainService.resetAllSettings = apply;
    await h.field("settings-" + action).emit("click"); await flush();
    old.resolve(emailStatus({ credentials: { ...emailStatus().credentials, tlsMode: "implicit" }, snapshot: { text: "Outdated window digest" } }));
    await flush();
    assert.equal(h.field("language").value, "zh-CN", action);
    assert.equal(h.field("run-frequency").value, "daily", action);
    assert.equal(h.field("email-tls-mode").value, "starttls", action);
    assert.notEqual(h.field("email-preview").value, "Outdated window digest", action);
  }
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); process.stdout.write("ok   " + name + "\n"); }
    catch (error) { failures++; process.stdout.write("FAIL " + name + "\n" + String(error?.stack || error) + "\n"); }
  }
  process.stdout.write("\n" + (tests.length - failures) + "/" + tests.length + " form-controls tests passed\n");
  if (failures) process.exitCode = 1;
})();
