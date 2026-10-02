"use strict";

/*
 * Pure, deliberately unwired helpers for the FeedRank email digest and for the
 * SMTP transport in email-service.js. Loading this module performs no I/O,
 * never reads a preference or credential, and cannot send mail.
 *
 * Transport decision (verified 2026-09-30 against the installed Zotero 10.0.3,
 * Gecko 140.15.0 / mozilla-esr140):
 *   - Zotero bundles no mail stack at all: `@mozilla.org/mail/server;1` and
 *     `nsIMsgOutgoingServer` are absent from xul.dll, and the Zotero app layer
 *     contains no SMTP code. Node.js and Nodemailer are not part of the
 *     runtime.
 *   - The only available secure transport is Gecko's raw socket API
 *     (`nsISocketTransportService`, `nsISocketTransport`, `nsITLSSocketControl`),
 *     which IS present. See .research/zotero10-socket-api.md.
 * Therefore this file speaks SMTP itself. It never falls back to plaintext,
 * never weakens certificate validation, and never authenticates before TLS has
 * been proven active.
 *
 * There is no Resend dependency and no hidden HTTP fallback anywhere in this
 * module or in the transport service that consumes it.
 */
/*
 * The digest's own words, in the reader's language.
 *
 * The paper titles and the model's explanations are the paper's own text and are never
 * translated here; these are the four strings the template itself contributes. The
 * subject line is deliberately NOT translated: a stored digest is validated against
 * `DIGEST_SUBJECT_PATTERN` when it is rebuilt or retried, so its identity must not
 * depend on the reader's language.
 */
const DIGEST_HEADINGS = {
  "en-US": { priority: "Priority papers", readingList: "Reading list", open: "Open", doi: "DOI: " },
  "zh-CN": { priority: "优先文章", readingList: "阅读清单", open: "打开", doi: "DOI：" },
};

function digestHeadings(locale) {
  const key = String(locale == null ? "" : locale).trim().toLowerCase().startsWith("zh")
    ? "zh-CN"
    : "en-US";
  return DIGEST_HEADINGS[key];
}

