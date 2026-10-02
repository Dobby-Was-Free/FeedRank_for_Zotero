"use strict";

/*
 * Tests for the settings-as-a-file module (chrome/content/settings-file.js).
 *
 * Offline and pure: no file system, no Zotero. The file I/O lives in the service, which is
 * driven by a picker and cannot run here; what CAN be pinned is the part that decides what a
 * file contains and what an imported file is allowed to change -- including the two rules the
 * module exists for: a credential never leaves in a file, and a credential never arrives in one.
 */

const fs = require("node:fs");
const assert = require("node:assert/strict");
const SettingsFile = require("../chrome/content/settings-file.js");

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

const CONFIG = Object.freeze({
  profile: "I work on photonic integration.",
  explanationLanguage: "en",
  lookbackDays: 7,
  candidateLimit: 120,
  batchSize: 12,
  batchConcurrency: 2,
  maxRetries: 1,
  requestTimeoutMs: 120000,
  runFrequency: "weekly",
  weeklyRunDay: 3,
  monthlyRunDay: 1,
  weeklyRunTime: "16:50",
  currency: "USD",
  inputPricePerMillion: 0.3,
  outputPricePerMillion: 1.2,
  bibliometricWeightPoints: 10,
  arxivSignificanceSignals: "",
});

const EMAIL = Object.freeze({
  transport: "smtp",
  automaticSendingEnabled: true,
  tlsMode: "implicit",
  authMethod: "login",
  priorityCount: 5,
  maximumPapers: 100,
  minimumRelevanceScore: 70,
  readingListEnabled: true,
  readingListCount: 50,
  transportTimeoutMs: 30000,
});

const JOURNAL = Object.freeze({ lookupEnabled: true, refreshBeforeScoring: false });

test("an export round-trips through an import", () => {
  const text = SettingsFile.buildExport({
    config: CONFIG,
    emailConfig: EMAIL,
    journalConfig: JOURNAL,
    version: "0.2.19",
    exportedAt: "2026-10-01T12:00:00.000Z",
  });
  const parsed = SettingsFile.parseImport(text);
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
  assert.deepEqual(parsed.config, CONFIG);
  assert.deepEqual(parsed.email, EMAIL);
  assert.deepEqual(parsed.journal, JOURNAL);
  assert.equal(parsed.version, "0.2.19");
  // The header states the rule to whoever opens the file in a text editor.
  assert.match(text, /Credentials are deliberately NOT included/);
  assert.match(text, /"kind": "feedrank-settings"/);
});

test("a credential is never exported, and never imported either", () => {
  // 1. Export refuses to carry one, rather than quietly dropping it: a wrong key list must fail
  //    loudly instead of producing a file that is missing a setting.
  assert.throws(
    () => SettingsFile.buildExport({
      config: { ...CONFIG, secretKey: "unit-test-only-key" },
      emailConfig: EMAIL,
      journalConfig: JOURNAL,
    }),
    /Refusing to export credential-bearing keys: secretKey/,
  );
  assert.throws(
    () => SettingsFile.buildExport({
      config: CONFIG,
      emailConfig: { ...EMAIL, password: "hunter2" },
      journalConfig: JOURNAL,
    }),
    /credential-bearing keys: password/,
  );

  // 2. An import ignores one that was hand-edited in, and says so.
  const text = SettingsFile.buildExport({
    config: CONFIG, emailConfig: EMAIL, journalConfig: JOURNAL,
  });
  const tampered = JSON.parse(text);
  tampered.email.password = "hunter2";
  tampered.email.secretKey = "unit-test-only-key";
  tampered.config.apiKey = "unit-test-only-key";
  tampered.config.credentials = { user: "x" };
  const parsed = SettingsFile.parseImport(JSON.stringify(tampered));
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
  for (const section of [parsed.config, parsed.email, parsed.journal]) {
    for (const key of Object.keys(section)) {
      assert.doesNotMatch(key, SettingsFile.SECRET_KEY_PATTERN, "a credential key was accepted: " + key);
    }
  }
  assert.ok(parsed.ignored.includes("password"));
  assert.ok(parsed.ignored.includes("secretKey"));
  assert.ok(parsed.ignored.includes("apiKey"));
  assert.ok(parsed.ignored.includes("credentials"));
  // The settings that are legitimate still arrived.
  assert.equal(parsed.email.automaticSendingEnabled, true);
  assert.equal(parsed.config.lookbackDays, 7);
});

