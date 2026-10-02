"use strict";

/*
 * Service-level tests for FeedRank's SMTP delivery state machine
 * (chrome/content/email-service.js).
 *
 * Everything here is local and offline. The Zotero/Services/State environment
 * is a fake in the style of tests/core.test.js, and the transport is a mock
 * SMTP dependency that drives a scripted in-memory socket: every command and
 * every message byte is read back from that socket's write transcript, so
 * "no message was transmitted" and "exactly one message was submitted" are
 * asserted against the bytes that would have reached the wire.
 *
 * NOTE ON THE TRANSPORT DOUBLE: both `runConnectionTest` and `submitMessage`
 * below are the *real* functions from chrome/content/email-smtp.js. Only the
 * socket is a double, so the command sequence, the MIME bytes, the dot-stuffing
 * and the reply handling under test are all the shipped implementations.
 */

const assert = require("node:assert/strict");
const Email = require("../chrome/content/email.js");
const EmailService = require("../chrome/content/email-service.js");
const RealSMTP = require("../chrome/content/email-smtp.js");

const CRLF = "\r\n";
const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

// 2026-10-01T00:00:00Z. A fixed clock keeps every frozen Message-ID date, key
// and timestamp deterministic.
const FIXED_NOW = Date.UTC(2026, 9, 1);
const SECRET = "unit-test-only-smtp-secret";
const CIPHERTEXT_PREFIX = "oskeystore-ciphertext:";

const CONNECTION = Object.freeze({
  host: "smtp.example.test",
  port: 465,
  tlsMode: "implicit",
  authMethod: "plain",
  username: "digest@example.test",
  from: "FeedRank <digest@example.test>",
  to: "reader@example.test",
});

const USABLE_TLS = Object.freeze({
  securityInfoPresent: true,
  encrypted: true,
  failedVerification: false,
  failedCertChain: false,
  hasSecurityError: false,
  sslVersionUsed: 0x0303,
  plaintextFallbackUsed: false,
});

const GREETING = "220 smtp.example.test ESMTP FeedRank test server" + CRLF;
const EHLO_IMPLICIT = [
  "250-smtp.example.test hello [10.0.0.1]",
  "250-SIZE 35882577",
  "250-8BITMIME",
  "250-AUTH PLAIN LOGIN XOAUTH2",
  "250 SMTPUTF8",
].join(CRLF) + CRLF;
const EHLO_STARTTLS = [
  "250-smtp.example.test hello [10.0.0.1]",
  "250-SIZE 35882577",
  "250-STARTTLS",
  "250 AUTH PLAIN",
].join(CRLF) + CRLF;
const STARTTLS_READY = "220 2.0.0 Ready to start TLS" + CRLF;
const AUTH_OK = "235 2.7.0 Authentication successful" + CRLF;
const SENDER_OK = "250 2.1.0 Sender OK" + CRLF;
const RECIPIENT_OK = "250 2.1.5 Recipient OK" + CRLF;
const DATA_READY = "354 Start mail input; end with <CRLF>.<CRLF>" + CRLF;
const QUEUED = "250 2.0.0 Ok: queued as 4Wx1AbCdEf" + CRLF;
const BYE = "221 2.0.0 Bye" + CRLF;

const ACCEPTED_REPLIES = [
  GREETING, EHLO_IMPLICIT, AUTH_OK, SENDER_OK, RECIPIENT_OK, DATA_READY, QUEUED, BYE,
];

