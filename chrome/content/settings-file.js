"use strict";

/*
 * FeedRank for Zotero — settings as a file.
 *
 * Three operations, asked for together: save the settings to a file, load them back, and clear
 * everything and start over.
 *
 * Two rules shape the format.
 *
 *   1. **No secret ever enters the file.** The SMTP password and the EasyScholar key live in an
 *      OS-encrypted Login Manager entry (see PRIVACY.md); writing them to a plain JSON file that
 *      a reader might email, sync or commit would undo that. An export carries settings, and an
 *      import ignores any credential-looking key even if someone hand-edits one in.
 *   2. **An import is untrusted input.** The file may have been edited, truncated, or come from a
 *      different version, so it is validated structurally here, and every value is then bounded
 *      by the ordinary `saveConfig` path -- this module never writes preferences itself.
 */

(function exposeFeedRankSettingsFile(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FeedRankSettingsFile = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createSettingsFile() {
  const KIND = "feedrank-settings";
  const SCHEMA = 1;

  // The settings that belong in a file: everything the panes can set, and nothing else.
  const CONFIG_KEYS = Object.freeze([
    "profile", "explanationLanguage", "lookbackDays", "candidateLimit", "batchSize",
    "batchConcurrency", "maxRetries", "requestTimeoutMs", "runFrequency", "weeklyRunDay",
    "monthlyRunDay", "weeklyRunTime", "currency", "inputPricePerMillion", "outputPricePerMillion",
    "bibliometricWeightPoints", "arxivSignificanceSignals",
  ]);
  const EMAIL_KEYS = Object.freeze([
    "transport", "automaticSendingEnabled", "tlsMode", "authMethod", "priorityCount",
    "maximumPapers", "minimumRelevanceScore", "readingListEnabled", "readingListCount",
    "transportTimeoutMs",
    // The connection itself. Not secrets -- the password is the secret, and it stays in the OS key
    // store -- but a file without them cannot carry the password back, because a login record needs
    // a host, a port and an identity to belong to.
    "host", "port", "username", "from", "to",
  ]);
  const JOURNAL_KEYS = Object.freeze(["lookupEnabled", "refreshBeforeScoring"]);

  /*
   * The two credential slots a file MAY carry, as OSKeyStore CIPHERTEXT only.
   *
   * Asked for directly: keep the credentials' link in the file so a reset can be undone by an
   * import. The plaintext never goes in: what is written is the same encrypted blob the OS key
   * store already holds, so the file is a copy of the credential rather than a readable password.
   * It is still a credential leaving its store -- anyone with the same OS account on the same
   * machine can decrypt it -- which is why the export ASKS first and omits it by default.
   */
  const CREDENTIAL_SLOTS = Object.freeze(["email", "scholar"]);

  // A ciphertext blob, not a password: printable, no whitespace, bounded. A plaintext secret
  // that happens to look like this is still refused by Zotero's own `isEncrypted` on restore.
  function normalizeCiphertext(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed.length < 40 || trimmed.length > 8192) return null;
    if (/\s/.test(trimmed)) return null;
    return trimmed;
  }

  /*
   * Anything that looks like a credential, by name. Dropped on import with a note, and never
   * written on export. The list is deliberately broad: a false positive costs one ignored field
   * in a corrupt file, a false negative writes a password to disk.
   */
  const SECRET_KEY_PATTERN = /secret|password|passwd|token|credential|authkey|apikey|api_key/i;

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function pick(source, keys, { dropped }) {
    const out = {};
    if (!isPlainObject(source)) return out;
    for (const [key, value] of Object.entries(source)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        dropped.push(key);
        continue;
      }
      if (!keys.includes(key)) continue;
      // Only the types a preference can hold; a nested object is never a setting.
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) out[key] = value;
    }
    return out;
  }

  /**
   * The file's text: a header a human can read, then the settings.
   */
  function buildExport({
    config, emailConfig, journalConfig, version, exportedAt, credentials = null,
  } = {}) {
    const dropped = [];
    const payload = {
      kind: KIND,
      schema: SCHEMA,
      note: "FeedRank for Zotero settings. Credentials are deliberately NOT included: the SMTP " +
        "password and the EasyScholar key stay in your OS-encrypted credential store and must be " +
        "re-entered on another machine.",
      app: "FeedRank for Zotero",
      version: String(version == null ? "" : version).slice(0, 32),
      exportedAt: String(exportedAt == null ? "" : exportedAt).slice(0, 64),
      config: pick(config, CONFIG_KEYS, { dropped }),
      email: pick(emailConfig, EMAIL_KEYS, { dropped }),
      journal: pick(journalConfig, JOURNAL_KEYS, { dropped }),
    };
    if (credentials) {
      const included = {};
      for (const slot of CREDENTIAL_SLOTS) {
        const ciphertext = normalizeCiphertext(credentials[slot]);
        if (ciphertext) included[slot] = ciphertext;
      }
      if (Object.keys(included).length) {
        payload.credentials = {
          format: "oskeystore-ciphertext",
          note: "Encrypted credential copies: the ciphertext your OS credential store holds, " +
            "and nothing more. The key that unlocks it is NOT in this file -- it stays in the OS " +
            "key store of the computer that wrote it -- so these copies work only for that OS " +
            "account on that machine. On another computer, re-enter the password and key.",
          ...included,
        };
        payload.note = "FeedRank for Zotero settings, INCLUDING a copy of the saved credentials " +
          "in ENCRYPTED form (see the credentials section). That copy decrypts only for the OS " +
          "account that wrote it: on another machine or account you must re-enter the password and " +
          "key. Treat this file like a password.";
      }
    }
    // A dropped key on export would mean the key lists are wrong; fail loudly instead of
    // silently shipping a settings file that is missing something.
    if (dropped.length) throw new Error("Refusing to export credential-bearing keys: " + dropped.join(", "));
    return JSON.stringify(payload, null, 2) + "\n";
  }

  /**
   * Parse an imported file. Never throws: a bad file is an answer, not an exception.
   *
   * @returns {{ok: boolean, errors: string[], ignored: string[], config: object, email: object,
   *            journal: object, version: string}}
   */
  function parseImport(text) {
    const result = {
      ok: false,
      errors: [],
      ignored: [],
      config: {},
      email: {},
      journal: {},
      credentials: {},
      version: "",
      exportedAt: "",
    };
    const raw = String(text == null ? "" : text);
    if (!raw.trim()) {
      result.errors.push("The file is empty");
      return result;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      result.errors.push("The file is not valid JSON: " + String(error?.message || error));
      return result;
    }
    if (!isPlainObject(parsed)) {
      result.errors.push("The file must contain a JSON object");
      return result;
    }
    if (parsed.kind !== KIND) {
      result.errors.push("This is not a FeedRank settings file");
      return result;
    }
    if (Number(parsed.schema) !== SCHEMA) {
      result.errors.push(
        "The file was written by a different settings format (schema " + String(parsed.schema) +
          ", this build reads " + SCHEMA + ")",
      );
      return result;
    }
    const dropped = [];
    result.config = pick(parsed.config, CONFIG_KEYS, { dropped });
    result.email = pick(parsed.email, EMAIL_KEYS, { dropped });
    result.journal = pick(parsed.journal, JOURNAL_KEYS, { dropped });
    result.ignored = [...new Set(dropped)];
    // The credentials section, if present: ciphertext only, and never merged into a setting.
    if (isPlainObject(parsed.credentials)) {
      for (const slot of CREDENTIAL_SLOTS) {
        const ciphertext = normalizeCiphertext(parsed.credentials[slot]);
        if (ciphertext) result.credentials[slot] = ciphertext;
        else if (parsed.credentials[slot] != null) result.ignored.push("credentials." + slot);
      }
    }
    result.version = String(parsed.version == null ? "" : parsed.version).slice(0, 32);
    result.exportedAt = String(parsed.exportedAt == null ? "" : parsed.exportedAt).slice(0, 64);
    const count = Object.keys(result.config).length + Object.keys(result.email).length +
      Object.keys(result.journal).length;
    if (!count && !Object.keys(result.credentials).length) {
      result.errors.push("The file contains no settings this build understands");
      return result;
    }
    result.ok = true;
    return result;
  }

  /*
   * "Clear all settings and reset."
   *
   * The scope is stated rather than implied, because the halves are very different: settings are
   * cheap to lose and scores are not. This clears the settings, the schedule marker and the
   * credential links -- after a reset the add-on must not be able to act as you on the mail server
   * or spend your EasyScholar key, so the stored secret is deleted, not merely forgotten. An
   * export that included the credentials can put them back. Score cache and cached journal metrics
   * are left alone: recomputing those costs model calls. The confirmation text and the pane hint
   * say exactly that.
   */
  const RESET = Object.freeze({
    /*
     * Absolute preference names, because the reset reads and clears them through Services.prefs.
     *
     * Three of these are the settings a user can actually have: the current key, the legacy key a
     * hand-edited about:config value may sit in, and the doubled-namespace key that 0.1.3 wrote and
     * that loadConfig() still falls back to. Clearing only the first one left a real profile's
     * settings -- and its profile text -- completely untouched.
     */
    prefs: Object.freeze([
      "extensions.zotero.feedranker.config",
      "extensions.zotero.feedranker.email.config",
      "extensions.zotero.feedranker.journal.config",
      "extensions.zotero.extensions.zotero.feedranker.config",
    ]),
    marker: Object.freeze(["weeklyPromptWeek"]),
    credentials: Object.freeze(["email", "scholar"]),
    keeps: Object.freeze(["ranks", "journalCache", "lastCandidates"]),
    summary: "Settings, the schedule and the journal-lookup options return to their defaults, and " +
      "the saved SMTP password and EasyScholar key are REMOVED from the encrypted credential " +
      "store: you will need to enter them again, or restore them from a settings file that " +
      "included them. Your cached scores and cached journal metrics are kept.",
  });

  function resetDescriptor() {
    return {
      prefs: [...RESET.prefs],
      marker: [...RESET.marker],
      credentials: [...RESET.credentials],
      keeps: [...RESET.keeps],
    };
  }

  return Object.freeze({
    KIND,
    SCHEMA,
    CONFIG_KEYS,
    EMAIL_KEYS,
    JOURNAL_KEYS,
    CREDENTIAL_SLOTS,
    normalizeCiphertext,
    SECRET_KEY_PATTERN,
    RESET,
    buildExport,
    parseImport,
    resetDescriptor,
  });
});