test("a file from anywhere else is refused, with a reason", () => {
  const cases = [
    ["", /empty/],
    ["not json at all", /not valid JSON/],
    ["[1,2,3]", /JSON object/],
    [JSON.stringify({ kind: "something-else", schema: 1 }), /not a FeedRank settings file/],
    [JSON.stringify({ kind: "feedrank-settings", schema: 99, config: { lookbackDays: 7 } }),
      /different settings format/],
    [JSON.stringify({ kind: "feedrank-settings", schema: 1, config: {}, email: {}, journal: {} }),
      /no settings this build understands/],
  ];
  for (const [text, expected] of cases) {
    const parsed = SettingsFile.parseImport(text);
    assert.equal(parsed.ok, false, "expected a refusal for: " + text.slice(0, 40));
    assert.match(parsed.errors.join(" "), expected);
    // A refusal never carries a partial patch to apply.
    assert.deepEqual(parsed.config, {});
    assert.deepEqual(parsed.email, {});
    assert.deepEqual(parsed.journal, {});
  }
});

test("only settings this build knows are taken from a file", () => {
  const parsed = SettingsFile.parseImport(JSON.stringify({
    kind: "feedrank-settings",
    schema: 1,
    version: "9.9.9",
    config: { lookbackDays: 21, somethingRemoved: true, ranks: { "1:A": { score: 90 } } },
    email: { maximumPapers: 25, futureOption: "x" },
    journal: { lookupEnabled: false, cacheDays: 30 },
  }));
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
  assert.deepEqual(parsed.config, { lookbackDays: 21 });
  assert.deepEqual(parsed.email, { maximumPapers: 25 });
  assert.deepEqual(parsed.journal, { lookupEnabled: false });
  // A file may claim any version; it is reported, never trusted as a permission.
  assert.equal(parsed.version, "9.9.9");
});

test("a reset clears the settings and keeps the scores", () => {
  const reset = SettingsFile.resetDescriptor();
  assert.deepEqual(reset.prefs, [
    "extensions.zotero.feedranker.config",
    "extensions.zotero.feedranker.email.config",
    "extensions.zotero.feedranker.journal.config",
    // Found in a real profile: 0.1.3 wrote the settings here, and loadConfig() still reads it.
    "extensions.zotero.extensions.zotero.feedranker.config",
  ]);
  // Absolute names, because the reset goes through Services.prefs, which does not add a namespace.
  for (const key of reset.prefs) {
    assert.match(key, /^extensions\.zotero\./, key + " must be fully qualified");
  }
  // Whatever loadConfig can read, the reset must be able to clear: the fallback chain is the reason
  // the doubled name is in this list at all.
  const main = fs.readFileSync("chrome/content/main.js", "utf8");
  for (const constant of ["PREF_CONFIG", "LEGACY_PREF_CONFIG", "BROKEN_PREF_CONFIG"]) {
    const value = (main.match(new RegExp("const " + constant + ' = "([^"]+)"')) || [])[1];
    assert.ok(value, constant + " must be defined");
    const absolute = constant === "PREF_CONFIG" ? "extensions.zotero." + value : value;
    assert.ok(reset.prefs.includes(absolute),
      constant + " (" + absolute + ") is read by loadConfig but never cleared by a reset");
  }
  assert.deepEqual(reset.marker, ["weeklyPromptWeek"]);
  // Stated, not implied: recomputing scores costs model calls, so a reset must not touch them.
  assert.deepEqual(reset.keeps, ["ranks", "journalCache", "lastCandidates"]);
  assert.match(SettingsFile.RESET.summary, /cached scores and cached journal metrics are kept/);
});

const CIPHERTEXT = "oskv1:" +
  Buffer.from("a-unit-test-only-key-that-is-long-enough-to-pass-the-shape-check", "utf8")
    .toString("base64");