// ---------------------------------------------------------------------------
// Fixtures and harness
// ---------------------------------------------------------------------------

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function base64(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function paper(overrides = {}) {
  return {
    id: "1:ABC123",
    title: "A ranked photonics paper",
    score: 92,
    confidence: "high",
    reason: "Directly relevant to the research profile.",
    source: "Test Feed",
    date: "2026-09-30",
    doi: "10.1000/example",
    url: "https://example.test/paper",
    ...overrides,
  };
}

function normalizedConnection(overrides = {}) {
  return Email.normalizeSMTPConfig({ ...CONNECTION, ...overrides });
}

function createOSKeyStore({ fail = false } = {}) {
  return {
    encryptCalls: [],
    async encrypt(value) {
      if (fail) throw new Error("simulated OS key store failure");
      this.encryptCalls.push(value);
      return CIPHERTEXT_PREFIX + Buffer.from(String(value), "utf8").toString("base64");
    },
    async decrypt(value) {
      return Buffer.from(String(value).slice(CIPHERTEXT_PREFIX.length), "base64").toString("utf8");
    },
    async isEncrypted(value) {
      return String(value).startsWith(CIPHERTEXT_PREFIX);
    },
    async ensureLoggedIn() {
      return true;
    },
  };
}

function createLogins({ failAdd = false } = {}) {
  const records = [];
  return {
    records,
    async searchLoginsAsync(query) {
      return records.filter((record) =>
        record.origin === query.origin && record.httpRealm === query.httpRealm);
    },
    async addLoginAsync(login) {
      if (failAdd) throw new Error("simulated Login Manager write failure");
      records.push(login);
    },
    // Zotero 10 removes records with the synchronous call; there is no removeLoginAsync to rely on.
    removeLogin(login) {
      const index = records.indexOf(login);
      if (index >= 0) records.splice(index, 1);
    },
    async modifyLogin(oldLogin, replacement) {
      const index = records.indexOf(oldLogin);
      if (index >= 0) records.splice(index, 1, replacement);
    },
  };
}

// A scripted SMTP peer. Canned replies are shifted off the queue in the exact
// order the state machine reads them; an Error entry makes the read fail the
// way a timeout or a dropped connection would.
function createScriptedSocket(security, replies) {
  const socket = {
    security,
    replies: [...replies],
    writes: [],
    opened: false,
    closed: false,
    tlsStarted: false,
    evidence: { ...USABLE_TLS },
    open() {
      socket.opened = true;
      return socket;
    },
    write(value) {
      socket.writes.push(String(value));
    },
    readReplyText() {
      const next = socket.replies.shift();
      if (next === undefined) {
        throw new Error("The SMTP connection closed before a complete reply arrived");
      }
      if (next instanceof Error) throw next;
      return String(next);
    },
    async startTLS() {
      socket.tlsStarted = true;
      return { ...socket.evidence };
    },
    describeSecurity() {
      return { ...socket.evidence };
    },
    isAlive() {
      return !socket.closed;
    },
    close() {
      socket.closed = true;
    },
  };
  return socket;
}

function createTransport() {
  const transport = {
    connections: [],
    queued: [],
    queue(replies = ACCEPTED_REPLIES) {
      transport.queued.push([...replies]);
    },
    createSocketConnection(options) {
      const replies = transport.queued.shift() || [...ACCEPTED_REPLIES];
      const socket = createScriptedSocket(options.security, replies);
      socket.host = options.host;
      socket.port = options.port;
      transport.connections.push(socket);
      return socket;
    },
    writes() {
      return transport.connections.flatMap((socket) => socket.writes);
    },
    // The frozen MIME text always begins with "MIME-Version: 1.0", so message
    // bodies can be told apart from SMTP command lines in the raw transcript.
    messageBodies() {
      return transport.writes().filter((write) => write.startsWith("MIME-Version: 1.0"));
    },
    commands() {
      return transport.writes().filter((write) => !write.startsWith("MIME-Version: 1.0"));
    },
  };
  return transport;
}

function createSMTP(transport) {
  return {
    submissions: [],
    connectionTests: [],
    createSocketConnection(options) {
      return transport.createSocketConnection(options);
    },
    runConnectionTest(args) {
      // The real, shipped connection test: it never issues MAIL FROM/RCPT
      // TO/DATA, and that is what the transcript assertions below check.
      this.connectionTests.push(args);
      return RealSMTP.runConnectionTest(args);
    },
    submitMessage(args) {
      // The REAL shipped submission path. This is what proves the whole service
      // reaches DATA and the terminating dot, not a local reproduction.
      this.submissions.push(args);
      return RealSMTP.submitMessage(args);
    },
  };
}

function createHarness(options = {}) {
  const osKeyStore = options.osKeyStore || createOSKeyStore();
  const logins = options.logins || createLogins();
  const clock = options.clock || (() => FIXED_NOW);
  const failWrite = options.failWrite || (() => false);
  const dropWrite = options.dropWrite || (() => false);
  const preferences = new Map(Object.entries(options.prefs || {}));
  const prompts = [];
  let confirmHandler = options.confirm || (() => true);
  let state = clone(options.initialState || {
    schema: 3,
    ranks: {},
    emailDelivery: {},
    emailSubmissions: {},
  });
  let queue = Promise.resolve();

  const stateAdapter = {
    load: () => clone(state),
    mutate(mutator) {
      const run = async () => {
        const draft = clone(state);
        await mutator(draft);
        // A silently dropped write must be indistinguishable from a lost one.
        if (dropWrite(draft)) return clone(state);
        if (failWrite(draft)) throw new Error("simulated state persistence failure");
        state = draft;
        return clone(state);
      };
      const operation = queue.then(run, run);
      queue = operation.catch(() => {});
      return operation;
    },
  };

  const transport = createTransport();
  const SMTP = createSMTP(transport);
  const Zotero = {
    Prefs: {
      get: (key) => preferences.get(key) || "",
      set: (key, value) => preferences.set(key, value),
    },
    OSKeyStore: osKeyStore,
  };
  const Services = {
    prompt: {
      confirm(parentWindow, title, message) {
        prompts.push({ title, message });
        return Boolean(confirmHandler(parentWindow, title, message));
      },
    },
    logins,
  };
  const Components = {
    interfaces: { nsILoginInfo: {} },
    Constructor: function Constructor() {
      return function LoginInfo(origin, formActionOrigin, httpRealm, username, password) {
        this.origin = origin;
        this.formActionOrigin = formActionOrigin;
        this.httpRealm = httpRealm;
        this.username = username;
        this.password = password;
      };
    },
  };

  const service = EmailService.create({ Zotero, Services, Components, Email, SMTP, State: stateAdapter, clock });
  return {
    service,
    Zotero,
    Services,
    Components,
    SMTP,
    transport,
    prompts,
    prefs: preferences,
    logins,
    osKeyStore,
    state: () => clone(state),
    setConfirm(handler) {
      confirmHandler = handler;
    },
  };
}

async function configureSession(service, overrides = {}, preferPersistent = false) {
  return service.saveCredentials({ ...CONNECTION, ...overrides, secret: SECRET, preferPersistent });
}

async function prepareWeekly(harness, { runID = "weekly-run-1", records = [paper()] } = {}) {
  await configureSession(harness.service);
  await harness.service.recordCompletedWeeklyRun({
    source: "weekly",
    runID,
    localDay: "2026-09-30",
    records,
  });
  await harness.service.openPreview({});
  const status = await harness.service.getStatus();
  assert.equal(status.currentSubmission.status, "prepared");
  return status.currentSubmission;
}

function assertNoSecretIn(values, label) {
  for (const value of values) {
    assert.equal(
      String(value).includes(SECRET),
      false,
      label + " must not contain the SMTP secret",
    );
  }
}

// The frozen, persisted record. The public submission view deliberately omits
// the wire text, so byte-level assertions read the durable state instead.
function frozenSubmission(harness, submissionKey) {
  const entry = harness.state().emailSubmissions[submissionKey];
  assert.ok(entry, "no frozen submission is persisted for " + submissionKey);
  return entry;
}

// ---------------------------------------------------------------------------
// Frozen preview and persisted state
// ---------------------------------------------------------------------------

test("a prepared preview freezes the exact wire bytes and persists no credential", async () => {
  const harness = createHarness();
  const prepared = await prepareWeekly(harness);
  const frozen = frozenSubmission(harness, prepared.submissionKey);

  assert.equal(prepared.kind, "digest");
  assert.equal(prepared.subject, Email.digestSubject("2026-09-30"));
  assert.equal(prepared.status, "prepared");
  assert.equal(frozen.status, "prepared");
  assert.equal(frozen.attempts, 0);
  assert.equal(frozen.messageSubmitted, false);
  // The persisted message is the full MIME text, byte-for-byte reproducible
  // from the stored parts.
  assert.equal(frozen.message, Email.buildMIMEMessage({
    from: frozen.from,
    to: frozen.envelopeTo,
    subject: frozen.subject,
    text: frozen.text,
    html: frozen.html,
    date: new Date(frozen.messageDate),
    messageID: frozen.messageID,
    boundary: frozen.messageBoundary,
  }).message);
  assert.ok(frozen.message.startsWith("MIME-Version: 1.0" + CRLF));
  assert.ok(frozen.message.includes("Subject: =?UTF-8?B?" + base64(Email.digestSubject("2026-09-30")) + "?="));
  assert.ok(frozen.message.endsWith("--" + frozen.messageBoundary + "--" + CRLF));
  // Both base64 parts decode back to the reviewed digest bodies.
  const encodedParts = [...frozen.message.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/g)]
    .map((match) => match[1].replace(/\r\n/g, ""));
  assert.equal(encodedParts.length, 2);
  assert.equal(Buffer.from(encodedParts[0], "base64").toString("utf8"), frozen.text);
  assert.equal(Buffer.from(encodedParts[1], "base64").toString("utf8"), frozen.html);
  assert.ok(frozen.text.includes("A ranked photonics paper"));
  assert.equal(harness.transport.connections.length, 0, "preparing must not connect");

  const state = harness.state();
  const entry = state.emailSubmissions[prepared.submissionKey];
  assert.ok(entry, "the frozen message must be persisted before any preview");
  assert.equal(entry.message, frozen.message);
  assert.equal(entry.payloadHash, Email.payloadHash({
    from: entry.from,
    to: entry.envelopeTo,
    subject: entry.subject,
    text: entry.text,
    html: entry.html,
    message: entry.message,
  }));
  assert.equal(entry.connectionIdentity, EmailService.connectionIdentity(Email, normalizedConnection()));
  assert.equal(entry.submissionKey.length <= 256, true);
  assert.equal(Object.hasOwn(entry, "secret"), false);
  assertNoSecretIn([JSON.stringify(state)], "persisted state");
  // The AUTH material for this credential appears in no persisted form.
  assert.equal(
    JSON.stringify(state).includes(base64("\u0000" + CONNECTION.username + "\u0000" + SECRET)),
    false,
  );
});

test("clearing the SMTP credential removes the record, and a silent failure is not called success", async () => {
  const harness = createHarness();
  await harness.service.saveCredentials({ ...CONNECTION, secret: SECRET });
  assert.equal(harness.logins.records.length, 1);
  assert.equal(typeof harness.logins.removeLoginAsync, "undefined", "this Zotero has no removeLoginAsync");
  const cleared = await harness.service.clearCredentials();
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.persistentCleared, true);
  assert.equal(harness.logins.records.length, 0, "the record must really be gone");

  // The failure that reached a user: a removal that does nothing must not report success.
  const stubborn = createHarness();
  await stubborn.service.saveCredentials({ ...CONNECTION, secret: SECRET });
  stubborn.logins.removeLogin = () => {};
  const outcome = await stubborn.service.clearCredentials();
  assert.equal(outcome.cleared, false, "the record survived, so the credential is still connected");
  assert.equal(outcome.persistentCleared, false);
  assert.equal(stubborn.logins.records.length, 1);
});

test("the SMTP secret can be exported as ciphertext and restored where it decrypts", async () => {
  const harness = createHarness();
  await harness.service.saveCredentials({ ...CONNECTION, secret: SECRET });

  const exported = await harness.service.exportStoredSecret();
  assert.ok(exported.ciphertext.startsWith(CIPHERTEXT_PREFIX));
  assert.equal(
    JSON.stringify(exported).includes(SECRET),
    false,
    "the export is the stored ciphertext, never the password",
  );

  // Same machine: the record is rebuilt from the file's ciphertext plus the connection the
  // settings state, and the secret then decrypts again.
  await harness.service.clearCredentials();
  assert.deepEqual(
    await harness.service.restoreStoredSecret({
      ciphertext: exported.ciphertext,
      connection: normalizedConnection(),
    }),
    { restored: true, usable: true, reason: "ok" },
  );
  assert.equal(harness.logins.records.length, 1);
  assert.equal((await harness.service.getCredentialsForManualSend({})).secret, SECRET);

  /*
   * A file from another machine or OS account: the secret is left empty. It is verified before it
   * is written, so a record that could never be decrypted is not installed in the first place.
   */
  const refusing = createOSKeyStore();
  refusing.decrypt = async () => {
    throw new Error("this OS account cannot decrypt that value");
  };
  const foreign = createHarness({ osKeyStore: refusing });
  assert.deepEqual(
    await foreign.service.restoreStoredSecret({
      ciphertext: exported.ciphertext,
      connection: normalizedConnection(),
    }),
    { restored: false, usable: false, reason: "undecryptable" },
  );
  assert.equal(foreign.logins.records.length, 0, "an undecryptable value is never stored");
  const summary = await foreign.service.credentialSummary();
  assert.equal(summary.configured, false, "nothing is configured after a failed restore");
  assert.equal(summary.storage, "none");

  // Plaintext is refused, and a ciphertext with no usable connection is refused too -- checked on
  // a store that CAN decrypt it, so the connection check is what decides.
  assert.deepEqual(
    await foreign.service.restoreStoredSecret({
      ciphertext: SECRET,
      connection: normalizedConnection(),
    }),
    { restored: false, usable: false, reason: "not-encrypted" },
  );
  assert.deepEqual(
    await harness.service.restoreStoredSecret({ ciphertext: exported.ciphertext, connection: {} }),
    { restored: false, usable: false, reason: "no-connection" },
  );
  assert.equal(harness.logins.records.length, 1, "a refused restore leaves the existing record alone");
});

