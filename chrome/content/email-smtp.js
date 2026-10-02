"use strict";

/*
 * Gecko socket transport for FeedRank's SMTP submission and connection test.
 *
 * VERIFIED API SURFACE (2026-09-30, installed Zotero 10.0.3 / Gecko 140.15.0):
 *   - `@mozilla.org/network/socket-transport-service;1` -> nsISocketTransportService
 *   - `nsISocketTransport` -> openInputStream/openOutputStream, tlsSocketControl,
 *     securityCallbacks, setTimeout(TIMEOUT_CONNECT|TIMEOUT_READ_WRITE)
 *   - `nsITLSSocketControl` -> Promise asyncStartTLS(), failedVerification,
 *     SSLVersionUsed, securityInfo
 *   - `nsITransportSecurityInfo` -> failedCertChain, succeededCertChain,
 *     overridableErrorCategory, errorCodeString
 *   - `nsIScriptableInputStream` / binary output stream for byte I/O
 * Absent from this build and therefore NOT relied upon:
 *   `@mozilla.org/mail/server;1`, `nsIMsgOutgoingServer`, `nsISSLSocketControl`,
 *   `nsIBadCertListener2`, `nsISSLErrorListener`.
 *
 * SECURITY POSTURE
 *   - The socket is always created with a TLS security provider ("ssl" for
 *     implicit TLS, "starttls" for an upgradeable socket). A plaintext socket
 *     is never constructed, and there is no configuration value that selects one.
 *   - Certificate validation is never overridden, and this build exposes no
 *     bad-certificate listener to return an override from. If the certificate
 *     cannot be validated the handshake fails and the connection closes; the
 *     SMTP state machine then never reaches AUTH.
 *   - Before any credential is written, `assertUsableTLS` must pass against the
 *     observed connection state. There is no fallback branch.
 *
 * THREADING NOTE
 *   Socket reads use Gecko's blocking stream API with a bounded
 *   TIMEOUT_READ_WRITE, which is the only byte-exact, ordering-safe read
 *   available without a promise-pumping layer. The read/write timeout is what
 *   bounds a stalled peer. Live socket behavior is a documented runtime check;
 *   the protocol state machine above this layer is exercised by mocked
 *   transport tests.
 */