test("credentials are written only when the export asks for them, and only as ciphertext", () => {
  const without = JSON.parse(SettingsFile.buildExport({ config: {}, emailConfig: {}, journalConfig: {} }));
  assert.equal(Object.hasOwn(without, "credentials"), false, "the default export carries no credential");
  assert.match(without.note, /NOT included/);

  const text = SettingsFile.buildExport({
    config: {},
    emailConfig: {},
    journalConfig: {},
    credentials: { email: CIPHERTEXT, scholar: "" },
  });
  const parsed = JSON.parse(text);
  assert.equal(parsed.credentials.format, "oskeystore-ciphertext");
  assert.equal(parsed.credentials.email, CIPHERTEXT);
  assert.equal(Object.hasOwn(parsed.credentials, "scholar"), false, "an empty slot is not written");
  assert.match(parsed.note, /INCLUDING/);
  // The file must say where the unlock key is NOT, because the ciphertext alone is not enough.
  assert.match(parsed.credentials.note, /NOT in this file/);
  assert.match(parsed.credentials.note, /another computer/);
  assert.equal(text.includes("a-unit-test-only-key"), false, "the file never holds a readable secret");
});

test("a credentials section is read as ciphertext only, and never as a setting", () => {
  const result = SettingsFile.parseImport(JSON.stringify({
    kind: "feedrank-settings",
    schema: 1,
    config: { lookbackDays: 6 },
    credentials: {
      email: CIPHERTEXT,
      scholar: "short",
      injected: CIPHERTEXT,
      // A file cannot use this section to introduce a preference.
      weeklyRunDay: 99,
    },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.credentials, { email: CIPHERTEXT });
  assert.deepEqual(result.ignored, ["credentials.scholar"]);
  assert.deepEqual(result.config, { lookbackDays: 6 });
  assert.equal(Object.hasOwn(result.config, "weeklyRunDay"), false, "a credential slot is not a setting");
  assert.equal(Object.hasOwn(result.config, "email"), false);

  // Whitespace can never be part of a stored ciphertext, and neither can a plaintext secret.
  const plaintext = SettingsFile.parseImport(JSON.stringify({
    kind: "feedrank-settings",
    schema: 1,
    config: { lookbackDays: 6 },
    credentials: { email: "hunter2 hunter2 hunter2 hunter2 hunter2 hunter2 hunter2" },
  }));
  assert.deepEqual(plaintext.credentials, {});
  assert.deepEqual(plaintext.ignored, ["credentials.email"]);
  assert.equal(plaintext.ok, true, "the settings half of the file is still usable");

  // A file carrying only credentials still counts as a file this build understands.
  const credentialsOnly = SettingsFile.parseImport(JSON.stringify({
    kind: "feedrank-settings",
    schema: 1,
    credentials: { scholar: CIPHERTEXT },
  }));
  assert.equal(credentialsOnly.ok, true);
  assert.deepEqual(credentialsOnly.credentials, { scholar: CIPHERTEXT });
});

test("reset says what it does to the credentials, and leaves the caches alone", () => {
  const descriptor = SettingsFile.resetDescriptor();
  assert.deepEqual(descriptor.credentials, ["email", "scholar"]);
  assert.deepEqual(descriptor.keeps, ["ranks", "journalCache", "lastCandidates"]);
  for (const word of [/REMOVED/, /again/, /cached scores/i]) {
    assert.match(SettingsFile.RESET.summary, word);
  }
  // The scope cannot drift from the sentence: every slot the reset names is a credential slot.
  for (const slot of descriptor.credentials) {
    assert.equal(SettingsFile.CREDENTIAL_SLOTS.includes(slot), true);
  }
});

test("the SMTP connection round-trips, and is not treated as a secret", () => {
  // Without these the import cannot attach a password to anything: a login record belongs to a
  // connection, and the file has to say which one.
  const connection = {
    host: "smtp.example.test", port: 994, username: "digest@example.test",
    from: "digest@example.test", to: "reader@example.test",
  };
  const text = SettingsFile.buildExport({ config: {}, emailConfig: { ...connection, maximumPapers: 10 }, journalConfig: {} });
  const parsed = SettingsFile.parseImport(text);
  assert.equal(parsed.ok, true);
  for (const [key, value] of Object.entries(connection)) {
    assert.equal(parsed.email[key], value, key + " must survive the round trip");
  }
  assert.equal(parsed.email.maximumPapers, 10);
  // Not credential material: the password is, and it is not in this section.
  assert.deepEqual(parsed.ignored, []);
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
  process.stdout.write("\n" + (tests.length - failures) + "/" + tests.length + " settings-file tests passed\n");
  if (failures) process.exitCode = 1;
})();