// ---------------------------------------------------------------------------
// Credential storage
// ---------------------------------------------------------------------------

test("persistent credentials are OSKeyStore ciphertext in one Login Manager record", async () => {
  const harness = createHarness();
  const status = await harness.service.saveCredentials({ ...CONNECTION, secret: SECRET });

  assert.equal(status.configured, true);
  assert.equal(status.storage, "login-manager");
  assert.equal(status.persistent, true);
  assertNoSecretIn([JSON.stringify(status)], "the public credential status");
  assert.deepEqual(harness.osKeyStore.encryptCalls, [SECRET]);

  assert.equal(harness.logins.records.length, 1);
  const record = harness.logins.records[0];
  assert.equal(record.origin, EmailService.LOGIN_ORIGIN);
  assert.equal(record.httpRealm, EmailService.LOGIN_REALM);
  assert.ok(record.password.startsWith(CIPHERTEXT_PREFIX), "only ciphertext may be stored");
  assert.equal(record.password.includes(SECRET), false);
  assert.equal(record.username.includes(SECRET), false);

  // The login's "username" field carries non-secret connection metadata only.
  const metadata = EmailService.parseLoginMetadata(record.username, Email);
  assert.ok(metadata, "the stored username field must parse as connection metadata");
  assert.equal(metadata.version, 2);
  assert.equal(metadata.kind, EmailService.LOGIN_KIND);
  assert.equal(metadata.host, CONNECTION.host);
  assert.equal(metadata.port, CONNECTION.port);
  assert.equal(metadata.tlsMode, CONNECTION.tlsMode);
  assert.equal(metadata.authMethod, CONNECTION.authMethod);
  assert.equal(metadata.username, CONNECTION.username);
  assert.equal(metadata.from, CONNECTION.from);
  assert.equal(metadata.to, CONNECTION.to);

  // Saving again replaces the one record instead of accumulating more.
  await harness.service.saveCredentials({ ...CONNECTION, secret: SECRET });
  assert.equal(harness.logins.records.length, 1);

  // No preference value may ever hold the secret.
  harness.service.saveConfig({ automaticSendingEnabled: false });
  assert.ok(harness.prefs.size > 0, "the non-secret config preference must still be written");
  assertNoSecretIn([...harness.prefs.values()], "the preference store");
  assertNoSecretIn([JSON.stringify(harness.state())], "persisted state");

  // The secret survives only inside the OSKeyStore ciphertext.
  await harness.service.shutdown();
  const restored = await harness.service.getCredentialsForManualSend({});
  assert.equal(restored.secret, SECRET);
  assert.equal(restored.host, CONNECTION.host);
});

test("a persistence failure falls back to session-only with a warning and writes no plaintext", async () => {
  const failingKeyStore = createHarness({ osKeyStore: createOSKeyStore({ fail: true }) });
  const keyStoreStatus = await failingKeyStore.service.saveCredentials({ ...CONNECTION, secret: SECRET });
  assert.equal(keyStoreStatus.storage, "session");
  assert.equal(keyStoreStatus.persistent, false);
  assert.equal(keyStoreStatus.configured, true);
  assert.match(keyStoreStatus.warning, /Secure persistence was unavailable/);
  assert.equal(failingKeyStore.logins.records.length, 0);
  assert.equal(failingKeyStore.osKeyStore.encryptCalls.length, 0);
  assertNoSecretIn([...failingKeyStore.prefs.values()], "the preference store");
  assertNoSecretIn([JSON.stringify(failingKeyStore.state())], "persisted state");
  // The credential is still usable for this session only.
  assert.equal((await failingKeyStore.service.getCredentialsForManualSend({})).secret, SECRET);

  const failingLogins = createHarness({ logins: createLogins({ failAdd: true }) });
  const loginStatus = await failingLogins.service.saveCredentials({ ...CONNECTION, secret: SECRET });
  assert.equal(loginStatus.storage, "session");
  assert.equal(loginStatus.persistent, false);
  assert.match(loginStatus.warning, /Secure persistence was unavailable/);
  assert.equal(failingLogins.logins.records.length, 0);
  assert.equal(JSON.stringify(failingLogins.osKeyStore.encryptCalls).includes(SECRET), true);
  assertNoSecretIn([...failingLogins.prefs.values()], "the preference store");
  assertNoSecretIn([JSON.stringify(failingLogins.state())], "persisted state");
});

// ---------------------------------------------------------------------------
// Persistence before submission
// ---------------------------------------------------------------------------

test("a pre-submission persistence failure results in zero sockets and zero commands", async () => {
  // Variant 1: the state mutation itself rejects.
  let failSubmitting = false;
  const throwing = createHarness({
    failWrite: (draft) => failSubmitting &&
      Object.values(draft.emailSubmissions).some((entry) => entry.status === "submitting"),
  });
  const throwingPrepared = await prepareWeekly(throwing);
  failSubmitting = true;
  await assert.rejects(
    throwing.service.sendPreparedSubmission(throwingPrepared.submissionKey, {}),
    /persistence failure|persisted/i,
  );
  assert.equal(throwing.transport.connections.length, 0);
  assert.equal(throwing.transport.commands().length, 0);

  // Variant 2: the write silently disappears.
  const dropped = createHarness({
    dropWrite: (draft) =>
      Object.values(draft.emailSubmissions).some((entry) => entry.status === "submitting"),
  });
  const droppedPrepared = await prepareWeekly(dropped);
  await assert.rejects(
    dropped.service.sendPreparedSubmission(droppedPrepared.submissionKey, {}),
    /could not be persisted/i,
  );
  assert.equal(dropped.transport.connections.length, 0);
  assert.equal(dropped.transport.commands().length, 0);
  // The reviewed prepared message is still available after the failure.
  assert.equal(dropped.state().emailSubmissions[droppedPrepared.submissionKey].status, "prepared");
});

test("an interrupted submission becomes unknown on startup with zero connections", async () => {
  const first = createHarness();
  const prepared = await prepareWeekly(first);
  const interrupted = first.state();
  interrupted.emailSubmissions[prepared.submissionKey].status = "submitting";
  interrupted.emailSubmissions[prepared.submissionKey].submittingAt = FIXED_NOW;

  const restarted = createHarness({ initialState: interrupted });
  const status = await restarted.service.startup();
  assert.equal(restarted.transport.connections.length, 0, "startup must never connect");
  assert.equal(restarted.SMTP.submissions.length, 0);
  const entry = restarted.state().emailSubmissions[prepared.submissionKey];
  assert.equal(entry.status, "unknown");
  assert.equal(entry.messageSubmitted, false);
  assert.match(entry.lastError, /restarted/i);
  assert.equal(status.currentSubmission.status, "unknown");
  assert.equal(status.retryKey, "", "an unknown outcome must not be offered as a retry");
  assert.equal(status.sending, false);
  await assert.rejects(
    restarted.service.retrySubmission(prepared.submissionKey, {}),
    /known not to have been sent/,
  );
});

// ---------------------------------------------------------------------------
// Submission locking and confirmation
// ---------------------------------------------------------------------------

test("two overlapping sends produce exactly one SMTP submission", async () => {
  const harness = createHarness();
  const prepared = await prepareWeekly(harness);
  harness.transport.queue();

  const first = harness.service.sendPreparedSubmission(prepared.submissionKey, {});
  await assert.rejects(
    harness.service.sendPreparedSubmission(prepared.submissionKey, {}),
    /already in progress/,
  );
  const result = await first;
  assert.equal(result.status, "accepted");
  assert.equal(result.sent, true);
  assert.equal(harness.SMTP.submissions.length, 1);
  assert.equal(harness.transport.connections.length, 1);
  assert.equal(harness.transport.messageBodies().length, 1);
  assert.equal(harness.transport.commands().filter((line) => line === "DATA" + CRLF).length, 1);
  assert.equal(harness.state().emailSubmissions[prepared.submissionKey].status, "accepted");
});

