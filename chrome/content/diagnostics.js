"use strict";

/*
 * FeedRank for Zotero — runtime diagnostics for the SMTP/TLS path.
 *
 * This module exists because the installed Gecko build does not expose the
 * members the SMTP code was written against: nsITLSSocketControl has no readable
 * `SSLVersionUsed`, and nsITransportSecurityInfo could not be confirmed to carry
 * a protocol version. Guessing at that shape from documentation produced two
 * rounds of "the connection is not encrypted" on a connection that was in fact
 * encrypted.
 *
 * So this module reports what the runtime ACTUALLY has, member by member, and
 * compares it with what the gate reads. It is a read-only inventory: it opens no
 * socket, sends nothing, reads no message, and never touches a credential.
 *
 * INVARIANTS, enforced by tests:
 *   - no secret, password, or ciphertext may appear in a report;
 *   - the report is bounded in length, because it is rendered into a settings
 *     window rather than a log file;
 *   - a member that throws on read is reported as THREW, not omitted, so a
 *     getter that raises is visible rather than looking absent.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FeedRankDiagnostics = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MAX_REPORT_CHARS = 12000;
  const MAX_MEMBERS = 60;

  // Members the SMTP gate and transport actually read, in the order they matter.
  // Each entry names where it comes from so a missing line points at the code
  // that will fail.
  const CONSUMED_MEMBERS = Object.freeze([
    { owner: "tlsSocketControl", name: "SSLVersionUsed", used: "the negotiated TLS version" },
    { owner: "tlsSocketControl", name: "failedVerification", used: "a certificate-verification failure" },
    { owner: "tlsSocketControl", name: "securityInfo", used: "the synchronous security state" },
    { owner: "tlsSocketControl", name: "asyncGetSecurityInfo", used: "the settled security state" },
    { owner: "tlsSocketControl", name: "asyncStartTLS", used: "the STARTTLS upgrade" },
    { owner: "securityInfo", name: "protocolVersion", used: "the negotiated TLS version" },
    { owner: "securityInfo", name: "securityState", used: "isSecure / isBroken" },
    { owner: "securityInfo", name: "failedCertChain", used: "a failed certificate chain" },
    { owner: "securityInfo", name: "errorCodeString", used: "a TLS error report" },
  ]);

  // Bumped whenever the TLS evidence or gate changes. It is printed in every
  // report so a log can be attributed to the code that produced it: two live logs
  // differed from the current source while the installed XPI matched it exactly,
  // and there was no way to tell from the log which build had run.
  const DIAGNOSTICS_BUILD = 6;

  function text(value, maximum = 400) {
    if (value == null) return "";
    let rendered;
    if (typeof value === "string") rendered = value;
    else if (typeof value === "number" || typeof value === "boolean") rendered = String(value);
    else if (typeof value === "function") rendered = "function";
    else {
      try {
        rendered = JSON.stringify(value);
      } catch (_) {
        rendered = "[unprintable]";
      }
    }
    return String(rendered == null ? "" : rendered)
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .slice(0, Math.max(0, maximum));
  }

  /**
   * Every own property name on an object and its prototype chain. Mirrors the
   * enumeration the TLS probe tool uses, and is how a member the code needs gets
   * discovered when it is not where the documentation says it is.
   */
  function memberNames(value) {
    const names = new Set();
    if (value == null) return [];
    let object = value;
    let depth = 0;
    try {
      while (object && object !== Object.prototype && depth < 8) {
        for (const name of Object.getOwnPropertyNames(object)) names.add(name);
        object = Object.getPrototypeOf(object);
        depth++;
      }
    } catch (_) {
      // A proxy or a dead wrapper can refuse enumeration. Report what we have.
    }
    return [...names].sort().slice(0, MAX_MEMBERS);
  }

  /**
   * Describe the security state without assuming its shape. This build returns
   * `securityState` as a NUMBER (0 == STATE_IS_INSECURE) rather than an object
   * with `isSecure`, so an object-only read printed three `undefined`s over a
   * value it had actually read.
   */
  function describeSecurityState(state) {
    if (state == null) return "ABSENT";
    if (typeof state === "number") {
      const names = { 0: "STATE_IS_INSECURE", 1: "STATE_IS_BROKEN", 2: "STATE_IS_SECURE" };
      return state + " (" + (names[state] || "unrecognised") + ")";
    }
    if (typeof state !== "object") return text(state) || "ABSENT";
    const parts = [];
    for (const member of ["isSecure", "isBroken", "securityState"]) {
      const read = safeRead(state, member);
      parts.push(member + ": " + (read.ok ? text(read.value) || "undefined" : "THREW"));
    }
    return "{" + parts.join(", ") + "}";
  }

  /**
   * Read one member, reporting a throwing getter as such instead of letting the
   * whole report fail. The value is rendered but never trusted to be printable.
   */
  function readMember(owner, name) {
    if (owner == null) return { name, present: false, value: "", error: "" };
    let present = false;
    try {
      present = name in owner || Object.prototype.hasOwnProperty.call(owner, name);
    } catch (_) {
      present = false;
    }
    if (!present) return { name, present: false, value: "", error: "" };
    try {
      return { name, present: true, value: text(owner[name]), error: "" };
    } catch (error) {
      return { name, present: true, value: "", error: text(error?.message || error) || "THREW" };
    }
  }

  /**
   * Render the accumulated lines into a bounded report block.
   */
  function renderLines(lines) {
    let report = lines.join("\n");
    if (report.length > MAX_REPORT_CHARS) {
      report = report.slice(0, MAX_REPORT_CHARS) + "\n… report truncated at " + MAX_REPORT_CHARS + " characters";
    }
    return report;
  }

  /**
   * A single value read under try/catch. Used for the interface-presence table,
   * where reading a member can itself throw: nsITLSSocketControl getters raise
   * NS_ERROR_NOT_AVAILABLE rather than returning undefined, so an unguarded read
   * takes down the whole report with the very error it was meant to reveal.
   */
  function safeRead(owner, name) {
    if (owner == null) return { ok: false, present: false, value: null, error: "" };
    try {
      const value = owner[name];
      return { ok: true, present: value !== undefined, value, error: "" };
    } catch (error) {
      return { ok: false, present: true, value: null, error: text(error?.message || error) || "THREW" };
    }
  }

  /**
   * Build the full inventory. `sources` maps a logical name to an object:
   * { tlsSocketControl, securityInfo, settledSecurityInfo, transport, socket,
   *   evidence }. Anything absent is reported as ABSENT rather than silently
   * skipped.
   */
  function buildReport(sources = {}, extra = {}) {
    const lines = [];
    const say = (line) => lines.push(line);
    say("FeedRank for Zotero — SMTP/TLS runtime diagnostics");
    say("Report build " + DIAGNOSTICS_BUILD + ". No secret is read or shown, and no socket is opened by this report.");
    say("");

    const control = sources.tlsSocketControl || null;
    const securityInfo = sources.securityInfo || null;
    const settled = sources.settledSecurityInfo || null;

    say("[interface presence]");
    for (const [label, value] of [
      ["tlsSocketControl", control],
      ["tlsSocketControl.SSLVersionUsed", safeRead(control, "SSLVersionUsed")],
      ["tlsSocketControl.securityInfo", safeRead(control, "securityInfo")],
      ["settled securityInfo (asyncGetSecurityInfo)", settled],
      ["asyncStartTLS", safeRead(control, "asyncStartTLS")],
      ["asyncGetSecurityInfo", safeRead(control, "asyncGetSecurityInfo")],
    ]) {
      // `safeRead` results carry their own status; anything else is a plain value.
      const read = value && typeof value === "object" && "ok" in value ? value : null;
      if (read && !read.ok) {
        say("  " + label + " = THREW " + read.error);
        continue;
      }
      const actual = read ? read.value : value;
      const kind = actual == null ? "ABSENT" : typeof actual;
      say("  " + label + " = " + kind + (kind === "number" ? " (" + text(actual) + ")" : ""));
    }
    say("");

    say("[members present on each object]");
    for (const [label, value] of [
      ["tlsSocketControl", control],
      ["securityInfo", securityInfo],
      ["settled securityInfo", settled],
    ]) {
      const names = memberNames(value);
      say("  " + label + ": " + (names.length ? names.join(", ") : "(none readable)"));
    }
    say("");

    say("[what the SMTP gate reads, and what this runtime gives it]");
    for (const entry of CONSUMED_MEMBERS) {
      const owner = entry.owner === "tlsSocketControl" ? control : securityInfo;
      const found = readMember(owner, entry.name);
      const status = found.present
        ? (found.error ? "THREW " + found.error : "= " + (found.value === "" ? "(empty)" : found.value))
        : "ABSENT";
      say("  " + entry.owner + "." + entry.name + " — " + entry.used + ": " + status);
    }
    say("");

    say("[security state as the gate will read it]");
    // Every read here is guarded: this build raises NS_ERROR_NOT_AVAILABLE for
    // nsITransportSecurityInfo.protocolVersion, and an unguarded read in the
    // report would replace the diagnosis with a component-failure message.
    const state = safeRead(securityInfo, "securityState");
    say("  securityState = " + (state.ok
      ? describeSecurityState(state.value)
      : "THREW " + state.error));
    const chain = safeRead(securityInfo, "failedCertChain");
    if (!chain.ok) {
      say("  failedCertChain = THREW " + chain.error);
    } else {
      say("  failedCertChain = " + (Array.isArray(chain.value)
        ? chain.value.length + " entr" + (chain.value.length === 1 ? "y" : "ies")
        : "ABSENT"));
    }
    say("");

    say("[transport and socket]");
    say("  transport = " + (sources.transport ? "present" : "ABSENT"));
    say("  socket.security = " + text(sources.socket?.security));
    say("  socket.handshakeCompleted = " + text(sources.socket?.handshakeCompleted));
    say("  socket.tlsStarted = " + text(sources.socket?.tlsStarted));
    const evidence = sources.evidence || null;
    if (evidence) {
      say("");
      say("[evidence the gate was handed]");
      for (const key of Object.keys(evidence).sort()) {
        if (key === "checks") continue;
        say("  " + key + " = " + text(evidence[key]));
      }
      if (Array.isArray(evidence.checks)) {
        say("");
        say("[evaluated checks]");
        for (const check of evidence.checks) {
          say("  " + text(check?.name) + " = " + text(check?.value) +
            (check?.evaluated === true ? "" : "  (not evaluated)"));
        }
      }
    }
    say("");

    say("[this attempt]");
    for (const key of Object.keys(extra).sort()) {
      say("  " + key + " = " + text(extra[key]));
    }

    return renderLines(lines);
  }

  /**
   * The last line of defence: whatever produced a report must not leak a
   * credential into a window that a user will paste into a bug report.
   */
  function assertNoSecret(report, secrets = []) {
    const rendered = String(report == null ? "" : report);
    for (const secret of secrets) {
      const value = text(secret, 400);
      if (value && value.length >= 4 && rendered.includes(value)) {
        throw new Error("The diagnostic report contained a credential and was discarded");
      }
    }
    return rendered;
  }

  return Object.freeze({
    CONSUMED_MEMBERS,
    DIAGNOSTICS_BUILD,
    MAX_REPORT_CHARS,
    buildReport,
    assertNoSecret,
    describeSecurityState,
    memberNames,
    readMember,
    renderLines,
    safeRead,
    text,
  });
});
