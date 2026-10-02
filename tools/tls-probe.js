/* FeedRank SMTP TLS diagnostic — paste into Zotero's
 * Tools → Developer → Run JavaScript, with "Run as async function" CHECKED.
 *
 * It opens ONE TLS socket to a public SMTP server, negotiates STARTTLS, and
 * reports every property it can read on nsITLSSocketControl. It sends no
 * credentials, no MAIL FROM, no message, and closes immediately.
 *
 * Replace HOST/PORT if you prefer a different server. Your own server is the
 * most useful target, but 587 with STARTTLS is what this plugin uses by default.
 */
const HOST = "smtp.gmail.com";
const PORT = 587;

const out = [];
const say = (label, value) => out.push(label + ": " + value);

try {
  const svc = Components.classes["@mozilla.org/network/socket-transport-service;1"]
    .getService(Components.interfaces.nsISocketTransportService);
  say("transport service", typeof svc);
  say("createTransport.length", svc.createTransport.length);

  const transport = svc.createTransport(["starttls"], HOST, PORT, null, null);
  say("transport", transport ? "created" : "NULL");
  transport.setTimeout(0, 15);
  transport.setTimeout(1, 15);

  const raw = transport.openInputStream(1, 0, 0);   // OPEN_BLOCKING
  const scriptable = Components.classes["@mozilla.org/scriptableinputstream;1"]
    .createInstance(Components.interfaces.nsIScriptableInputStream);
  scriptable.init(raw);
  const sink = transport.openOutputStream(0, 0, 0);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const readReply = async () => {
    let buf = "";
    for (let i = 0; i < 200; i++) {
      const n = scriptable.available();
      if (n > 0) {
        buf += scriptable.read(n);
        // A reply is complete when its last line is "NNN " (not "NNN-").
        const lines = buf.split("\r\n").filter((l) => l.length);
        if (lines.length && /^\d{3} /.test(lines[lines.length - 1])) return buf;
      }
      await sleep(20);
    }
    return buf;
  };
  const command = async (text) => {
    if (text) sink.write(text, text.length);
    return readReply();
  };

  say("greeting", JSON.stringify((await command("")).slice(0, 80)));
  const ehlo = await command("EHLO feedrank.local\r\n");
  say("ehlo advertises STARTTLS", /STARTTLS/i.test(ehlo));
  say("starttls reply", JSON.stringify((await command("STARTTLS\r\n")).slice(0, 80)));

  // ---- the part that matters ------------------------------------------------
  const control = transport.tlsSocketControl;
  say("tlsSocketControl", control ? "present" : "ABSENT");

  if (control) {
    const proto = Object.getPrototypeOf(control);
    const names = new Set();
    for (let o = control; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const k of Object.getOwnPropertyNames(o)) names.add(k);
    }
    const interesting = [...names].filter((n) =>
      /ssl|tls|secur|cert|verif|version|alpn|npn|cipher|kea|mac|host/i.test(n));
    say("readable members", interesting.sort().join(", ") || "(none matched)");

    for (const key of ["SSLVersionUsed", "SSLVersionOffered", "failedVerification",
      "securityInfo", "providerFlags", "MACAlgorithmUsed", "KEAUsed",
      "clientCertSent", "denyClientCert"]) {
      let value;
      try {
        value = control[key];
      } catch (e) {
        value = "THREW " + e.message;
      }
      const kind = value && typeof value === "object" ? "object" : typeof value;
      say("  " + key, kind + " = " + (kind === "object" ? "[object]" : JSON.stringify(value)));
    }

    if (control.securityInfo) {
      const info = control.securityInfo;
      const infoNames = new Set();
      for (let o = info; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
        for (const k of Object.getOwnPropertyNames(o)) infoNames.add(k);
      }
      say("securityInfo members", [...infoNames].sort().join(", "));
      try {
        say("securityInfo.securityState", JSON.stringify(info.securityState));
      } catch (e) {
        say("securityInfo.securityState", "THREW " + e.message);
      }
      try {
        say("securityInfo.errorCodeString", JSON.stringify(info.errorCodeString));
      } catch (e) {
        say("securityInfo.errorCodeString", "THREW " + e.message);
      }
    } else {
      say("securityInfo", "ABSENT — so isSecure cannot be read synchronously");
    }

    // The asynchronous accessor, if this build has it.
    if (typeof control.asyncGetSecurityInfo === "function") {
      try {
        const info = await control.asyncGetSecurityInfo();
        const names = new Set();
        for (let o = info; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
          for (const k of Object.getOwnPropertyNames(o)) names.add(k);
        }
        say("asyncGetSecurityInfo members", [...names].sort().join(", "));
        say("async securityState", JSON.stringify(info?.securityState));
      } catch (e) {
        say("asyncGetSecurityInfo", "THREW " + e.message);
      }
    } else {
      say("asyncGetSecurityInfo", "not available");
    }
  }

  say("after-handshake SSLVersionUsed",
    control ? JSON.stringify(control.SSLVersionUsed) : "n/a");

  try { sink.close(); } catch (e) {}
  try { scriptable.close(); } catch (e) {}
  try { transport.close(0); } catch (e) {}
} catch (error) {
  out.push("FAILED: " + (error && error.message ? error.message : String(error)));
}

out.join("\n");