test("the email test transmits exactly one message and needs the preview flow", async () => {
  const harness = createHarness();
  await configureSession(harness.service);

  const preview = await harness.service.sendTestEmail({});
  assert.equal(preview.subject, Email.TEST_SUBJECT);
  assert.equal(preview.frozen, true);
  assert.match(preview.text, /non-empty manual FeedRank/i);
  assert.doesNotMatch(preview.text, /A ranked photonics paper/);
  assert.equal(harness.transport.connections.length, 0, "opening a preview must not connect");
  assert.equal(harness.state().emailSubmissions[preview.submissionKey].status, "prepared");
  // No confirmation dialog exists any more: the Send control lives inside the
  // preview window, which already shows the exact frozen message, so the click is
  // the decision.
  assert.equal(harness.prompts.length, 0, "sending must not open a confirmation");

  harness.transport.queue();
  const sent = await harness.service.sendPreparedSubmission(preview.submissionKey, {});
  assert.equal(sent.status, "accepted");
  assert.equal(harness.SMTP.submissions.length, 1);
  assert.equal(harness.transport.connections.length, 1);
  const commands = harness.transport.commands();
  assert.deepEqual(
    commands.filter((line) => /^(MAIL FROM|RCPT TO|DATA)/.test(line)),
    ["MAIL FROM <" + CONNECTION.username + ">" + CRLF, "RCPT TO <" + CONNECTION.to + ">" + CRLF, "DATA" + CRLF],
  );
  const bodies = harness.transport.messageBodies();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0], Email.dotStuff(frozenSubmission(harness, preview.submissionKey).message));
  assert.equal(harness.state().emailSubmissions[preview.submissionKey].status, "accepted");
});

// ---------------------------------------------------------------------------
// The no-message connection test
// ---------------------------------------------------------------------------

test("the connection test sends no MAIL FROM, RCPT TO, or DATA and reports messageTransmitted false", async () => {
  const harness = createHarness();
  await configureSession(harness.service);
  harness.transport.queue();

  const result = await harness.service.testConnection({});
  assert.equal(result.ok, true);
  assert.equal(result.messageTransmitted, false);
  assert.equal(result.tlsMode, "implicit");
  assert.equal(result.protocol, "TLS 1.2");
  assert.equal(harness.transport.connections.length, 1);
  assert.equal(harness.SMTP.connectionTests.length, 1);
  assert.equal(harness.SMTP.submissions.length, 0);

  const commands = harness.transport.commands();
  assert.deepEqual(commands, [
    "EHLO feedrank.local" + CRLF,
    "AUTH PLAIN " + base64("\u0000" + CONNECTION.username + "\u0000" + SECRET) + CRLF,
    "QUIT" + CRLF,
  ]);
  for (const forbidden of [/^MAIL FROM/, /^RCPT TO/, /^DATA/, /^BDAT/]) {
    assert.equal(commands.some((line) => forbidden.test(line)), false, String(forbidden));
  }
  assert.equal(harness.transport.messageBodies().length, 0);
  assert.equal(harness.SMTP.submissions.length, 0);

  // The STARTTLS variant upgrades before any credential is written, and still
  // transmits no message.
  const upgraded = createHarness();
  await configureSession(upgraded.service, { tlsMode: "starttls", port: 587 });
  upgraded.transport.queue([GREETING, EHLO_STARTTLS, STARTTLS_READY, EHLO_IMPLICIT, AUTH_OK, BYE]);
  const upgradeResult = await upgraded.service.testConnection({});
  assert.equal(upgradeResult.ok, true);
  assert.equal(upgradeResult.messageTransmitted, false);
  assert.equal(upgradeResult.tlsMode, "starttls");
  const upgradeCommands = upgraded.transport.commands();
  assert.ok(upgradeCommands.includes("STARTTLS" + CRLF));
  assert.ok(upgradeCommands.indexOf("STARTTLS" + CRLF) < upgradeCommands.findIndex((line) => line.startsWith("AUTH ")));
  assert.equal(upgraded.transport.connections[0].tlsStarted, true);
  assert.equal(upgraded.transport.connections[0].security, "starttls");
  for (const forbidden of [/^MAIL FROM/, /^RCPT TO/, /^DATA/]) {
    assert.equal(upgradeCommands.some((line) => forbidden.test(line)), false, String(forbidden));
  }
});

test("the shipped submitMessage reaches DATA and the terminating dot over the real command builder", async () => {
  // Regression guard for a defect where email.js buildCommand() rejected the
  // "MAIL FROM" and "RCPT TO" verbs, so SMTPSession.submit() threw before any
  // envelope command was written and NO message could ever be submitted. This
  // test drives the real shipped submitMessage over a scripted socket and
  // asserts the complete wire sequence.
  const harness = createHarness();
  const prepared = await prepareWeekly(harness);
  const frozen = frozenSubmission(harness, prepared.submissionKey);
  const socket = createScriptedSocket("ssl", ACCEPTED_REPLIES);
  const result = await RealSMTP.submitMessage({
    Email,
    socket,
    credentials: { ...normalizedConnection(), secret: SECRET },
    submission: frozen,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.state, "accepted");
  assert.equal(result.messageSubmitted, true);
  assert.equal(result.serverAccepted, true);
  assert.equal(result.code, 250);

  // The two-word verbs must appear, in order, before DATA.
  const commands = socket.writes;
  const indexOf = (prefix) => commands.findIndex((line) => line.startsWith(prefix));
  const mailFrom = indexOf("MAIL FROM");
  const rcptTo = indexOf("RCPT TO");
  const data = commands.findIndex((line) => line === "DATA" + CRLF);
  assert.ok(mailFrom >= 0, "MAIL FROM must be written");
  assert.ok(rcptTo > mailFrom, "RCPT TO must follow MAIL FROM");
  assert.ok(data > rcptTo, "DATA must follow RCPT TO");
  assert.equal(commands[mailFrom], "MAIL FROM <" + frozen.envelopeFrom + ">" + CRLF);
  assert.equal(commands[rcptTo], "RCPT TO <" + frozen.envelopeTo + ">" + CRLF);
  // The frozen message is what goes on the wire, terminated by CRLF "." CRLF.
  const wire = commands.join("");
  assert.ok(wire.includes(frozen.message.slice(0, 80)), "the frozen message must be transmitted");
  assert.ok(wire.includes(CRLF + "." + CRLF), "the message must end with the DATA terminator");
  assert.equal(Email.buildCommand("MAIL FROM", "<" + CONNECTION.username + ">"),
    "MAIL FROM <" + CONNECTION.username + ">" + CRLF);
  assert.equal(Email.buildCommand("RCPT TO", "<" + CONNECTION.to + ">"),
    "RCPT TO <" + CONNECTION.to + ">" + CRLF);
});

// ---------------------------------------------------------------------------
// Unknown and retryable outcomes
// ---------------------------------------------------------------------------

test("a disconnect at the terminating dot is unknown, refuses retry, and refuses resend while disabled", async () => {
  const harness = createHarness();
  const prepared = await prepareWeekly(harness);
  const frozen = frozenSubmission(harness, prepared.submissionKey);
  harness.transport.queue([
    GREETING, EHLO_IMPLICIT, AUTH_OK, SENDER_OK, RECIPIENT_OK, DATA_READY,
    new Error("The SMTP connection closed before a complete reply arrived"),
  ]);

  const result = await harness.service.sendPreparedSubmission(prepared.submissionKey, {});
  assert.equal(result.status, "unknown");
  assert.equal(result.retryable, false);
  assert.equal(result.messageSubmitted, true);
  assert.match(result.message, /Delivery is unknown/);

  const entry = harness.state().emailSubmissions[prepared.submissionKey];
  assert.equal(entry.status, "unknown");
  assert.equal(entry.messageSubmitted, true);
  assert.equal(entry.message, frozen.message, "the frozen bytes stay available for review");

  // The message may already be in the mailbox: no automatic retry, and the
  // provably-unsent retry path is closed for it as well.
  await assert.rejects(
    harness.service.retrySubmission(prepared.submissionKey, {}),
    /known not to have been sent/,
  );
  assert.equal(harness.transport.connections.length, 1);
  const status = await harness.service.getStatus();
  assert.equal(status.currentSubmission.status, "unknown");
  assert.equal(status.retryKey, "");
});

test("a manual resend of an unknown outcome reuses byte-identical bytes and reports the risk", async () => {
  const harness = createHarness();
  const prepared = await prepareWeekly(harness);
  const frozen = frozenSubmission(harness, prepared.submissionKey);
  harness.transport.queue([
    GREETING, EHLO_IMPLICIT, AUTH_OK, SENDER_OK, RECIPIENT_OK, DATA_READY,
    new Error("The SMTP connection closed before a complete reply arrived"),
  ]);
  assert.equal((await harness.service.sendPreparedSubmission(prepared.submissionKey, {})).status, "unknown");

  // No setting gates this any more. The tick box that used to be required is
  // gone, because the labelled button that reaches this call is itself the
  // confirmation; the call still refuses anything that is not an unknown
  // outcome, and it still refuses a provably-unsent retry through this path.
  await assert.rejects(
    () => harness.service.resendUnknownSubmission("feedrank-smtp/not-a-submission", {}),
    /unknown outcome/,
  );
  assert.equal(harness.transport.connections.length, 1);

  harness.transport.queue();
  const resent = await harness.service.resendUnknownSubmission(prepared.submissionKey, {});
  assert.equal(resent.status, "accepted");
  assert.equal(resent.sent, true);
  // The risk is still reported, just passively instead of as a blocking prompt.
  assert.match(resent.message, /duplicate delivery is possible/);
  assert.equal(harness.prompts.length, 0, "a resend must not open a confirmation");
  assert.equal(harness.transport.connections.length, 2);
  // The text the dialog used to carry is still produced, as a description.
  const risk = harness.service.describeDuplicateRisk({ ...frozen, createdAt: Date.now() });
  assert.match(risk, /may already have been delivered/);
  assert.match(risk, /second copy/);

  const bodies = harness.transport.messageBodies();
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], Email.dotStuff(frozen.message));
  assert.equal(bodies[1], bodies[0], "a resend must reuse the frozen bytes exactly");
  assert.equal(harness.state().emailSubmissions[prepared.submissionKey].message, frozen.message);
});