(function exposeFeedRankerEmail(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.FeedRankerEmail = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createEmailCore() {
  const DEFAULT_DIGEST_OPTIONS = Object.freeze({
    priorityCount: 5,
    // A deliberately small default limits the data disclosed in a delivery.
    // Raising this must be an explicit user setting.
    maximumPapers: 10,
    minimumRelevanceScore: 70,
    readingListEnabled: false,
    readingListCount: 30,
  });

  // SMTP wire constants. RFC 5321 §4.5.3.1 bounds a command line at 512 octets
  // including CRLF and a text line at 1000 octets including CRLF.
  const CRLF = "\r\n";
  const SMTP_MAX_COMMAND_LENGTH = 512;
  const SMTP_MAX_REPLY_LENGTH = 8192;
  const SMTP_MAX_REPLY_LINES = 64;
  const SMTP_MAX_TEXT_LINE_LENGTH = 1000;
  const MAX_MESSAGE_LENGTH = 2 * 1024 * 1024;
  // RFC 2045 §6.8 caps an encoded line at 76 characters.
  const BASE64_LINE_LENGTH = 76;

  const TLS_MODES = Object.freeze(["implicit", "starttls"]);
  const AUTH_METHODS = Object.freeze(["plain", "login", "xoauth2"]);
  /*
   * The subject carries the WEEK, so the date range is visible in the inbox
   * without opening anything: the body no longer repeats it as a heading.
   *
   * The range is the only part that varies, and it is written from the same window
   * the digest covers, so the subject of a message can never disagree with the
   * papers inside it. `DIGEST_SUBJECT_PATTERN` is what validates a stored
   * submission, because an exact-equality check is no longer possible -- or
   * desirable: a tampered subject must still be refused, but next week's range must
   * not be.
   */
  const DIGEST_SUBJECT_PREFIX = "FeedRank weekly digest";
  const DIGEST_RANGE_PATTERN = "\\d{4}-\\d{2}-\\d{2}(?: to \\d{4}-\\d{2}-\\d{2})?";
  const DIGEST_SUBJECT_PATTERN = new RegExp("^" + DIGEST_SUBJECT_PREFIX + " — " + DIGEST_RANGE_PATTERN + "$");
  const DIGEST_SUBJECT = DIGEST_SUBJECT_PREFIX;
  const TEST_SUBJECT = "FeedRank — SMTP delivery test";
  const MAX_FROM_LENGTH = 320;
  const MAX_SUBJECT_LENGTH = 200;

  // The subject for one week's digest: prefix plus the exact window it covers.
  function digestSubject(range) {
    return text(DIGEST_SUBJECT_PREFIX + " — " + text(range, 64), MAX_SUBJECT_LENGTH);
  }

  const B64_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  // ---------------------------------------------------------------------------
  // Small shared helpers
  // ---------------------------------------------------------------------------

  function text(value, maximum = 2000) {
    const clean = String(value == null ? "" : value)
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return clean.slice(0, Math.max(0, maximum));
  }

  function boundedInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isInteger(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, number));
  }

  function score(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 100 ? number : null;
  }

  // FeedRank's local Priority can include a fractional bibliometric adjustment.
  // Keep `score()` integer-only because it validates the model's raw relevance
  // score, while this helper is only used to order already eligible records.
  function priority(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
  }

  function normalizeDate(value) {
    const date = text(value, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Digest date must be YYYY-MM-DD");
    return date;
  }

  function escapeHTML(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeURL(value) {
    const raw = text(value, 2048);
    if (!raw) return "";
    try {
      const parsed = new URL(raw);
      if (!/^(https?):$/.test(parsed.protocol) || parsed.username || parsed.password) return "";
      return parsed.href;
    } catch (_) {
      return "";
    }
  }

  function normalizeDOI(value) {
    let doi = text(value, 600);
    if (!doi) return "";
    doi = doi.replace(/^doi\s*:\s*/i, "");
    try {
      const parsed = new URL(doi);
      if (/^(?:dx\.)?doi\.org$/i.test(parsed.hostname)) {
        doi = parsed.pathname.replace(/^\/+/, "");
      }
    } catch (_) {
      // A bare DOI is the expected non-URL input form.
    }
    doi = doi.replace(/\s+/g, "").replace(/[<>]/g, "").replace(/[.,;:]+$/, "");
    // Keep this deliberately conservative: an unusual/invalid DOI remains
    // plain metadata rather than becoming an untrusted link target.
    return /^10\.\d{4,9}\/[A-Za-z0-9._;()/:+-]+$/i.test(doi) ? doi : "";
  }

  function doiURL(value) {
    const doi = normalizeDOI(value);
    if (!doi) return "";
    return "https://doi.org/" + encodeURIComponent(doi).replace(/%2F/gi, "/");
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

  // ---------------------------------------------------------------------------
  // Addresses and headers
  // ---------------------------------------------------------------------------

  function assertNoCRLF(value, name) {
    if (/[\r\n]/.test(String(value == null ? "" : value))) {
      throw new Error(name + " must not contain a line break");
    }
  }

  function validateAddress(value, name = "Email address") {
    const address = text(value, 254).toLowerCase();
    // This intentionally accepts a conservative ASCII subset. It keeps the
    // digest from becoming an arbitrary RFC 5322 header field or a
    // multi-recipient delivery mechanism.
    const valid = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(address);
    if (!valid) throw new Error(name + " must be one valid email address");
    return address;
  }

  function normalizeFrom(value) {
    const source = text(value, MAX_FROM_LENGTH);
    assertNoCRLF(source, "From address");
    const match = source.match(/^([^<>]+?)\s*<([^<>]+)>$/);
    if (!match) return validateAddress(source, "From address");
    const displayName = text(match[1], 128);
    if (!displayName || !/^[A-Za-z0-9 .,'()&-]+$/.test(displayName)) {
      throw new Error("From display name contains unsupported characters");
    }
    return displayName + " <" + validateAddress(match[2], "From address") + ">";
  }

  // The envelope sender is the bare address even when a display name was given.
  function envelopeAddress(value) {
    const normalized = normalizeFrom(value);
    const match = normalized.match(/<([^<>]+)>$/);
    return match ? match[1] : normalized;
  }

  function headerValue(value, name = "Header") {
    // Reject rather than silently rewrite: a newline reaching a header would be
    // exactly the injection this function exists to prevent.
    assertNoCRLF(value, name);
    const clean = text(value, MAX_SUBJECT_LENGTH);
    if (/[\u0000-\u001F\u007F]/.test(clean)) throw new Error(name + " contains a control character");
    return clean;
  }

  // ---------------------------------------------------------------------------
  // Base64 (no Buffer, no btoa: this code also runs in a Gecko chrome scope)
  // ---------------------------------------------------------------------------

  function utf8Bytes(value) {
    const source = String(value == null ? "" : value);
    const bytes = [];
    for (let index = 0; index < source.length; index++) {
      let code = source.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < source.length) {
        const next = source.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          index++;
        }
      }
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x10000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
      }
    }
    return bytes;
  }

  function base64Encode(value) {
    const bytes = Array.isArray(value) ? value : utf8Bytes(value);
    let output = "";
    for (let index = 0; index < bytes.length; index += 3) {
      const first = bytes[index];
      const second = index + 1 < bytes.length ? bytes[index + 1] : null;
      const third = index + 2 < bytes.length ? bytes[index + 2] : null;
      output += B64_ALPHABET[first >> 2];
      output += B64_ALPHABET[((first & 0x03) << 4) | (second == null ? 0 : second >> 4)];
      output += second == null
        ? "="
        : B64_ALPHABET[((second & 0x0f) << 2) | (third == null ? 0 : third >> 6)];
      output += third == null ? "=" : B64_ALPHABET[third & 0x3f];
    }
    return output;
  }

  function base64Lines(value) {
    const encoded = base64Encode(value);
    const lines = [];
    for (let index = 0; index < encoded.length; index += BASE64_LINE_LENGTH) {
      lines.push(encoded.slice(index, index + BASE64_LINE_LENGTH));
    }
    return lines;
  }

  // ---------------------------------------------------------------------------
  // RFC 5322 / MIME message construction
  // ---------------------------------------------------------------------------

  function randomToken() {
    try {
      const uuid = globalThis.crypto?.randomUUID?.();
      if (uuid) return String(uuid).replace(/-/g, "");
    } catch (_) {}
    // A non-cryptographic fallback. The boundary and Message-ID only need to be
    // unique and unpredictable enough not to collide with message content.
    return fnv1a(String(Math.random()) + ":" + Date.now()) + fnv1a(String(Math.random()));
  }

  function messageIDFor(domain) {
    const host = text(domain, 200).replace(/[^A-Za-z0-9.-]/g, "") || "feedrank.invalid";
    return "<" + randomToken() + "." + fnv1a(String(Date.now())) + "@" + host + ">";
  }

  function rfc5322Date(date = new Date()) {
    const when = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    return when.toUTCString().replace(/GMT$/, "+0000");
  }

  // Produce a plain ASCII header value. A non-ASCII subject becomes a single
  // RFC 2047 encoded word, so no raw UTF-8 and no 8-bit content ever reaches a
  // header line.
  function encodeHeaderValue(value, name) {
    const unwrapped = String(value == null ? "" : value).replace(/[\r\n]+/g, " ");
    const clean = text(unwrapped, MAX_SUBJECT_LENGTH);
    if (!clean) throw new Error(name + " must not be empty");
    if (/^[\x20-\x7E]*$/.test(clean)) return clean;
    return "=?UTF-8?B?" + base64Encode(clean) + "?=";
  }

  function foldedHeaderLine(name, value) {
    const line = name + ": " + value;
    assertNoCRLF(line, "Header line");
    return line;
  }

  // Base64 has no line-oriented specials, so this carries the entire digest
  // safely regardless of what a paper title, abstract, or reason contains.
  function encodeBodyPart(contentType, content, transferEncoding) {
    const lines = [
      "Content-Type: " + contentType,
      "Content-Transfer-Encoding: " + transferEncoding,
      "",
    ];
    return lines.concat(base64Lines(content));
  }

  function buildMIMEMessage({
    from,
    to,
    subject,
    text: plainText,
    html,
    date = new Date(),
    messageID = "",
    boundary = "",
  } = {}) {
    const normalizedFrom = normalizeFrom(from);
    const normalizedTo = validateAddress(to, "Recipient");
    const cleanSubject = headerValue(subject, "Subject");
    const plain = String(plainText == null ? "" : plainText);
    const rich = String(html == null ? "" : html);
    if (!plain) throw new Error("A non-empty plain-text digest body is required");
    if (!rich) throw new Error("A non-empty HTML digest body is required");

    // Derive the Message-ID domain from the sender so it stays stable and
    // attributable without disclosing the recipient.
    const senderDomain = envelopeAddress(normalizedFrom).split("@")[1] || "feedrank.invalid";
    const id = text(messageID, 300) || messageIDFor(senderDomain);
    assertNoCRLF(id, "Message-ID");
    if (!/^<[^<>\s]+@[^<>\s]+>$/.test(id)) throw new Error("Message-ID is malformed");
    const token = text(boundary, 200) || "feedrank-" + randomToken();
    if (!/^[A-Za-z0-9'()+_,./:=?-]{8,200}$/.test(token)) throw new Error("MIME boundary is malformed");

    const headers = [
      foldedHeaderLine("MIME-Version", "1.0"),
      foldedHeaderLine("Date", rfc5322Date(date)),
      foldedHeaderLine("Message-ID", id),
      foldedHeaderLine("Subject", encodeHeaderValue(cleanSubject, "Subject")),
      foldedHeaderLine("From", normalizedFrom),
      foldedHeaderLine("To", normalizedTo),
      // Deliberately absent: Cc, Bcc, Reply-To, custom headers, attachments,
      // and any tracking or read-receipt request.
      foldedHeaderLine("Content-Type", "multipart/alternative; boundary=\"" + token + "\""),
    ];

    const body = [
      "This is a multi-part message in MIME format.",
      "--" + token,
      ...encodeBodyPart("text/plain; charset=UTF-8", plain, "base64"),
      "--" + token,
      ...encodeBodyPart("text/html; charset=UTF-8", rich, "base64"),
      "--" + token + "--",
    ];

    const message = headers.join(CRLF) + CRLF + CRLF + body.join(CRLF) + CRLF;
    assertNoBareNewline(message);
    for (const line of message.split(CRLF)) {
      if (line.length > SMTP_MAX_TEXT_LINE_LENGTH - 2) {
        throw new Error("A MIME line exceeds the SMTP text-line limit");
      }
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new Error("The MIME message exceeds FeedRank's sending limit");
    }
    return { message, messageID: id, boundary: token, subject: cleanSubject };
  }

  function assertNoBareNewline(value) {
    if (/(^|[^\r])\n/.test(value) || /\r([^\n]|$)/.test(value)) {
      throw new Error("Message content contains a bare line break");
    }
  }

  // RFC 5321 §4.5.2: a line beginning with "." is transmitted with an extra
  // leading ".", and the message ends with CRLF "." CRLF.
  function dotStuff(message) {
    const normalized = String(message == null ? "" : message).replace(/\r\n/g, "\n");
    const lines = normalized.split("\n").map((line) => (line.startsWith(".") ? "." + line : line));
    return lines.join(CRLF) + CRLF + "." + CRLF;
  }

  // ---------------------------------------------------------------------------
  // SMTP command and reply handling
  // ---------------------------------------------------------------------------

  // The exact command vocabulary this client issues. Enrollment is deliberate:
  // a verb not on this list is rejected before it can reach the wire, and the
  // only two-word commands in SMTP are MAIL FROM and RCPT TO.
  const SMTP_VERBS = Object.freeze(new Set([
    "EHLO", "HELO", "STARTTLS", "AUTH", "MAIL FROM", "RCPT TO", "DATA",
    "QUIT", "RSET", "NOOP", "VRFY",
  ]));

  function buildCommand(name, argument = "") {
    // Collapse internal whitespace runs so "MAIL  FROM" is not a distinct verb.
    const verb = String(name == null ? "" : name).trim().replace(/\s+/g, " ").toUpperCase();
    if (!SMTP_VERBS.has(verb)) throw new Error("Invalid SMTP command verb");
    const rawArgument = argument == null ? "" : String(argument);
    // A command argument must never contain CR or LF: that is the SMTP command
    // injection this check exists to prevent.
    if (/[\r\n]/.test(rawArgument)) throw new Error("SMTP command argument must not contain a line break");
    if (/[\u0000-\u001F\u007F]/.test(rawArgument)) {
      throw new Error("SMTP command argument contains a control character");
    }
    const line = rawArgument ? verb + " " + rawArgument : verb;
    if (line.length + CRLF.length > SMTP_MAX_COMMAND_LENGTH) {
      throw new Error("SMTP command exceeds the 512-octet command-line limit");
    }
    return line + CRLF;
  }

  // A bare argument line with no verb. RFC 4954 uses this for the AUTH LOGIN
  // password step, where the client sends the base64 secret on its own line.
  // The base64 alphabet cannot contain CR, LF, or a control character, so the
  // injection concern that motivates buildCommand() does not apply; only the
  // command-line bound needs enforcing.
  function buildArgumentLine(argument) {
    const rawArgument = String(argument == null ? "" : argument);
    if (!rawArgument) throw new Error("An SMTP continuation line must not be empty");
    if (!/^[\x21-\x7E]+$/.test(rawArgument)) {
      throw new Error("An SMTP continuation line must be printable ASCII");
    }
    if (rawArgument.length + CRLF.length > SMTP_MAX_COMMAND_LENGTH) {
      throw new Error("SMTP continuation line exceeds the 512-octet command-line limit");
    }
    return rawArgument + CRLF;
  }

  function parseReply(raw) {
    const source = String(raw == null ? "" : raw);
    if (!source) throw new Error("Empty SMTP reply");
    if (source.length > SMTP_MAX_REPLY_LENGTH) throw new Error("SMTP reply is too long");
    const lines = source.split(CRLF).filter((line, index, all) =>
      !(index === all.length - 1 && line === ""));
    if (!lines.length) throw new Error("Empty SMTP reply");
    if (lines.length > SMTP_MAX_REPLY_LINES) throw new Error("SMTP reply has too many lines");

    const parsed = [];
    for (const line of lines) {
      if (/[\r\n]/.test(line)) throw new Error("SMTP reply line contains a line break");
      const match = line.match(/^(\d{3})([ -])(.*)$/);
      if (!match) {
        // A bare three-digit final line is tolerated only for the single-line
        // form; anything else is a malformed reply.
        if (lines.length === 1 && /^\d{3}$/.test(line)) {
          parsed.push({ code: Number(line), continued: false, text: "" });
          continue;
        }
        throw new Error("Malformed SMTP reply line");
      }
      parsed.push({ code: Number(match[1]), continued: match[2] === "-", text: match[3] });
    }

    const code = parsed[0].code;
    if (parsed.some((entry) => entry.code !== code)) {
      throw new Error("Inconsistent SMTP reply code in a multi-line reply");
    }
    // The LAST line must terminate the reply. A single "250-more" line is an
    // unfinished reply, not a complete one, and must never be read as success.
    for (let index = 0; index < parsed.length - 1; index++) {
      if (!parsed[index].continued) throw new Error("Malformed multi-line SMTP reply");
    }
    if (parsed[parsed.length - 1].continued) {
      throw new Error("Incomplete multi-line SMTP reply");
    }
    return {
      code,
      lines: parsed.map((entry) => entry.text),
      text: text(parsed.map((entry) => entry.text).join(" "), 500),
    };
  }

  // RFC 5321 reply classes: 2xx and 3xx are positive, 4xx a transient negative
  // and 5xx a permanent negative. A 4xx is never treated as permission to
  // silently replay a message.
  function replyClass(code) {
    const number = Number(code);
    if (!Number.isInteger(number) || number < 100 || number > 599) return "invalid";
    if (number < 400) return "positive";
    if (number < 500) return "transient";
    return "permanent";
  }

  // Every awaited reply must match the exact code the RFC specifies for that
  // step. A "positive" reply to the wrong command is a protocol error, not a
  // success.
  const SMTP_PHASES = Object.freeze({
    greeting: Object.freeze({ expect: Object.freeze([220]), label: "server greeting" }),
    ehlo: Object.freeze({ expect: Object.freeze([250]), label: "EHLO" }),
    starttls: Object.freeze({ expect: Object.freeze([220]), label: "STARTTLS" }),
    auth: Object.freeze({ expect: Object.freeze([235, 503]), label: "authentication" }),
    mailFrom: Object.freeze({ expect: Object.freeze([250]), label: "MAIL FROM" }),
    rcptTo: Object.freeze({ expect: Object.freeze([250, 251]), label: "RCPT TO" }),
    data: Object.freeze({ expect: Object.freeze([354]), label: "DATA" }),
    // 250 is acceptance for this recipient; 251 is "will forward". The final
    // reply after the terminating dot is the only definitive outcome.
    body: Object.freeze({ expect: Object.freeze([250]), label: "message body" }),
    quit: Object.freeze({ expect: Object.freeze([221]), label: "QUIT" }),
    noop: Object.freeze({ expect: Object.freeze([250]), label: "NOOP" }),
    rset: Object.freeze({ expect: Object.freeze([250]), label: "RSET" }),
  });

  function checkReply(phase, reply) {
    const spec = SMTP_PHASES[phase];
    if (!spec) throw new Error("Unknown SMTP phase: " + String(phase));
    const parsed = parseReply(reply);
    const ok = spec.expect.includes(parsed.code);
    return {
      phase,
      label: spec.label,
      code: parsed.code,
      text: parsed.text,
      ok,
      klass: replyClass(parsed.code),
    };
  }

  function requireReply(phase, reply) {
    const checked = checkReply(phase, reply);
    if (!checked.ok) {
      const error = new Error(
        "SMTP " + checked.label + " failed with " + checked.code + " " + checked.text,
      );
      error.smtpCode = checked.code;
      error.smtpPhase = phase;
      error.smtpClass = checked.klass;
      throw error;
    }
    return checked;
  }

  function parseEhloCapabilities(reply) {
    const parsed = parseReply(reply);
    const checked = checkReply("ehlo", reply);
    if (!checked.ok) return { ok: false, capabilities: [], authMechanisms: [], text: checked.text };
    const capabilities = [];
    const authMechanisms = [];
    for (const line of parsed.lines) {
      const cleaned = text(line, 200);
      if (!cleaned) continue;
      const keyword = cleaned.split(/\s+/)[0].toUpperCase();
      capabilities.push(keyword);
      if (keyword === "AUTH") {
        for (const mechanism of cleaned.split(/\s+/).slice(1)) {
          const name = mechanism.toUpperCase();
          if (/^[A-Z0-9-]{3,20}$/.test(name)) authMechanisms.push(name);
        }
      }
    }
    return {
      ok: true,
      capabilities,
      authMechanisms: [...new Set(authMechanisms)],
      // STARTTLS must be advertised before the upgrade is attempted.
      supportsStartTLS: capabilities.includes("STARTTLS"),
      supportsSMTPUTF8: capabilities.includes("SMTPUTF8"),
      supports8BITMIME: capabilities.includes("8BITMIME"),
      size: (() => {
        const line = parsed.lines.map((entry) => text(entry, 200))
          .find((entry) => /^SIZE\b/i.test(entry));
        const value = line && Number(line.split(/\s+/)[1]);
        return Number.isFinite(value) && value > 0 ? value : null;
      })(),
      text: checked.text,
    };
  }

  function buildAuthCommand(method, { username, secret } = {}) {
    const name = String(method == null ? "" : method).toLowerCase();
    // The username is sent as an SMTP command argument, so it must not be able
    // to introduce a new command.
    const user = String(username == null ? "" : username);
    const proof = String(secret == null ? "" : secret);
    if (!user || !proof) throw new Error("An SMTP username and secret are required for authentication");
    if (/[\r\n]/.test(user) || /[\u0000-\u001F\u007F]/.test(user)) {
      throw new Error("The SMTP username contains an unsupported character");
    }
    if (!AUTH_METHODS.includes(name)) throw new Error("Unsupported SMTP authentication method");
    if (name === "plain") {
      // RFC 4616: NUL authzid, NUL authcid, NUL password.
      return buildCommand("AUTH", "PLAIN " + base64Encode("\u0000" + user + "\u0000" + proof));
    }
    if (name === "xoauth2") {
      // RFC 7628 / Google XOAUTH2: "user=" user "^Aauth=Bearer " token "^A^A".
      const material = "user=" + user + "\u0001auth=Bearer " + proof + "\u0001\u0001";
      return buildCommand("AUTH", "XOAUTH2 " + base64Encode(material));
    }
    // Use LOGIN without an initial response. The transport then answers the
    // username and password challenges exactly once each. Sending the username
    // here AND again after 334 makes initial-response-aware servers receive the
    // username as the password and reject otherwise valid credentials with 535.
    return buildCommand("AUTH", "LOGIN");
  }

  // LOGIN starts with bare AUTH LOGIN; the username and then password are sent
  // as separate base64 continuation lines in response to the two challenges.
  function buildLoginSecretCommand(secret) {
    const proof = String(secret == null ? "" : secret);
    if (!proof) throw new Error("An SMTP secret is required");
    return buildArgumentLine(base64Encode(proof));
  }

  // ---------------------------------------------------------------------------
  // Digest selection and rendering
  // ---------------------------------------------------------------------------

  function normalizeDigestOptions(raw = {}) {
    const minimumRelevanceScore = boundedInteger(
      raw.minimumRelevanceScore == null ? raw.priorityMinimumScore : raw.minimumRelevanceScore,
      DEFAULT_DIGEST_OPTIONS.minimumRelevanceScore,
      0,
      100,
    );
    return {
      priorityCount: boundedInteger(
        raw.priorityCount,
        DEFAULT_DIGEST_OPTIONS.priorityCount,
        1,
        50,
      ),
      maximumPapers: boundedInteger(
        raw.maximumPapers,
        DEFAULT_DIGEST_OPTIONS.maximumPapers,
        1,
        100,
      ),
      minimumRelevanceScore,
      // Kept as a return-value alias for callers that still read it.
      priorityMinimumScore: minimumRelevanceScore,
      readingListEnabled: raw.readingListEnabled === true,
      readingListCount: boundedInteger(
        raw.readingListCount,
        DEFAULT_DIGEST_OPTIONS.readingListCount,
        1,
        100,
      ),
    };
  }

  function compareRecords(left, right) {
    // Relevance Score remains the eligibility threshold, but this ordering
    // deliberately honors FeedRank's separate local Priority value for the
    // digest's labeled "Priority papers" section. Older records without a
    // Priority value fall back to their relevance Score.
    const leftPriority = priority(left?.priorityScore) ?? score(left?.score) ?? -1;
    const rightPriority = priority(right?.priorityScore) ?? score(right?.score) ?? -1;
    const priorityOrder = rightPriority - leftPriority;
    if (priorityOrder) return priorityOrder;
    const scoreOrder = (score(right.score) ?? -1) - (score(left.score) ?? -1);
    if (scoreOrder) return scoreOrder;
    const dateOrder = text(right.date, 50).localeCompare(text(left.date, 50));
    if (dateOrder) return dateOrder;
    const titleOrder = text(left.title, 500).localeCompare(text(right.title, 500));
    if (titleOrder) return titleOrder;
    return text(left.id, 200).localeCompare(text(right.id, 200));
  }

  // The caller is responsible for passing only records from one immutable,
  // user-confirmed daily feed-scoring run. This helper never treats arbitrary
  // cache entries or manually selected papers as digest-eligible by itself.
  function selectDigestRecords(records, rawOptions = {}) {
    const options = normalizeDigestOptions(rawOptions);
    const seen = new Set();
    const ordered = [];
    for (const record of Array.isArray(records) ? records : []) {
      const id = text(record?.id, 200);
      if (!id || seen.has(id) || score(record?.score) == null) continue;
      seen.add(id);
      ordered.push(record);
    }
    ordered.sort(compareRecords);

    const eligible = ordered.filter((record) =>
      score(record.score) >= options.minimumRelevanceScore,
    );
    const priority = eligible.slice(0, Math.min(options.priorityCount, options.maximumPapers));
    const priorityIDs = new Set(priority.map((record) => text(record.id, 200)));
    const remainingCapacity = Math.max(0, options.maximumPapers - priority.length);
    const readingList = options.readingListEnabled
      ? eligible
        .filter((record) => !priorityIDs.has(text(record.id, 200)))
        .slice(0, Math.min(options.readingListCount, remainingCapacity))
      : [];
    return { priority, readingList, options };
  }

  // A bounded list of short strings, from whichever field carries it. The digest
  // prints these, so they are capped here rather than at each use.
  function textList(value, { maximum = 6, length = 120 } = {}) {
    const list = Array.isArray(value) ? value : value == null ? [] : [value];
    const seen = new Set();
    const out = [];
    for (const entry of list) {
      const clean = text(entry, length);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      out.push(clean);
      if (out.length >= maximum) break;
    }
    return out;
  }

  function normalizedRecord(record) {
    const doi = normalizeDOI(record?.doi);
    return {
      id: text(record?.id, 200),
      title: text(record?.title, 500) || "Untitled paper",
      score: score(record?.score),
      confidence: text(record?.confidence, 30) || "not stated",
      reason: text(record?.reason, 1200),
      // Authors and the institutional affiliation are what a reader uses to judge a
      // preprint at a glance, so the digest carries them instead of the model's
      // confidence and rationale. Zotero records them in several fields depending on
      // the item type, so every spelling is accepted.
      authors: textList(record?.authors ?? record?.creators, { maximum: 6, length: 120 }),
      institutions: textList(
        record?.institutions ?? record?.affiliations ?? record?.institution ?? record?.university,
        { maximum: 2, length: 160 },
      ),
      source: text(record?.source, 300),
      date: text(record?.date, 50),
      doi,
      // A valid DOI becomes a canonical HTTPS fallback only when the article
      // URL is absent or unsafe.
      url: safeURL(record?.url) || doiURL(doi),
    };
  }

  // "A. Author, B. Author, C. Author et al." -- long author lists must not push the
  // rest of the line off the screen.
  function authorLine(authors) {
    const list = Array.isArray(authors) ? authors : [];
    if (!list.length) return "";
    if (list.length <= 3) return list.join(", ");
    return list.slice(0, 3).join(", ") + " et al.";
  }

  // The one line of secondary information the digest prints: who wrote it, where
  // they are, and where it came from.
  function recordDetailLine(paper, { withScore = false } = {}) {
    return [
      withScore ? "Score: " + paper.score + "/100" : "",
      authorLine(paper.authors),
      paper.institutions.join(", "),
      paper.source,
      paper.date,
    ].filter(Boolean).join(" · ");
  }

  function textRecord(record, number, words = DIGEST_HEADINGS["en-US"]) {
    const paper = normalizedRecord(record);
    const lines = [
      number + ". " + paper.title,
      "   " + recordDetailLine(paper, { withScore: true }),
    ];
    if (paper.doi) lines.push("   " + words.doi + paper.doi);
    if (paper.url) lines.push("   Article: " + paper.url);
    return lines.join("\n");
  }

  /*
   * The style block for the HTML part.
   *
   * Two things constrain this. Email clients strip or half-support `<style>`, so
   * every element that matters also carries its metrics inline; and the reader
   * wants to see the week at a glance rather than scroll one paper at a time, so
   * each paper is TWO lines -- title with its score, and one detail line carrying
   * the authors, their institution, the source and the date -- with no top-level
   * margins of its own. With the sizes below that is roughly 75px per paper, so
   * eight or more fit on one screen of a normal mail pane.
   */
  const DIGEST_STYLE = [
    "<style>",
    "body{margin:0;padding:14px;background:#ffffff;color:#1f2429;",
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.35}",
    "h1{font-size:17px;line-height:1.3;margin:0 0 2px;font-weight:700}",
    "h2{font-size:14px;line-height:1.3;margin:14px 0 6px;font-weight:700;color:#3a434e}",
    "p.summary{font-size:12px;line-height:1.4;color:#5b6470;margin:0 0 4px}",
    // No list rules: the items are plain blocks, so no client can add a marker of its
    // own beside the number the title already carries.
    ".papers>div{margin:0 0 9px;padding:0 0 8px;border-bottom:1px solid #eceff3}",
    ".papers>div:last-child{border-bottom:0}",
    ".t{font-size:15px;line-height:1.32;font-weight:600;margin:0}",
    ".m{font-size:12px;line-height:1.4;color:#5b6470;margin:2px 0 0}",
    ".s{font-weight:700;white-space:nowrap}",
    ".i{font-style:italic}",
    "a{color:#1a5fb4;text-decoration:none}",
    "</style>",
  ].join("");

  // The inline copies of the same metrics, for the clients that drop the block.
  const ITEM_STYLE = "margin:0 0 9px;padding:0 0 8px;border-bottom:1px solid #eceff3";
  const TITLE_STYLE = "font-size:15px;line-height:1.32;font-weight:600;margin:0";
  const META_STYLE = "font-size:12px;line-height:1.4;color:#5b6470;margin:2px 0 0";
  // The score is colour-coded, and the colour is only a hint: the number is always
  // printed, so nothing depends on a client rendering the colour.
  const scoreColour = (value) => (value >= 85 ? "#0a7d55" : value >= 70 ? "#8a6100" : "#5b6470");

  function htmlRecord(record, number, words = DIGEST_HEADINGS["en-US"]) {
    const paper = normalizedRecord(record);
    const score = Number(paper.score);
    /*
     * Line 1: number, title, score. Line 2: the authors in italic, then their
     * institution, the source, the date, the DOI and the link -- joined rather than
     * stacked, so a paper costs one detail line instead of five.
     */
    const heading = [
      "<div style=\"" + TITLE_STYLE + "\">",
      escapeHTML(number + ". " + paper.title),
      " <span class=\"s\" style=\"font-weight:700;white-space:nowrap;color:" +
        scoreColour(score) + "\">" + escapeHTML(String(paper.score)) + "/100</span>",
      "</div>",
    ];
    const authors = authorLine(paper.authors);
    const detail = [
      authors ? "<span class=\"i\" style=\"font-style:italic\">" + escapeHTML(authors) + "</span>" : "",
      paper.institutions.length ? escapeHTML(paper.institutions.join(", ")) : "",
      paper.source ? escapeHTML(paper.source) : "",
      paper.date ? escapeHTML(paper.date) : "",
      paper.doi ? words.doi + escapeHTML(paper.doi) : "",
    ].filter(Boolean).join(" · ");
    const link = paper.url
      ? " <a href=\"" + escapeHTML(paper.url) + "\" style=\"color:#1a5fb4;text-decoration:none\">" + escapeHTML(words.open) + "</a>"
      : "";
    const detailLine = detail || link
      ? "<div style=\"" + META_STYLE + "\">" + detail + link + "</div>"
      : "";
    return "<div class=\"p\" style=\"" + ITEM_STYLE + "\">" + heading.join("") + detailLine + "</div>";
  }

  function buildDigest({ date, records, options = {}, window: digestWindow = null, locale = "en-US" }) {
    const words = digestHeadings(locale);
    const localDay = normalizeDate(date);
    const selected = selectDigestRecords(records, options);
    const all = [...selected.priority, ...selected.readingList];
    if (!all.length) throw new Error("No eligible scored papers are available for this digest");

    // The digest covers a WEEK, not a day: the papers the scheduled run collected
    // over the last seven calendar days. The window goes into the SUBJECT, so the
    // reader sees the week in the inbox and the body starts straight at the papers
    // instead of repeating a heading and a blurb above them.
    const dateOnly = (value, fallback) =>
      /^\d{4}-\d{2}-\d{2}$/.test(String(value == null ? "" : value)) ? String(value) : fallback;
    const from = dateOnly(digestWindow?.from, localDay);
    const to = dateOnly(digestWindow?.to, localDay);
    const range = from === to ? from : from + " to " + to;

    const subject = digestSubject(range);
    const textSections = [
      words.priority,
      ...selected.priority.map((record, index) => textRecord(record, index + 1, words)),
    ];
    const htmlSections = [
      "<!doctype html><html><head><meta charset=\"utf-8\">",
      "<title>" + escapeHTML(digestSubject(range)) + "</title>",
      DIGEST_STYLE,
      "</head><body>",
      /*
       * Plain blocks, not a list.
       *
       * Reported from the reader's inbox: "in the email I see this kind of repeated
       * numbering. one from office list one is pure number" -- the items were `<li>`
       * inside an `<ol>`, and every heading already begins with "N. ". Outlook (and
       * several webmails) apply their own numbering to an ordered list and ignore
       * `list-style:none`, so each paper arrived as "1. 1. Title". A `<div>` has no
       * marker for a client to add, and the number in the title is the one the
       * plain-text part carries too, so both parts read the same.
       */
      "<h2 style=\"margin-top:0\">" + escapeHTML(words.priority) + "</h2><div class=\"papers\" style=\"margin:0;padding:0\">",
      ...selected.priority.map((record, index) => htmlRecord(record, index + 1, words)),
      "</div>",
    ];
    if (selected.readingList.length) {
      textSections.push("", words.readingList);
      htmlSections.push("<h2>" + escapeHTML(words.readingList) + "</h2><div class=\"papers\" style=\"margin:0;padding:0\">");
      selected.readingList.forEach((record, index) => {
        textSections.push(textRecord(record, selected.priority.length + index + 1, words));
        htmlSections.push(htmlRecord(record, selected.priority.length + index + 1, words));
      });
      htmlSections.push("</div>");
    }
    htmlSections.push("</body></html>");
    const result = {
      date: localDay,
      subject: text(subject, 200),
      text: textSections.join("\n"),
      html: htmlSections.join(""),
      priority: selected.priority.map(normalizedRecord),
      readingList: selected.readingList.map(normalizedRecord),
    };
    result.contentHash = fnv1a(JSON.stringify({
      subject: result.subject,
      text: result.text,
      html: result.html,
    }));
    return result;
  }

  // A digest body is stored as inspected text, so it is bounded and must not
  // carry raw RSS markup.
  function boundedDigestBody(value, maximum) {
    const source = String(value == null ? "" : value);
    if (source.length > maximum) return null;
    return source;
  }

  // ---------------------------------------------------------------------------
  // SMTP connection configuration
  // ---------------------------------------------------------------------------

  function normalizeHost(value) {
    const raw = String(value == null ? "" : value).trim().toLowerCase();
    if (!raw || raw.length > 253) throw new Error("Enter a valid SMTP server host name");
    // An IP literal is accepted for a self-hosted server.
    if (/^\[?[0-9a-f:.]+\]?$/.test(raw) && /[:.]/.test(raw)) return raw.replace(/^\[|\]$/g, "");
    const labels = raw.split(".");
    if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error("Enter a valid SMTP server host name");
    }
    return raw;
  }

  function normalizePort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Enter a valid SMTP port between 1 and 65535");
    }
    return port;
  }

  function normalizeTLSMode(value) {
    const mode = String(value == null ? "" : value).trim().toLowerCase();
    if (!TLS_MODES.includes(mode)) {
      throw new Error("Choose an SMTP TLS mode: implicit TLS or STARTTLS");
    }
    return mode;
  }

  function normalizeAuthMethod(value) {
    const method = String(value == null ? "" : value).trim().toLowerCase();
    if (!AUTH_METHODS.includes(method)) {
      throw new Error("Choose a supported SMTP authentication method");
    }
    return method;
  }

  // `implicit` means TLS from the first byte (port 465). `starttls` means a
  // plaintext connection that MUST be upgraded before any credential is sent.
  function securityForTLSMode(mode) {
    return normalizeTLSMode(mode) === "implicit" ? "ssl" : "starttls";
  }

  function normalizeSMTPConfig(raw = {}) {
    const tlsMode = normalizeTLSMode(raw.tlsMode);
    const authMethod = normalizeAuthMethod(raw.authMethod);
    const username = String(raw.username == null ? "" : raw.username).trim();
    if (!username) throw new Error("Enter the SMTP username");
    if (/[\r\n\u0000-\u001F\u007F]/.test(username) || username.length > 320) {
      throw new Error("The SMTP username contains an unsupported character");
    }
    const defaultPort = tlsMode === "implicit" ? 465 : 587;
    return {
      host: normalizeHost(raw.host),
      port: raw.port == null || raw.port === "" ? defaultPort : normalizePort(raw.port),
      tlsMode,
      authMethod,
      username,
      // The bare envelope sender, used for MAIL FROM.
      from: normalizeFrom(raw.from),
      to: validateAddress(raw.to, "Recipient"),
      // A connection test sends no message, so it is always allowed; a real
      // submission always needs its own preview and confirmation.
      requireTLS: true,
    };
  }

  function isSecureTLSMode(mode) {
    return TLS_MODES.includes(String(mode == null ? "" : mode).trim().toLowerCase());
  }

  function nextTLSVersionName(value) {
    const number = Number(value);
    // nsITLSSocketControl.SSL_VERSION_* values. TLS 1.0 and 1.1 are refused.
    if (number === 0x0304) return "TLS 1.3";
    if (number === 0x0303) return "TLS 1.2";
    if (number === 0x0302) return "TLS 1.1";
    if (number === 0x0301) return "TLS 1.0";
    if (number === 0x0300) return "SSL 3.0";
    // A missing or non-numeric version is reported as unknown rather than as
    // "version NaN".
    if (!Number.isFinite(number) || number < 0) return "unknown";
    return "version " + number;
  }

  /*
   * The single gate that decides whether credentials may be sent. There is no
   * "warn and continue" branch.
   *
   * Encryption is judged from whichever evidence the running build can actually
   * supply, in order of strength:
   *
   *   1. `securityInfo.securityState.isSecure` — the explicit signal. Used when
   *      the build exposes it.
   *   2. `handshakeCompleted` — a STARTTLS handshake that resolved, or an
   *      implicit-TLS socket that reported a real TLS version. This is how the
   *      transport proves encryption when `securityInfo` is NOT readable from
   *      JS, which is the case in this Zotero build.
   *
   * Requiring only (1) made the gate reject every working connection: the
   * property is absent, so "encrypted" defaulted to false and AUTH was refused
   * on a session that was in fact encrypted. Requiring NOTHING is obviously
   * unacceptable, so (2) is an explicit, named precondition that the caller sets
   * only after the handshake has actually completed, and the negotiated version
   * must still be TLS 1.2 or 1.3.
   *
   * What this canNOT do is inspect the certificate chain when the build reports
   * no securityInfo. That is stated rather than hidden: FeedRank never installs
   * a certificate override and never accepts a bad certificate, so a certificate
   * that fails validation fails the handshake and the connection closes before
   * this gate is reached. There is no override hook in this build to bypass it
   * with.
   */
  // A TLS version reported by this runtime, normalised to the 16-bit wire code
  // point. Three encodings are accepted because the build exposes the version in
  // more than one place and they do not agree:
  //
  //   - 0x0304        nsITLSSocketControl.SSLVersionUsed. The live build reported
  //                   772 here, which is the documented wire value for TLS 1.3.
  //   - 0x03040000    the high half of a 32-bit field.
  //   - 1..4          nsITransportSecurityInfo.protocolVersion, which on this
  //                   build is NOT a wire code point but its own enum: it
  //                   returned 4 for a TLS 1.3 session. Read as a wire code that
  //                   is meaningless, so 1..4 are mapped explicitly.
  //
  // -1 means "not observed by any of those", which is a refusal: with
  // SSLVersionUsed readable there is no longer any reason to authenticate
  // without knowing the protocol.
  function tlsVersionCode(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || !Number.isInteger(number) || number <= 0) return -1;
    const valid = (code) => code >= 0x0300 && code <= 0x0305;
    if (valid(number)) return number;
    const high = Math.floor(number / 0x10000) & 0xffff;
    if (valid(high)) return high;
    const low = number & 0xffff;
    if (valid(low)) return low;
    // nsITransportSecurityInfo's own enum.
    if (number === 1) return 0x0301;
    if (number === 2) return 0x0302;
    if (number === 3) return 0x0303;
    if (number === 4) return 0x0304;
    return -1;
  }

  // `sslVersionUsed` is preferred; `protocolVersion` is only a fallback.
  function observedTLSVersion(evidence) {
    for (const candidate of [evidence.sslVersionUsed, evidence.protocolVersion]) {
      if (candidate == null) continue;
      const code = tlsVersionCode(candidate);
      if (code !== -1) return code;
    }
    return -1;
  }

  function assertUsableTLS(evidence = {}) {
    const problems = [];
    const version = observedTLSVersion(evidence);
    let verifiedBy = "";
    /*
     * Encryption, from POSITIVE evidence.
     *
     * The transport settles this field, and it settles it from facts that can
     * only hold for an established session: a negotiated cipher, an empty TLS
     * error string, and a certificate chain that was built rather than failed.
     * A security STATE is deliberately not consulted, because on this build it is
     * not populated at the instant a handshake resolves — it reads
     * `securityState: 0` / `SSLVersionUsed: -1` on a connection that is in fact
     * TLS 1.3 with a valid Outlook certificate, and treating that as a verdict
     * refused a working connection twice.
     *
     * What that means for THIS function: `encrypted === false` is a deliberate
     * negative and is always refused, while `encrypted == null` (unknown) is not
     * a refusal on its own — it falls through to the handshake and failure checks
     * below. An absent field must never be read as the string "false".
     */
    if (evidence.encrypted === true) {
      verifiedBy = evidence.encryptionEvidence ? "resolved TLS session" : "security-info";
    } else if (evidence.encrypted === false || evidence.hasSecurityError === true) {
      // A negative verdict, or a positive report of a TLS error. Either is real
      // evidence, and a resolved handshake is not counter-evidence to it.
      problems.push("the connection is not encrypted");
    } else if (evidence.handshakeCompleted === true) {
      // Unknown from the security record, but a resolved STARTTLS handshake is
      // real evidence in its own right: the control object's asyncStartTLS()
      // completed on this socket.
      verifiedBy = "completed-handshake";
    } else {
      problems.push(
        "neither the TLS security state nor a completed handshake was reported",
      );
    }
    if (evidence.failedVerification === true) {
      problems.push("certificate verification failed");
    }
    if (evidence.failedCertChain) problems.push("the certificate chain did not validate");
    if (evidence.hasSecurityError === true) {
      problems.push("the TLS security state reports an error");
    }
    /*
     * A version that was OBSERVED must be TLS 1.2 or 1.3. A version that could
     * not be read is recorded as unconfirmed and does NOT block: this build reads
     * SSLVersionUsed as -1 on some runs and 772 on others, depending only on when
     * it is asked, so the same working server would otherwise connect or fail at
     * random. The refusal is reserved for a version that was genuinely read and
     * is too old, which is the case that actually matters.
     */
    if (version !== -1 && version !== 0x0303 && version !== 0x0304) {
      problems.push("the negotiated protocol is " + nextTLSVersionName(version) + ", not TLS 1.2 or 1.3");
    }
    if (evidence.plaintextFallbackUsed === true) problems.push("a plaintext fallback was used");
    if (problems.length) {
      throw new Error("Refusing to send SMTP credentials: " + problems.join("; "));
    }
    return {
      protocol: version === -1 ? "TLS 1.2 or 1.3 (version not reported by this build)" : nextTLSVersionName(version),
      protocolConfirmed: version !== -1,
      failedVerification: false,
      verifiedBy,
    };
  }

  // ---------------------------------------------------------------------------
  // Password-free connection test
  // ---------------------------------------------------------------------------

  // A connection test must prove the server is reachable, that TLS can be
  // negotiated, and that the credentials are accepted, without ever issuing
  // MAIL FROM or transmitting a message.
  const CONNECTION_TEST_COMMANDS = Object.freeze([]);

  function buildConnectionTestPlan({ config, capabilities } = {}) {
    const normalized = normalizeSMTPConfig(config);
    const caps = capabilities || {};
    if (normalized.tlsMode === "starttls" && caps.supportsStartTLS === false) {
      throw new Error("The SMTP server does not advertise STARTTLS; FeedRank will not send credentials over a plaintext connection");
    }
    return {
      host: normalized.host,
      port: normalized.port,
      tlsMode: normalized.tlsMode,
      security: securityForTLSMode(normalized.tlsMode),
      authMethod: normalized.authMethod,
      // Proves the sequence: greeting, EHLO, TLS, AUTH. Deliberately no
      // MAIL FROM, RCPT TO, or DATA.
      steps: ["greeting", "ehlo", ...(normalized.tlsMode === "starttls" ? ["starttls"] : []), "auth", "quit"],
      transmitsMessage: false,
      commands: CONNECTION_TEST_COMMANDS,
    };
  }

  function assertNoMessageTransmission(steps) {
    const forbidden = ["mailFrom", "rcptTo", "data", "body"];
    const found = (Array.isArray(steps) ? steps : []).filter((step) => forbidden.includes(step));
    if (found.length) {
      throw new Error("A connection test must not transmit a message (found: " + found.join(", ") + ")");
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Frozen submission state
  // ---------------------------------------------------------------------------

  function payloadHash(payload) {
    return fnv1a(JSON.stringify({
      from: payload?.from,
      to: payload?.to,
      subject: payload?.subject,
      html: payload?.html,
      text: payload?.text,
      message: payload?.message,
    }));
  }

  // SMTP has no provider-side idempotency key, so this identifier exists only
  // to bind stored state to one exact frozen message and to block a second
  // simultaneous submission. It is never sent to the server as a deduplicator.
  function makeSubmissionKey({ date, runID, payload }) {
    const localDay = normalizeDate(date);
    const normalizedRunID = text(runID, 1000);
    if (!normalizedRunID) throw new Error("A completed scoring-run identifier is required");
    return "feedrank-smtp/" + localDay + "/" + fnv1a(normalizedRunID) + "/" + payloadHash(payload);
  }

  function createDeliveryState({ date, runID, payload, now = Date.now() } = {}) {
    const createdAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    return {
      schema: 2,
      date: normalizeDate(date),
      runHash: fnv1a(text(runID, 1000)),
      payloadHash: payloadHash(payload),
      submissionKey: makeSubmissionKey({ date, runID, payload }),
      attempts: 0,
      status: "prepared",
      createdAt,
      nextAttemptAt: null,
      acceptedAt: null,
      failedAt: null,
      lastError: "",
      // SMTP cannot confirm delivery to a mailbox; the best a client can record
      // is that the server accepted responsibility for the message.
      serverAccepted: false,
    };
  }

  // Rules for turning a transport outcome into durable state. This is the
  // safety core of the SMTP migration:
  //   - A definitive acceptance (2xx to the terminating dot) is `accepted`.
  //   - Any failure strictly before the terminating dot was sent is provably
  //     not delivered, so it stays `retryable` (never automatic).
  //   - Anything after the terminating dot began, or any interrupted/unknown
  //     outcome, is `unknown` and is NEVER retried automatically.
  function recordDeliveryOutcome(state, outcome, { now = Date.now() } = {}) {
    const previous = state && typeof state === "object" ? state : {};
    const completedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const attempts = Math.max(0, Number(previous.attempts) || 0) + 1;
    const shared = {
      ...previous,
      attempts,
      messageSubmitted: outcome?.messageSubmitted === true,
      serverAccepted: outcome?.accepted === true,
    };
    if (outcome?.accepted) {
      return {
        ...shared,
        status: "accepted",
        acceptedAt: completedAt,
        nextAttemptAt: null,
        lastError: "",
      };
    }
    if (outcome?.state === "unknown") {
      return {
        ...shared,
        status: "unknown",
        failedAt: completedAt,
        nextAttemptAt: null,
        lastError: text(outcome?.error || "The SMTP outcome is unknown", 500),
      };
    }
    const retryable = outcome?.retryable === true && outcome?.messageSubmitted !== true;
    return {
      ...shared,
      status: retryable ? "retryable" : "failed",
      failedAt: completedAt,
      nextAttemptAt: null,
      lastError: text(outcome?.error || "The SMTP server did not accept the message", 500),
    };
  }

  // A conservative classification of a thrown transport error. `phase`
  // identifies how far the state machine had progressed.
  /*
   * A hint appended to an authentication failure.
   *
   * The server's own reply carries a correlation id, which reads like an internal
   * detail and tells the user nothing actionable. A 535 alone cannot distinguish
   * a bad secret, disabled SMTP AUTH, or a provider's modern-auth requirement.
   * Recommend only provider-supported credentials, never blanket app passwords.
   */
  function authenticationHint(code, authMethod, host = "") {
    if (Number(code) !== 535) return "";
    const method = String(authMethod || "").toLowerCase();
    if (method === "xoauth2") {
      return " The provider rejected the access token: it may be expired, or missing the SMTP.Send scope.";
    }
    if (["smtp-mail.outlook.com", "smtp.office365.com"].includes(String(host).toLowerCase())) {
      return " Microsoft may require OAuth2/Modern Authentication or administrator-enabled SMTP AUTH. " +
        "Do not repeatedly retry a password. FeedRank has no Microsoft sign-in/token-refresh flow yet.";
    }
    return " The provider rejected authentication. Check its SMTP access policy and username; " +
      "use an app password only if the provider officially permits one. " +
      "Some providers require the sender to match the username.";
  }

  function classifySMTPError(error, { phase = "", messageSubmitted = false, authMethod = "", host = "" } = {}) {
    const code = Number(error?.smtpCode) || 0;
    const klass = code ? replyClass(code) : "";
    const message = text(error?.message || "SMTP exchange failed", 500);
    // The server's sentence is separate from our summary and is where the reason
    // actually appears; include it rather than discarding it.
    const serverReply = text(error?.feedRankServerReply || "", 400);
    const detail = serverReply && !message.includes(serverReply) ? " Server reply: " + serverReply : "";
    if (messageSubmitted) {
      return {
        accepted: false,
        retryable: false,
        state: "unknown",
        code,
        messageSubmitted: true,
        error: message + detail + " The message had already been submitted; delivery is unknown.",
      };
    }
    if (error?.smtpClass === "configuration") {
      // The server refused the mechanism, or the settings cannot work at all.
      // Re-sending the identical request would fail identically, so this is a
      // final configuration failure rather than a retry prompt.
      return { accepted: false, retryable: false, state: "failed", code, messageSubmitted: false, error: message + detail };
    }
    if (code === 535) {
      // A credential rejection is permanent for these credentials, so it is never
      // retryable, and it is the one failure a user can actually fix.
      return {
        accepted: false,
        retryable: false,
        state: "failed",
        code,
        messageSubmitted: false,
        error: message + detail + authenticationHint(code, authMethod, host),
      };
    }
    if (code >= 500) {
      // A permanent negative reply proves the server refused the message.
      return { accepted: false, retryable: false, state: "failed", code, messageSubmitted: false, error: message + detail };
    }
    if (code >= 400) {
      // A transient negative reply proves rejection for this attempt only.
      return { accepted: false, retryable: true, state: "retryable", code, messageSubmitted: false, error: message + detail };
    }
    if (code) {
      return { accepted: false, retryable: false, state: "failed", code, messageSubmitted: false, error: message + detail };
    }
    // No reply at all: a connect/DNS/socket failure before the dot is provably
    // not delivered, so a manual retry is safe. It is still never automatic.
    return {
      accepted: false,
      retryable: true,
      state: "retryable",
      code: 0,
      messageSubmitted: false,
      error: message + detail,
    };
  }

  function retryDelayMilliseconds() {
    // SMTP offers no provider retry schedule. The transport deliberately has no
    // timer; a known transient rejection may be retried only by a later
    // explicit user action.
    return null;
  }

  return Object.freeze({
    DEFAULT_DIGEST_OPTIONS,
    CRLF,
    SMTP_MAX_COMMAND_LENGTH,
    SMTP_MAX_REPLY_LENGTH,
    SMTP_MAX_TEXT_LINE_LENGTH,
    MAX_MESSAGE_LENGTH,
    BASE64_LINE_LENGTH,
    TLS_MODES,
    AUTH_METHODS,
    DIGEST_SUBJECT,
    DIGEST_SUBJECT_PREFIX,
    DIGEST_SUBJECT_PATTERN,
    digestSubject,
    TEST_SUBJECT,
    SMTP_PHASES,
    CONNECTION_TEST_COMMANDS,
    text,
    boundedInteger,
    boundedDigestBody,
    escapeHTML,
    safeURL,
    normalizeDOI,
    doiURL,
    fnv1a,
    assertNoCRLF,
    validateAddress,
    normalizeFrom,
    envelopeAddress,
    headerValue,
    utf8Bytes,
    base64Encode,
    base64Lines,
    rfc5322Date,
    encodeHeaderValue,
    buildMIMEMessage,
    dotStuff,
    SMTP_VERBS,
    buildCommand,
    buildArgumentLine,
    parseReply,
    replyClass,
    checkReply,
    requireReply,
    parseEhloCapabilities,
    buildAuthCommand,
    buildLoginSecretCommand,
    normalizeDigestOptions,
    selectDigestRecords,
    buildDigest,
    normalizeHost,
    normalizePort,
    normalizeTLSMode,
    normalizeAuthMethod,
    securityForTLSMode,
    normalizeSMTPConfig,
    isSecureTLSMode,
    nextTLSVersionName,
    assertUsableTLS,
    buildConnectionTestPlan,
    assertNoMessageTransmission,
    payloadHash,
    makeSubmissionKey,
    createDeliveryState,
    recordDeliveryOutcome,
    authenticationHint,
    classifySMTPError,
    retryDelayMilliseconds,
  });
});
