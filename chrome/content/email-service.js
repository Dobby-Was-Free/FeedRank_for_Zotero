"use strict";

/*
 * Stateful, manual-only SMTP delivery companion for email.js and email-smtp.js.
 *
 * This module deliberately has no timer, no startup sender, and no background
 * retry. A message can be submitted only after a person opens the reviewed
 * preview and confirms that exact frozen draft.
 *
 * SECURITY INVARIANTS
 *   - No credential is ever written to a Zotero preference. The secret is held
 *     in session memory and, when persistent storage is available, as an
 *     OSKeyStore ciphertext inside a FeedRank-only Login Manager record.
 *   - The address pair (sender, recipient) and the connection identity live in
 *     that same Login Manager record, not in plaintext preferences.
 *   - SMTP has no provider-side idempotency key. The frozen message, envelope,
 *     and configuration identity are persisted BEFORE DATA is sent, and an
 *     uncertain outcome is never resent automatically.
 */
(function exposeFeedRankerEmailService(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.FeedRankerEmailService = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createEmailServiceModule() {
  const TOOL_NAME = "FeedRank for Zotero";
  // Zotero.Prefs adds its own extensions.zotero. namespace. This must remain a
  // bare name; it holds only non-secret delivery options.
  const EMAIL_CONFIG_PREF = "feedranker.email.config";
  const LOGIN_ORIGIN = "https://feedranker.invalid";
  const LOGIN_REALM = "FeedRank for Zotero / SMTP submission";
  const LOGIN_KIND = "smtp";

  const MAX_DIGEST_PAPERS = 100;
  const MAX_SAVED_SUBMISSIONS = 3;
  const MAX_DIGEST_CONTENT_LENGTH = 60000;
  const MAX_MESSAGE_STATE_LENGTH = 200000;
  const MAX_EMAIL_STATE_LENGTH = 400000;
  const MAX_TRANSPORT_TIMEOUT_MS = 120000;
  const DEFAULT_TRANSPORT_TIMEOUT_MS = 30000;

  const DELIVERY_STATUSES = new Set([
    "prepared", "ready", "submitting", "accepted", "retryable", "failed", "unknown",
  ]);
  // A status that still blocks a second submission for the same run. This is
  // what makes a double click a no-op instead of a duplicate message.
  const BLOCKING_STATUSES = new Set(["prepared", "ready", "submitting", "accepted", "unknown", "retryable"]);
  // Which completed run a stored digest came from. "weekly" is the scheduled
  // source; "daily" is what 0.2.6 and earlier wrote and is still accepted so an
  // upgrade does not discard the digest an install already has; "manual" is a
  // user-invoked run of any scope.
  const DIGEST_SOURCES = new Set(["weekly", "daily", "manual"]);

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function boundedText(value, maximum = 2000) {
    return String(value == null ? "" : value)
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, Math.max(0, maximum));
  }

  function boundedBody(value, maximum = MAX_DIGEST_CONTENT_LENGTH) {
    const source = String(value == null ? "" : value);
    return source.length <= maximum ? source : "";
  }

  function boundedInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isInteger(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, number));
  }

  function safeNow(value = Date.now()) {
    return Number.isFinite(Number(value)) ? Number(value) : Date.now();
  }

  function fnv1a(value) {
    let hash = 0x811c9dc5;
    const input = String(value == null ? "" : value);
    for (let index = 0; index < input.length; index++) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function opaqueRunID(value) {
    const source = boundedText(value, 1000);
    if (!source) throw new Error("A completed run identifier is required");
    // Do not persist Zotero item IDs or any caller-owned run label. A compact
    // deterministic opaque token is sufficient to bind state to one run.
    return "run-" + fnv1a(source);
  }

  // Error text can contain a server banner or a partial command echo. Strip
  // anything that looks like a credential before it is stored or displayed.
  // The AUTH rule requires a long base64-shaped token so ordinary prose such as
  // "does not offer AUTH PLAIN (it advertised: LOGIN)" is not mangled.
  function redact(value, fallback = "") {
    const cleaned = boundedText(value, 500)
      .replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]")
      .replace(/\bAUTH\s+(PLAIN|LOGIN|XOAUTH2)\s+[A-Za-z0-9+/=]{16,}/gi, "AUTH $1 [redacted]")
      .replace(/\bre_[A-Za-z0-9_-]+/g, "[redacted API key]");
    return cleaned || fallback;
  }

  function safeError(error, fallback = "SMTP request failed") {
    return redact(error?.message || error, fallback);
  }

  // A secret is opaque here; only shape is validated. It is never trimmed in a
  // way that would silently alter a legitimate password.
  function normalizeSecret(value, label = "SMTP secret") {
    const secret = String(value == null ? "" : value);
    if (!secret) throw new Error("Enter the " + label);
    if (secret.length > 2000) throw new Error("The " + label + " is too long");
    if (/[\u0000\r\n]/.test(secret)) throw new Error("The " + label + " contains an unsupported character");
    return secret;
  }

  function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  }

  function localDayNow() {
    const now = new Date();
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
  }

  function digestHash(digest) {
    return fnv1a(JSON.stringify({
      subject: digest?.subject,
      text: digest?.text,
      html: digest?.html,
    }));
  }

  function isBoundedDigest(Email, digest) {
    if (!digest || typeof digest !== "object") return false;
    // A digest subject now carries the week it covers, so it is validated against
    // the shape rather than one fixed string. The prefix and the range format are
    // still exact: a hand-edited or injected subject is refused, and next week's
    // range is not.
    if (!Email.DIGEST_SUBJECT_PATTERN.test(String(digest.subject || "")) || !validDate(digest.date)) return false;
    if (!boundedBody(digest.text) || !boundedBody(digest.html)) return false;
    return JSON.stringify({
      subject: digest.subject,
      text: digest.text,
      html: digest.html,
    }).length <= MAX_DIGEST_CONTENT_LENGTH;
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  function normalizeEmailConfig(Email, raw = {}) {
    const normalized = Email.normalizeDigestOptions(asObject(raw));
    const maximumPapers = boundedInteger(
      raw.maximumPapers,
      Math.min(MAX_DIGEST_PAPERS, normalized.maximumPapers),
      1,
      MAX_DIGEST_PAPERS,
    );
    const tlsMode = raw.tlsMode == null || raw.tlsMode === ""
      ? "starttls"
      : Email.normalizeTLSMode(raw.tlsMode);
    const authMethod = raw.authMethod == null || raw.authMethod === ""
      ? "plain"
      : Email.normalizeAuthMethod(raw.authMethod);
    return {
      transport: "smtp",
      // This alone never permits a send. A completed weekly run must also carry
      // a separate same-run authorization from Zotero's confirmation UI.
      automaticSendingEnabled: raw.automaticSendingEnabled === true,
      tlsMode,
      authMethod,
      priorityCount: Math.min(
        maximumPapers,
        boundedInteger(raw.priorityCount, normalized.priorityCount, 1, 50),
      ),
      maximumPapers,
      minimumRelevanceScore: boundedInteger(
        raw.minimumRelevanceScore == null ? raw.priorityMinimumScore : raw.minimumRelevanceScore,
        normalized.minimumRelevanceScore,
        0,
        100,
      ),
      readingListEnabled: raw.readingListEnabled === true,
      readingListCount: boundedInteger(raw.readingListCount, normalized.readingListCount, 1, 100),
      transportTimeoutMs: boundedInteger(
        raw.transportTimeoutMs,
        DEFAULT_TRANSPORT_TIMEOUT_MS,
        5000,
        MAX_TRANSPORT_TIMEOUT_MS,
      ),
    };
  }

  function parseLoginMetadata(value, Email) {
    let metadata = {};
    try {
      metadata = asObject(JSON.parse(String(value || "")));
    } catch (_) {
      return null;
    }
    if (metadata.version !== 2 || metadata.kind !== LOGIN_KIND) return null;
    try {
      const connection = Email.normalizeSMTPConfig({
        host: metadata.host,
        port: metadata.port,
        tlsMode: metadata.tlsMode,
        authMethod: metadata.authMethod,
        username: metadata.username,
        from: metadata.from,
        to: metadata.to,
      });
      return { version: 2, kind: LOGIN_KIND, ...connection };
    } catch (_) {
      return null;
    }
  }

  function loginMatchesNamespace(login) {
    const origin = String(login?.origin || login?.hostname || "");
    const realm = String(login?.httpRealm || login?.realm || "");
    return origin === LOGIN_ORIGIN && realm === LOGIN_REALM;
  }

  // A stable, non-secret identity for one exact connection + address pair. Any
  // change to host, port, TLS mode, auth method, username, sender, or recipient
  // produces a different token, which invalidates a previously frozen draft.
  function connectionIdentity(Email, connection) {
    return fnv1a(JSON.stringify([
      connection.host,
      connection.port,
      connection.tlsMode,
      connection.authMethod,
      connection.username,
      connection.from,
      connection.to,
    ]));
  }

  // ---------------------------------------------------------------------------
  // Persisted digest snapshot
  // ---------------------------------------------------------------------------

  function normalizedSnapshot(Email, raw) {
    const source = String(raw?.source || "");
    const runID = String(raw?.runID || "");
    const digest = asObject(raw?.digest);
    // "weekly" is the current scheduled source; "daily" is the name 0.2.6 and
    // earlier wrote, and an existing install's stored snapshot must keep working.
    if (!DIGEST_SOURCES.has(source) || !/^run-[a-f0-9]{8}$/i.test(runID)) return null;
    if (!isBoundedDigest(Email, digest)) return null;
    const priorityCount = boundedInteger(raw.priorityCount, 0, 0, MAX_DIGEST_PAPERS);
    const readingListCount = boundedInteger(raw.readingListCount, 0, 0, MAX_DIGEST_PAPERS);
    if (!priorityCount || priorityCount + readingListCount > MAX_DIGEST_PAPERS) return null;
    const contentHash = String(raw.contentHash || "");
    if (contentHash !== digestHash(digest)) return null;
    return {
      schema: 2,
      source,
      runID,
      localDay: digest.date,
      priorityCount,
      readingListCount,
      recordCount: priorityCount + readingListCount,
      contentHash,
      createdAt: safeNow(raw.createdAt),
      digest: {
        date: digest.date,
        subject: digest.subject,
        text: digest.text,
        html: digest.html,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Frozen submission
  // ---------------------------------------------------------------------------

  function normalizedSubmission(Email, key, raw) {
    const source = asObject(raw);
    const submissionKey = String(source.submissionKey || "");
    if (key !== submissionKey || !/^feedrank-smtp\//.test(key) || key.length > 256) return null;
    if (!DELIVERY_STATUSES.has(source.status)) return null;
    const kind = source.kind === "test" ? "test" : "digest";
    const message = String(source.message || "");
    if (!message || message.length > Email.MAX_MESSAGE_LENGTH) return null;
    if (!boundedBody(source.text) || !boundedBody(source.html)) return null;
    // The test subject is fixed; a digest subject names the week it covers, so it
    // is matched against the shape rather than one exact string.
    const subject = String(source.subject || "");
    if (kind === "test" ? subject !== Email.TEST_SUBJECT : !Email.DIGEST_SUBJECT_PATTERN.test(subject)) return null;

    // Rebuilding the MIME text from the stored parts must reproduce the stored
    // bytes exactly. Otherwise the frozen draft was tampered with or a
    // generator changed, and it must not be sent.
    let rebuilt;
    try {
      rebuilt = Email.buildMIMEMessage({
        from: source.from,
        to: source.envelopeTo,
        subject: source.subject,
        text: source.text,
        html: source.html,
        date: new Date(Number(source.messageDate) || 0),
        messageID: source.messageID,
        boundary: source.messageBoundary,
      });
    } catch (_) {
      return null;
    }
    if (rebuilt.message !== message) return null;

    let connection;
    try {
      connection = Email.normalizeSMTPConfig({
        host: source.host,
        port: source.port,
        tlsMode: source.tlsMode,
        authMethod: source.authMethod,
        username: source.username,
        from: source.from,
        to: source.envelopeTo,
      });
    } catch (_) {
      return null;
    }
    const identity = connectionIdentity(Email, connection);
    if (identity !== String(source.connectionIdentity || "")) return null;
    const payloadHash = Email.payloadHash({
      from: source.from,
      to: source.envelopeTo,
      subject: source.subject,
      html: source.html,
      text: source.text,
      message,
    });
    if (payloadHash !== String(source.payloadHash || "")) return null;
    const createdAt = Number(source.createdAt);
    if (!Number.isFinite(createdAt) || createdAt <= 0) return null;

    return {
      schema: 2,
      kind,
      date: validDate(source.date) ? source.date : "",
      runHash: /^[a-f0-9]{8}$/i.test(String(source.runHash || "")) ? String(source.runHash) : "",
      submissionKey,
      payloadHash,
      connectionIdentity: identity,
      host: connection.host,
      port: connection.port,
      tlsMode: connection.tlsMode,
      authMethod: connection.authMethod,
      username: connection.username,
      from: connection.from,
      envelopeFrom: Email.envelopeAddress(connection.from),
      envelopeTo: connection.to,
      subject: String(source.subject),
      text: String(source.text),
      html: String(source.html),
      message,
      messageID: String(source.messageID || ""),
      messageBoundary: String(source.messageBoundary || ""),
      messageDate: Number(source.messageDate) || 0,
      payloadHashShort: fnv1a(message),
      attempts: Math.max(0, Number(source.attempts) || 0),
      status: source.status,
      createdAt,
      submittingAt: Number.isFinite(Number(source.submittingAt)) ? Number(source.submittingAt) : null,
      acceptedAt: Number.isFinite(Number(source.acceptedAt)) ? Number(source.acceptedAt) : null,
      failedAt: Number.isFinite(Number(source.failedAt)) ? Number(source.failedAt) : null,
      messageSubmitted: source.messageSubmitted === true,
      serverAccepted: source.serverAccepted === true,
      lastError: redact(source.lastError),
    };
  }

  // ---------------------------------------------------------------------------
  // Service
  // ---------------------------------------------------------------------------

  class FeedRankEmailService {
    constructor({ Zotero, Services, Components, Email, SMTP, State, Diagnostics, clock } = {}) {
      if (!Zotero || !Services || !Email || !SMTP) {
        throw new Error("FeedRank email service dependencies are unavailable");
      }
      this.Zotero = Zotero;
      this.Services = Services;
      this.Components = Components || {};
      this.Email = Email;
      this.SMTP = SMTP;
      // Optional: when present, a connection test also reports what this Zotero
      // build actually exposes on its TLS objects. Absent is not an error — the
      // test simply returns no report.
      this.Diagnostics = Diagnostics || Zotero?.FeedRankDiagnostics || null;
      this.clock = typeof clock === "function" ? clock : () => Date.now();
      this.State = State || {
        load: () => this.Zotero.FeedRanker?.loadState?.(),
        // Email delivery is disabled until main supplies its canonical,
        // serialized mutation function. An independent stale read/modify/write
        // would be unsafe beside a scoring-cache commit.
        mutate: (mutator) => this.Zotero.FeedRanker?.mutateState?.(mutator),
      };
      this.sessionCredentials = new Map();
      this.sendInProgress = false;
      this.testInProgress = false;
      // The newest delivery outcome that could not be written to the state. Session
      // only, and never a credential: it exists so a delivered message is still
      // reported as delivered instead of as an older failure.
      this.sessionOutcome = null;
      // Windows that want to be told when a delivery ends.
      //
      // The settings pane is a SEPARATE window from whichever one sends -- the
      // scheduled run has no window open, and Review digest sends from the preview
      // window -- so "Last email" could only ever be right when the pane happened to
      // be repopulated. A listener is how it is right immediately instead.
      this.deliveryListeners = new Set();
    }

    /*
     * Ask to be told when a delivery ends: after an accepted message, after a
     * refusal, and after an outcome that could not be recorded locally.
     *
     * Returns an unsubscribe function. A listener that throws is ignored: one pane's
     * broken render must not stop another from refreshing, and must never reach the
     * send that has already happened.
     */
    subscribeDelivery(listener) {
      if (typeof listener !== "function") return () => {};
      this.deliveryListeners.add(listener);
      return () => {
        this.deliveryListeners.delete(listener);
      };
    }

    notifyDeliveryChanged() {
      for (const listener of [...this.deliveryListeners]) {
        try {
          listener();
        } catch (error) {
          this.logError(new Error("A FeedRank delivery listener failed: " + safeError(error)));
        }
      }
    }

    // Errors that happen while reporting an outcome must not vanish into a catch:
    // a failed local write is exactly what a user needs to see in a log.
    logError(error) {
      try {
        this.Zotero.logError(error);
      } catch (_) {}
    }

    // -- configuration ------------------------------------------------------

    loadConfig() {
      let raw = {};
      try {
        raw = asObject(JSON.parse(this.Zotero.Prefs?.get?.(EMAIL_CONFIG_PREF) || "{}"));
      } catch (_) {}
      return normalizeEmailConfig(this.Email, raw);
    }

    saveConfig(rawConfig = {}) {
      const config = normalizeEmailConfig(this.Email, { ...this.loadConfig(), ...asObject(rawConfig) });
      if (typeof this.Zotero.Prefs?.set !== "function") throw new Error("Zotero preferences are unavailable");
      this.Zotero.Prefs.set(EMAIL_CONFIG_PREF, JSON.stringify(config));
      return config;
    }

    async startup() {
      // State recovery only. It never loads a credential and never connects.
      // A restart while a submission was in flight is deliberately ambiguous
      // and therefore becomes non-retryable unknown.
      await this.recoverInterruptedSubmissions();
      return this.getStatus();
    }

    async shutdown() {
      this.sessionCredentials.clear();
      this.sendInProgress = false;
      this.testInProgress = false;
    }

    // -- secure credential storage -----------------------------------------

    osKeyStore() {
      const store = this.Zotero.OSKeyStore;
      return store && typeof store.encrypt === "function" &&
        typeof store.decrypt === "function" && typeof store.isEncrypted === "function"
        ? store
        : null;
    }

    async encryptSecret(secret, parentWindow) {
      const store = this.osKeyStore();
      if (!store) throw new Error("Zotero OSKeyStore is unavailable");
      if (typeof store.ensureLoggedIn === "function") {
        const allowed = await store.ensureLoggedIn(
          "Authorize FeedRank email credential access",
          TOOL_NAME,
          parentWindow || null,
          true,
        );
        if (allowed === false) throw new Error("Secure credential access was not authorized");
      }
      const encrypted = await store.encrypt(secret);
      if (!encrypted || !(await store.isEncrypted(encrypted))) {
        throw new Error("OSKeyStore did not return a verified encrypted credential");
      }
      return encrypted;
    }

    async decryptSecret(encrypted, parentWindow) {
      const store = this.osKeyStore();
      if (!store || !(await store.isEncrypted(encrypted))) {
        throw new Error("The saved FeedRank credential is not a verified encrypted value");
      }
      if (typeof store.ensureLoggedIn === "function") {
        const allowed = await store.ensureLoggedIn(
          "Authorize FeedRank email credential access",
          TOOL_NAME,
          parentWindow || null,
          true,
        );
        if (allowed === false) throw new Error("Secure credential access was not authorized");
      }
      return normalizeSecret(await store.decrypt(encrypted));
    }

    async findLoginRecords() {
      const logins = this.Services.logins;
      if (typeof logins?.searchLoginsAsync !== "function") return [];
      const records = await logins.searchLoginsAsync({
        origin: LOGIN_ORIGIN,
        httpRealm: LOGIN_REALM,
      });
      return (Array.isArray(records) ? records : []).filter(loginMatchesNamespace);
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

    createLogin(metadata, encryptedSecret) {
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
      // The login's "username" field carries the non-secret SMTP identity, and
      // its "password" field carries only OSKeyStore ciphertext.
      return new Constructor(
        LOGIN_ORIGIN, null, LOGIN_REALM, JSON.stringify(metadata), encryptedSecret, "", "",
      );
    }

    /*
     * Credential round-trip for the settings file. See the journal service's counterpart for the
     * reasoning; the two behave the same way.
     *
     * The non-secret half of the record (host, port, TLS mode, addresses) is rebuilt from what the
     * CALLER states, not from the ciphertext, so a file can never smuggle a connection the
     * settings pane does not show.
     */
    async exportStoredSecret() {
      const record = (await this.findLoginRecords())
        .find((login) => parseLoginMetadata(login?.username, this.Email));
      if (!record || !record.password) return null;
      return { ciphertext: String(record.password) };
    }

    async restoreStoredSecret({ ciphertext, connection } = {}) {
      const value = typeof ciphertext === "string" ? ciphertext.trim() : "";
      if (!value) return { restored: false, usable: false, reason: "empty" };
      const store = this.Zotero.OSKeyStore;
      if (!store || !(await store.isEncrypted(value))) {
        return { restored: false, usable: false, reason: "not-encrypted" };
      }
      let usable = false;
      try {
        usable = Boolean(await this.decryptSecret(value));
      } catch (_) {
        usable = false;
      }
      if (!usable) return { restored: false, usable: false, reason: "undecryptable" };
      let normalizedConnection;
      try {
        normalizedConnection = this.Email.normalizeSMTPConfig(connection || {});
      } catch (_) {
        return { restored: false, usable: false, reason: "no-connection" };
      }
      try {
        const records = await this.findLoginRecords();
        const metadata = { version: 2, kind: LOGIN_KIND, ...normalizedConnection };
        const replacement = this.createLogin(metadata, value);
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
      this.sessionCredentials.delete(LOGIN_KIND);
      return { restored: true, usable: true, reason: "ok" };
    }

    async saveCredentials({ secret, host, port, tlsMode, authMethod, username, from, to, parentWindow, preferPersistent = true } = {}) {
      const normalizedSecret = normalizeSecret(secret);
      const connection = this.Email.normalizeSMTPConfig({ host, port, tlsMode, authMethod, username, from, to });
      const credential = { ...connection, secret: normalizedSecret };
      // Always retain a session copy for the immediately following manual
      // preview/send. It is erased by shutdown and never serialized.
      this.sessionCredentials.set(LOGIN_KIND, credential);
      if (!preferPersistent) return this.publicCredentialStatus("session", credential, false);

      const metadata = { version: 2, kind: LOGIN_KIND, ...connection };
      try {
        const records = await this.findLoginRecords();
        const encryptedSecret = await this.encryptSecret(normalizedSecret, parentWindow);
        const replacement = this.createLogin(metadata, encryptedSecret);
        const logins = this.Services.logins;
        if (records.length && typeof logins?.modifyLogin === "function") {
          await logins.modifyLogin(records[0], replacement);
          for (const extra of records.slice(1)) await this.removeLoginRecord(extra);
        } else if (!records.length && typeof logins?.addLoginAsync === "function") {
          await logins.addLoginAsync(replacement);
        } else {
          throw new Error("Secure Login Manager storage is unavailable");
        }
        return this.publicCredentialStatus("login-manager", credential, true);
      } catch (error) {
        // A session-only fallback is safer than a plaintext preference. The
        // user is told explicitly that it disappears when Zotero closes.
        return {
          ...this.publicCredentialStatus("session", credential, false),
          warning: "Secure persistence was unavailable; the SMTP secret will be cleared when Zotero closes. " + safeError(error),
        };
      }
    }

    async clearCredentials() {
      let remaining = [];
      try {
        for (const record of await this.findLoginRecords()) {
          await this.removeLoginRecord(record);
        }
      } finally {
        // The session copy goes whatever the store did: it is this process's own memory.
        this.sessionCredentials.delete(LOGIN_KIND);
      }
      // Ask the store again. A record that survived (a failed removal, a locked store, an API this
      // build does not have) must not be reported as cleared.
      remaining = await this.findLoginRecords().catch(() => null);
      const persistentCleared = Array.isArray(remaining) && remaining.length === 0;
      return { cleared: persistentCleared, persistentCleared, storage: "none" };
    }

    publicCredentialStatus(storage, credential, persistent) {
      return {
        configured: Boolean(credential?.secret),
        storage,
        persistent,
        host: credential?.host || "",
        port: credential?.port || 0,
        tlsMode: credential?.tlsMode || "",
        authMethod: credential?.authMethod || "",
        username: credential?.username || "",
        from: credential?.from || "",
        to: credential?.to || "",
      };
    }

    async credentialSummary() {
      const session = this.sessionCredentials.get(LOGIN_KIND);
      if (session) return this.publicCredentialStatus("session", session, false);
      try {
        const login = (await this.findLoginRecords())
          .find((record) => parseLoginMetadata(record?.username, this.Email));
        const metadata = login && parseLoginMetadata(login.username, this.Email);
        if (metadata) {
          return {
            configured: true,
            storage: "login-manager",
            persistent: true,
            host: metadata.host,
            port: metadata.port,
            tlsMode: metadata.tlsMode,
            authMethod: metadata.authMethod,
            username: metadata.username,
            from: metadata.from,
            to: metadata.to,
          };
        }
      } catch (_) {}
      return this.publicCredentialStatus("none", null, false);
    }

    async getCredentialsForManualSend({ parentWindow } = {}) {
      const session = this.sessionCredentials.get(LOGIN_KIND);
      if (session) return { ...session };
      const records = await this.findLoginRecords();
      /*
       * The reason a saved credential could not be used is kept, not discarded.
       *
       * This loop used to swallow every decryption failure and fall through to
       * "set the credential in FeedRank settings first", which is what an
       * UNATTENDED run reported when the OS key store declined to unlock the
       * secret -- a message that sends the reader to a settings pane where
       * everything is already correct. The automatic digest send is exactly the
       * context where nobody is watching, so the real cause is the only useful
       * thing the error can carry.
       */
      let lastUnlockError = null;
      let lastMetadata = null;
      for (const login of records) {
        const metadata = parseLoginMetadata(login?.username, this.Email);
        if (!metadata) continue;
        lastMetadata = metadata;
        try {
          const credential = {
            ...metadata,
            secret: await this.decryptSecret(login.password, parentWindow),
          };
          this.sessionCredentials.set(LOGIN_KIND, credential);
          return { ...credential };
        } catch (error) {
          lastUnlockError = error;
        }
      }
      if (lastUnlockError) {
        throw new Error(
          "The saved FeedRank credential could not be unlocked: " +
            safeError(lastUnlockError, "the OS key store did not release the secret") +
            (lastMetadata?.host ? " (server " + lastMetadata.host + ")" : "") +
            "; nothing was sent",
        );
      }
      throw new Error("Set the SMTP server, username, sender, recipient, and secret in FeedRank settings first");
    }

    // -- transport ----------------------------------------------------------

    transportTimeouts() {
      const config = this.loadConfig();
      return {
        connectTimeoutMs: config.transportTimeoutMs,
        ioTimeoutMs: config.transportTimeoutMs,
        commandTimeoutMs: config.transportTimeoutMs,
      };
    }

    openSocket(connection) {
      // The single socket factory. It only ever receives Gecko's TLS providers.
      return this.SMTP.createSocketConnection({
        Components: this.Components,
        // Passed so the socket can record the TLS gate's own verdict on its
        // evidence. Without it the connection log said "accepted (no verdict
        // detail)", which is exactly the detail the log exists to carry.
        Email: this.Email,
        host: connection.host,
        port: connection.port,
        security: this.Email.securityForTLSMode(connection.tlsMode),
        ...this.transportTimeouts(),
      }).open();
    }

    async withSocket(connection, work) {
      const socket = this.openSocket(connection);
      try {
        return await work(socket);
      } finally {
        try {
          socket.close();
        } catch (_) {}
      }
    }

    // -- no-message connection test ----------------------------------------

    // Proves reachability, TLS negotiation, and credential acceptance without
    // issuing MAIL FROM, RCPT TO, or DATA. It sends no paper metadata and no
    // message of any kind.
    //
    // The result always carries a `diagnostics` report: a read-only inventory of
    // what this Zotero build actually exposes on the TLS objects, compared with
    // what the gate reads. It exists because the installed build does not expose
    // the documented members, and guessing at the shape produced two rounds of a
    // false "not encrypted" refusal on connections that were encrypted.
    async testConnection({ parentWindow, credentials, connectionConfig } = {}) {
      if (this.testInProgress) throw new Error("An SMTP connection test is already in progress");
      this.testInProgress = true;
      let testedConnection = null;
      try {
        let connection = credentials || await this.getCredentialsForManualSend({ parentWindow });
        if (!credentials && connectionConfig) {
          const displayed = this.Email.normalizeSMTPConfig(connectionConfig);
          // Allow a corrected port/TLS mode to be tested without retyping a
          // saved password, but never send it to a different host or account.
          if (displayed.host !== connection.host || displayed.username !== connection.username) {
            throw new Error("The displayed server or username differs from the saved credential. Enter a credential for this account first");
          }
          if ((displayed.authMethod === "xoauth2") !== (connection.authMethod === "xoauth2")) {
            throw new Error("Changing between password and OAuth authentication requires a new credential");
          }
          connection = { ...connection, ...displayed };
        }
        testedConnection = connection;
        // The plan must describe the flow that will actually run. The
        // credential carries the connection identity that the socket and the
        // session are built from, so it — not the saved digest options — is the
        // source of truth for the TLS mode and auth method here.
        const plan = this.Email.buildConnectionTestPlan({ config: connection });
        this.Email.assertNoMessageTransmission(plan.steps);
        return await this.withSocket(connection, (socket) => this.SMTP.runConnectionTest({
          Email: this.Email,
          socket,
          credentials: connection,
          timeouts: this.transportTimeouts(),
          Diagnostics: this.Diagnostics || null,
        }));
      } catch (error) {
        return {
          ok: false,
          messageTransmitted: false,
          error: safeError(error, "The SMTP connection test failed") + this.Email.authenticationHint(
            error?.smtpCode, testedConnection?.authMethod || "", testedConnection?.host || ""),
          // Attached by runConnectionTest while the socket was still open, which
          // is the only moment this evidence can be read.
          diagnostics: typeof error?.feedRankDiagnostics === "string" ? error.feedRankDiagnostics : "",
        };
      } finally {
        this.testInProgress = false;
      }
    }

    // -- digest snapshot ----------------------------------------------------

    readRootState() {
      const state = this.State?.load?.();
      if (!state || typeof state !== "object") throw new Error("FeedRank delivery state is unavailable");
      return state;
    }

    async mutateEmailState(mutator, { keepKey = "" } = {}) {
      if (typeof this.State?.mutate !== "function") {
        throw new Error("FeedRank's serialized state updater is unavailable; email delivery is disabled");
      }
      let result;
      await this.State.mutate(async (rootState) => {
        if (!rootState || typeof rootState !== "object") {
          throw new Error("FeedRank delivery state is unavailable");
        }
        const emailState = {
          delivery: asObject(rootState.emailDelivery),
          submissions: asObject(rootState.emailSubmissions),
        };
        result = await mutator(emailState);
        rootState.emailDelivery = emailState.delivery;
        rootState.emailSubmissions = this.pruneSubmissions(emailState.submissions, { keepKey });
        this.assertStateBounds(rootState.emailDelivery, rootState.emailSubmissions);
      });
      return result;
    }

    assertStateBounds(delivery, submissions) {
      const current = normalizedSnapshot(this.Email, asObject(delivery).currentRun);
      if (asObject(delivery).currentRun && !current) throw new Error("Digest snapshot is invalid or too large");
      const entries = Object.values(asObject(submissions));
      for (const entry of entries) {
        if (String(entry?.message || "").length > MAX_MESSAGE_STATE_LENGTH) {
          throw new Error("The frozen outgoing message is too large to save safely");
        }
      }
      if (JSON.stringify({ delivery, submissions }).length > MAX_EMAIL_STATE_LENGTH) {
        throw new Error("Digest delivery state is too large to save safely");
      }
    }

    /*
     * Keep the newest records, and NEVER the wrong ones.
     *
     * The reported failure this fixes: a message was accepted by the server, the
     * outcome could not be written, and the pane said the delivery history was
     * incomplete. The write failed because of this function. Three `retryable`
     * submissions -- failed TEST emails -- were already stored; a `retryable`
     * record is protected from eviction, and once the digest's status changed from
     * `submitting` to `accepted` it became TERMINAL, so the history budget for
     * terminal records was `MAX_SAVED_SUBMISSIONS - protected.length`, which was
     * zero. The record was pruned away in the same transaction that wrote it, the
     * read-back check that guards the write found nothing, and the caller was told
     * the outcome could not be saved.
     *
     * Two rules now hold:
     *   1. The entry the caller is writing (`keepKey`) is always kept, whatever its
     *      status and whatever else is stored. It is the record the caller reads
     *      back, and the one the pane shows as "Last email".
     *   2. In-flight and ambiguous records stay protected, but they no longer
     *      consume the whole budget: the newest of them are kept up to the cap, and
     *      the rest of the room goes to the newest completed history.
     */
    pruneSubmissions(rawSubmissions, { keepKey = "" } = {}) {
      const protectedStatuses = new Set(["prepared", "submitting", "unknown", "retryable"]);
      const valid = [];
      for (const [key, raw] of Object.entries(asObject(rawSubmissions))) {
        const submission = normalizedSubmission(this.Email, key, raw);
        if (submission) valid.push(submission);
      }
      valid.sort((left, right) => right.createdAt - left.createdAt);

      const kept = [];
      const keptKeys = new Set();
      const keep = (entry) => {
        if (!entry || keptKeys.has(entry.submissionKey)) return;
        kept.push(entry);
        keptKeys.add(entry.submissionKey);
      };

      // Rule 1: the record being written.
      keep(valid.find((entry) => entry.submissionKey === keepKey));
      // Rule 2a: the newest in-flight or ambiguous records, up to the cap.
      for (const entry of valid) {
        if (kept.length >= MAX_SAVED_SUBMISSIONS) break;
        if (protectedStatuses.has(entry.status)) keep(entry);
      }
      // Rule 2b: the newest completed history fills whatever room is left.
      for (const entry of valid) {
        if (kept.length >= MAX_SAVED_SUBMISSIONS) break;
        if (!protectedStatuses.has(entry.status)) keep(entry);
      }
      // A cap of zero -- or a state holding only the entry being written -- must
      // still return that entry rather than nothing.
      if (!kept.length) keep(valid[0]);
      return Object.fromEntries(kept.map((entry) => [entry.submissionKey, entry]));
    }

    currentSnapshot() {
      return normalizedSnapshot(this.Email, asObject(this.readRootState().emailDelivery).currentRun);
    }

    currentSubmissions() {
      const raw = asObject(this.readRootState().emailSubmissions);
      return Object.fromEntries(Object.entries(raw)
        .map(([key, value]) => [key, normalizedSubmission(this.Email, key, value)])
        .filter(([, value]) => Boolean(value)));
    }

    async recoverInterruptedSubmissions() {
      let changed = false;
      await this.mutateEmailState((emailState) => {
        const submissions = asObject(emailState.submissions);
        for (const [key, raw] of Object.entries(submissions)) {
          const submission = normalizedSubmission(this.Email, key, raw);
          if (!submission || submission.status !== "submitting") continue;
          // SMTP cannot prove the state of a message the server may already
          // hold. Fail closed.
          submissions[key] = {
            ...submission,
            status: "unknown",
            failedAt: this.clock(),
            messageSubmitted: submission.messageSubmitted === true,
            lastError: "FeedRank restarted while this message was being submitted; delivery is unknown and FeedRank will not resend it automatically.",
          };
          changed = true;
        }
      });
      return changed;
    }

    buildSnapshot({ source, runID, localDay, records, window: digestWindow } = {}) {
      if (!DIGEST_SOURCES.has(String(source || ""))) {
        throw new Error("Only completed weekly or explicitly manual runs are digest-eligible");
      }
      const config = this.loadConfig();
      const digest = this.Email.buildDigest({
        date: validDate(localDay) ? localDay : localDayNow(),
        records: Array.isArray(records) ? records : [],
        options: config,
        window: digestWindow,
        // The digest's own headings follow Zotero's UI language, the same switch the
        // panes use. The subject line does not: a stored digest is validated by its
        // subject, so its identity must not change with the reader's language.
        locale: this.Zotero?.locale,
      });
      if (!isBoundedDigest(this.Email, digest)) throw new Error("Digest content is too large or invalid");
      const snapshot = {
        schema: 2,
        source,
        runID: opaqueRunID(runID),
        localDay: digest.date,
        priorityCount: digest.priority.length,
        readingListCount: digest.readingList.length,
        recordCount: digest.priority.length + digest.readingList.length,
        contentHash: digestHash(digest),
        createdAt: this.clock(),
        digest: {
          date: digest.date,
          subject: digest.subject,
          text: digest.text,
          html: digest.html,
        },
      };
      if (!normalizedSnapshot(this.Email, snapshot)) throw new Error("Digest snapshot could not be validated");
      return snapshot;
    }

    async storeSnapshot(snapshot) {
      await this.mutateEmailState((emailState) => {
        emailState.delivery = { schema: 2, currentRun: snapshot, updatedAt: this.clock() };
      });
      return { recorded: true, snapshot: this.publicSnapshot(snapshot) };
    }

    async recordCompletedWeeklyRun({
      source, runID, localDay, records, window: digestWindow, autoSendApproved = false, parentWindow,
    } = {}) {
      if (source !== "weekly") return { recorded: false, reason: "Only completed weekly runs are auto-digest eligible" };
      const snapshot = this.buildSnapshot({ source: "weekly", runID, localDay, records, window: digestWindow });
      // By default this hook only writes an exact local preview snapshot. It
      // does not load a credential, open a dialog, or connect anywhere.
      const stored = await this.storeSnapshot(snapshot);
      // Auto delivery is an exceptionally narrow exception to the default
      // preview-first path. It is permitted only when main passes a literal
      // same-run authorization obtained from a separate pre-ranking dialog;
      // config alone, startup, a timer, and any retry state can never trigger
      // it. A failure here is reported as a non-send, never thrown back into a
      // successfully committed ranking run.
      if (autoSendApproved !== true || this.loadConfig().automaticSendingEnabled !== true) return stored;
      try {
        const prepared = await this.prepareCurrentSubmission({ parentWindow });
        if (prepared.status !== "prepared") {
          return {
            ...stored,
            autoResult: { sent: false, status: prepared.status, message: "The weekly digest already has a delivery state; it was not sent again." },
          };
        }
        const autoResult = await this.withSendLock(() =>
          this.submitPersistedSubmission(prepared, parentWindow, "Send approved weekly digest", { preApproved: true }),
        );
        return { ...stored, autoResult };
      } catch (error) {
        return {
          ...stored,
          autoResult: { sent: false, status: "not-sent", retryable: false, message: safeError(error) },
        };
      }
    }

    /*
     * Rebuild a digest and send it in one step, with no preview window.
     *
     * The single exception to the preview-first rule, and deliberately a narrow
     * one: it exists for one visible button whose label says exactly what it
     * does. That click is the confirmation, so `automaticSendingEnabled` is not
     * consulted -- this is not an automatic send, it is a manual one. Everything
     * that guards the message itself is unchanged: the digest is rebuilt from
     * exactly the records the caller passed, bounded and validated like any
     * other, frozen into wire bytes and persisted before the socket opens, and
     * an existing delivery state for the same run still blocks a second copy.
    /*
     * Rebuild the local digest from caller-supplied scored records.
     *
     * This is the whole "rebuild" function: it creates the message, bounds and
     * validates it, and stores it as the current snapshot. It opens no connection,
     * loads no credential, and consults neither the automatic-send opt-in nor the
     * delivery state.
     *
     * Writing a local digest is free and reversible: it discloses nothing and
     * cannot send anything. Gating it behind the delivery approval is what left the
     * pane saying "no digest is available yet" after a manual scoring run, which
     * reads as a broken feature.
     */
    async rebuildDigest({ records, localDay, window: digestWindow, runID } = {}) {
      if (!Array.isArray(records) || !records.length) {
        throw new Error("There are no scored articles to build a digest from");
      }
      const date = validDate(localDay) ? localDay : localDayNow();
      const snapshot = this.buildSnapshot({
        source: "manual",
        runID: boundedText(runID, 1000) || "preview:" + date,
        localDay: date,
        records,
        window: digestWindow,
      });
      await this.storeSnapshot(snapshot);
      return { built: true, snapshot: this.publicSnapshot(snapshot) };
    }

    // Kept as the older name of rebuildDigest, for a pane from a previous version
    // that is still open during an update.
    async storePreviewFromRecords(input = {}) {
      return this.rebuildDigest(input);
    }

    async prepareDigestFromRankedResults({ records, summary = {}, localDay } = {}) {
      if (!Array.isArray(records) || !records.length) {
        throw new Error("There are no scored papers to prepare for a manual digest");
      }
      const date = validDate(localDay)
        ? localDay
        : validDate(summary?.localDay)
          ? summary.localDay
          : localDayNow();
      // Invoked only by a visible user action in the scored-results window. It
      // supports manual/N-day/selected scopes, but never becomes an automatic
      // delivery source.
      const stableRunMaterial = boundedText(summary?.runID || summary?.refresh?.startedAt, 1000) ||
        "manual:" + date + ":" + fnv1a(JSON.stringify(records));
      const snapshot = this.buildSnapshot({
        source: "manual",
        runID: stableRunMaterial,
        localDay: date,
        records,
      });
      return this.storeSnapshot(snapshot);
    }

    publicSnapshot(snapshot) {
      if (!snapshot) return null;
      return {
        available: true,
        source: snapshot.source,
        localDay: snapshot.localDay,
        priorityCount: snapshot.priorityCount,
        readingListCount: snapshot.readingListCount,
        recordCount: snapshot.recordCount,
        subject: snapshot.digest.subject,
        text: snapshot.digest.text,
        html: snapshot.digest.html,
        contentHash: snapshot.contentHash,
      };
    }

    async previewCurrentDigest() {
      const snapshot = this.currentSnapshot();
      const credentials = await this.credentialSummary();
      if (!snapshot) return { available: false, credentials };
      return {
        ...this.publicSnapshot(snapshot),
        credentials,
      };
    }

    async getStatus() {
      const snapshot = this.currentSnapshot();
      const submissions = this.currentSubmissions();
      const values = Object.values(submissions);
      const currentRunHash = snapshot ? fnv1a(snapshot.runID) : "";
      const current = values
        .filter((entry) => entry.runHash === currentRunHash)
        .sort((left, right) => right.createdAt - left.createdAt)[0] || null;
      return {
        config: this.loadConfig(),
        credentials: await this.credentialSummary(),
        snapshot: this.publicSnapshot(snapshot),
        currentSubmission: current ? this.publicSubmission(current) : null,
        retryKey: current?.status === "retryable" ? current.submissionKey : "",
        // The most recent delivery this install knows about, whatever run it came
        // from, so the pane can state when the last email was actually sent.
        lastDelivery: this.lastDeliverySummary(values),
        sending: this.sendInProgress,
      };
    }

    /*
     * "Last email" for the settings pane, from the retained submission records.
     *
     * Only a real message counts: a connection test never reaches MAIL FROM and
     * is recorded separately, so it cannot be mistaken for a sent digest. The
     * newest submission decides, because a retained older success must not
     * outrank a later failure -- the pane says what happened LAST.
     *
     * An outcome that could not be written to the state is kept in memory for the
     * session (see `rememberOutcome`) and is used when it is newer than anything
     * persisted, so a delivered message whose record failed to save is still
     * reported as delivered rather than as somebody else's older failure.
     */
    lastDeliverySummary(submissions = Object.values(this.currentSubmissions())) {
      const latest = [...submissions]
        .filter((entry) => entry.kind !== "connection-test")
        .sort((left, right) => (right.acceptedAt || right.failedAt || right.createdAt) -
          (left.acceptedAt || left.failedAt || left.createdAt))[0] || null;
      const summary = (entry, recordSaved) => ({
        status: entry.status,
        accepted: entry.status === "accepted",
        date: entry.date,
        subject: entry.subject,
        to: entry.envelopeTo || entry.to,
        host: entry.host,
        attempts: entry.attempts,
        createdAt: entry.createdAt,
        acceptedAt: entry.acceptedAt,
        failedAt: entry.failedAt,
        messageSubmitted: entry.messageSubmitted === true,
        lastError: entry.lastError || "",
        recordSaved,
      });
      const persisted = latest ? summary(latest, true) : null;
      const remembered = this.sessionOutcome;
      if (!remembered) return persisted;
      // The same message: the remembered outcome is strictly better information
      // than a record that the failed write left at "submitting" or "prepared", so
      // it wins regardless of timestamps -- which is the case that reported a
      // delivered email as an older, unrelated failure.
      if (remembered.submissionKey && remembered.submissionKey === (latest?.submissionKey || "")) {
        return summary(remembered, remembered.recordSaved === true);
      }
      const rememberedAt = remembered.acceptedAt || remembered.failedAt || remembered.createdAt || 0;
      const persistedAt = persisted ? (persisted.acceptedAt || persisted.failedAt || persisted.createdAt || 0) : 0;
      if (persisted && persistedAt > rememberedAt) return persisted;
      return summary(remembered, remembered.recordSaved === true);
    }

    // Keep the newest outcome that could not be persisted, for this session only.
    // Never contains a credential: it is the same shape the service already stores.
    rememberOutcome(outcome) {
      const previous = this.sessionOutcome;
      const at = outcome?.acceptedAt || outcome?.failedAt || outcome?.createdAt || 0;
      const previousAt = previous
        ? (previous.acceptedAt || previous.failedAt || previous.createdAt || 0)
        : 0;
      if (!previous || at >= previousAt) this.sessionOutcome = { ...outcome };
      return this.sessionOutcome;
    }

    publicSubmission(submission) {
      if (!submission) return null;
      return {
        submissionKey: submission.submissionKey,
        kind: submission.kind,
        date: submission.date,
        attempts: submission.attempts,
        status: submission.status,
        createdAt: submission.createdAt,
        submittingAt: submission.submittingAt,
        acceptedAt: submission.acceptedAt,
        failedAt: submission.failedAt,
        messageSubmitted: submission.messageSubmitted,
        lastError: submission.lastError,
        subject: submission.subject,
        from: submission.from,
        to: submission.envelopeTo,
        host: submission.host,
        port: submission.port,
        tlsMode: submission.tlsMode,
      };
    }

    findBlockingSubmission(snapshot) {
      const runHash = fnv1a(snapshot.runID);
      const current = Object.values(this.currentSubmissions())
        .filter((entry) => entry.runHash === runHash)
        .sort((left, right) => right.createdAt - left.createdAt);
      return current.find((entry) => BLOCKING_STATUSES.has(entry.status)) || null;
    }

    // Build and freeze the exact wire message before the preview is shown, so
    // later ranking or settings edits cannot alter what was reviewed. The
    // frozen bytes are persisted before any connection is opened.
    buildFrozenSubmission({ connection, digest, kind, date, runID }) {
      const built = this.Email.buildMIMEMessage({
        from: connection.from,
        to: connection.to,
        subject: digest.subject,
        text: digest.text,
        html: digest.html,
        date: new Date(this.clock()),
      });
      return {
        schema: 2,
        kind,
        date: validDate(date) ? date : localDayNow(),
        runHash: fnv1a(String(runID || "")),
        submissionKey: this.Email.makeSubmissionKey({
          date: validDate(date) ? date : localDayNow(),
          runID,
          payload: {
            from: connection.from,
            to: connection.to,
            subject: digest.subject,
            html: digest.html,
            text: digest.text,
            message: built.message,
          },
        }),
        payloadHash: this.Email.payloadHash({
          from: connection.from,
          to: connection.to,
          subject: digest.subject,
          html: digest.html,
          text: digest.text,
          message: built.message,
        }),
        connectionIdentity: connectionIdentity(this.Email, connection),
        host: connection.host,
        port: connection.port,
        tlsMode: connection.tlsMode,
        authMethod: connection.authMethod,
        username: connection.username,
        from: connection.from,
        envelopeFrom: this.Email.envelopeAddress(connection.from),
        envelopeTo: connection.to,
        subject: digest.subject,
        text: digest.text,
        html: digest.html,
        message: built.message,
        messageID: built.messageID,
        messageBoundary: built.boundary,
        messageDate: this.clock(),
        attempts: 0,
        status: "prepared",
        createdAt: this.clock(),
        submittingAt: null,
        acceptedAt: null,
        failedAt: null,
        messageSubmitted: false,
        serverAccepted: false,
        lastError: "",
      };
    }

    async prepareCurrentSubmission({ parentWindow } = {}) {
      const snapshot = this.currentSnapshot();
      if (!snapshot) throw new Error("No completed FeedRank digest is available to preview or send");
      const existing = this.findBlockingSubmission(snapshot);
      if (existing) return existing;
      const connection = await this.getCredentialsForManualSend({ parentWindow });
      const prepared = this.buildFrozenSubmission({
        connection,
        digest: snapshot.digest,
        kind: "digest",
        date: snapshot.localDay,
        runID: snapshot.runID,
      });
      return this.persistSubmission(prepared);
    }

    async prepareTestSubmission({ parentWindow } = {}) {
      const connection = await this.getCredentialsForManualSend({ parentWindow });
      const date = localDayNow();
      const prepared = this.buildFrozenSubmission({
        connection,
        digest: {
          subject: this.Email.TEST_SUBJECT,
          text: "This is a non-empty manual FeedRank for Zotero SMTP delivery test. No paper metadata is included.",
          html: "<!doctype html><html><body><p>This is a non-empty manual FeedRank for Zotero SMTP delivery test. No paper metadata is included.</p></body></html>",
        },
        kind: "test",
        date,
        // A test is always a new explicit operation, never a retry of a digest.
        // The persisted state still protects a double click.
        runID: "test:" + this.clock() + ":" + fnv1a(connection.from + connection.to),
      });
      return this.persistSubmission(prepared);
    }

    /*
     * No confirmation dialog before a submission.
     *
     * The user's click IS the confirmation. The Send control lives inside the
     * preview window, which already shows the exact frozen subject, recipients,
     * and wire body, so a modal repeating that same text and asking again adds a
     * second click to the same decision without adding information.
     *
     * What replaces it is a record, not a prompt: the frozen message is persisted
     * before the connection is opened, and the connection identity is re-checked
     * against the frozen draft so the reviewed message is still the message that
     * goes out. `describeSubmission` is retained so the caller can report exactly
     * what was sent, passively, after the fact.
     */
    describeSubmission(submission) {
      return {
        host: submission.host,
        port: submission.port,
        tlsMode: submission.tlsMode,
        from: submission.from,
        to: submission.envelopeTo,
        subject: submission.subject,
        messageBytes: submission.message.length,
      };
    }

    async persistSubmission(submission) {
      const normalized = normalizedSubmission(this.Email, submission.submissionKey, submission);
      if (!normalized) throw new Error("The outgoing message could not be validated before saving");
      await this.mutateEmailState((emailState) => {
        emailState.submissions[normalized.submissionKey] = normalized;
      }, { keepKey: normalized.submissionKey });
      // A write that silently disappears must abort before any connection is
      // opened. Main's state whitelist makes this verification meaningful.
      const saved = this.currentSubmissions()[normalized.submissionKey];
      if (!saved || saved.payloadHash !== normalized.payloadHash ||
          saved.connectionIdentity !== normalized.connectionIdentity ||
          saved.status !== normalized.status) {
        throw new Error("The outgoing message could not be persisted; nothing was sent");
      }
      return saved;
    }

    // Re-validate the frozen draft against the *current* connection before it
    // is sent. If the server, addresses, TLS mode, or secret changed after the
    // preview, the reviewed message is not the message that would go out.
    assertConnectionMatchesFrozen(submission, connection) {
      const identity = connectionIdentity(this.Email, connection);
      if (identity !== submission.connectionIdentity) {
        throw new Error("The SMTP settings changed after this message was prepared. Reopen the preview and review the exact message again.");
      }
      if (connection.host !== submission.host || Number(connection.port) !== Number(submission.port) ||
          connection.tlsMode !== submission.tlsMode || connection.authMethod !== submission.authMethod) {
        throw new Error("The SMTP connection changed after this message was prepared; nothing was sent.");
      }
    }

    async submitPersistedSubmission(submission, parentWindow, actionLabel, { preApproved = false } = {}) {
      // Retrieve the transient secret before changing durable state. If the
      // secure credential was removed or locked, no attempt is recorded and
      // nothing is sent; the reviewed prepared message remains available.
      const connection = await this.getCredentialsForManualSend({ parentWindow });
      // Re-validated against the frozen draft, which is the guard that matters:
      // it guarantees the reviewed message is the message that goes out. The
      // modal that used to follow this check is gone, because the preview window
      // the user clicked Send in already showed the same text.
      this.assertConnectionMatchesFrozen(submission, connection);
      const submitting = {
        ...submission,
        status: "submitting",
        submittingAt: this.clock(),
        lastError: "",
      };
      // Persist the exact frozen message before the connection is opened.
      const persisted = await this.persistSubmission(submitting);
      const outcome = await this.dispatchSubmission(persisted, connection);
      const completed = {
        ...this.Email.recordDeliveryOutcome(persisted, outcome, { now: this.clock() }),
        // Keep the frozen wire text and its identity so a manual retry is
        // byte-identical and duplicate prevention stays checkable.
        message: persisted.message,
        messageID: persisted.messageID,
        messageBoundary: persisted.messageBoundary,
        messageDate: persisted.messageDate,
        submissionKey: persisted.submissionKey,
      };
      completed.lastError = redact(completed.lastError);
      try {
        const saved = await this.persistSubmission(completed);
        // Announced before the value is returned, so a pane that repopulates on the
        // event is already correct when the caller reports the result.
        this.notifyDeliveryChanged();
        return {
          sent: Boolean(outcome.accepted),
          status: saved.status,
          retryable: saved.status === "retryable",
          submissionKey: saved.submissionKey,
          messageSubmitted: saved.messageSubmitted,
          // The recipient travels with the outcome, so the run's closing window can
          // say WHERE the digest went instead of only that something was sent.
          to: saved.envelopeTo,
          host: saved.host,
          message: saved.status === "accepted"
            ? "The SMTP server accepted the message for delivery."
            : saved.status === "unknown"
              ? "Delivery is unknown. FeedRank will not resend this message automatically; confirm in your mailbox before acting."
              : saved.lastError || "The SMTP server did not accept the message.",
        };
      } catch (error) {
        /*
         * The server's own answer is already known here; only the local record
         * could not be written.
         *
         * Reporting "delivery unknown" for a message the server ACCEPTED is what
         * told a user their delivered email had not been sent, and left the pane
         * showing an older, unrelated failure as "Last email". The outcome object
         * is in hand, so it is reported as what it is, and it is also kept in
         * memory for this session so the status line can still show it. Nothing is
         * resent either way: no retry affordance is exposed, and no compensating
         * network call is made.
         */
        const accepted = outcome?.accepted === true;
        const failedAt = this.clock();
        this.rememberOutcome({
          submissionKey: persisted.submissionKey,
          kind: persisted.kind,
          date: persisted.date,
          status: accepted ? "accepted" : "unknown",
          accepted,
          attempts: (Number(persisted.attempts) || 0) + 1,
          createdAt: persisted.createdAt,
          acceptedAt: accepted ? failedAt : null,
          failedAt: accepted ? null : failedAt,
          messageSubmitted: outcome?.messageSubmitted === true,
          to: persisted.envelopeTo,
          host: persisted.host,
          subject: persisted.subject,
          lastError: accepted ? "" : safeError(error),
          recordSaved: false,
        });
        this.logError(
          new Error(
            "FeedRank could not save the delivery record" + (accepted ? " for an accepted message" : "") +
              ": " + safeError(error),
          ),
        );
        // The outcome is in memory even though the record could not be written, so
        // the panes are told to reread: `lastDeliverySummary` prefers this session's
        // remembered outcome over the stale stored one.
        this.notifyDeliveryChanged();
        return {
          sent: accepted,
          status: accepted ? "accepted" : "unknown",
          retryable: false,
          submissionKey: persisted.submissionKey,
          messageSubmitted: outcome?.messageSubmitted === true,
          serverAccepted: accepted,
          recordSaved: false,
          to: persisted.envelopeTo,
          host: persisted.host,
          message: accepted
            ? "The SMTP server accepted the message for delivery, but FeedRank could not update its local record. " +
              "The email has been sent; the delivery history shown here is incomplete for this message."
            : "The SMTP server replied, but FeedRank could not save the outcome. " +
              "Delivery is unknown; nothing will be resent automatically.",
        };
      }
    }

    // The single network submission. It opens a fresh TLS socket per attempt,
    // so no connection state is reused between a preview and a later retry.
    async dispatchSubmission(submission, connection) {
      try {
        return await this.withSocket(connection, (socket) => this.SMTP.submitMessage({
          Email: this.Email,
          socket,
          credentials: connection,
          submission,
          timeouts: this.transportTimeouts(),
        }));
      } catch (error) {
        // A failure while *opening* the socket provably happened before any
        // command was sent, so nothing can have been delivered.
        return this.Email.classifySMTPError(error, { messageSubmitted: false });
      }
    }

    async withSendLock(work) {
      if (this.sendInProgress) throw new Error("A message submission is already in progress");
      this.sendInProgress = true;
      try {
        return await work();
      } finally {
        this.sendInProgress = false;
      }
    }

    async sendPreparedSubmission(submissionKey, { parentWindow } = {}) {
      return this.withSendLock(async () => {
        const key = boundedText(submissionKey, 256);
        const submission = this.currentSubmissions()[key];
        if (!submission || submission.status !== "prepared") {
          throw new Error("Open the current message preview before sending; only its prepared message may be submitted");
        }
        return this.submitPersistedSubmission(submission, parentWindow, "Send");
      });
    }

    async sendCurrentDigest({ parentWindow } = {}) {
      // Public entry points are preview-first. The preview dialog calls the
      // narrowly scoped sendPreparedSubmission() only after a second explicit
      // user click, so calling a façade cannot silently start network traffic.
      return this.openPreview({ parentWindow });
    }

    // SMTP has no provider-side deduplication, so a retry of a message the
    // server may already hold can deliver a duplicate. It is offered only for a
    // provably-unsent message, or when the user has explicitly enabled manual
    // resend of an uncertain one.
    async retrySubmission(submissionKey, { parentWindow } = {}) {
      return this.withSendLock(async () => {
        const key = boundedText(submissionKey, 256);
        const submission = this.currentSubmissions()[key];
        if (!submission || submission.status !== "retryable") {
          throw new Error("Only a message that is known not to have been sent can be retried");
        }
        if (submission.messageSubmitted) {
          throw new Error("This message may already have been delivered; FeedRank will not create a possible duplicate");
        }
        return this.submitPersistedSubmission(submission, parentWindow, "Retry");
      });
    }

    async resendUnknownSubmission(submissionKey, { parentWindow } = {}) {
      /*
       * No setting gates this any more; the BUTTON is the guard.
       *
       * The removed check box ("Allow a manual resend after an unknown outcome")
       * only ever unlocked this one call, and the call is reachable only from an
       * explicitly labelled control that the pane and the preview offer only when
       * a submission's outcome is genuinely unknown. Asking for the same decision
       * twice -- once in settings, once in the click -- is the pattern this add-on
       * has already removed everywhere else. The risk is unchanged and still
       * stated: the outcome is unknown, so a resend can deliver a second copy,
       * and the caller reports that risk passively after the attempt.
       */
      return this.withSendLock(async () => {
        const key = boundedText(submissionKey, 256);
        const submission = this.currentSubmissions()[key];
        if (!submission || submission.status !== "unknown") {
          throw new Error("Only a submission with an unknown outcome can be manually resent");
        }
        const connection = await this.getCredentialsForManualSend({ parentWindow });
        this.assertConnectionMatchesFrozen(submission, connection);
        const submitting = { ...submission, status: "submitting", submittingAt: this.clock(), lastError: "" };
        const persisted = await this.persistSubmission(submitting);
        const outcome = await this.dispatchSubmission(persisted, connection);
        const completed = {
          ...this.Email.recordDeliveryOutcome(persisted, outcome, { now: this.clock() }),
          message: persisted.message,
          messageID: persisted.messageID,
          messageBoundary: persisted.messageBoundary,
          messageDate: persisted.messageDate,
          submissionKey: persisted.submissionKey,
        };
        completed.lastError = redact(completed.lastError);
        const saved = await this.persistSubmission(completed);
        return {
          sent: Boolean(outcome.accepted),
          status: saved.status,
          retryable: saved.status === "retryable",
          submissionKey: saved.submissionKey,
          message: saved.status === "accepted"
            ? "The SMTP server accepted the resent message. A duplicate delivery is possible."
            : saved.lastError || "The SMTP server did not accept the resent message.",
        };
      });
    }

    /*
     * The duplicate-risk text, retained as a DESCRIPTION rather than a dialog.
     *
     * It is still produced so the outcome can report the risk passively, after
     * the resend has been attempted, instead of blocking on it beforehand. The
     * guard that prevents an accidental duplicate is the opt-in setting, which is
     * off by default and is what this text used to describe.
     */
    describeDuplicateRisk(submission) {
      return [
        "This message may already have been delivered.",
        "Recipient " + submission.envelopeTo + ", subject \u201c" + submission.subject + "\u201d.",
        "First attempt " + new Date(submission.createdAt).toLocaleString() + ".",
        "Resending can deliver a second copy, and FeedRank cannot remove it.",
      ].join(" ");
    }

    async openPreview({ parentWindow } = {}) {
      let preview = await this.previewCurrentDigest();
      if (!preview.available) throw new Error("No completed FeedRank digest is available yet");
      let prepared = null;
      let preparationError = "";
      try {
        prepared = await this.prepareCurrentSubmission({ parentWindow });
      } catch (error) {
        // A body-only preview remains useful before credentials are entered,
        // but it deliberately has no enabled Send action.
        preparationError = safeError(error);
      }
      if (prepared) {
        preview = {
          ...preview,
          subject: prepared.subject,
          text: prepared.text,
          html: prepared.html,
          credentials: {
            configured: true,
            storage: "prepared",
            persistent: false,
            host: prepared.host,
            port: prepared.port,
            tlsMode: prepared.tlsMode,
            username: prepared.username,
            from: prepared.from,
            to: prepared.envelopeTo,
          },
          frozen: true,
          submissionKey: prepared.submissionKey,
          messageSize: prepared.message.length,
        };
      } else {
        preview = { ...preview, frozen: false, preparationError };
      }
      if (typeof parentWindow?.openDialog !== "function") return preview;
      const status = await this.getStatus();
      const args = {
        preview,
        submission: status.currentSubmission,
        retryKey: status.retryKey,
        // A separately labelled action, offered only for an unknown outcome: the
        // click itself is the confirmation, and the label names the risk.
        resendKey: status.currentSubmission?.status === "unknown"
          ? status.currentSubmission.submissionKey
          : "",
        send: prepared?.status === "prepared"
          ? () => this.sendPreparedSubmission(prepared.submissionKey, { parentWindow })
          : null,
        retry: (key) => this.retrySubmission(key, { parentWindow }),
        resend: (key) => this.resendUnknownSubmission(key, { parentWindow }),
      };
      parentWindow.openDialog(
        "chrome://feedranker/content/email-preview.xhtml",
        "feed-ranker-email-preview",
        // Dependent: the preview is read while Zotero keeps working, and a refresh
        // must not push the message being reviewed behind the main window.
        "chrome,dialog=no,dependent=yes,resizable,centerscreen,width=900,height=760",
        args,
      );
      return preview;
    }

    async openTestPreview({ parentWindow } = {}) {
      const prepared = await this.prepareTestSubmission({ parentWindow });
      const preview = {
        available: true,
        source: "manual-test",
        localDay: prepared.date,
        priorityCount: 0,
        readingListCount: 0,
        recordCount: 0,
        subject: prepared.subject,
        text: prepared.text,
        html: prepared.html,
        contentHash: prepared.payloadHash,
        frozen: true,
        submissionKey: prepared.submissionKey,
        messageSize: prepared.message.length,
        credentials: {
          configured: true,
          storage: "prepared",
          persistent: false,
          host: prepared.host,
          port: prepared.port,
          tlsMode: prepared.tlsMode,
          username: prepared.username,
          from: prepared.from,
          to: prepared.envelopeTo,
        },
      };
      if (typeof parentWindow?.openDialog !== "function") return preview;
      parentWindow.openDialog(
        "chrome://feedranker/content/email-preview.xhtml",
        "feed-ranker-email-test-preview",
        "chrome,dialog=no,dependent=yes,resizable,centerscreen,width=900,height=760",
        {
          preview,
          submission: this.publicSubmission(prepared),
          retryKey: "",
          resendKey: "",
          send: () => this.sendPreparedSubmission(prepared.submissionKey, { parentWindow }),
          retry: null,
          resend: null,
        },
      );
      return preview;
    }

    // A real email test is a separate, explicit action from the no-message
    // connection test, and it is still preview-first: the dialog's Send action
    // asks for a second exact-content confirmation before its one submission.
    async sendTestEmail({ parentWindow } = {}) {
      return this.openTestPreview({ parentWindow });
    }

    // These façade aliases let score-results UI use an intentionally
    // preview-first flow. Neither function opens a connection.
    async previewDigest(input = {}, summaryArgument, parentWindowArgument) {
      const { records, summary, localDay, parentWindow } = Array.isArray(input)
        ? { records: input, summary: summaryArgument, parentWindow: parentWindowArgument }
        : asObject(input);
      if (Array.isArray(records)) {
        await this.prepareDigestFromRankedResults({ records, summary, localDay });
      }
      return this.openPreview({ parentWindow });
    }

    async sendDigest(input = {}, summaryArgument, parentWindowArgument) {
      const { records, summary, localDay, parentWindow } = Array.isArray(input)
        ? { records: input, summary: summaryArgument, parentWindow: parentWindowArgument }
        : asObject(input);
      if (Array.isArray(records)) {
        await this.prepareDigestFromRankedResults({ records, summary, localDay });
      }
      return this.openPreview({ parentWindow });
    }
  }

  return Object.freeze({
    EMAIL_CONFIG_PREF,
    LOGIN_ORIGIN,
    LOGIN_REALM,
    LOGIN_KIND,
    MAX_DIGEST_PAPERS,
    MAX_SAVED_SUBMISSIONS,
    MAX_MESSAGE_STATE_LENGTH,
    MAX_EMAIL_STATE_LENGTH,
    BLOCKING_STATUSES,
    normalizeEmailConfig,
    parseLoginMetadata,
    connectionIdentity,
    create(dependencies) {
      return new FeedRankEmailService(dependencies);
    },
  });
});