test("a provably-unsent 4xx rejection is retryable and the retry reuses the same bytes", async () => {
  const harness = createHarness();
  const prepared = await prepareWeekly(harness);
  const frozen = frozenSubmission(harness, prepared.submissionKey);
  harness.transport.queue([GREETING, EHLO_IMPLICIT, AUTH_OK, SENDER_OK, "450 4.7.1 Greylisted, try again later" + CRLF]);

  const first = await harness.service.sendPreparedSubmission(prepared.submissionKey, {});
  assert.equal(first.status, "retryable");
  assert.equal(first.retryable, true);
  assert.equal(first.messageSubmitted, false);
  assert.equal(harness.transport.messageBodies().length, 0, "no message byte may be written after a 4xx");

  harness.transport.queue();
  const retried = await harness.service.retrySubmission(prepared.submissionKey, {});
  assert.equal(retried.status, "accepted");
  assert.equal(harness.transport.connections.length, 2);
  const bodies = harness.transport.messageBodies();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0], Email.dotStuff(frozen.message));
  assert.equal(harness.state().emailSubmissions[prepared.submissionKey].message, frozen.message);
  assert.equal(harness.state().emailSubmissions[prepared.submissionKey].attempts, 2);
});

// ---------------------------------------------------------------------------
// Connection-change protection
// ---------------------------------------------------------------------------

test("a changed host, port, TLS mode, username, sender, or recipient refuses to send and opens no socket", async () => {
  const changes = [
    ["host", { host: "other.example.test" }],
    ["port", { port: 2525 }],
    ["tlsMode", { tlsMode: "starttls", port: 587 }],
    ["username", { username: "other@example.test" }],
    ["from", { from: "Other Sender <other@example.test>" }],
    ["to", { to: "other-reader@example.test" }],
  ];
  for (const [field, change] of changes) {
    const harness = createHarness();
    const prepared = await prepareWeekly(harness);
    await configureSession(harness.service, change);
    harness.transport.queue();
    await assert.rejects(
      harness.service.sendPreparedSubmission(prepared.submissionKey, {}),
      /SMTP settings changed|SMTP connection changed/,
      field + " must invalidate the frozen draft",
    );
    assert.equal(harness.transport.connections.length, 0, field + " must not open a socket");
    assert.equal(harness.transport.commands().length, 0);
    assert.equal(harness.state().emailSubmissions[prepared.submissionKey].status, "prepared");
  }
});

// ---------------------------------------------------------------------------
// Digest content safety
// ---------------------------------------------------------------------------