(function exposeFeedRankerSMTP(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.FeedRankerSMTP = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createSMTPModule() {
  const SOCKET_TRANSPORT_SERVICE = "@mozilla.org/network/socket-transport-service;1";
  const SCRIPTABLE_INPUT_STREAM = "@mozilla.org/scriptableinputstream;1";
  const BINARY_OUTPUT_STREAM = "@mozilla.org/binaryoutputstream;1";
  const TIMER = "@mozilla.org/timer;1";

  const WAIT_CLOSURE_ONLY = 0x0040;
  // nsITransport.OPEN_BLOCKING = 1 << 0. Must be passed to openInputStream or
  // the resulting stream is non-blocking and read() raises
  // NS_BASE_STREAM_WOULD_BLOCK rather than waiting for the server.
  const OPEN_BLOCKING = 1;
  const OPEN_UNBUFFERED = 1 << 1;
  // nsISocketTransport.TIMEOUT_CONNECT / TIMEOUT_READ_WRITE
  const TIMEOUT_CONNECT = 0;
  const TIMEOUT_READ_WRITE = 1;

  const DEFAULT_CONNECT_TIMEOUT_MS = 20000;
  const DEFAULT_IO_TIMEOUT_MS = 30000;
  // A defensive cap on buffered server output, so a hostile or broken peer
  // cannot make FeedRank allocate without bound.
  const MAX_BUFFERED_BYTES = 64 * 1024;

  function boundedInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isInteger(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, number));
  }

  function messageOf(error, fallback = "SMTP transport failed") {
    const raw = error?.message || error?.name || error;
    const clean = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
    return clean ? clean.slice(0, 500) : fallback;
  }

  function isClosingError(error) {
    const name = String(error?.name || "");
    const message = messageOf(error, "");
    return name === "NS_BASE_STREAM_CLOSED" ||
      /NS_BASE_STREAM_CLOSED|stream is closed|socket.*closed|Connection.*closed/i.test(message);
  }

  // ---------------------------------------------------------------------------
  // SMTP reply framing
  // ---------------------------------------------------------------------------

  // RFC 5321 §4.2.1: the reply code is followed by "-" when more lines follow
  // and by a space on the final line. A reply is complete as soon as that final
  // line arrives, which is what makes bounded, incremental reading safe.
  function lastLineCompletesReply(buffer) {
    const source = String(buffer == null ? "" : buffer);
    if (!source.endsWith("\r\n") && !source.endsWith("\n")) return false;
    const lines = source.replace(/\r\n/g, "\n").split("\n").filter((line, index, all) =>
      !(index === all.length - 1 && line === ""));
    if (!lines.length) return false;
    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(/^(\d{3})([ -])/);
      if (!match) return false;
      // Every line but the last must continue; the last must terminate.
      if (index < lines.length - 1) {
        if (match[2] !== "-") return false;
      } else if (match[2] !== " ") {
        return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Components access
  // ---------------------------------------------------------------------------

  function componentAccess(Components) {
    const Cc = Components?.classes || Components?.Classes;
    const Ci = Components?.interfaces || Components?.Interfaces;
    if (!Cc || !Ci) throw new Error("Gecko XPCOM components are unavailable");
    return { Cc, Ci };
  }

  function getService(Components, contractID, interfaceName) {
    const { Cc, Ci } = componentAccess(Components);
    const iface = Ci[interfaceName];
    if (!iface) throw new Error("This Zotero build does not expose " + interfaceName);
    return Cc[contractID].getService(iface);
  }

  function createInstance(Components, contractID, interfaceName) {
    const { Cc, Ci } = componentAccess(Components);
    const iface = Ci[interfaceName];
    if (!iface) throw new Error("This Zotero build does not expose " + interfaceName);
    return Cc[contractID].createInstance(iface);
  }

  // ---------------------------------------------------------------------------
  // Socket connection
  // ---------------------------------------------------------------------------

  class SMTPSocketConnection {
    constructor({
      Components,
      Classes,
      Interfaces,
      Email,
      host,
      port,
      security,
      connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
      ioTimeoutMs = DEFAULT_IO_TIMEOUT_MS,
      setTimer,
      clearTimer,
      delay,
    } = {}) {
      if (!host || !port) throw new Error("An SMTP host and port are required");
      // Only Gecko's two TLS providers are ever requested. This is the single
      // place a socket is constructed, and neither branch can yield plaintext.
      if (security !== "ssl" && security !== "starttls") {
        throw new Error("FeedRank refuses to open a non-TLS SMTP socket");
      }
      this.Components = Components || (Classes || Interfaces ? { classes: Classes, interfaces: Interfaces } : null);
      // Used only to record the gate's own verdict on the evidence, for the
      // diagnostic. Absent is tolerated: the socket then reports
      // "accepted (no verdict detail)" instead of failing.
      this.Email = Email || null;
      this.host = String(host);
      this.port = Number(port);
      this.security = security;
      this.connectTimeoutMs = boundedInteger(connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 1000, 120000);
      this.ioTimeoutMs = boundedInteger(ioTimeoutMs, DEFAULT_IO_TIMEOUT_MS, 1000, 120000);
      this.setTimer = setTimer;
      this.clearTimer = clearTimer;
      // Asynchronous wait between reply polls. Injected so a test can resolve it
      // immediately instead of waiting in real time.
      this.delay = typeof delay === "function"
        ? delay
        : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      this.transport = null;
      this.input = null;
      this.rawInput = null;
      this.output = null;
      this.buffer = "";
      this.closed = false;
      this.tlsStarted = false;
      // Set only when a STARTTLS handshake actually resolved. It is the fallback
      // proof of encryption for builds whose nsITLSSocketControl exposes no
      // JS-readable securityInfo.
      this.handshakeCompleted = false;
      // Security info read asynchronously after the handshake, when the build
      // offers asyncGetSecurityInfo(). Preferred over the synchronous property.
      this.settledSecurityInfo = null;
      this.plaintextOnly = security === "starttls";
      // This is a cache of *observed* evidence, not a set of defaults. It
      // must start empty: describeSecurity() is intentionally idempotent once
      // it has examined the socket, but a truthy placeholder here made it
      // return an unobserved `encrypted: false` immediately after a successful
      // asyncStartTLS() promise. That stale placeholder was then treated as a
      // real negative TLS verdict and blocked authentication.
      this.securityEvidence = null;
      this.evaluatedChecks = [];
    }

    // `openInputStream` is what actually triggers connection setup.
    open() {
      if (this.transport) throw new Error("This SMTP connection is already open");
      const service = getService(this.Components, SOCKET_TRANSPORT_SERVICE, "nsISocketTransportService");
      // Arities matter here. In this Gecko (ESR 140) the IDL is:
      //   createTransport(in Array<ACString> aSocketTypes,
      //                   in AUTF8String aHost,
      //                   in long aPort,
      //                   in nsIProxyInfo aProxyInfo,
      //                   in nsIDNSRecord aDnsRecord)
      // Passing four arguments raises "Not enough arguments
      // [nsISocketTransportService.createTransport]" at call time. The fifth is
      // the pre-resolved DNS record; null means "resolve aHost normally", which
      // is what we want.
      const transport = service.createTransport([this.security], this.host, this.port, null, null);
      if (!transport) throw new Error("The SMTP socket transport could not be created");
      transport.setTimeout(TIMEOUT_CONNECT, Math.ceil(this.connectTimeoutMs / 1000));
      transport.setTimeout(TIMEOUT_READ_WRITE, Math.ceil(this.ioTimeoutMs / 1000));
      this.transport = transport;
      try {
        // The flags argument is NOT optional in effect. nsITransport defines
        // OPEN_BLOCKING = 1 << 0, and passing 0 requests a NON-blocking stream,
        // whose read() returns NS_BASE_STREAM_WOULD_BLOCK instead of waiting.
        // A blocking input stream plus the transport's own TIMEOUT_READ_WRITE is
        // what makes readReplyText() bounded and correct.
        //
        // The raw stream from openInputStream() has no scriptable read method,
        // so it MUST be wrapped in nsIScriptableInputStream, which is what
        // provides available() and read() to JS. Skipping the wrapper fails at
        // the first read with "The SMTP input stream is not readable".
        const rawInput = transport.openInputStream(OPEN_BLOCKING, 0, 0);
        const ScriptableInput = this.Components?.classes?.[SCRIPTABLE_INPUT_STREAM]
          ?.createInstance(this.Components.interfaces.nsIScriptableInputStream);
        if (!ScriptableInput || typeof ScriptableInput.init !== "function") {
          throw new Error("nsIScriptableInputStream is unavailable in this Zotero build");
        }
        ScriptableInput.init(rawInput);
        this.rawInput = rawInput;
        this.input = ScriptableInput;
        // The output side is deliberately left as the raw stream: a command is
        // pure ASCII with no NUL, so nsIOutputStream.write() is already
        // byte-exact. nsIBinaryOutputStream would NOT help here — its
        // writeStringZ() prefixes a 32-bit length field, which is not what SMTP
        // wants.
        this.output = transport.openOutputStream(0, 0, 0);
      } catch (error) {
        this.close();
        throw new Error("Could not connect to " + this.host + ":" + this.port + " — " + messageOf(error));
      }
      return this;
    }

    /*
     * Read whatever the stream currently holds.
     *
     * `available()` returning 0 means "nothing buffered YET", not end of stream:
     * the server may simply not have replied in the microseconds since the write.
     * Returning "" there was read as EOF and produced
     * "the SMTP connection ended before a complete reply arrived" against a real
     * server, so a zero count is reported separately from a real read and the
     * caller waits and retries. This is the ONE place that distinction is made.
     */
    readChunk() {
      const stream = this.input;
      if (!stream) return { data: "", eof: true };
      if (typeof stream.available === "function" && typeof stream.read === "function") {
        let available = 0;
        try {
          available = Number(stream.available()) || 0;
        } catch (error) {
          if (isClosingError(error)) return { data: "", eof: true };
          throw error;
        }
        // Nothing buffered yet: not EOF, just early.
        if (available <= 0) return { data: "", eof: false };
        const data = String(stream.read(Math.min(available, 4096)) || "");
        // A readable stream that reports bytes but yields none is at EOF.
        return { data, eof: data === "" };
      }
      if (typeof stream.readBytes === "function") {
        const data = String(stream.readBytes(4096) || "");
        return { data, eof: data === "" };
      }
      throw new Error("The SMTP input stream is not readable");
    }

    /*
     * Read until the SMTP reply framing says the reply is complete.
     *
     * ASYNC, deliberately. `available()` returning 0 means "nothing buffered
     * yet", not end of stream: the server may not have replied in the
     * microseconds since the write. A synchronous retry would have to spin on
     * the main thread, which would stall all of Zotero, so the wait is a real
     * asynchronous delay and the whole read path is awaited.
     *
     * Bounded by the transport's own TIMEOUT_READ_WRITE for the socket, plus the
     * deadline and size limits enforced here.
     */
    async readReplyText({ maximumBytes = 8192 } = {}) {
      if (!this.input) throw new Error("The SMTP connection is not open");
      const deadline = Date.now() + this.ioTimeoutMs;
      for (;;) {
        if (lastLineCompletesReply(this.buffer)) {
          const reply = this.buffer;
          this.buffer = "";
          return reply;
        }
        if (this.buffer.length > maximumBytes || this.buffer.length > MAX_BUFFERED_BYTES) {
          throw new Error("The SMTP server reply exceeded FeedRank's size limit");
        }
        let result;
        try {
          result = this.readChunk();
        } catch (error) {
          if (isClosingError(error)) {
            throw new Error("The SMTP connection closed before a complete reply arrived");
          }
          throw new Error("Reading the SMTP reply failed — " + messageOf(error));
        }
        if (result.eof && !result.data) {
          throw new Error("The SMTP connection ended before a complete reply arrived");
        }
        if (result.data) {
          this.buffer += result.data;
          continue;
        }
        // Nothing buffered yet: wait without blocking the main thread, then
        // retry. The deadline is what makes this terminate.
        if (Date.now() >= deadline) {
          throw new Error(
            "The SMTP server did not finish its reply within " + this.ioTimeoutMs + " ms",
          );
        }
        await this.delay(20);
      }
    }

    write(text) {
      if (!this.output) throw new Error("The SMTP connection is not open");
      const source = String(text == null ? "" : text);
      if (!source) return;
      try {
        // nsIOutputStream.write takes a byte-counted string; SMTP commands and
        // base64 message bodies are pure ASCII by construction.
        this.output.write(source, source.length);
        if (typeof this.output.flush === "function") this.output.flush();
      } catch (error) {
        throw new Error("Writing to the SMTP connection failed — " + messageOf(error));
      }
    }

    // STARTTLS upgrade. Awaited, and followed by an explicit TLS assertion, so
    // the caller cannot continue on an un-upgraded socket.
    async startTLS() {
      if (this.security !== "starttls") throw new Error("This connection did not request STARTTLS");
      const control = this.transport?.tlsSocketControl;
      if (!control || typeof control.asyncStartTLS !== "function") {
        throw new Error("This Zotero build cannot upgrade the SMTP socket with STARTTLS");
      }
      try {
        await control.asyncStartTLS();
      } catch (error) {
        throw new Error("The STARTTLS handshake failed — " + messageOf(error));
      }
      // Reaching here means the handshake RESOLVED. Recorded before anything is
      // read from the control object, because that object's synchronous state
      // was observed to be still empty at this instant.
      this.tlsStarted = true;
      this.handshakeCompleted = true;
      // A previous diagnostic may have observed the pre-upgrade socket.
      this.securityEvidence = null;
      // Prefer the asynchronous accessor when the build has it: it is documented
      // to return the state after the handshake, whereas the synchronous
      // securityInfo property can still read as unpopulated here. Failure to
      // read it is not fatal — the recorded handshake still stands, and any
      // failure flag it does report is honoured by the gate.
      if (typeof control.asyncGetSecurityInfo === "function") {
        try {
          this.settledSecurityInfo = await control.asyncGetSecurityInfo();
        } catch (_) {
          this.settledSecurityInfo = null;
        }
      }
      // Discard anything the peer sent before the handshake; a real server sends
      // nothing between the 220 reply and the TLS ClientHello.
      this.buffer = "";
      return this.describeSecurity();
    }

    // Re-observe after encrypted network I/O (the post-STARTTLS EHLO), not at
    // the instant asyncStartTLS enables TLS. An unpopulated error-free record
    // alone is NOT proof of encryption. No AUTH bytes may precede this check.
    async verifyTLS() {
      const control = this.tlsControl();
      if (typeof control?.asyncGetSecurityInfo === "function") {
        try { this.settledSecurityInfo = await control.asyncGetSecurityInfo(); }
        catch (_) { this.settledSecurityInfo = null; }
      }
      this.securityEvidence = null;
      const evidence = this.describeSecurity();
      const verdict = this.Email.assertUsableTLS(evidence);
      if (!verdict.protocolConfirmed) {
        evidence.verifiedBy = "REFUSED";
        evidence.refusal = "Refusing to send SMTP credentials: a negotiated TLS 1.2 or 1.3 session could not be verified";
        this.securityEvidence = { ...evidence };
        throw new Error(evidence.refusal);
      }
      return verdict;
    }

    // Read the observed TLS state. Assertions are made in email.js
    // (assertUsableTLS) so the decision rule has one testable home.
    //
    // IDEMPOTENT: the first computed result is cached and returned thereafter.
    // Re-computing it is not harmless — the security info fills in over time, so a
    // second call can report a protocol version the gate did not have, which is
    // exactly what made one connection log show `protocolVersion THREW` and
    // `SSLVersionUsed = 772` next to `protocolConfirmed = false`. The evidence
    // must describe the moment the decision was made, not the moment it was
    // printed.
    describeSecurity() {
      if (this.securityEvidence) return { ...this.securityEvidence, checks: this.evaluatedChecks };
      try {
        return this.readSecurity();
      } catch (error) {
        /*
         * A LAST-RESORT GUARD, and the reason it exists.
         *
         * An XPCOM getter on this build raises NS_ERROR_NOT_AVAILABLE rather than
         * returning undefined, and there is more than one of them. Each was fixed
         * in turn, and each time the exception escaped, the caller saw a truncated
         * evidence object with an EMPTY checks list and `securityInfoPresent`
         * left at false — which the gate then read as "not encrypted".
         *
         * Rather than continue chasing individual getters, nothing may escape this
         * method at all. A read that throws produces the handshake-only fallback,
         * which is exactly the evidence the gate needs to admit a session whose
         * handshake demonstrably completed. It is recorded loudly so the specific
         * getter can still be found, but it can no longer decide the outcome.
         */
        const fallback = {
          securityInfoPresent: false,
          encrypted: null,
          failedVerification: false,
          failedCertChain: false,
          hasSecurityError: false,
          sslVersionUsed: -1,
          protocolVersion: -1,
          plaintextFallbackUsed: false,
          handshakeCompleted: this.handshakeCompleted === true,
          securityReadFailed: String(error?.message || error).slice(0, 200),
          verifiedBy: this.handshakeCompleted === true ? "completed-handshake" : "REFUSED",
        };
        if (fallback.handshakeCompleted !== true) {
          // No handshake either: this really is an unproven socket.
          fallback.encrypted = false;
        }
        this.securityEvidence = fallback;
        this.evaluatedChecks = [{ name: "describeSecurity THREW", value: fallback.securityReadFailed, evaluated: true }];
        return { ...fallback, checks: this.evaluatedChecks };
      }
    }

    readSecurity() {
      const transport = this.transport;
      const control = transport?.tlsSocketControl || null;
      const checks = [];
      const record = (name, value, evaluated) => {
        checks.push({ name, value, evaluated });
        return value;
      };
      const evidence = {
        securityInfoPresent: false,
        /*
         * NULL, not false. This field is a verdict, and an absent verdict is not
         * the same as a negative one. Leaving the default at `false` meant that
         * whenever the security record was not readable yet — which is the normal
         * state immediately after STARTTLS resolves on this build — the gate saw a
         * deliberate "not encrypted" and refused a working connection, bypassing
         * the handshake fallback entirely. The live log that reported
         * `encrypted = false, sslVersionUsed = -1, handshakeCompleted = true` was
         * refused for exactly that reason.
         *
         * It is set below, and only to something a read actually established.
         */
        encrypted: null,
        failedVerification: false,
        failedCertChain: false,
        hasSecurityError: false,
        sslVersionUsed: -1,
        // A second, independent source for the negotiated version. On the
        // installed build nsITLSSocketControl exposes no readable SSLVersionUsed,
        // so the protocol has to come from the settled security info instead;
        // -1 means "not observed" and must never be read as a version.
        protocolVersion: -1,
        plaintextFallbackUsed: false,
        // A resolved STARTTLS handshake. The gate accepts this as proof of
        // encryption when nothing established a negative verdict.
        handshakeCompleted: this.handshakeCompleted === true,
      };

      if (!control) {
        this.securityEvidence = evidence;
        this.evaluatedChecks = checks;
        return { ...evidence, checks };
      }

      // Every control read is guarded: these are XPCOM getters that raise
      // NS_ERROR_NOT_AVAILABLE rather than returning undefined on this build.
      const sslVersionUsed = readQuietly(control, "SSLVersionUsed");
      if (typeof sslVersionUsed === "number") {
        evidence.sslVersionUsed = sslVersionUsed;
        record("SSLVersionUsed", sslVersionUsed, true);
      } else {
        record("SSLVersionUsed", null, false);
      }
      const failedVerification = readQuietly(control, "failedVerification");
      if (typeof failedVerification === "boolean") {
        evidence.failedVerification = failedVerification;
        record("failedVerification", failedVerification, true);
      } else {
        record("failedVerification", null, false);
      }

      // Prefer the security info obtained asynchronously after the handshake:
      // the synchronous property was observed to be unpopulated at that moment.
      //
      // Both reads are guarded. `control.securityInfo` is a getter that raises
      // NS_ERROR_NOT_AVAILABLE on this build, and an unguarded read there threw out
      // of describeSecurity() and aborted the whole connection test — the live log
      // showed `securityInfo = [unprintable]` with `securityInfoPresent = false`,
      // which is what that exception looks like from the outside.
      const info = this.settledSecurityInfo || readQuietly(control, "securityInfo") || null;
      if (info) {
        evidence.securityInfoPresent = true;
        record("securityInfo", true, true);
        /*
         * The negotiated protocol version.
         *
         * `SSLVersionUsed` on the control object is the wire code point and is
         * readable on some runs (772 == TLS 1.3) but reads -1 on others, because
         * it is not populated at the instant it is first asked. The security
         * info's own `protocolVersion` is NOT a wire code point on this build but
         * an enum, where 3 means TLS 1.2 and 4 means TLS 1.3.
         *
         * Exactly ONE of these members exists, so the loop must stop after the
         * first name it finds: a missing alias raises NS_ERROR_NOT_AVAILABLE on
         * the SECOND name, and letting that exception escape discarded the first,
         * perfectly good value.
         */
        let protocolValue = null;
        for (const member of ["protocolVersion", "ProtocolVersion"]) {
          let exists = false;
          try {
            exists = member in info;
          } catch (_) {
            exists = false;
          }
          if (!exists) continue;
          try {
            const value = info[member];
            if (typeof value === "number" && value > 0) protocolValue = value;
            record("securityInfo." + member, value, true);
          } catch (error) {
            // Recorded and deliberately NOT fatal: this getter raising on one
            // member must not cost us the version we can read elsewhere.
            record("securityInfo." + member + " THREW", String(error?.message || error).slice(0, 120), true);
          }
          break;
        }
        if (protocolValue != null) evidence.protocolVersion = protocolValue;

        /*
         * Encryption verdict, from POSITIVE evidence only.
         *
         * A security state is NOT populated at the moment a handshake resolves:
         * `securityState` reads 0 and `isSecure` reads false on a connection that
         * is in fact TLS 1.3 with a valid chain (the live Outlook log). Treating
         * that as a verdict refused a working connection twice, so the verdict is
         * no longer taken from the state object at all. It is taken from things
         * that can only be true of an established, verified session:
         *
         *   - a non-empty cipher name, which only exists after a handshake;
         *   - `errorCodeString` empty, meaning no TLS-level failure was recorded;
         *   - a certificate chain that was BUILT and not reported as failed.
         *
         * A refusal still comes from positive evidence of failure, which the gate
         * applies: failedVerification, a failed chain, a broken state, or a
         * security error.
         */
        const cipher = readQuietly(info, "cipherName");
        if (typeof cipher === "string" && cipher) {
          evidence.cipherName = cipher.slice(0, 80);
          record("cipherName", evidence.cipherName, true);
        } else {
          record("cipherName", null, false);
        }
        const errorString = readQuietly(info, "errorCodeString");
        const hasErrorString = typeof errorString === "string" && errorString.length > 0;
        if (hasErrorString) {
          evidence.hasSecurityError = true;
          record("errorCodeString", errorString, true);
        } else {
          record("errorCodeString", null, false);
        }
        const chain = readQuietly(info, "failedCertChain");
        if (Array.isArray(chain) && chain.length) {
          evidence.failedCertChain = true;
          record("failedCertChain", chain.length, true);
        } else {
          record("failedCertChain", Array.isArray(chain) ? 0 : null, Array.isArray(chain));
        }
        const succeeded = readQuietly(info, "succeededCertChain");
        const chainBuilt = Array.isArray(succeeded) && succeeded.length > 0;
        record("succeededCertChain", chainBuilt ? succeeded.length : null, chainBuilt);

        // Recorded for the report, and inspected ONLY for a positive failure
        // report. On this build the state is a bare number before the handshake
        // settles, so a numeric value is never a verdict; but an object that
        // explicitly reports `isBroken` is a real failure and must be honoured.
        const state = readQuietly(info, "securityState");
        if (typeof state === "number" && (state & 1) !== 0) {
          evidence.hasSecurityError = true;
          record("securityState.isBroken", true, true);
        }
        if (state && typeof state === "object") {
          const broken = readQuietly(state, "isBroken");
          if (broken === true) {
            evidence.hasSecurityError = true;
            record("securityState.isBroken", true, true);
          }
        }
        record("securityState", typeof state === "object" ? "[object]" : state,
          typeof state === "number" || (state != null && typeof state === "object"));

        if (!hasErrorString && !evidence.failedCertChain) {
          const reasons = [];
          if (evidence.cipherName) reasons.push("cipher " + evidence.cipherName);
          if (chainBuilt) reasons.push("certificate chain verified");
          const secureState = typeof state === "number" ? (state & 2) !== 0
            : readQuietly(state, "isSecure") === true;
          if (secureState) reasons.push("secure TLS state");
          if (reasons.length && (this.security === "ssl" || this.tlsStarted === true)) {
            evidence.encrypted = true;
            evidence.encryptionEvidence = reasons.join(", ");
            record("encryptedFrom", evidence.encryptionEvidence, true);
          }
        } else {
          // A TLS error string or a failed chain IS positive evidence of a broken
          // session, so this is a real negative verdict.
          evidence.encrypted = false;
          evidence.encryptionEvidence = "a TLS error or a failed certificate chain was reported";
          record("encryptedFrom", evidence.encryptionEvidence, true);
        }
      } else {
        // NO USABLE SECURITY RECORD. This is the normal state on this build for a
        // short window after STARTTLS resolves, and it is not a verdict: the
        // record is unreadable, not negative. `encrypted` stays null so the gate
        // falls through to the handshake, which is real evidence in its own right.
        record("securityInfo", null, false);
      }

      // A READABLE version can only exist once a handshake negotiated it, so it is
      // trustworthy positive evidence and also settles the handshake question.
      const versionObserved = evidence.sslVersionUsed !== -1 || evidence.protocolVersion !== -1;
      if (versionObserved) {
        evidence.handshakeCompleted = true;
        this.handshakeCompleted = true;
        if (evidence.encrypted == null) {
          evidence.encrypted = true;
          evidence.encryptionEvidence = "implicit TLS with a negotiated version";
        }
        record("versionObserved", evidence.sslVersionUsed !== -1 ? evidence.sslVersionUsed : evidence.protocolVersion, true);
      } else {
        record("versionObserved", null, false);
      }

      // A STARTTLS socket that reports neither a handshake nor any version is the
      // one shape where nothing at all was established, and it must be refused.
      // The gate refuses it by requiring either `encrypted === true` or a resolved
      // handshake, both of which are absent here.
      if (this.security === "starttls" && evidence.encrypted == null && evidence.handshakeCompleted !== true) {
        evidence.encrypted = false;
        evidence.encryptionEvidence = "STARTTLS did not complete and no version was readable";
        record("encryptedFrom", evidence.encryptionEvidence, true);
      }
      // A STARTTLS socket is still plaintext until the explicit upgrade. This
      // also keeps failure diagnostics from inventing a completed handshake.
      if (this.security === "starttls" && this.tlsStarted !== true) {
        evidence.encrypted = false;
        evidence.handshakeCompleted = false;
        evidence.encryptionEvidence = "STARTTLS has not started; no TLS session established";
        record("encryptedFrom", evidence.encryptionEvidence, true);
      }

      this.securityEvidence = evidence;
      this.evaluatedChecks = checks;
      // Record the gate's own verdict on this evidence, so a diagnostic can show
      // WHY the connection was accepted or refused rather than only the inputs.
      try {
        const verdict = this.Email?.assertUsableTLS(evidence);
        // Defensive: a gate that returns nothing must not crash the diagnostic,
        // which is what produced "can't access property verifiedBy, verdict is
        // undefined" in the log and hid the real failure.
        evidence.verifiedBy = verdict?.verifiedBy || "accepted (no verdict detail)";
        evidence.protocolConfirmed = verdict?.protocolConfirmed === true;
      } catch (error) {
        evidence.verifiedBy = "REFUSED";
        evidence.refusal = String(error?.message || error).slice(0, 300);
      }
      // Say WHY the version is unconfirmed, so a reader does not have to infer it
      // from the values above. The two sources are read independently, and on the
      // installed build they disagree depending only on when they are asked.
      if (evidence.protocolConfirmed !== true) {
        evidence.protocolNote = "No TLS version was readable at the moment of the decision: " +
          "SSLVersionUsed read " + evidence.sslVersionUsed +
          " and nsITransportSecurityInfo.protocolVersion " +
          (evidence.protocolVersion === -1 ? "was not readable yet" : "read " + evidence.protocolVersion) +
          (evidence.encrypted === true
            ? ". Encryption was observed, but the protocol version remains unconfirmed."
            : ". A negotiated TLS session has not been verified; no credential may be sent.");
      }
      return { ...evidence, checks };
    }

    isAlive() {
      try {
        return Boolean(this.transport?.isAlive?.());
      } catch (_) {
        return false;
      }
    }

    // The nsITLSSocketControl this socket is speaking through, or null. Exposed
    // for the diagnostics report, which inventories its members; nothing else
    // should hold a reference to it.
    tlsControl() {
      try {
        return this.transport?.tlsSocketControl || null;
      } catch (_) {
        return null;
      }
    }

    close() {
      this.closed = true;
      const attempt = (fn) => {
        try {
          fn?.();
        } catch (_) {}
      };
      // The scriptable wrapper forwards close() to the stream it wraps, but the
      // raw stream is closed explicitly as well so a wrapper that fails to
      // forward cannot leave the socket half-open.
      attempt(() => this.input?.close?.());
      attempt(() => this.rawInput?.close?.());
      attempt(() => this.output?.close?.());
      attempt(() => this.transport?.close?.(0));
      this.input = null;
      this.rawInput = null;
      this.output = null;
      this.transport = null;
    }
  }

  function createSocketConnection(options) {
    return new SMTPSocketConnection(options);
  }

  // ---------------------------------------------------------------------------
  // SMTP session driver
  // ---------------------------------------------------------------------------

  /*
   * A session is driven entirely through a small `socket` interface:
   *   open(), write(text), readReplyText(), startTLS(), describeSecurity(),
   *   close()
   * so the full protocol exchange is testable with a mock socket.
   */
  class SMTPSession {
    constructor({ Email, socket, timeouts = {} } = {}) {
      if (!Email) throw new Error("FeedRank email helpers are required");
      if (!socket) throw new Error("An SMTP socket is required");
      this.Email = Email;
      this.socket = socket;
      this.transcript = [];
      // Recorded so an unknown outcome can be classified correctly: once the
      // terminating dot has been written, delivery can no longer be disproved.
      this.messageSubmitted = false;
      this.tlsAsserted = false;
      this.serverAccepted = false;
      this.authenticationInProgress = false;
      this.authStage = "not started";
      this.authReplies = [];
    }

    // Bounded protocol record. Authentication continuations and initial
    // responses are never retained, even as base64. Server AUTH replies record
    // only the code, so an echoed credential cannot enter the transcript.
    note(direction, text) {
      let safeText = String(text == null ? "" : text);
      if (this.authenticationInProgress) {
        if (direction === "S") {
          safeText = "[AUTH reply " + (safeText.match(/^(\d{3})/)?.[1] || "unparsed") + "]";
        } else if (!/^AUTH LOGIN\r\n$/.test(safeText)) {
          safeText = "[AUTH credential redacted]";
        }
      }
      this.transcript.push({
        direction,
        text: safeText.replace(/\r\n/g, "\\r\\n").slice(0, 400),
      });
      if (this.transcript.length > 200) this.transcript.shift();
    }

    async readReply() {
      const raw = await this.socket.readReplyText();
      if (this.authenticationInProgress) {
        this.authReplies.push({ stage: this.authStage, code: Number(String(raw).match(/^(\d{3})/)?.[1]) || 0 });
      }
      this.note("S", raw);
      return raw;
    }

    async send(phase, command) {
      if (command != null) {
        this.note("C", command);
        this.socket.write(command);
      }
      const raw = await this.readReply();
      const checked = this.Email.requireReply(phase, raw);
      return { ...checked, raw };
    }

    // Write a command and read its reply WITHOUT asserting a final code, for
    // the multi-step AUTH exchanges where the server legitimately answers with
    // an intermediate 334 challenge.
    async sendUnchecked(command) {
      this.note("C", command);
      this.socket.write(command);
      const raw = await this.readReply();
      return this.Email.checkReply("auth", raw);
    }

    // Proves the transport is live and that the server greeted us, without
    // sending any credential or message content.
    async greet() {
      return this.send("greeting", null);
    }

    async ehlo(clientName = "feedrank.local") {
      const reply = await this.send("ehlo", this.Email.buildCommand("EHLO", clientName));
      return this.Email.parseEhloCapabilities(reply.raw);
    }

    async upgradeToTLS(capabilities) {
      if (this.socket.security !== "starttls") return null;
      if (capabilities && capabilities.supportsStartTLS === false) {
        throw new Error("The SMTP server does not advertise STARTTLS; no credential will be sent in plaintext");
      }
      await this.send("starttls", this.Email.buildCommand("STARTTLS"));
      const evidence = await this.socket.startTLS();
      const negotiated = this.Email.assertUsableTLS(evidence);
      this.tlsAsserted = true;
      return negotiated;
    }

    // The only place credentials are written. Guarded so a caller cannot reach
    // it before TLS has been proven on the live connection.
    async authenticate(args) {
      this.authenticationInProgress = true;
      this.authStage = "verify TLS";
      try {
        const reply = await this.authenticateExchange(args);
        this.authStage = "accepted";
        return reply;
      } catch (error) {
        if (error && typeof error === "object") error.smtpAuthStage = this.authStage;
        throw error;
      } finally {
        this.authenticationInProgress = false;
      }
    }

    async authenticateExchange({ authMethod, username, secret, capabilities = null }) {
      if (this.socket.security === "starttls" && !this.tlsAsserted) {
        throw new Error("Refusing to authenticate before STARTTLS has been verified");
      }
      if (this.socket.security !== "starttls") {
        // Implicit TLS: assert the observed session state before writing.
        const evidence = this.socket.describeSecurity();
        this.Email.assertUsableTLS(evidence);
        this.tlsAsserted = true;
      }
      // The native transport requires a fresh, version-confirmed session even
      // if the early STARTTLS placeholder was accepted by the pure gate.
      if (typeof this.socket.verifyTLS === "function") await this.socket.verifyTLS();
      const method = String(authMethod || "").toLowerCase();
      // A server that advertises its AUTH mechanisms is authoritative: do not
      // transmit a credential in a mechanism it never offered. A server that
      // advertises no AUTH line at all is left to reject the command itself,
      // because a few deployments still accept AUTH unadvertised.
      const offered = capabilities?.authMechanisms;
      if (Array.isArray(offered) && offered.length && !offered.includes(method.toUpperCase())) {
        const error = new Error(
          "The SMTP server does not offer AUTH " + method.toUpperCase() +
          " (it advertised: " + offered.join(", ") + ")",
        );
        error.smtpPhase = "auth";
        error.smtpCode = 0;
        error.smtpClass = "configuration";
        throw error;
      }
      if (method === "login") {
        // AUTH LOGIN is a challenge/response exchange. The server answers the
        // AUTH command with "334 <base64 prompt>", then the client sends the
        // base64 username on its own line, receives another 334, and sends the
        // base64 secret. 235/503 mean no challenge was needed.
        // Pre-build all three lines before writing anything; no initial
        // username is attached to AUTH LOGIN. Each 334 gets its correct answer.
        const command = this.Email.buildAuthCommand("login", { username, secret });
        const usernameLine = this.Email.buildLoginSecretCommand(username);
        const secretLine = this.Email.buildLoginSecretCommand(secret);
        this.authStage = "LOGIN command";
        const first = await this.sendUnchecked(command);
        if (first.code === 235 || first.code === 503) return first;
        if (first.code !== 334) {
          const error = new Error("SMTP authentication failed with " + first.code + " " + first.text);
          error.smtpCode = first.code;
          error.smtpPhase = "auth";
          error.smtpClass = first.klass;
          throw error;
        }
        this.authStage = "LOGIN username";
        const challenge = await this.sendUnchecked(usernameLine);
        if (challenge.code === 235 || challenge.code === 503) return challenge;
        if (challenge.code !== 334) {
          const error = new Error("SMTP authentication failed with " + challenge.code + " " + challenge.text);
          error.smtpCode = challenge.code;
          error.smtpPhase = "auth";
          error.smtpClass = challenge.klass;
          throw error;
        }
        // The final reply to the secret is the only one that proves the
        // credential was accepted, so this step does assert a final code.
        this.authStage = "LOGIN secret";
        return this.send("auth", secretLine);
      }
      this.authStage = method.toUpperCase() + " initial response";
      return this.send("auth", this.Email.buildAuthCommand(method, { username, secret }));
    }

    async noop() {
      return this.send("noop", this.Email.buildCommand("NOOP"));
    }

    async quit() {
      try {
        return await this.send("quit", this.Email.buildCommand("QUIT"));
      } catch (_) {
        // QUIT is best-effort: the message outcome is already decided.
        return null;
      }
    }

    // Envelope and message submission. `message` is the exact, pre-built MIME
    // text; nothing is regenerated here.
    async submit({ from, to, message }) {
      await this.send("mailFrom", this.Email.buildCommand("MAIL FROM", "<" + from + ">"));
      await this.send("rcptTo", this.Email.buildCommand("RCPT TO", "<" + to + ">"));
      await this.send("data", this.Email.buildCommand("DATA"));
      // From here on the server may already hold the message.
      this.messageSubmitted = true;
      this.socket.write(this.Email.dotStuff(message));
      const final = this.Email.requireReply("body", await this.readReply());
      this.serverAccepted = true;
      return final;
    }
  }

  // ---------------------------------------------------------------------------
  // High-level operations
  // ---------------------------------------------------------------------------

  // A connection test performs greeting, EHLO, optional STARTTLS, AUTH, QUIT.
  // It never issues MAIL FROM, RCPT TO, or DATA, so no message can be sent.
  /**
   * Choose the mechanism to authenticate with.
   *
   * A server that advertises its AUTH list is authoritative, and the list is
   * often narrower than the configured preference: smtp-mail.outlook.com offers
   * LOGIN and XOAUTH2 and NOT PLAIN, so a saved "AUTH PLAIN" made a working,
   * fully encrypted connection fail with what looked like a TLS error. Rather
   * than making the user discover and change a setting, the strongest
   * advertised mechanism is negotiated, keeping the configured choice when the
   * server does offer it.
   */
  function resolveAuthMethod({ Email, configured, capabilities }) {
    const preferred = String(configured || "").toLowerCase();
    const offered = (Array.isArray(capabilities?.authMechanisms) ? capabilities.authMechanisms : [])
      .map((name) => String(name || "").toUpperCase())
      .filter(Boolean);
    if (!offered.length) return { method: preferred, negotiated: false, offered };
    if (offered.includes(preferred.toUpperCase())) {
      return { method: preferred, negotiated: false, offered };
    }
    // PLAIN and LOGIN use passwords; XOAUTH2 uses bearer tokens. Never switch
    // credential families or accidentally send a password as an OAuth token.
    for (const candidate of (preferred === "xoauth2" ? [] : ["plain", "login"])) {
      if (offered.includes(candidate.toUpperCase())) {
        return { method: candidate, negotiated: true, offered };
      }
    }
    // The server advertises AUTH but none of the three mechanisms this client
    // implements. `authenticate` reports that against the advertised list.
    return { method: preferred, negotiated: false, offered };
  }

  /**
   * The reply that belongs to THIS error, or "".
   *
   * Deliberately narrow. An earlier revision fell back to the last reply in the
   * session transcript, which is actively harmful: on a disconnect after the
   * terminating dot, the last recorded reply is the "250 Ok" that preceded the
   * send, and reporting that as the failure's server reply made an UNKNOWN
   * outcome look like a retryable one. Better to report no reply than the wrong
   * one.
   */
  function serverReplyText(error) {
    const candidates = [error?.serverReply, error?.smtpReply, error?.reply, error?.responseText];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 500);
    }
    return "";
  }

  // Read a member that may raise rather than return. nsITLSSocketControl and
  // nsITransportSecurityInfo both have getters that throw NS_ERROR_NOT_AVAILABLE
  // on this build, so no diagnostic read may be unguarded.
  function readQuietly(owner, name) {
    if (owner == null) return null;
    try {
      return owner[name] ?? null;
    } catch (_) {
      return null;
    }
  }

  async function runConnectionTest({ Email, socket, credentials, timeouts = {}, Diagnostics = null } = {}) {
    const plan = Email.buildConnectionTestPlan({ config: credentials });
    Email.assertNoMessageTransmission(plan.steps);
    const session = new SMTPSession({ Email, socket, timeouts });
    // Everything the diagnostic needs to explain a refusal, captured as it
    // happens. Read-only: no secret is included, and no socket is opened for it.
    const observed = {
      tlsMode: plan.tlsMode,
      authMethod: plan.authMethod,
      ehloCapabilities: "",
      starttlsNegotiated: "",
    };
    let greetingReceived = false;
    // Timing, because "it takes longer this time" is a report worth being able to
    // check rather than guess at. Each stage is stamped as it completes.
    const startedAt = Date.now();
    let stageStartedAt = startedAt;
    const timings = [];
    const markStage = (name) => {
      const now = Date.now();
      timings.push(name + " " + (now - stageStartedAt) + "ms");
      stageStartedAt = now;
    };
    // Observation must never change behaviour: a diagnostic that throws would
    // turn a passing connection test into a failure, so every write here is
    // defensive. `session.ehlo()` returns a parsed object whose `capabilities`
    // member is the list; accepting a raw list too keeps this observation
    // harmless for mocked transports.
    const noteCapabilities = (capabilities) => {
      try {
        const lines = Array.isArray(capabilities?.capabilities)
          ? capabilities.capabilities
          : (Array.isArray(capabilities) ? capabilities : []);
        observed.ehloCapabilities = lines
          .map((line) => String(line).slice(0, 120))
          .join(" | ") || "(not a list)";
      } catch (_) {
        observed.ehloCapabilities = "(unreadable)";
      }
    };
    const diagnosticsFor = (error) => {
      if (!Diagnostics?.buildReport) return "";
      const credentialsSecrets = [credentials?.secret];
      try {
        // The CACHED evidence, not a fresh read: describeSecurity() is idempotent,
        // so this is the state at the moment the decision was made. Re-deriving it
        // here is what previously let one report show a version next to
        // `protocolConfirmed = false`.
        const evidence = socket.describeSecurity ? socket.describeSecurity() : null;
        const control = socket.tlsControl() || null;
        const report = Diagnostics.buildReport({
          tlsSocketControl: control,
          securityInfo: readQuietly(control, "securityInfo"),
          settledSecurityInfo: socket.settledSecurityInfo || null,
          transport: socket.transport || null,
          socket,
          evidence,
        }, {
          ...observed,
          authStage: session.authStage,
          authReplies: session.authReplies.map((reply) => reply.stage + " → " + reply.code).join(" | ") || "none",
          failure: error ? (error.message || String(error)) : "none",
          host: plan.host,
          port: plan.port,
          username: credentials?.username || "",
        });
        // A report must never carry the credential, even though this code does
        // not read it.
        return Diagnostics.assertNoSecret(report, credentialsSecrets);
      } catch (reportError) {
        // A report that cannot be built must still say something. Returning ""
        // here is what left the settings log box empty while the failure message
        // blamed an unrelated component, which is strictly worse than a short
        // honest report.
        try {
          return Diagnostics.assertNoSecret(
            "FeedRank connection log\n" +
            "The full runtime inventory could not be built: " +
            String(reportError?.message || reportError) + "\n" +
            "Gate failure: " + (error ? (error.message || String(error)) : "none") + "\n" +
            "Host: " + plan.host + ":" + plan.port + " (" + plan.tlsMode + ")\n" +
            "This is a defect in the diagnostic itself; the connection result above is still valid.",
            credentialsSecrets,
          );
        } catch (_) {
          return "";
        }
      }
    };
    try {
      await session.greet();
      greetingReceived = true;
      markStage("greeting");
      let capabilities = await session.ehlo();
      noteCapabilities(capabilities);
      markStage("ehlo");
      let negotiated = null;
      if (plan.tlsMode === "starttls") {
        negotiated = await session.upgradeToTLS(capabilities);
        observed.starttlsNegotiated = negotiated?.protocol || "";
        markStage("starttls");
        // RFC 3207: the server resets its state after STARTTLS, so the
        // capability list must be re-read over the encrypted channel.
        capabilities = await session.ehlo();
        noteCapabilities(capabilities);
        markStage("ehlo-after-tls");
        if (typeof socket.verifyTLS === "function") {
          negotiated = await socket.verifyTLS();
          observed.starttlsNegotiated = negotiated.protocol;
        }
      } else {
        negotiated = Email.assertUsableTLS(socket.describeSecurity());
        session.tlsAsserted = true;
      }
      // Negotiate the mechanism only AFTER the capability list has been re-read
      // over the encrypted channel, which is the list that counts.
      const auth = resolveAuthMethod({
        Email,
        configured: plan.authMethod,
        capabilities,
      });
      observed.authNegotiated = auth.negotiated ? auth.method : "configured";
      observed.authOffered = auth.offered.join(", ");
      await session.authenticate({
        authMethod: auth.method,
        username: credentials.username,
        secret: credentials.secret,
        capabilities,
      });
      markStage("authenticate");
      await session.quit();
      markStage("quit");
      observed.totalElapsedMs = Date.now() - startedAt;
      observed.timings = timings.join(", ");
      return {
        ok: true,
        authStage: session.authStage,
        host: plan.host,
        port: plan.port,
        tlsMode: plan.tlsMode,
        protocol: negotiated?.protocol || "",
        protocolConfirmed: negotiated?.protocolConfirmed !== false,
        verifiedBy: negotiated?.verifiedBy || "",
        authMethod: auth.method,
        authNegotiated: auth.negotiated,
        authOffered: auth.offered,
        // Stated explicitly so no caller can mistake a connection test for a
        // delivery: no message was transmitted.
        messageTransmitted: false,
        steps: plan.steps,
        diagnostics: diagnosticsFor(null),
      };
    } catch (error) {
      // The server's own reply is often the only place the real reason appears,
      // and it is not in `error.message` today: a 535 from Outlook carries a
      // correlation id and, when the cause is a disabled mechanism, an explicit
      // "SmtpClientAuthentication is disabled" sentence. Surface it verbatim.
      markStage("FAILED at this stage");
      observed.totalElapsedMs = Date.now() - startedAt;
      observed.timings = timings.join(", ");
      if (error?.smtpAuthStage) observed.failureStage = "authentication: " + error.smtpAuthStage;
      if (!greetingReceived) {
        // Greeting failure means AUTH was never reached. Never diagnose it as
        // a bad password or automatically retry with another security mode.
        observed.failureStage = "greeting (before EHLO or authentication)";
        if (error && typeof error === "object" && !observed.ehloCapabilities) {
          error.message += " No authentication was attempted. " +
            (plan.tlsMode === "starttls" && [465, 994].includes(plan.port)
              ? "This port commonly expects Implicit TLS from the first byte; check the provider's TLS setting."
              : "Check the provider's SMTP host, port, TLS mode, and network reachability.");
        }
      }
      if (error && typeof error === "object") {
        try {
          const serverReply = serverReplyText(error);
          if (serverReply) error.feedRankServerReply = serverReply;
        } catch (_) {}
      }
      // Attached to the error so the caller can show it beside the failure
      // message rather than making the user reproduce the failure to get it.
      try {
        if (error && typeof error === "object" && !error.feedRankDiagnostics) {
          error.feedRankDiagnostics = diagnosticsFor(error);
        }
      } catch (_) {}
      throw error;
    } finally {
      socket.close();
    }
  }

  async function submitMessage({ Email, socket, credentials, submission, timeouts = {} } = {}) {
    if (!submission?.message) throw new Error("A frozen MIME message is required before submission");
    const session = new SMTPSession({ Email, socket, timeouts });
    let authenticated = false;
    // Declared OUTSIDE the try: the catch block needs it to explain a credential
    // rejection, and a `const` inside the try is not in scope there. Getting that
    // wrong threw "auth is not defined" FROM the catch block, which was then
    // classified as a retryable transport failure — so a real SMTP reply was
    // reported as a retryable network problem. A bug in the error path must never
    // be able to masquerade as the error it is describing.
    let auth = null;
    try {
      await session.greet();
      let capabilities = await session.ehlo();
      if (submission.tlsMode === "starttls") {
        await session.upgradeToTLS(capabilities);
        capabilities = await session.ehlo();
      } else {
        Email.assertUsableTLS(socket.describeSecurity());
        session.tlsAsserted = true;
      }
      // Same negotiation as the connection test: the advertised list is
      // authoritative, so a saved "AUTH PLAIN" against a server that offers only
      // LOGIN/XOAUTH2 must not cost the user a send.
      auth = resolveAuthMethod({
        Email,
        configured: credentials.authMethod,
        capabilities,
      });
      await session.authenticate({
        authMethod: auth.method,
        username: credentials.username,
        secret: credentials.secret,
        capabilities,
      });
      authenticated = true;
      const final = await session.submit({
        from: submission.envelopeFrom,
        to: submission.envelopeTo,
        message: submission.message,
      });
      await session.quit();
      return {
        accepted: true,
        retryable: false,
        state: "accepted",
        code: final.code,
        messageSubmitted: true,
        // The server accepted responsibility. SMTP cannot prove inbox delivery.
        serverAccepted: true,
        serverReply: final.text,
        transcript: session.transcript,
      };
    } catch (error) {
      // Narrowed to a string on purpose: `error.feedRankServerReply` may be an
      // Error, and the caller only ever renders it.
      const extractedReply = serverReplyText(error);
      if (error && typeof error === "object" && extractedReply && !error.feedRankServerReply) {
        try {
          error.feedRankServerReply = extractedReply;
        } catch (_) {}
      }
      const classified = Email.classifySMTPError(error, {
        // Prefer the session's own record over the caller's expectation: it is
        // set at the exact moment the terminating dot is written. `undefined`
        // when the session has no record, so the classifier falls back to the
        // error itself rather than being told "false" about an unknown outcome.
        messageSubmitted: session.messageSubmitted === true ? true : undefined,
        // Passed so a 535 can explain the likely cause rather than only the code.
        // Null-guarded: if authentication was never reached there is no method to
        // report, and the hint must simply be omitted.
        authMethod: auth?.method || credentials?.authMethod || "",
        host: credentials?.host || "",
      });
      return {
        ...classified,
        authenticated,
        // Always a string, and empty when the error carried no reply. Never a
        // reply borrowed from another step, which would misreport an unknown
        // outcome as though the server had answered this one.
        serverReply: extractedReply || "",
        // Same reason: a caller renders this, so it must never be undefined.
        error: classified.error || "The SMTP server did not accept the message",
        transcript: session.transcript,
      };
    } finally {
      socket.close();
    }
  }

  return Object.freeze({
    SOCKET_TRANSPORT_SERVICE,
    SCRIPTABLE_INPUT_STREAM,
    BINARY_OUTPUT_STREAM,
    TIMER,
    WAIT_CLOSURE_ONLY,
    OPEN_BLOCKING,
    OPEN_UNBUFFERED,
    TIMEOUT_CONNECT,
    TIMEOUT_READ_WRITE,
    DEFAULT_CONNECT_TIMEOUT_MS,
    DEFAULT_IO_TIMEOUT_MS,
    MAX_BUFFERED_BYTES,
    lastLineCompletesReply,
    resolveAuthMethod,
    serverReplyText,
    SMTPSocketConnection,
    SMTPSession,
    createSocketConnection,
    getService,
    createInstance,
    runConnectionTest,
    submitMessage,
  });
});
