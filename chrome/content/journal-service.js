"use strict";

/*
 * Stateful EasyScholar lookup companion for journal.js.
 *
 * The secret key is a user-owned credential and is treated exactly like the
 * SMTP secret: held in session memory, and when persistent storage is available
 * written only as an OSKeyStore ciphertext inside a FeedRank-only Login Manager
 * record. It is never written to a Zotero preference, never logged, and never
 * placed in an error message or a URL that FeedRank prints.
 *
 * Results are cached per normalized publication name so repeat items in one
 * journal cost one request, and the cache holds only the metrics FeedRank
 * displays, never the key.
 */
(function exposeFeedRankerJournalService(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.FeedRankerJournalService = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createJournalServiceModule() {
  const TOOL_NAME = "FeedRank for Zotero";
  // Zotero.Prefs adds its own extensions.zotero. namespace; this must stay bare.
  // It stores only non-secret lookup options.
  const JOURNAL_CONFIG_PREF = "feedranker.journal.config";
  const LOGIN_ORIGIN = "https://feedranker.invalid";
  const LOGIN_REALM = "FeedRank for Zotero / EasyScholar lookup";
  const MAX_STORED_METRICS = 24;
  const MAX_STORED_VALUE_LENGTH = 200;

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function boundedText(value, maximum = 500) {
    return String(value == null ? "" : value)
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, Math.max(0, maximum));
  }

  // A Zotero item exposes its fields through getField(), never as properties,
  // while FeedRank's own candidate records carry `publicationTitle` as a plain
  // property. Reading only one of the two silently skipped every Extra write, so
  // accept both shapes and return "" when neither has a usable value.
  function readPublicationTitle(record) {
    if (!record) return "";
    if (typeof record.getField === "function") {
      try {
        return record.getField("publicationTitle");
      } catch (_) {
        return "";
      }
    }
    return record.publicationTitle;
  }

  // Error text from the HTTP layer can quote the request URL, which contains the
  // secret key. Strip it before anything is stored or shown.
  function redact(value, fallback = "") {
    const cleaned = boundedText(value, 400)
      .replace(/secretKey=[^&\s"']+/gi, "secretKey=[redacted]")
      .replace(/\b[A-Fa-f0-9]{32}\b/g, "[redacted key]");
    return cleaned || fallback;
  }

  function safeError(error, fallback = "EasyScholar lookup failed") {
    return redact(error?.message || error, fallback);
  }

  function normalizeConfig(raw = {}) {
    return {
      provider: "easyscholar",
      // Off until the user supplies their own key; there is no other gate,
      // because a saved key is itself the opt-in.
      lookupEnabled: raw.lookupEnabled !== false,
      // Refresh the journal information for the papers about to be scored, so a
      // Priority calculation never runs against stale or missing evidence.
      refreshBeforeScoring: raw.refreshBeforeScoring === true,
      // `Number(null)` is 0, so guard the absent case explicitly: a missing
      // timestamp means "never looked up", not "looked up in 1970".
      lastLookupAt: raw.lastLookupAt == null || !Number.isFinite(Number(raw.lastLookupAt))
        ? null
        : Number(raw.lastLookupAt),
      lastLookupCount: Math.max(0, Number(raw.lastLookupCount) || 0),
      lastError: redact(raw.lastError),
    };
  }

  function normalizedCacheEntry(Journal, key, raw) {
    const source = asObject(raw);
    if (boundedText(source.cacheKey, 200) !== key) return null;
    const retrievedAt = Number(source.retrievedAt);
    if (!Number.isFinite(retrievedAt) || retrievedAt <= 0) return null;
    const metrics = (Array.isArray(source.metrics) ? source.metrics : [])
      .slice(0, MAX_STORED_METRICS)
      .map((metric) => ({
        key: boundedText(metric?.key, 60),
        label: boundedText(metric?.label, 80),
        value: boundedText(metric?.value, MAX_STORED_VALUE_LENGTH),
      }))
      .filter((metric) => metric.key && metric.value);
    return {
      cacheKey: key,
      found: source.found === true,
      journalName: boundedText(source.journalName, 300),
      metrics,
      retrievedAt,
    };
  }

  function cacheEntryToResult(entry) {
    const result = {
      ok: true,
      found: entry.found === true,
      code: 200,
      message: "",
      journalName: entry.journalName,
      metrics: entry.metrics.map((metric) => ({ ...metric })),
      retrievedAt: entry.retrievedAt,
      fromCache: true,
    };
    const find = (key) => entry.metrics.find((metric) => metric.key === key);
    result.impactFactor = find("sciif") ? find("sciif").value : "";
    result.fiveYearImpactFactor = find("sciif5") ? find("sciif5").value : "";
    result.jcrQuartile = find("sci") ? find("sci").value : "";
    return result;
  }

  class FeedRankJournalService {
    constructor({ Zotero, Services, Components, Journal, State, clock } = {}) {
      if (!Zotero || !Services || !Journal) {
        throw new Error("FeedRank journal service dependencies are unavailable");
      }
      this.Zotero = Zotero;
      this.Services = Services;
      this.Components = Components || {};
      this.Journal = Journal;
      this.clock = typeof clock === "function" ? clock : () => Date.now();
      this.State = State || {
        load: () => this.Zotero.FeedRanker?.loadState?.(),
        mutate: (mutator) => this.Zotero.FeedRanker?.mutateState?.(mutator),
      };
      this.sessionSecretKey = "";
      this.lookupInProgress = false;
      this.memoryCache = new Map();
    }

    // -- configuration -----------------------------------------------------

    loadConfig() {
      let raw = {};
      try {
        raw = asObject(JSON.parse(this.Zotero.Prefs?.get?.(JOURNAL_CONFIG_PREF) || "{}"));
      } catch (_) {}
      return normalizeConfig(raw);
    }

    saveConfig(rawConfig = {}) {
      const input = asObject(rawConfig);
      // Check the CALLER'S input, not the normalized result. normalizeConfig
      // drops unknown fields, so testing the output could never fire for the
      // case this guard exists for — and redact() rewrites a request URL into
      // the literal "secretKey=[redacted]", which the old check matched, so
      // persisting an ordinary redacted error was wrongly refused.
      for (const key of Object.keys(input)) {
        if (/secret|password|token|apikey|api_key/i.test(key)) {
          throw new Error("Refusing to save a credential field (" + key + ") in preferences");
        }
      }
      const config = normalizeConfig({ ...this.loadConfig(), ...input });
      if (typeof this.Zotero.Prefs?.set !== "function") throw new Error("Zotero preferences are unavailable");
      this.Zotero.Prefs.set(JOURNAL_CONFIG_PREF, JSON.stringify(config));
      return config;
    }

    // -- credential storage ------------------------------------------------

    osKeyStore() {
      const store = this.Zotero.OSKeyStore;
      return store && typeof store.encrypt === "function" &&
        typeof store.decrypt === "function" && typeof store.isEncrypted === "function"
        ? store
        : null;
    }

    async encryptSecretKey(secretKey, parentWindow) {
      const store = this.osKeyStore();
      if (!store) throw new Error("Zotero OSKeyStore is unavailable");
      if (typeof store.ensureLoggedIn === "function") {
        const allowed = await store.ensureLoggedIn(
          "Authorize FeedRank EasyScholar key access",
          TOOL_NAME,
          parentWindow || null,
          true,
        );
        if (allowed === false) throw new Error("Secure credential access was not authorized");
      }
      const encrypted = await store.encrypt(secretKey);
      if (!encrypted || !(await store.isEncrypted(encrypted))) {
        throw new Error("OSKeyStore did not return a verified encrypted credential");
      }
      return encrypted;
    }

    async decryptSecretKey(encrypted, parentWindow) {
      const store = this.osKeyStore();
      if (!store || !(await store.isEncrypted(encrypted))) {
        throw new Error("The saved FeedRank key is not a verified encrypted value");
      }
      if (typeof store.ensureLoggedIn === "function") {
        const allowed = await store.ensureLoggedIn(
          "Authorize FeedRank EasyScholar key access",
          TOOL_NAME,
          parentWindow || null,
          true,
        );
        if (allowed === false) throw new Error("Secure credential access was not authorized");
      }
      return this.Journal.normalizeSecretKey(await store.decrypt(encrypted));
    }

    async findLoginRecords() {
      const logins = this.Services.logins;
      if (typeof logins?.searchLoginsAsync !== "function") return [];
      const records = await logins.searchLoginsAsync({
        origin: LOGIN_ORIGIN,
        httpRealm: LOGIN_REALM,
      });
      return (Array.isArray(records) ? records : []).filter((login) => {
        const origin = String(login?.origin || login?.hostname || "");
        const realm = String(login?.httpRealm || login?.realm || "");
        return origin === LOGIN_ORIGIN && realm === LOGIN_REALM;
      });
    }

    /*
     * Remove one login record, and prove it is gone.
     *
     * The synchronous removeLogin() is what this Zotero uses; removeLoginAsync is kept only as a
     * fallback for a build that has that instead. Neither is trusted: the caller re-reads the store,
     * because an optional call on a missing method is indistinguishable from success.
     */
    removeLoginRecord(record) {
      const logins = this.Services?.logins;
      if (typeof logins?.removeLogin === "function") {
        logins.removeLogin(record);
        return;
      }
      if (typeof logins?.removeLoginAsync === "function") {
        return logins.removeLoginAsync(record);
      }
      throw new Error("Secure Login Manager storage is unavailable");
    }

    createLogin(encryptedKey) {
      const Ci = this.Components?.interfaces;
      const LoginInfo = this.Components?.Constructor;
      if (typeof LoginInfo !== "function" || !Ci?.nsILoginInfo) {
        throw new Error("Secure Login Manager storage is unavailable");
      }
      const Constructor = new LoginInfo(
        "@mozilla.org/login-manager/loginInfo;1",
        Ci.nsILoginInfo,
        "init",
      );
      // The username field carries a fixed non-secret label; only the password
      // field holds ciphertext.
      return new Constructor(
        LOGIN_ORIGIN, null, LOGIN_REALM, "easyscholar-secret-key", encryptedKey, "", "",
      );
    }

    /*
     * Credential round-trip for the settings file.
     *
     * exportStoredSecret returns the ciphertext the key store already holds -- never a decrypted
     * key: this method has no path that produces a readable secret. It is still credential
     * material (the same OS account can decrypt it), so the caller asks before writing it to a
     * file.
     *
     * restoreStoredSecret verifies before it writes. A blob this machine cannot decrypt -- a file
     * copied from another machine or OS account -- is not installed at all: "restored" and "usable"
     * are different answers, and a record that cannot be decrypted is worse than none, because the
     * lookup would fail later with a less obvious message. On that path the key simply stays
     * empty and the caller says so.
     */
    async exportStoredSecret() {
      const record = (await this.findLoginRecords()).find((login) => login?.password);
      if (!record) return null;
      return { ciphertext: String(record.password) };
    }

    async restoreStoredSecret({ ciphertext } = {}) {
      const value = typeof ciphertext === "string" ? ciphertext.trim() : "";
      if (!value) return { restored: false, usable: false, reason: "empty" };
      const store = this.osKeyStore();
      if (!store || !(await store.isEncrypted(value))) {
        return { restored: false, usable: false, reason: "not-encrypted" };
      }
      let usable = false;
      try {
        usable = Boolean(await this.decryptSecretKey(value));
      } catch (_) {
        usable = false;
      }
      if (!usable) return { restored: false, usable: false, reason: "undecryptable" };
      try {
        const records = await this.findLoginRecords();
        const replacement = this.createLogin(value);
        const logins = this.Services.logins;
        if (records.length && typeof logins?.modifyLogin === "function") {
          await logins.modifyLogin(records[0], replacement);
          for (const extra of records.slice(1)) await this.removeLoginRecord(extra);
        } else if (!records.length && typeof logins?.addLoginAsync === "function") {
          await logins.addLoginAsync(replacement);
        } else {
          return { restored: false, usable: false, reason: "unavailable" };
        }
      } catch (_) {
        return { restored: false, usable: false, reason: "unavailable" };
      }
      // A restored record is not a session copy: the key is read from the store like any other, so
      // a reset still removes it.
      this.sessionSecretKey = null;
      return { restored: true, usable: true, reason: "ok" };
    }

    async saveSecretKey({ secretKey, parentWindow, preferPersistent = true } = {}) {
      const key = this.Journal.normalizeSecretKey(secretKey);
      this.sessionSecretKey = key;
      if (!preferPersistent) return { configured: true, storage: "session", persistent: false };
      try {
        const records = await this.findLoginRecords();
        const encrypted = await this.encryptSecretKey(key, parentWindow);
        const replacement = this.createLogin(encrypted);
        const logins = this.Services.logins;
        if (records.length && typeof logins?.modifyLogin === "function") {
          await logins.modifyLogin(records[0], replacement);
          for (const extra of records.slice(1)) await this.removeLoginRecord(extra);
        } else if (!records.length && typeof logins?.addLoginAsync === "function") {
          await logins.addLoginAsync(replacement);
        } else {
          throw new Error("Secure Login Manager storage is unavailable");
        }
        return { configured: true, storage: "login-manager", persistent: true };
      } catch (error) {
        return {
          configured: true,
          storage: "session",
          persistent: false,
          warning: "Secure persistence was unavailable; the EasyScholar key will be cleared when Zotero closes. " +
            safeError(error),
        };
      }
    }

    async clearSecretKey() {
      try {
        for (const record of await this.findLoginRecords()) {
          await this.removeLoginRecord(record);
        }
      } finally {
        // This process's own copies go regardless: a session key must not outlive the store entry.
        this.sessionSecretKey = "";
        this.memoryCache.clear();
      }
      // Ask the store again, so "cleared" cannot mean "a call was made".
      const remaining = await this.findLoginRecords().catch(() => null);
      const persistentCleared = Array.isArray(remaining) && remaining.length === 0;
      return { cleared: persistentCleared, persistentCleared };
    }

    async credentialSummary() {
      if (this.sessionSecretKey) return { configured: true, storage: "session", persistent: false };
      try {
        const records = await this.findLoginRecords();
        if (records.length) return { configured: true, storage: "login-manager", persistent: true };
      } catch (_) {}
      return { configured: false, storage: "none", persistent: false };
    }

    async getSecretKey({ parentWindow } = {}) {
      if (this.sessionSecretKey) return this.sessionSecretKey;
      for (const login of await this.findLoginRecords()) {
        try {
          const key = await this.decryptSecretKey(login.password, parentWindow);
          this.sessionSecretKey = key;
          return key;
        } catch (_) {}
      }
      throw new Error("Add your EasyScholar secret key in FeedRank settings first");
    }

    // -- cache -------------------------------------------------------------

    readCache() {
      try {
        return asObject(this.State?.load?.()?.journalCache);
      } catch (_) {
        return {};
      }
    }

    cachedResult(publicationName) {
      const key = this.Journal.publicationCacheKey(publicationName);
      if (!key) return null;
      const memory = this.memoryCache.get(key);
      // Label a memory hit too. `storeResult` caches the freshly fetched result,
      // whose fromCache is false, so returning it verbatim made "fromCache"
      // mean "read from durable state" rather than "no request was made".
      if (memory) return { ...memory, metrics: memory.metrics.map((metric) => ({ ...metric })), fromCache: true };
      const entry = normalizedCacheEntry(this.Journal, key, this.readCache()[key]);
      if (!entry) return null;
      /*
       * No reuse window. A journal's impact factor and JCR quartile do not change
       * between runs, so a cached entry is always reused and a scoring run makes
       * no request once a title has been resolved. Fresh data is fetched only when
       * the user asks for it: "Update journal info" calls `lookup` directly, and an
       * unconditional request replaces the entry with the newer figures.
       *
       * An earlier revision expired entries after a configurable number of days, so
       * a stale-looking cache caused requests nobody asked for and left a resolved
       * journal "missing" again after the window passed.
       */
      const result = cacheEntryToResult(entry);
      this.memoryCache.set(key, result);
      return result;
    }

    async storeResult(publicationName, result) {
      const key = this.Journal.publicationCacheKey(publicationName);
      if (!key) return;
      this.memoryCache.set(key, result);
      if (typeof this.State?.mutate !== "function") return;
      try {
        await this.State.mutate((rootState) => {
          if (!rootState || typeof rootState !== "object") return;
          const cache = asObject(rootState.journalCache);
          cache[key] = {
            cacheKey: key,
            found: result.found === true,
            journalName: boundedText(result.journalName, 300),
            metrics: (Array.isArray(result.metrics) ? result.metrics : [])
              .slice(0, MAX_STORED_METRICS)
              .map((metric) => ({
                key: boundedText(metric.key, 60),
                label: boundedText(metric.label, 80),
                value: boundedText(metric.value, MAX_STORED_VALUE_LENGTH),
              }))
              .filter((metric) => metric.key && metric.value),
            retrievedAt: Number(result.retrievedAt) || this.clock(),
          };
          rootState.journalCache = this.Journal.pruneCache(cache);
        });
      } catch (_) {
        // A cache write failure must never fail the lookup the user asked for.
      }
    }

    // -- lookup ------------------------------------------------------------

    /*
     * The EasyScholar request, and why it does not use Zotero.HTTP.
     *
     * Zotero's request logger builds its own display string from the URL it is given and
     * redacts only a lowercase `key=` (http.js, `_requestInternal`); `options.displayURL` is
     * honoured by `download()` alone, and `debug: false` does not apply, because the URL line
     * is logged either way. This request carries the user's key as `secretKey`, so handing it
     * to that API would write the key into debug output.
     *
     * `fetch` is what Zotero's own download path uses, and it is available in this scope. The
     * URL is never logged here -- not on success, not on failure -- and any error this method
     * raises is built from `safeError`, which strips the key. A build with no `fetch` fails
     * closed with a message that names no secret, rather than falling back to the logging path.
     */
    async performRankRequest(prepared, { fetchImpl, timeoutMs } = {}) {
      const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
      if (typeof doFetch !== "function") {
        throw new Error(
          "This Zotero build cannot make a key-bearing request without logging it; " +
            "EasyScholar lookup is unavailable here",
        );
      }
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timeout = Number.isFinite(Number(timeoutMs))
        ? Number(timeoutMs)
        : Number(this.Journal?.REQUEST_TIMEOUT_MS) || 15000;
      const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
      try {
        const response = await doFetch(prepared.url, {
          ...prepared.fetchOptions,
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (!response || typeof response.text !== "function") {
          throw new Error("The journal lookup returned no readable response");
        }
        if (response.ok === false) {
          throw new Error("The journal lookup was refused with status " + Number(response.status));
        }
        return await response.text();
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // `request` is injected so this is testable without a network call; it is a fetch-shaped
    // function, never Zotero.HTTP.request -- see performRankRequest.
    async lookup(publicationName, { parentWindow, secretKey, request, force = false } = {}) {
      const name = this.Journal.normalizePublicationName(publicationName);
      if (!force) {
        const cached = this.cachedResult(name);
        if (cached) return cached;
      }
      const key = secretKey || await this.getSecretKey({ parentWindow });
      const prepared = this.Journal.buildRankRequest({ secretKey: key, publicationName: name });
      let raw;
      try {
        raw = await this.performRankRequest(prepared, { fetchImpl: request });
      } catch (error) {
        // `safeError` strips a bearer token and the request's own secret before this reaches
        // any notice, log line or thrown message.
        throw new Error("EasyScholar request failed: " + safeError(error));
      }
      const payload = this.Journal.safeResponseBody(raw);
      const result = this.Journal.parseRankResponse(payload, { publicationName: name });
      result.retrievedAt = this.clock();
      result.fromCache = false;
      if (result.ok) await this.storeResult(name, result);
      return result;
    }

    // Look up every distinct publication title among the given records and
    // return a map keyed by the original title. Bounded and sequential: this is
    // a user-triggered batch, not a background job.
    //
    // `items` is optional. When it is supplied, every item whose publication
    // title resolved also gets its metrics mirrored into Extra, because a value
    // that lives only in FeedRank's private cache disappears with the add-on.
    async lookupMany(publicationNames, options = {}) {
      if (this.lookupInProgress) throw new Error("An EasyScholar lookup is already in progress");
      this.lookupInProgress = true;
      const results = new Map();
      const items = Array.isArray(options.items) ? options.items : [];
      let looked = 0;
      let failed = 0;
      let saved = 0;
      try {
        const unique = [];
        const seen = new Set();
        for (const value of Array.isArray(publicationNames) ? publicationNames : []) {
          const name = boundedText(value, 300);
          if (!name) continue;
          const key = this.Journal.publicationCacheKey(name);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          unique.push(name);
        }
        for (const name of unique) {
          let result;
          try {
            result = await this.lookup(name, options);
            results.set(name, result);
            if (result.found) looked++;
            else failed++;
          } catch (error) {
            failed++;
            results.set(name, { ok: false, found: false, metrics: [], error: safeError(error) });
            continue;
          }
          if (!result.found) continue;
          const evidence = this.cachedOrResult(name, result);
          const groupKey = this.Journal.publicationCacheKey(name);
          for (const item of items) {
            // Match through the same normalization the caller used to build the
            // title list, and read the title in whichever shape the caller has:
            // a live Zotero item, or a candidate record. Never throw for one
            // whose title is missing — an ordinary book or report has none.
            const itemKey = this.Journal.publicationCacheKey(
              boundedText(readPublicationTitle(item), 300),
            );
            if (!itemKey || itemKey !== groupKey) continue;
            const outcome = await this.saveEvidenceToItem(item, evidence);
            if (outcome.changed) saved++;
          }
        }
        this.saveConfig({
          lastLookupAt: this.clock(),
          lastLookupCount: looked,
          lastError: failed && !looked ? "No journal could be resolved" : "",
        });
      } finally {
        this.lookupInProgress = false;
      }
      return { results, looked, failed, saved };
    }

    // -- Extra-field persistence ------------------------------------------

    /*
     * Merge the retrieved metrics into an item's Extra field using the labels
     * already established by the Green Frog convention, so the values are
     * readable by anything that reads that convention and survive without
     * FeedRank's own cache.
     *
     * This is the ONLY place FeedRank writes to a Zotero item. Like Green Frog,
     * it happens whenever a journal was actually resolved — there is no switch to
     * find, and nothing is written for a journal that was not resolved or whose
     * cached entry is past the reuse window. The merge is strictly additive:
     *   - lines carrying other labels are preserved byte for byte;
     *   - an existing line with the same label is REPLACED in place, so repeated
     *     runs do not accumulate duplicates;
     *   - a label with no value is omitted rather than written empty;
     *   - a value that is not a plain decimal is never written for the two
     *     numeric fields, because a malformed number is worse than no number.
     */
    extraFieldText(rawExtra, evidence) {
      const LABELS = ["影响因子", "5年影响因子", "JCR分区"];
      const wanted = new Map();
      const decimal = (value) => {
        const raw = String(value == null ? "" : value).trim();
        return /^\d+(?:\.\d+)?$/.test(raw) ? raw : "";
      };
      const impact = decimal(evidence?.impactFactor);
      const fiveYear = decimal(evidence?.fiveYearImpactFactor);
      const quartile = boundedText(evidence?.jcrQuartile, 120);
      if (impact) wanted.set("影响因子", impact);
      if (fiveYear) wanted.set("5年影响因子", fiveYear);
      if (quartile) wanted.set("JCR分区", quartile);

      const kept = [];
      const present = new Set();
      for (const line of String(rawExtra == null ? "" : rawExtra).split(/\r?\n/)) {
        const match = line.match(/^\s*(影响因子|5年影响因子|JCR分区)\s*[:：]\s*(.*?)\s*$/u);
        if (!match) {
          // Preserve everything else exactly, including blank lines.
          kept.push(line);
          continue;
        }
        present.add(match[1]);
        const value = wanted.get(match[1]);
        // Replace in place when we have a fresh value; drop a managed line that
        // carries nothing when we do not, so stale numbers cannot linger.
        if (value) kept.push(match[1] + ": " + value);
      }
      for (const [label, value] of [...wanted.entries()]) {
        if (present.has(label)) continue;
        kept.push(label + ": " + value);
      }
      // Collapse blank runs at either edge that an empty field or an append can
      // create. Interior blank lines the user wrote are preserved.
      const isBlank = (line) => !boundedText(line);
      while (kept.length && isBlank(kept[0])) kept.shift();
      while (kept.length && isBlank(kept[kept.length - 1])) kept.pop();
      return kept.join("\n");
    }

    // Write the metrics for one item, returning whether the field changed.
    async saveEvidenceToItem(item, result) {
      if (!item || typeof item.getField !== "function" || typeof item.setField !== "function") {
        return { changed: false, reason: "item-unavailable" };
      }
      const evidence = this.Journal.toJournalEvidence(result);
      if (!evidence.available) return { changed: false, reason: "no-evidence" };
      let current = "";
      try {
        current = String(item.getField("extra") || "");
      } catch (_) {
        return { changed: false, reason: "field-unreadable" };
      }
      const next = this.extraFieldText(current, evidence);
      if (next === current) return { changed: false, reason: "already-current" };
      try {
        item.setField("extra", next);
        if (typeof item.saveTx === "function") await item.saveTx();
      } catch (error) {
        return { changed: false, reason: "save-failed", error: safeError(error) };
      }
      return { changed: true, reason: "updated" };
    }

    /*
     * Resolve the evidence for one journal that has just been looked up. Prefer
     * the freshly stored cache entry so the Extra write and the scoring run
     * agree on exactly one set of numbers and one retrieval timestamp; fall back
     * to the raw result if the cache write did not land.
     */
    cachedOrResult(name, result) {
      const cached = this.cachedResult(name);
      if (cached?.found) return cached;
      return result;
    }

    /*
     * Refresh journal information for a set of papers immediately before they
     * are scored. `entries` is [{ publicationTitle, item }]. A cached result costs
     * no request, so a repeat run is free.
     *
     * Writing the metrics into each item's Extra field and re-reading them from
     * EasyScholar are two DIFFERENT jobs, and either one alone is a complete,
     * useful operation:
     *   - `save` mirrors whatever evidence is already cached into Extra.
     *   - `refresh` re-reads the evidence, so the numbers are current before the
     *     score is computed.
     * Tying the write to the refresh meant that turning the refresh off also
     * silently wrote nothing, which made a resolved journal look as though it had
     * never been retrieved. `refresh` now only decides whether a request may be
     * made.
     *
     * Failure is deliberately non-fatal: a scoring run must not be blocked by a
     * journal lookup. The caller is told what happened and continues with
     * whatever evidence it already has.
     */
    async refreshForScoring(entries, { parentWindow, request, refresh = true, save = true, force = false, onProgress, shouldStop } = {}) {
      const config = this.loadConfig();
      const empty = { attempted: false, looked: 0, failed: 0, saved: 0, skipped: 0, cached: 0 };
      if (config.lookupEnabled !== true) return { ...empty, reason: "disabled" };
      if (refresh !== true && save !== true) return { ...empty, reason: "nothing-to-do" };
      const credentials = await this.credentialSummary();
      if (credentials.configured !== true) return { ...empty, reason: "no-key" };

      // Deduplicate by normalized journal name so ten papers in one journal
      // cost one request, while keeping every item that needs the write.
      const byJournal = new Map();
      let skipped = 0;
      for (const entry of Array.isArray(entries) ? entries : []) {
        const name = boundedText(entry?.publicationTitle, 300);
        if (!name) {
          skipped++;
          continue;
        }
        const key = this.Journal.publicationCacheKey(name);
        if (!key) {
          skipped++;
          continue;
        }
        if (!byJournal.has(key)) byJournal.set(key, { name, items: [] });
        if (entry.item) byJournal.get(key).items.push(entry.item);
      }
      if (!byJournal.size) return { ...empty, attempted: true, skipped };

      // A save-only run mirrors the cache and never invents evidence: a title with
      // no cached record is simply not written.
      const groups = [...byJournal.values()];
      let looked = 0;
      let failed = 0;
      let saved = 0;
      let cached = 0;
      let index = 0;
      for (const group of groups) {
        if (typeof shouldStop === "function" && shouldStop()) {
          return { attempted: true, looked, failed, saved, cached, skipped, reason: "cancelled" };
        }
        index++;
        let result = null;
        if (refresh === true || force === true) {
          onProgress?.(group.name, index, groups.length);
          let threw = false;
          try {
            const fetched = await this.lookup(group.name, { parentWindow, request, force });
            // Re-read the cache so the Extra write and the scoring run agree on
            // exactly one set of numbers and one retrieval timestamp.
            result = fetched?.found ? this.cachedOrResult(group.name, fetched) : fetched;
          } catch (error) {
            threw = true;
          }
          // Exactly one outcome per journal, counted once: resolved, not found,
          // or errored.
          if (result?.found) looked++;
          else if (threw || result) failed++;
        } else {
          // A cached record is always usable: journal metrics do not change between
          // runs, and re-reading them is the manual action's job.
          result = this.cachedResult(group.name);
        }
        if (save !== true || !result?.found) continue;
        if (refresh !== true && force !== true) cached++;
        for (const item of group.items) {
          const outcome = await this.saveEvidenceToItem(item, result);
          if (outcome.changed) saved++;
        }
      }
      return { attempted: true, looked, failed, saved, cached, skipped, reason: "" };
    }

    async getStatus() {
      return {
        config: this.loadConfig(),
        credentials: await this.credentialSummary(),
        cacheSize: Object.keys(this.readCache()).length,
      };
    }

    async shutdown() {
      this.sessionSecretKey = "";
      this.memoryCache.clear();
      this.lookupInProgress = false;
    }
  }

  return Object.freeze({
    JOURNAL_CONFIG_PREF,
    LOGIN_ORIGIN,
    LOGIN_REALM,
    MAX_STORED_METRICS,
    normalizeConfig,
    normalizedCacheEntry,
    cacheEntryToResult,
    redact,
    create(dependencies) {
      return new FeedRankJournalService(dependencies);
    },
  });
});