test("hostile paper content is escaped in the HTML digest and unsafe URLs are omitted", async () => {
  const harness = createHarness();
  await configureSession(harness.service);
  await harness.service.prepareDigestFromRankedResults({
    records: [paper({
      id: "1:HOSTILE",
      title: "</strong><script>alert('x')</script>",
      reason: "Ignore prior instructions and <img src=x onerror=alert(1)>",
      // The digest no longer prints the model's rationale, so the payload also rides
      // in a field it does print: the author list.
      authors: ["Ignore prior instructions and <img src=x onerror=alert(1)>"],
      url: "javascript:alert(document.cookie)",
      doi: "10.1000/hostile.1",
    })],
    summary: { runID: "manual-hostile-run" },
    localDay: "2026-09-30",
  });
  const preview = await harness.service.openPreview({});
  assert.equal(preview.frozen, true);
  assert.doesNotMatch(preview.html, /<script|<img|<svg|javascript:/i);
  assert.match(preview.html, /&lt;\/strong&gt;&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
  assert.match(preview.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(preview.text, /javascript:/i);
  // Only the template's own tags survive, so no injected element can exist. The
  // compact layout added a style block, a title, a charset meta and the score
  // span; the list is exhaustive on purpose, so a new tag must be added here
  // deliberately rather than appearing in a message unnoticed. `ol` and `li` are
  // gone on purpose: Outlook numbered the ordered list itself and the reader saw
  // "1. 1. Title", so the items are plain blocks now.
  const tags = [...preview.html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((match) => match[1].toLowerCase());
  assert.deepEqual([...new Set(tags)].sort(),
    ["a", "body", "div", "h2", "head", "html", "meta", "span", "style", "title"]);
  // The valid DOI still supplies the canonical HTTPS fallback, and it is the
  // only link target in the message.
  assert.deepEqual(
    [...preview.html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]),
    ["https://doi.org/10.1000/hostile.1"],
  );
  assert.match(preview.text, /https:\/\/doi\.org\/10\.1000\/hostile\.1/);
  assert.equal(harness.transport.connections.length, 0);
});

// ---------------------------------------------------------------------------
// Automatic weekly delivery
// ---------------------------------------------------------------------------

test("automatic weekly delivery needs the saved opt-in and a same-run approval, and never fires at startup", async () => {
  const noOptIn = createHarness();
  await configureSession(noOptIn.service);
  const refused = await noOptIn.service.recordCompletedWeeklyRun({
    source: "weekly",
    runID: "auto-no-opt-in",
    localDay: "2026-09-30",
    records: [paper()],
    autoSendApproved: true,
  });
  assert.equal(refused.autoResult, undefined);
  assert.equal(noOptIn.transport.connections.length, 0);

  const noApproval = createHarness();
  await configureSession(noApproval.service);
  noApproval.service.saveConfig({ automaticSendingEnabled: true });
  assert.equal(noApproval.transport.connections.length, 0, "saving settings must not send");
  await noApproval.service.startup();
  assert.equal(noApproval.transport.connections.length, 0, "startup must not send");
  const unapproved = await noApproval.service.recordCompletedWeeklyRun({
    source: "weekly",
    runID: "auto-no-approval",
    localDay: "2026-09-30",
    records: [paper()],
    autoSendApproved: false,
  });
  assert.equal(unapproved.autoResult, undefined);
  assert.equal(noApproval.transport.connections.length, 0);

  const approved = createHarness();
  await configureSession(approved.service);
  approved.service.saveConfig({ automaticSendingEnabled: true });
  approved.transport.queue();
  const sent = await approved.service.recordCompletedWeeklyRun({
    source: "weekly",
    runID: "auto-approved",
    localDay: "2026-09-30",
    records: [paper()],
    autoSendApproved: true,
  });
  assert.equal(sent.recorded, true);
  assert.equal(sent.autoResult.status, "accepted");
  assert.equal(sent.autoResult.sent, true);
  assert.equal(approved.transport.connections.length, 1);
  assert.equal(approved.transport.messageBodies().length, 1);
});

test("an unattended automatic send reports why the saved credential could not be unlocked", async () => {
  /*
   * The state a scheduled run starts in: Zotero has been restarted, so the only
   * copy of the SMTP secret is the OS key store ciphertext in the Login Manager,
   * and the key store declines to release it. Nobody is watching the screen.
   *
   * This used to arrive as "Set the SMTP server, username, sender, recipient, and
   * secret in FeedRank settings first" -- which sends the reader to a pane where
   * everything is already configured, because the real failure was swallowed by an
   * empty catch. The reason is the only useful thing that error can carry.
   */
  const harness = createHarness();
  await configureSession(harness.service, {}, true);
  harness.service.saveConfig({ automaticSendingEnabled: true });
  await harness.service.shutdown();
  harness.osKeyStore.ensureLoggedIn = async () => false;

  const result = await harness.service.recordCompletedWeeklyRun({
    source: "weekly",
    runID: "auto-locked-credential",
    localDay: "2026-09-30",
    records: [paper()],
    autoSendApproved: true,
  });

  assert.equal(result.recorded, true, "the digest itself is still stored for review");
  assert.equal(result.autoResult.sent, false);
  assert.match(result.autoResult.message, /could not be unlocked/);
  assert.match(result.autoResult.message, /not authorized/);
  assert.match(result.autoResult.message, /smtp\.example\.test/);
  assert.equal(harness.transport.connections.length, 0, "nothing was connected to");
  assert.equal(harness.transport.messageBodies().length, 0, "nothing reached the wire");
});

test("a credential that was never stored still points at the settings pane", async () => {
  const harness = createHarness();
  const result = await harness.service.recordCompletedWeeklyRun({
    source: "weekly",
    runID: "auto-no-credential",
    localDay: "2026-09-30",
    records: [paper()],
    autoSendApproved: true,
  });
  // No opt-in here, so nothing was attempted; the point of the test is that the
  // pristine case has no misleading "could not be unlocked" text to offer.
  assert.equal(result.autoResult, undefined);
  await assert.rejects(
    () => harness.service.getCredentialsForManualSend({}),
    /Set the SMTP server, username, sender, recipient, and secret in FeedRank settings first/,
  );
});

test("a delivery outcome tells the panes, so Last email refreshes after the send", async () => {
  // Asked for directly: "last email line in the menu should refresh after the email
  // sent". The pane is a different window from whichever one sends -- the scheduled run
  // has no window at all -- so the line used to keep whatever it read when the pane was
  // last populated.
  const harness = createHarness();
  await configureSession(harness.service);
  harness.service.saveConfig({ automaticSendingEnabled: true });
  const pings = [];
  const unsubscribe = harness.service.subscribeDelivery(() => pings.push("delivery"));
  assert.equal(pings.length, 0, "nothing is announced before a delivery");

  harness.transport.queue();
  const sent = await harness.service.recordCompletedWeeklyRun({
    source: "weekly",
    runID: "auto-listener-1",
    localDay: "2026-09-30",
    records: [paper()],
    autoSendApproved: true,
  });
  assert.equal(sent.autoResult.sent, true);
  assert.equal(pings.length, 1, "the outcome is announced once it is recorded");

  // A listener that throws cannot reach the send that already happened, and cannot
  // stop another listener from being told.
  const broken = harness.service.subscribeDelivery(() => {
    throw new Error("simulated pane failure");
  });
  harness.transport.queue();
  await harness.service.recordCompletedWeeklyRun({
    source: "weekly",
    runID: "auto-listener-2",
    localDay: "2026-09-30",
    records: [paper()],
    autoSendApproved: true,
  });
  assert.equal(pings.length, 2, "a broken listener does not silence the others");

  // And unsubscribing really stops it: a closed window must not be repopulated.
  broken();
  unsubscribe();
  harness.transport.queue();
  await harness.service.recordCompletedWeeklyRun({
    source: "weekly",
    runID: "auto-listener-3",
    localDay: "2026-09-30",
    records: [paper()],
    autoSendApproved: true,
  });
  assert.equal(pings.length, 2, "an unsubscribed listener is not called again");
});

// ---------------------------------------------------------------------------
// Rebuild and send are separate functions
// ---------------------------------------------------------------------------
test("a rebuild followed by the preview's submit delivers the built message", async () => {
  const harness = createHarness();
  await configureSession(harness.service);
  await harness.service.rebuildDigest({
    records: [paper()],
    localDay: "2026-09-30",
    window: { from: "2026-09-24", to: "2026-09-30" },
    runID: "preview:2026-09-30:10:AAAA",
  });
  // Review digest prepares the frozen message; its Send button submits it. That is
  // the only sending path in the pane now.
  const preview = await harness.service.openPreview({});
  assert.equal(preview.frozen, true);
  harness.transport.queue();

  const result = await harness.service.sendPreparedSubmission(preview.submissionKey, {});
  assert.equal(result.sent, true);
  assert.equal(result.status, "accepted");
  assert.equal(harness.transport.connections.length, 1);
  assert.equal(harness.transport.messageBodies().length, 1);
  assert.equal(harness.prompts.length, 0, "no confirmation dialog may be opened");
  assert.match(harness.transport.messageBodies()[0], /^MIME-Version: 1\.0/);
  assert.equal(harness.state().emailSubmissions[result.submissionKey].status, "accepted");
});

test("a message the server ACCEPTED is reported as sent even when its record cannot be saved", async () => {
  // Reported from live use with two screenshots: the email arrived, and FeedRank
  // said "The SMTP server replied, but FeedRank could not save the outcome.
  // Delivery is unknown", while "Last email" showed an older, unrelated failure.
  //
  // The cause was the local write of the OUTCOME failing after the server had
  // already replied. The server's answer is known at that point, so it is what is
  // reported; the outcome is also kept in memory for the session so the status line
  // shows the real last delivery instead of a stale one.
  const harness = createHarness({
    // Fail exactly the write of the ACCEPTED outcome, and nothing before it: the
    // earlier writes (the digest, the prepared message) must succeed, because that
    // is the situation the user was in.
    failWrite: (draft) => Object.values(draft.emailSubmissions || {})
      .some((entry) => entry?.status === "accepted"),
  });
  await configureSession(harness.service);
  await harness.service.rebuildDigest({
    records: [paper()],
    localDay: "2026-09-30",
    window: { from: "2026-09-24", to: "2026-09-30" },
    runID: "preview:2026-09-30:10:AAAA",
  });
  const preview = await harness.service.openPreview({});
  harness.transport.queue();

  const result = await harness.service.sendPreparedSubmission(preview.submissionKey, {});
  assert.equal(result.sent, true, "the server accepted the message, so it was sent");
  assert.equal(result.status, "accepted");
  assert.equal(result.serverAccepted, true);
  assert.equal(result.recordSaved, false, "the caller is told the local record is incomplete");
  assert.match(result.message, /accepted the message for delivery/);
  assert.match(result.message, /could not update its local record/);
  assert.doesNotMatch(result.message, /Delivery is unknown/);
  // Exactly one message went out: a failed record must never cause a resend.
  assert.equal(harness.transport.connections.length, 1);
  assert.equal(harness.transport.messageBodies().length, 1);

  // The session remembers it, so "Last email" reports the delivery that happened
  // rather than whichever older failure happens to be persisted.
  const status = await harness.service.getStatus();
  assert.equal(status.lastDelivery.accepted, true);
  assert.equal(status.lastDelivery.status, "accepted");
  assert.equal(status.lastDelivery.recordSaved, false);
  assert.equal(status.lastDelivery.to, CONNECTION.to);
  assert.equal(status.lastDelivery.host, CONNECTION.host);

  // A message the server did NOT accept is still reported as unknown, and still
  // never resent automatically.
  const unaccepted = createHarness({
    failWrite: (draft) => Object.values(draft.emailSubmissions || {})
      .some((entry) => entry?.status === "accepted"),
  });
  await configureSession(unaccepted.service);
  await unaccepted.service.rebuildDigest({
    records: [paper()], localDay: "2026-09-30", runID: "preview:2026-09-30:10:BBBB",
  });
  const unacceptedPreview = await unaccepted.service.openPreview({});
  unaccepted.transport.queue([
    GREETING, EHLO_IMPLICIT, AUTH_OK, SENDER_OK, RECIPIENT_OK, DATA_READY,
    new Error("The SMTP connection closed before a complete reply arrived"),
  ]);
  const unknown = await unaccepted.service.sendPreparedSubmission(unacceptedPreview.submissionKey, {});
  assert.equal(unknown.sent, false);
  assert.match(unknown.message, /Delivery is unknown/);
  assert.equal((await unaccepted.service.getStatus()).lastDelivery.accepted, false);
});

test("rebuildDigest writes a local digest and sends nothing", async () => {
  const harness = createHarness();
  await configureSession(harness.service);
  harness.transport.queue();

  const built = await harness.service.rebuildDigest({
    records: [paper()],
    localDay: "2026-09-30",
    window: { from: "2026-09-24", to: "2026-09-30" },
    runID: "preview:2026-09-30:10:AAAA",
  });

  assert.equal(built.built, true);
  assert.equal(built.snapshot.recordCount, 1);
  // A rebuild is local only: no connection, no credential, no message, no prompt.
  assert.equal(harness.transport.connections.length, 0);
  assert.equal(harness.prompts.length, 0);
  const stored = harness.state().emailDelivery.currentRun;
  assert.equal(stored.source, "manual");
  assert.match(stored.digest.subject, /^FeedRank weekly digest — \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/);
  // The window is in the SUBJECT, so the body no longer repeats it.
  assert.equal(stored.digest.subject, "FeedRank weekly digest — 2026-09-24 to 2026-09-30");
  assert.doesNotMatch(stored.digest.text, /2026-09-24 to 2026-09-30/);
  assert.match(stored.digest.text, /^Priority papers$/m);
  assert.equal(harness.state().emailSubmissions && Object.keys(harness.state().emailSubmissions).length, 0,
    "a rebuild must not prepare or record a submission");

  // Idempotent for the same week: rebuilding twice produces one identity, so the
  // Send button cannot be confused by two different digests of the same papers.
  const again = await harness.service.rebuildDigest({
    records: [paper()],
    localDay: "2026-09-30",
    window: { from: "2026-09-24", to: "2026-09-30" },
    runID: "preview:2026-09-30:10:AAAA",
  });
  assert.equal(again.snapshot.contentHash, built.snapshot.contentHash);

  // Nothing to build from is refused rather than stored empty.
  await assert.rejects(() => harness.service.rebuildDigest({ records: [], localDay: "2026-09-30" }),
    /no scored articles/i);
});

test("the preview refuses a second send of a digest the server already accepted", async () => {
  const harness = createHarness();
  await configureSession(harness.service);
  await harness.service.rebuildDigest({
    records: [paper()],
    localDay: "2026-09-30",
    window: { from: "2026-09-24", to: "2026-09-30" },
    runID: "preview:2026-09-30:10:AAAA",
  });
  const builtText = harness.state().emailDelivery.currentRun.digest.text;
  const preview = await harness.service.openPreview({});
  harness.transport.queue();
  const result = await harness.service.sendPreparedSubmission(preview.submissionKey, {});
  assert.equal(result.status, "accepted");
  assert.equal(harness.transport.connections.length, 1);
  // The bytes sent are the bytes that were built, and the stored digest is
  // untouched by sending.
  assert.equal(harness.state().emailDelivery.currentRun.digest.text, builtText);

  // Reviewing again prepares nothing new: the delivery state for this digest
  // refuses a duplicate.
  const again = await harness.service.openPreview({});
  assert.equal(again.submissionKey, preview.submissionKey);
  assert.equal(harness.transport.connections.length, 1);
});

test("a completed delivery is saved even when the record cap is already full", async () => {
  // The reported "still can send, but information not right": the email arrived and
  // the record was never written, so the pane kept saying the history was
  // incomplete. The cause was pruning, not the network: three `retryable` records
  // (failed test emails) filled the cap, and the digest's record became TERMINAL the
  // moment it was accepted, so the budget left for terminal history was zero and the
  // record was dropped inside the very transaction that wrote it. The read-back
  // guard then correctly refused to call it saved.
  const harness = createHarness();
  await configureSession(harness.service);

  // Fill the store with failed test emails: `retryable` records, which are the ones
  // that used to crowd everything else out.
  for (let index = 0; index < 3; index++) {
    await harness.service.rebuildDigest({
      records: [paper()], localDay: "2026-09-30", runID: "preview:2026-09-30:test" + index,
    });
    harness.transport.queue([
      GREETING, EHLO_IMPLICIT, AUTH_OK, SENDER_OK, RECIPIENT_OK, DATA_READY,
      new Error("The SMTP connection closed before a complete reply arrived"),
    ]);
    const preview = await harness.service.openPreview({});
    await harness.service.sendPreparedSubmission(preview.submissionKey, {});
  }
  const before = Object.values(harness.state().emailSubmissions);
  assert.ok(before.length >= 1, "the failed attempts are stored");

  // Now a real digest that the server accepts.
  await harness.service.rebuildDigest({
    records: [paper()],
    localDay: "2026-09-30",
    window: { from: "2026-09-24", to: "2026-09-30" },
    runID: "preview:2026-09-30:10:REAL",
  });
  harness.transport.queue();
  const preview = await harness.service.openPreview({});
  const result = await harness.service.sendPreparedSubmission(preview.submissionKey, {});

  assert.equal(result.sent, true);
  assert.equal(result.status, "accepted");
  assert.equal(result.recordSaved === false, false, "the record must be saved, not reported as incomplete");
  assert.doesNotMatch(result.message || "", /could not update its local record/);
  // And the write really landed: the accepted record is in the state and is what
  // "Last email" reports.
  const stored = harness.state().emailSubmissions[preview.submissionKey];
  assert.ok(stored, "the accepted submission must survive pruning");
  assert.equal(stored.status, "accepted");
  const last = (await harness.service.getStatus()).lastDelivery;
  assert.equal(last.accepted, true);
  assert.equal(last.recordSaved, true);
  assert.equal(harness.transport.connections.length, 4, "one connection per attempt, no resends");
});

test("the last-email status reports the newest real delivery and ignores connection tests", async () => {
  const harness = createHarness();
  await configureSession(harness.service);
  assert.equal((await harness.service.getStatus()).lastDelivery, null);

  // A connection test transmits no message, so it must never be shown as the
  // last email.
  harness.transport.queue();
  await harness.service.testConnection({});
  assert.equal((await harness.service.getStatus()).lastDelivery, null);

  harness.transport.queue();
  await harness.service.rebuildDigest({
    records: [paper()],
    localDay: "2026-09-30",
    window: { from: "2026-09-24", to: "2026-09-30" },
    runID: "preview:2026-09-30:10:AAAA",
  });
  const preview = await harness.service.openPreview({});
  const sent = await harness.service.sendPreparedSubmission(preview.submissionKey, {});
  const last = (await harness.service.getStatus()).lastDelivery;
  assert.equal(last.accepted, true);
  assert.equal(last.status, "accepted");
  assert.equal(last.to, CONNECTION.to);
  assert.equal(last.host, CONNECTION.host);
  assert.equal(last.acceptedAt > 0, true);
  assert.match(last.subject, Email.DIGEST_SUBJECT_PATTERN);
  assert.equal(last.messageSubmitted, true);
  assert.equal(typeof last.acceptedAt, "number");
  assert.equal(sent.status, "accepted");
});

test("normalizeEmailConfig keeps no resend opt-in and no transport surprise", () => {
  // The "allow a manual resend after an unknown outcome" tick box is gone. The
  // setting is not merely hidden: it does not exist in the saved shape either, so
  // an old preference cannot keep a switch the pane no longer shows.
  const defaults = EmailService.normalizeEmailConfig(Email, {});
  assert.equal(Object.hasOwn(defaults, "allowManualResendAfterUnknown"), false);
  assert.equal(
    Object.hasOwn(EmailService.normalizeEmailConfig(Email, { allowManualResendAfterUnknown: true }),
      "allowManualResendAfterUnknown"),
    false,
  );

  assert.equal(defaults.transport, "smtp");
  assert.equal(defaults.tlsMode, "starttls");
  assert.equal(defaults.authMethod, "plain");
  assert.equal(defaults.automaticSendingEnabled, false);
  assert.equal(EmailService.normalizeEmailConfig(Email, { automaticSendingEnabled: "true" }).automaticSendingEnabled, false);
  assert.throws(() => EmailService.normalizeEmailConfig(Email, { tlsMode: "plaintext" }), /TLS mode/);
  assert.throws(() => EmailService.normalizeEmailConfig(Email, { authMethod: "cram-md5" }), /authentication method/);
});

test("parseLoginMetadata rejects invalid records and connectionIdentity tracks every connection field", () => {
  const metadataValue = (overrides = {}) => JSON.stringify({
    version: 2,
    kind: EmailService.LOGIN_KIND,
    ...normalizedConnection(),
    ...overrides,
  });
  assert.ok(EmailService.parseLoginMetadata(metadataValue(), Email));
  for (const invalid of [
    { tlsMode: "plaintext" },
    { tlsMode: "none" },
    { authMethod: "cram-md5" },
    { authMethod: "" },
    { from: "not an address" },
    { from: "digest@example.test" + CRLF + "Bcc: attacker@example.test" },
    { to: "a@example.test, c@example.test" },
    { to: "" },
    { host: "" },
    { port: 0 },
    { port: 70000 },
    { username: "   " },
  ]) {
    assert.equal(
      EmailService.parseLoginMetadata(metadataValue(invalid), Email),
      null,
      "must reject " + JSON.stringify(invalid),
    );
  }
  assert.equal(EmailService.parseLoginMetadata("not json", Email), null);
  assert.equal(EmailService.parseLoginMetadata("", Email), null);
  assert.equal(EmailService.parseLoginMetadata(JSON.stringify({ version: 1, kind: EmailService.LOGIN_KIND }), Email), null);
  assert.equal(EmailService.parseLoginMetadata(JSON.stringify({ version: 2, kind: "resend" }), Email), null);
  assert.equal(EmailService.parseLoginMetadata(metadataValue({ port: "465" }), Email).port, 465);

  const identity = EmailService.connectionIdentity(Email, normalizedConnection());
  assert.equal(EmailService.connectionIdentity(Email, normalizedConnection()), identity);
  for (const [field, change] of [
    ["host", { host: "other.example.test" }],
    ["port", { port: 2525 }],
    ["tlsMode", { tlsMode: "starttls" }],
    ["authMethod", { authMethod: "login" }],
    ["username", { username: "other@example.test" }],
    ["from", { from: "Other Sender <other@example.test>" }],
    ["to", { to: "other-reader@example.test" }],
  ]) {
    assert.notEqual(
      EmailService.connectionIdentity(Email, normalizedConnection(change)),
      identity,
      field + " must change the connection identity",
    );
  }
});

// ---------------------------------------------------------------------------
// Persisted state bounds
// ---------------------------------------------------------------------------

test("persisted state holds no credential and stays inside the module's bounds", async () => {
  const harness = createHarness();
  const prepared = await prepareWeekly(harness);
  harness.transport.queue();
  assert.equal((await harness.service.sendPreparedSubmission(prepared.submissionKey, {})).status, "accepted");

  const state = harness.state();
  assert.equal(JSON.stringify(state).includes(SECRET), false);
  assert.equal(JSON.stringify(state).includes(CIPHERTEXT_PREFIX), false);
  assert.equal(JSON.stringify(state).includes("AUTH PLAIN"), false);
  assert.equal(JSON.stringify(state).includes("Bearer"), false);

  const entries = Object.values(state.emailSubmissions);
  assert.equal(entries.length, 1);
  for (const entry of entries) {
    assert.equal(Object.hasOwn(entry, "secret"), false);
    assert.equal(Object.hasOwn(entry, "password"), false);
    assert.ok(entry.message.length <= EmailService.MAX_MESSAGE_STATE_LENGTH);
    assert.ok(entry.submissionKey.length <= 256);
    assert.equal(entry.status, "accepted");
  }
  assert.ok(
    JSON.stringify({ delivery: state.emailDelivery, submissions: state.emailSubmissions }).length
      <= EmailService.MAX_EMAIL_STATE_LENGTH,
  );
  assert.equal(EmailService.MAX_MESSAGE_STATE_LENGTH, 200000);
  assert.equal(EmailService.MAX_EMAIL_STATE_LENGTH, 400000);
});

// ---------------------------------------------------------------------------
// The failure path itself must not fail
// ---------------------------------------------------------------------------

test("an error thrown from the failure path is never reported as an SMTP outcome", async () => {
  // The bug this pins: `auth` was declared with `const` inside the try block and
  // then used in the catch block, so the catch threw "auth is not defined". That
  // ReferenceError was classified as a transport failure with no reply, which
  // turned a real server rejection into a RETRYABLE outcome. A defect in the
  // error path must never be able to masquerade as the error it describes.
  const harness = createHarness();
  const prepared = await prepareWeekly(harness);
  // The server rejects the credentials outright, before any envelope command.
  harness.transport.queue([
    GREETING, EHLO_IMPLICIT, "535 5.7.3 Authentication unsuccessful" + CRLF,
  ]);

  const result = await harness.service.sendPreparedSubmission(prepared.submissionKey, {});
  assert.equal(result.status, "failed", "a 535 is permanent, not a retryable transport problem");
  assert.equal(result.retryable, false);
  assert.equal(result.sent, false);
  // The service surfaces the classifier's text as `message`, which is what the
  // settings pane renders.
  assert.match(result.message, /535/);
  assert.match(result.message, /app password/);
  assert.doesNotMatch(result.message, /auth is not defined/,
    "a defect in the error path must never appear as the SMTP outcome");

  const commands = harness.transport.commands();
  assert.equal(commands.some((line) => /^(MAIL FROM|RCPT TO|DATA)/.test(line)), false,
    "nothing may reach the envelope after a credential rejection");
  assert.equal(harness.state().emailSubmissions[prepared.submissionKey].messageSubmitted, false);
});

test("a disconnect after the terminating dot stays unknown, not retryable", async () => {
  // `messageSubmitted: undefined` must not be read as `false`: the difference
  // decides whether FeedRank offers a retry for a message the server may already
  // hold.
  const harness = createHarness();
  const prepared = await prepareWeekly(harness);
  harness.transport.queue([
    GREETING, EHLO_IMPLICIT, AUTH_OK, SENDER_OK, RECIPIENT_OK, DATA_READY,
    new Error("The SMTP connection closed before a complete reply arrived"),
  ]);
  const result = await harness.service.sendPreparedSubmission(prepared.submissionKey, {});
  assert.equal(result.status, "unknown");
  assert.equal(result.retryable, false);
  assert.equal(result.messageSubmitted, true);
  assert.match(result.message, /Delivery is unknown/);
});

// ---------------------------------------------------------------------------

test("connection test uses a corrected displayed TLS mode with saved credentials, without persisting or sending mail", async () => {
  const h = createHarness();
  await configureSession(h.service, { host: "smtp.example.test", port: 994, tlsMode: "starttls", authMethod: "login" });
  h.transport.queue([GREETING, EHLO_IMPLICIT, "334 VXNlcm5hbWU6\r\n", "334 UGFzc3dvcmQ6\r\n", AUTH_OK, BYE]);
  const result = await h.service.testConnection({ connectionConfig: { ...CONNECTION,
    host: "smtp.example.test", port: 994, tlsMode: "implicit", authMethod: "login" } });
  assert.equal(result.ok, true);
  assert.equal(h.transport.connections[0].security, "ssl");
  assert.equal(h.transport.messageBodies().length, 0);
  assert.equal((await h.service.getCredentialsForManualSend()).tlsMode, "starttls", "a test must not silently save connection settings");
  assert.doesNotMatch(h.transport.commands().join(""), /MAIL FROM|RCPT TO|DATA/);
});

test("connection test never forwards a saved secret to another host, username or authentication family", async () => {
  const h = createHarness();
  await configureSession(h.service);
  for (const overrides of [{ host: "another.example.test" }, { username: "other@example.test" }, { authMethod: "xoauth2" }]) {
    const result = await h.service.testConnection({ connectionConfig: { ...CONNECTION, ...overrides } });
    assert.equal(result.ok, false);
    assert.equal(h.transport.connections.length, 0);
  }
});

test("saved LOGIN credentials survive secure reload and are sent once each in the canonical challenge exchange", async () => {
  const h = createHarness();
  await h.service.saveCredentials({ ...CONNECTION, authMethod: "login", secret: SECRET });
  await h.service.shutdown();
  assert.equal(h.service.sessionCredentials.size, 0);
  h.transport.queue([GREETING, EHLO_IMPLICIT, "334 VXNlcm5hbWU6\r\n", "334 UGFzc3dvcmQ6\r\n", AUTH_OK, BYE]);
  assert.equal((await h.service.testConnection()).ok, true);
  assert.deepEqual(h.transport.commands(), ["EHLO feedrank.local\r\n", "AUTH LOGIN\r\n",
    base64(CONNECTION.username) + CRLF, base64(SECRET) + CRLF, "QUIT\r\n"]);
  assert.equal(h.transport.messageBodies().length, 0);
  assertNoSecretIn([...h.prefs.values(), JSON.stringify(h.state())], "preferences and delivery state");
});

test("a rejected LOGIN credential remains failed, sends no message, and does not trigger PLAIN fallback or another attempt", async () => {
  const h = createHarness();
  await configureSession(h.service, { authMethod: "login" });
  h.transport.queue([GREETING, EHLO_IMPLICIT, "334 VXNlcm5hbWU6\r\n", "334 UGFzc3dvcmQ6\r\n", "535 Authentication failed\r\n"]);
  const result = await h.service.testConnection();
  assert.equal(result.ok, false);
  assert.match(result.error, /535/);
  assert.equal(h.transport.connections.length, 1);
  assert.equal(h.transport.commands().filter((line) => line.startsWith("AUTH ")).length, 1);
  assert.equal(h.transport.commands().some((line) => line.startsWith("AUTH PLAIN")), false);
  assert.equal(h.transport.messageBodies().length, 0);
});

async function run() {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.run();
      process.stdout.write("✓" + entry.name + "\n");
    } catch (error) {
      failed++;
      process.stderr.write("✓" + entry.name + "\n" + error.stack + "\n");
    }
  }
  if (failed) process.exitCode = 1;
  else process.stdout.write("\n" + tests.length + " email-service tests passed.\n");
}

run();
