"use strict";

/*
 * Core-level tests for FeedRank's SMTP implementation (chrome/content/email.js).
 *
 * Nothing in this file opens a socket, resolves a name, or holds a real
 * credential: every exchange is a canned string handed to the pure protocol
 * helpers, and every digest is built from local fixtures.
 */

const assert = require("node:assert/strict");
const Email = require("../chrome/content/email.js");
const SMTP = require("../chrome/content/email-smtp.js");

const CRLF = "\r\n";
const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function paper(overrides = {}) {
  return {
    id: "10:ABC123",
    title: "Integrated photonic squeezed-light source",
    score: 90,
    confidence: "high",
    reason: "Directly relevant to the supplied research profile.",
    source: "Quantum Photonics Feed",
    date: "2026-09-30",
    doi: "10.1000/example.1",
    url: "https://example.test/article",
    ...overrides,
  };
}

// The module deliberately avoids Buffer/btoa (it also runs in a Gecko chrome
// scope), so every expected base64 value is computed here with Node instead.
function base64(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function smtpConfig(overrides = {}) {
  return {
    host: "smtp.example.test",
    port: 465,
    tlsMode: "implicit",
    authMethod: "plain",
    username: "digest@example.test",
    from: "FeedRank <digest@example.test>",
    to: "reader@example.test",
    ...overrides,
  };
}

function usableTLS(overrides = {}) {
  return {
    securityInfoPresent: true,
    encrypted: true,
    failedVerification: false,
    failedCertChain: false,
    hasSecurityError: false,
    sslVersionUsed: 0x0303,
    plaintextFallbackUsed: false,
    ...overrides,
  };
}

// Extract one body from a multipart/alternative message, with its CRLF line
// breaks intact. Index 1 is the text/plain part and index 2 the text/html part
// for the boundary builder used below (index 0 is the preamble).
function mimeBody(message, boundary, index) {
  const chunk = message.split("--" + boundary)[index];
  const separator = chunk.indexOf(CRLF + CRLF);
  assert.notEqual(separator, -1, "MIME part " + index + " has no header/body separator");
  const body = chunk.slice(separator + 4);
  return body.endsWith(CRLF) ? body.slice(0, -CRLF.length) : body;
}

function smtpError(code, message, phase = "rcptTo") {
  return Object.assign(new Error(message), {
    smtpCode: code,
    smtpPhase: phase,
    smtpClass: Email.replyClass(code),
  });
}

// ---------------------------------------------------------------------------
// Digest selection and rendering (unchanged behaviour, still covered)
// ---------------------------------------------------------------------------

test("digest selection uses proposed defaults and never duplicates an item", () => {
  const records = [
    paper({ id: "A", score: 98 }),
    paper({ id: "B", score: 90 }),
    paper({ id: "B", score: 89, title: "Duplicate" }),
    paper({ id: "C", score: 70 }),
    paper({ id: "D", score: 69 }),
  ];
  const selected = Email.selectDigestRecords(records);
  assert.deepEqual(selected.priority.map((record) => record.id), ["A", "B", "C"]);
  assert.deepEqual(selected.readingList, []);

  const withReadingList = Email.selectDigestRecords(records, {
    priorityCount: 2,
    priorityMinimumScore: 70,
    readingListEnabled: true,
    readingListCount: 30,
  });
  assert.deepEqual(withReadingList.priority.map((record) => record.id), ["A", "B"]);
  assert.deepEqual(withReadingList.readingList.map((record) => record.id), ["C"]);
});

test("priority digest ordering preserves decimal local Priority values", () => {
  const records = [
    paper({ id: "higher-relevance", score: 91, priorityScore: 90.5 }),
    paper({ id: "higher-decimal-priority", score: 90, priorityScore: 90.75 }),
  ];
  const selected = Email.selectDigestRecords(records, { priorityCount: 2, maximumPapers: 2 });
  assert.deepEqual(selected.priority.map((record) => record.id), [
    "higher-decimal-priority",
    "higher-relevance",
  ]);
  assert.deepEqual(selected.readingList, []);
});

test("priority digest ordering uses local Priority while relevance Score remains the threshold", () => {
  const records = [
    paper({ id: "highest-score", score: 98, priorityScore: 98 }),
    paper({ id: "highest-priority", score: 90, priorityScore: 100 }),
    paper({ id: "below-threshold", score: 69, priorityScore: 100 }),
  ];
  const selected = Email.selectDigestRecords(records, { priorityCount: 2, maximumPapers: 2 });
  assert.deepEqual(selected.priority.map((record) => record.id), ["highest-priority", "highest-score"]);
  assert.equal(selected.priority.some((record) => record.id === "below-threshold"), false);
});

test("default digest is capped at ten papers at Score 70 or higher", () => {
  const records = Array.from({ length: 14 }, (_, index) => paper({
    id: "cap-" + index,
    score: index === 13 ? 69 : 100 - index,
  }));
  const selected = Email.selectDigestRecords(records, {
    priorityCount: 10,
    readingListEnabled: true,
    readingListCount: 30,
  });
  assert.equal(selected.priority.length + selected.readingList.length, 10);
  assert.ok([...selected.priority, ...selected.readingList].every((record) => record.score >= 70));
});

test("digest template escapes untrusted paper content and rejects unsafe links", () => {
  const digest = Email.buildDigest({
    date: "2026-09-30",
    records: [paper({
      title: "</strong><img src=x onerror=alert(1)>",
      reason: "<script>alert('x')</script>",
      // The reason is no longer printed, so the hostile payload also rides in the
      // two fields the digest DOES print: the authors and the institution.
      authors: ["<script>alert('author')</script>"],
      institutions: ["<img src=y onerror=alert(2)>"],
      url: "javascript:alert(1)",
    })],
  });
  assert.match(digest.html, /&lt;\/strong&gt;&lt;img/);
  assert.match(digest.html, /&lt;script&gt;/);
  assert.doesNotMatch(digest.html, /<script|<img|javascript:/i);
  assert.doesNotMatch(digest.text, /javascript:/i);
  assert.match(digest.text, /Untitled paper|<\/strong>/);
  // The subject names the week the digest covers, so the range is visible in the
  // inbox and the body does not repeat it as a heading.
  assert.equal(digest.subject, Email.digestSubject("2026-09-30"));
  assert.match(digest.subject, /^FeedRank weekly digest — 2026-09-30$/);
  assert.equal(Email.DIGEST_SUBJECT_PATTERN.test(digest.subject), true);
  assert.equal(Email.DIGEST_SUBJECT_PATTERN.test("FeedRank weekly digest — not a range"), false);
  assert.equal(Email.DIGEST_SUBJECT_PATTERN.test("FeedRank — Research digest"), false);
  // No heading and no blurb: the body starts straight at the papers.
  assert.doesNotMatch(digest.html, /<h1/);
  assert.doesNotMatch(digest.text, /^FeedRank weekly digest/m);
  assert.doesNotMatch(digest.text, /Papers published or posted in the last seven days/);
  assert.match(digest.html, /<h2[^>]*>Priority papers<\/h2>/);
  assert.match(digest.text, /^Priority papers$/m);
});

test("the digest prints authors and their institution, and not the model's confidence or rationale", () => {
  const digest = Email.buildDigest({
    date: "2026-09-30",
    records: [paper({
      title: "Integrated balanced homodyne detector",
      score: 95,
      confidence: "high",
      reason: "Directly relevant to the research profile.",
      authors: ["Doe, Jane", "Roe, Richard", "Poe, Edgar", "Noe, Alice"],
      institutions: ["Example University", "Example Institute"],
      source: "arXiv search - example topic",
      date: "2026-09-29 14:25:54",
      doi: "10.48550/arXiv.2609.37671",
      url: "https://arxiv.org/abs/2609.37671v1",
    })],
  });
  // Authors, trimmed to three plus "et al.", and the institution they are at.
  assert.match(digest.text, /Doe, Jane, Roe, Richard, Poe, Edgar et al\./);
  assert.match(digest.text, /Example University, Example Institute/);
  assert.match(digest.html, /Doe, Jane, Roe, Richard, Poe, Edgar et al\./);
  assert.match(digest.html, /Example University/);
  assert.match(digest.html, /font-style:italic/);
  // The score, the source, the date, the DOI and the link all survive.
  assert.match(digest.text, /Score: 95\/100/);
  assert.match(digest.text, /arXiv search - example topic/);
  assert.match(digest.text, /2026-09-29 14:25:54/);
  assert.match(digest.text, /DOI: 10\.48550\/arXiv\.2609\.37671/);
  assert.match(digest.text, /Article: https:\/\/arxiv\.org\/abs\/2609\.37671v1/);
  // And the two fields that were removed are gone from both parts.
  assert.doesNotMatch(digest.text, /Confidence/);
  assert.doesNotMatch(digest.text, /Why:/);
  assert.doesNotMatch(digest.html, /Confidence/);
  assert.doesNotMatch(digest.html, /Why:/);
  assert.doesNotMatch(digest.html, /Directly relevant to the research profile/);
  assert.doesNotMatch(digest.text, /Directly relevant to the research profile/);

  // A record with no authors and no institution still renders: the detail line
  // simply carries whatever exists.
  const bare = Email.buildDigest({
    date: "2026-09-30",
    records: [paper({ title: "No author metadata", score: 80, source: "", date: "" })],
  });
  assert.match(bare.text, /^1\. No author metadata$/m);
  assert.doesNotMatch(bare.html, /<div style="font-size:12px[^"]*"><\/div>/);
});

test("the digest HTML fits at least five papers on one screen", () => {
  // "Make the email look better, and fit at least five papers on a screen." The
  // old template stacked five or six separate blocks per paper (score, why,
  // source, date, DOI, link), which cost about 150px each before any text wrapped,
  // so a normal mail pane showed two or three. Each paper is now TWO lines: the
  // title with its score, and one detail line with the authors and the rest.
  const records = Array.from({ length: 6 }, (_, index) => paper({
    id: "10:SLOT" + index,
    title: "Fully passive monolithic silicon quantum photonic circuit for entangled photon-pair generation " + index,
    score: 96 - index * 3,
    authors: ["Doe, Jane", "Roe, Richard", "Poe, Edgar"],
    institutions: ["Example University"],
    source: "arXiv search - example topic",
    date: "2026-09-2" + index + " 11:42:07",
    doi: "10.48550/arXiv.2609.2942" + index,
    url: "https://arxiv.org/abs/2609.2942" + index,
  }));
  const digest = Email.buildDigest({
    date: "2026-09-30",
    records,
    options: { maximumPapers: 10, minimumRelevanceScore: 70, priorityCount: 6 },
  });

  // One block per paper. They used to be <li> inside an <ol>, which Outlook numbers
  // itself: a reader saw "1. 1. Title" because the heading already carries its number
  // and the ordered list added a second one. A plain block has no marker to add.
  const items = digest.html.split("<div class=\"p\" ").slice(1).map((part) => "<div class=\"p\" " + part);
  assert.equal(items.length, 6);
  // Two lines inside each block: the title with its score, then the detail line.
  for (const item of items) {
    const inner = (item.match(/<div/g) || []).length - 1;
    assert.equal(inner, 2, "a paper must be two lines, not a stack: " + item.slice(0, 80));
  }
  assert.doesNotMatch(digest.html, /<br\s*\/?>/i, "line breaks must come from the layout, not from <br>");
  // No list element and no list marker: nothing a mail client can renumber, and none
  // of an <ol>'s default 40px indent.
  assert.doesNotMatch(digest.html, /<ol|<ul|<li|list-style/);
  assert.match(digest.html, /<div class="papers" style="margin:0;padding:0">/);
  assert.match(digest.html, /<style>/);
  // The number is written into the title, in both the HTML and the text part.
  assert.match(digest.html, />1\. Fully passive/);
  assert.match(digest.text, /^\s*1\. Fully passive/m);
  assert.match(digest.html, /<style>/);
  // Score, authors, institution, source, date, DOI and the link all survive.
  assert.match(digest.html, /96\/100/);
  assert.match(digest.html, /Doe, Jane, Roe, Richard, Poe, Edgar/);
  assert.match(digest.html, /Example University/);
  assert.match(digest.html, /arXiv search - example topic/);
  assert.match(digest.html, /DOI: 10\.48550\/arXiv\.2609\.29420/);
  assert.match(digest.html, /href="https:\/\/arxiv\.org\/abs\/2609\.29420"/);

  /*
   * The height budget, from the sizes the message itself declares: a title line at
   * 15px/1.32 and a detail line at 12px/1.4, plus 2px between them, 9px below the
   * item and 8px of padding. The title is assumed to wrap to TWO lines and the
   * detail line to two as well -- authors, institution, source, date and DOI are a
   * lot of text -- which is the realistic worst case at a normal reading width.
   * Five such papers must fit in a 750px reading area, and in practice eight do.
   */
  const px = (markup, property) => {
    const match = markup.match(new RegExp(property + ":([\\d.]+)px"));
    return match ? Number(match[1]) : 0;
  };
  const lines = (markup) => (markup.match(/line-height:([\d.]+)/) || [, "1"])[1];
  const first = items[0];
  const blocks = first.match(/<div style="[^"]*"/g) || [];
  const height = blocks.reduce((total, block) => {
    const size = px(block, "font-size");
    return total + size * Number(lines(block)) * 2 + px(block, "margin-top");
  }, 0) + 9 + 8 + 1;
  assert.ok(height <= 150, "one paper must stay under 150px so five fit on a screen; measured " + Math.round(height));
  assert.ok(height * 5 <= 750, "five papers must fit in a 750px reading area; measured " + Math.round(height * 5));
  assert.ok(height * 8 <= 750, "eight papers should fit too; measured " + Math.round(height * 8));
});

test("valid DOI is a canonical HTTPS fallback when article URL is unsafe", () => {
  const digest = Email.buildDigest({
    date: "2026-09-30",
    records: [paper({
      doi: "https://doi.org/10.1000/a-b_(c)",
      url: "data:text/html,unsafe",
    })],
  });
  assert.equal(Email.normalizeDOI("doi:10.1000/a-b_(c)"), "10.1000/a-b_(c)");
  assert.equal(Email.doiURL("10.1000/a-b_(c)"), "https://doi.org/10.1000/a-b_(c)");
  assert.match(digest.html, /href="https:\/\/doi\.org\/10\.1000\/a-b_\(c\)"/);
  assert.doesNotMatch(digest.html, /data:text/i);
});

// ---------------------------------------------------------------------------
// SMTP reply parsing
// ---------------------------------------------------------------------------

test("parseReply accepts single-line, bare, and multi-line replies and rejects broken framing", () => {
  assert.deepEqual(Email.parseReply("250 OK" + CRLF), { code: 250, lines: ["OK"], text: "OK" });
  assert.deepEqual(Email.parseReply("250"), { code: 250, lines: [""], text: "" });

  const multi = Email.parseReply(
    "250-mail.example.test" + CRLF + "250-SIZE 35882577" + CRLF + "250 AUTH PLAIN LOGIN" + CRLF,
  );
  assert.equal(multi.code, 250);
  assert.deepEqual(multi.lines, ["mail.example.test", "SIZE 35882577", "AUTH PLAIN LOGIN"]);
  assert.equal(multi.text, "mail.example.test SIZE 35882577 AUTH PLAIN LOGIN");

  assert.throws(() => Email.parseReply(""), /Empty SMTP reply/);
  assert.throws(() => Email.parseReply(null), /Empty SMTP reply/);
  assert.throws(() => Email.parseReply("garbage" + CRLF), /Malformed SMTP reply line/);
  assert.throws(() => Email.parseReply("25 OK" + CRLF), /Malformed SMTP reply line/);
  assert.throws(() => Email.parseReply("25x OK" + CRLF), /Malformed SMTP reply line/);
  assert.throws(
    () => Email.parseReply("250-first" + CRLF + "250-second" + CRLF),
    /Incomplete multi-line SMTP reply/,
  );
  assert.throws(
    () => Email.parseReply("250-first" + CRLF + "550 second" + CRLF),
    /Inconsistent SMTP reply code in a multi-line reply/,
  );
  assert.throws(
    () => Email.parseReply("250-first" + CRLF + "250 second" + CRLF + "250 third" + CRLF),
    /Malformed multi-line SMTP reply/,
  );
  assert.throws(
    () => Email.parseReply("250 " + "x".repeat(Email.SMTP_MAX_REPLY_LENGTH) + CRLF),
    /SMTP reply is too long/,
  );
  assert.throws(
    () => Email.parseReply(("250-x" + CRLF).repeat(64) + "250 x" + CRLF),
    /SMTP reply has too many lines/,
  );
  // 64 lines is exactly the accepted maximum.
  assert.equal(Email.parseReply(("250-x" + CRLF).repeat(63) + "250 x" + CRLF).code, 250);
});

test("a reply is only complete at the terminating line and its text is bounded", () => {
  // A lone "250-" line is an UNFINISHED reply. parseReply must refuse it, so no
  // caller can mistake a partial multi-line reply for a complete success. The
  // socket layer enforces the same rule independently via
  // lastLineCompletesReply().
  assert.throws(
    () => Email.parseReply("250-only-more-to-come" + CRLF),
    /Incomplete multi-line SMTP reply/,
  );
  for (const partial of [
    "250-a" + CRLF + "250-b" + CRLF,
    "250-a" + CRLF + "250-b" + CRLF + "250-c" + CRLF,
    "220-a" + CRLF + "220-b" + CRLF,
  ]) {
    assert.throws(() => Email.parseReply(partial), /Incomplete multi-line SMTP reply/);
  }
  // A continuation marker on the final line is the same unfinished reply.
  assert.throws(() => Email.parseReply("250-a" + CRLF + "250-b-" + CRLF), /Incomplete multi-line SMTP reply/);
  // A non-continued line followed by more lines is malformed in the other way.
  assert.throws(() => Email.parseReply("250 a" + CRLF + "250 b" + CRLF), /Malformed multi-line SMTP reply/);

  const long = Email.parseReply("250 " + "y".repeat(900) + CRLF);
  assert.equal(long.text.length, 500);
  assert.equal(Email.SMTP_MAX_REPLY_LENGTH, 8192);
});

// ---------------------------------------------------------------------------
// Per-phase reply acceptance
// ---------------------------------------------------------------------------

test("checkReply and requireReply accept only the exact RFC code for each phase", () => {
  assert.equal(Email.checkReply("greeting", "220 ready" + CRLF).ok, true);
  assert.equal(Email.checkReply("greeting", "250 ready" + CRLF).ok, false);
  assert.equal(Email.checkReply("ehlo", "250 hi" + CRLF).ok, true);
  assert.equal(Email.checkReply("ehlo", "220 hi" + CRLF).ok, false);
  assert.equal(Email.checkReply("starttls", "220 go" + CRLF).ok, true);
  assert.equal(Email.checkReply("starttls", "250 go" + CRLF).ok, false);
  assert.equal(Email.checkReply("auth", "235 2.7.0 ok" + CRLF).ok, true);
  assert.equal(Email.checkReply("auth", "503 already authenticated" + CRLF).ok, true);
  // 334 is the *challenge* that starts AUTH LOGIN, never its result.
  assert.equal(Email.checkReply("auth", "334 VXNlcm5hbWU6" + CRLF).ok, false);
  assert.equal(Email.checkReply("mailFrom", "250 sender ok" + CRLF).ok, true);
  assert.equal(Email.checkReply("rcptTo", "250 recipient ok" + CRLF).ok, true);
  assert.equal(Email.checkReply("rcptTo", "251 will forward" + CRLF).ok, true);
  assert.equal(Email.checkReply("rcptTo", "252 cannot verify" + CRLF).ok, false);
  assert.equal(Email.checkReply("quit", "221 bye" + CRLF).ok, true);
  assert.equal(Email.checkReply("quit", "250 bye" + CRLF).ok, false);
  assert.equal(Email.checkReply("noop", "250 ok" + CRLF).ok, true);
  assert.equal(Email.checkReply("rset", "250 ok" + CRLF).ok, true);
  assert.throws(() => Email.checkReply("nope", "250 ok" + CRLF), /Unknown SMTP phase/);

  // DATA must be exactly 354: a 250 there is a protocol error, not a success.
  assert.equal(Email.checkReply("data", "354 Start mail input" + CRLF).ok, true);
  const wrongCode = Email.checkReply("data", "250 queued" + CRLF);
  assert.equal(wrongCode.ok, false);
  assert.equal(wrongCode.klass, "positive");
  assert.equal(wrongCode.label, "DATA");

  // The final reply after the terminating dot must be 250, not 354.
  assert.equal(Email.checkReply("body", "250 queued as 4Wx1" + CRLF).ok, true);
  assert.equal(Email.checkReply("body", "354 go" + CRLF).ok, false);

  assert.equal(Email.requireReply("data", "354 go" + CRLF).code, 354);
  let thrown = null;
  try {
    Email.requireReply("data", "250 queued" + CRLF);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "a 250 reply to DATA must be rejected");
  assert.equal(thrown.smtpCode, 250);
  assert.equal(thrown.smtpPhase, "data");
  assert.equal(thrown.smtpClass, "positive");
  assert.match(thrown.message, /SMTP DATA failed with 250 queued/);
});

test("a 4xx reply is transient and a 5xx reply is permanent", () => {
  const transient = Email.checkReply("rcptTo", "450 4.7.1 Greylisted, try again later" + CRLF);
  assert.equal(transient.ok, false);
  assert.equal(transient.klass, "transient");
  const permanent = Email.checkReply("rcptTo", "550 5.1.1 No such user here" + CRLF);
  assert.equal(permanent.ok, false);
  assert.equal(permanent.klass, "permanent");

  assert.equal(Email.replyClass(220), "positive");
  assert.equal(Email.replyClass(354), "positive");
  assert.equal(Email.replyClass(399), "positive");
  assert.equal(Email.replyClass(400), "transient");
  assert.equal(Email.replyClass(499), "transient");
  assert.equal(Email.replyClass(500), "permanent");
  assert.equal(Email.replyClass(599), "permanent");
  assert.equal(Email.replyClass(600), "invalid");
  assert.equal(Email.replyClass(99), "invalid");
  assert.equal(Email.replyClass("450"), "transient");
});

// ---------------------------------------------------------------------------
// EHLO capabilities
// ---------------------------------------------------------------------------

test("parseEhloCapabilities detects STARTTLS, AUTH mechanisms, and SIZE", () => {
  const capabilities = Email.parseEhloCapabilities([
    "250-mail.example.test hello [10.0.0.1]",
    "250-SIZE 35882577",
    "250-8BITMIME",
    "250-AUTH PLAIN LOGIN XOAUTH2",
    "250-STARTTLS",
    "250 SMTPUTF8",
  ].join(CRLF) + CRLF);
  assert.equal(capabilities.ok, true);
  assert.equal(capabilities.supportsStartTLS, true);
  assert.equal(capabilities.supportsSMTPUTF8, true);
  assert.equal(capabilities.supports8BITMIME, true);
  assert.deepEqual(capabilities.authMechanisms, ["PLAIN", "LOGIN", "XOAUTH2"]);
  assert.equal(capabilities.size, 35882577);
  assert.ok(capabilities.capabilities.includes("STARTTLS"));
  assert.ok(capabilities.capabilities.includes("AUTH"));

  const noExtensions = Email.parseEhloCapabilities("250 mail.example.test" + CRLF);
  assert.equal(noExtensions.ok, true);
  assert.equal(noExtensions.supportsStartTLS, false);
  assert.deepEqual(noExtensions.authMechanisms, []);
  assert.equal(noExtensions.size, null);

  // A non-250 reply is not a capability list.
  const refused = Email.parseEhloCapabilities("550 5.7.1 Service unavailable" + CRLF);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.capabilities, []);
  assert.deepEqual(refused.authMechanisms, []);
  assert.equal(refused.text, "5.7.1 Service unavailable");

  // SIZE without a usable value yields null; AUTH mechanisms are deduplicated.
  assert.equal(Email.parseEhloCapabilities("250-mail.test" + CRLF + "250 SIZE 0" + CRLF).size, null);
  assert.deepEqual(
    Email.parseEhloCapabilities("250-mail.test" + CRLF + "250 AUTH PLAIN PLAIN LOGIN" + CRLF).authMechanisms,
    ["PLAIN", "LOGIN"],
  );
  assert.throws(() => Email.parseEhloCapabilities("not a reply" + CRLF), /Malformed SMTP reply line/);
  // An EHLO extension list that never terminates is refused rather than read as
  // a partial capability set.
  assert.throws(() => Email.parseEhloCapabilities("250-STARTTLS" + CRLF), /Incomplete multi-line SMTP reply/);
});

// ---------------------------------------------------------------------------
// Command construction
// ---------------------------------------------------------------------------

test("buildCommand rejects CRLF and control-character injection and over-long command lines", () => {
  assert.equal(Email.buildCommand("NOOP"), "NOOP" + CRLF);
  assert.equal(Email.buildCommand("ehlo", "feedrank.local"), "EHLO feedrank.local" + CRLF);
  assert.equal(Email.buildCommand("DATA"), "DATA" + CRLF);
  assert.equal(Email.buildCommand("STARTTLS"), "STARTTLS" + CRLF);
  assert.equal(Email.buildCommand("MAIL FROM", "<digest@example.test>"), "MAIL FROM <digest@example.test>" + CRLF);
  // A collapsed verb is not a synonym: SMTP has no MAILFROM command.
  assert.throws(() => Email.buildCommand("MAILFROM", "<digest@example.test>"), /Invalid SMTP command verb/);

  assert.throws(() => Email.buildCommand("EHLO", "a" + CRLF + "MAIL FROM:<attacker@example.test>"), /line break/);
  assert.throws(() => Email.buildCommand("EHLO", "a\nMAIL FROM:<attacker@example.test>"), /line break/);
  assert.throws(() => Email.buildCommand("EHLO", "a\u0000b"), /control character/);
  assert.throws(() => Email.buildCommand("EHLO", "a\u007fb"), /control character/);
  assert.throws(() => Email.buildCommand("EH", "x"), /Invalid SMTP command verb/);
  assert.throws(() => Email.buildCommand("", "x"), /Invalid SMTP command verb/);
  assert.throws(() => Email.buildCommand(null, "x"), /Invalid SMTP command verb/);
  // The two-word forms are legal and must round-trip.
  assert.equal(Email.buildCommand("MAIL FROM", "<a@b.test>"), "MAIL FROM <a@b.test>" + CRLF);
  assert.equal(Email.buildCommand("RCPT TO", "<c@d.test>"), "RCPT TO <c@d.test>" + CRLF);

  // RFC 5321 §4.5.3.1: 512 octets including CRLF.
  assert.equal(Email.SMTP_MAX_COMMAND_LENGTH, 512);
  assert.equal(Email.buildCommand("EHLO", "x".repeat(505)).length, 512);
  assert.throws(() => Email.buildCommand("EHLO", "x".repeat(506)), /512-octet command-line limit/);
  assert.throws(() => Email.buildCommand("EHLO", "x".repeat(600)), /512-octet command-line limit/);
});

test("buildAuthCommand produces the exact base64 material for PLAIN, LOGIN, and XOAUTH2", () => {
  const username = "digest@example.test";
  const secret = "not-a-real-secret";

  assert.equal(
    Email.buildAuthCommand("plain", { username, secret }),
    "AUTH PLAIN " + base64("\u0000" + username + "\u0000" + secret) + CRLF,
  );
  assert.equal(
    Email.buildAuthCommand("PLAIN", { username, secret }),
    "AUTH PLAIN " + base64("\u0000" + username + "\u0000" + secret) + CRLF,
  );
  assert.equal(
    Email.buildAuthCommand("login", { username, secret }),
    "AUTH LOGIN" + CRLF,
  );
  assert.equal(
    Email.buildAuthCommand("xoauth2", { username, secret }),
    "AUTH XOAUTH2 " + base64("user=" + username + "\u0001auth=Bearer " + secret + "\u0001\u0001") + CRLF,
  );

  for (const method of ["plain", "login", "xoauth2"]) {
    assert.throws(() => Email.buildAuthCommand(method, { username: "", secret }), /username and secret are required/);
    assert.throws(() => Email.buildAuthCommand(method, { username, secret: "" }), /username and secret are required/);
    assert.throws(() => Email.buildAuthCommand(method, {}), /username and secret are required/);
  }
  assert.throws(
    () => Email.buildAuthCommand("plain", { username: "u@example.test" + CRLF + "AUTH LOGIN", secret }),
    /unsupported character/,
  );
  assert.throws(
    () => Email.buildAuthCommand("plain", { username: "u\u0000@example.test", secret }),
    /unsupported character/,
  );
  assert.throws(
    () => Email.buildAuthCommand("cram-md5", { username, secret }),
    /Unsupported SMTP authentication method/,
  );
  assert.throws(
    () => Email.buildAuthCommand("", { username, secret }),
    /Unsupported SMTP authentication method/,
  );
});

test("buildLoginSecretCommand emits the bare base64 secret line that AUTH LOGIN requires", () => {
  // RFC 4954 AUTH LOGIN: after the 334 challenge the client sends the base64
  // secret on its own line, with no verb. Regression guard for a defect where
  // the base64 was passed to buildCommand() as a *verb*, so every realistic
  // secret threw "Invalid SMTP command verb" and the password step could never
  // be produced.
  for (const secret of ["hunter2", "not-a-real-secret", "A", "app password with spaces", "p@ss:w/rd+="]) {
    assert.equal(Email.buildLoginSecretCommand(secret), base64(secret) + CRLF);
    // The line is base64 only: no verb, no injection surface.
    assert.match(Email.buildLoginSecretCommand(secret), /^[A-Za-z0-9+/]+={0,2}\r\n$/);
  }
  assert.equal(Email.buildLoginSecretCommand("\u0000\u0000\u0000"), "AAAA" + CRLF);
  assert.throws(() => Email.buildLoginSecretCommand(""), /An SMTP secret is required/);
  assert.throws(() => Email.buildLoginSecretCommand(null), /An SMTP secret is required/);
});

test("buildCommand expresses the standard one- and two-word verbs and rejects everything else", () => {
  // Regression guard: the verb pattern must accept the two-word commands that
  // SMTPSession.submit() actually builds, or no message can ever reach DATA.
  assert.equal(Email.buildCommand("MAIL FROM", "<digest@example.test>"), "MAIL FROM <digest@example.test>" + CRLF);
  assert.equal(Email.buildCommand("RCPT TO", "<reader@example.test>"), "RCPT TO <reader@example.test>" + CRLF);
  assert.equal(Email.buildCommand("mail from", "<a@b.test>"), "MAIL FROM <a@b.test>" + CRLF);
  assert.equal(Email.buildCommand("MAIL FROM", ""), "MAIL FROM" + CRLF);
  // A three-word or otherwise malformed verb is still refused, as is a verb
  // that tries to smuggle a second command through the verb slot.
  assert.throws(() => Email.buildCommand("MAIL FROM EVIL", "<a@b.test>"), /Invalid SMTP command verb/);
  assert.throws(() => Email.buildCommand("EHLO" + CRLF + "DATA", "x"), /Invalid SMTP command verb/);
  assert.throws(() => Email.buildCommand("EHLO DATA", "x"), /Invalid SMTP command verb/);
  assert.throws(() => Email.buildCommand("DATA BODY", "x"), /Invalid SMTP command verb/);
  assert.throws(() => Email.buildCommand("EHLO;", "x"), /Invalid SMTP command verb/);
});

test("buildArgumentLine accepts printable ASCII only and enforces the command-line bound", () => {
  assert.equal(Email.buildArgumentLine("QUJD"), "QUJD" + CRLF);
  assert.throws(() => Email.buildArgumentLine(""), /must not be empty/);
  assert.throws(() => Email.buildArgumentLine("a" + CRLF + "MAIL FROM:<x@y.test>"), /printable ASCII/);
  assert.throws(() => Email.buildArgumentLine("a\nb"), /printable ASCII/);
  assert.throws(() => Email.buildArgumentLine("a\u0000b"), /printable ASCII/);
  assert.throws(() => Email.buildArgumentLine("a b"), /printable ASCII/);
  assert.throws(() => Email.buildArgumentLine("x".repeat(600)), /512-octet command-line limit/);
});

// ---------------------------------------------------------------------------
// MIME message construction
// ---------------------------------------------------------------------------

test("buildMIMEMessage emits exactly the required headers and no optional delivery headers", () => {
  const built = Email.buildMIMEMessage({
    from: "FeedRank <digest@example.test>",
    to: "reader@example.test",
    subject: "FeedRank daily digest",
    text: "Digest body",
    html: "<p>Digest body</p>",
    date: new Date(1759190400000),
    messageID: "<fixed-token@example.test>",
    boundary: "feedrank-fixedboundary",
  });
  assert.deepEqual(built.message.split(CRLF + CRLF)[0].split(CRLF), [
    "MIME-Version: 1.0",
    "Date: " + new Date(1759190400000).toUTCString().replace(/GMT$/, "+0000"),
    "Message-ID: <fixed-token@example.test>",
    "Subject: FeedRank daily digest",
    "From: FeedRank <digest@example.test>",
    "To: reader@example.test",
    'Content-Type: multipart/alternative; boundary="feedrank-fixedboundary"',
  ]);
  assert.equal(built.messageID, "<fixed-token@example.test>");
  assert.equal(built.boundary, "feedrank-fixedboundary");
  assert.equal(built.subject, "FeedRank daily digest");
  for (const forbidden of [/^Cc:/im, /^Bcc:/im, /^Reply-To:/im, /^Content-Disposition:/im, /^In-Reply-To:/im, /^Return-Receipt-To:/im, /attachment/i]) {
    assert.doesNotMatch(built.message, forbidden);
  }
  assert.equal(built.message.includes("--feedrank-fixedboundary--" + CRLF), true);
  assert.throws(() => Email.buildMIMEMessage({
    from: "a@example.test", to: "b@example.test", subject: "s", text: "t", html: "",
  }), /HTML digest body is required/);
  assert.throws(() => Email.buildMIMEMessage({
    from: "a@example.test", to: "b@example.test", subject: "s", text: "", html: "<p>t</p>",
  }), /plain-text digest body is required/);
});

test("buildMIMEMessage encodes a non-ASCII subject as one RFC 2047 encoded word", () => {
  const subject = "Résumé — 论文";
  const built = Email.buildMIMEMessage({
    from: "FeedRank <digest@example.test>",
    to: "reader@example.test",
    subject,
    text: "body",
    html: "<p>body</p>",
    date: new Date(1759190400000),
    messageID: "<fixed-token@example.test>",
    boundary: "feedrank-fixedboundary",
  });
  assert.equal(built.subject, subject);
  const subjectLine = built.message.split(CRLF).find((line) => line.startsWith("Subject: "));
  assert.equal(subjectLine, "Subject: =?UTF-8?B?" + base64(subject) + "?=");
  assert.match(subjectLine, /^[\x20-\x7E]+$/, "a header line must stay 7-bit ASCII");
  assert.equal(built.message.split(CRLF).some((line) => line === "Subject: " + subject), false);

  const ascii = Email.buildMIMEMessage({
    from: "FeedRank <digest@example.test>",
    to: "reader@example.test",
    subject: "FeedRank daily digest",
    text: "body",
    html: "<p>body</p>",
    date: new Date(1759190400000),
    messageID: "<fixed-token@example.test>",
    boundary: "feedrank-fixedboundary",
  });
  assert.equal(ascii.message.split(CRLF).includes("Subject: FeedRank daily digest"), true);
  assert.doesNotMatch(ascii.message, /\?UTF-8\?B\?/);
});

test("both MIME parts are base64, 76 characters per line, and round-trip the original UTF-8", () => {
  const boundary = "feedrank-fixedboundary";
  const text = "Ligne une — 论文 😀" + "\n" + "Ligne deux avec \"guillemets\" et <chevrons>".repeat(6) + "\n";
  const html = "<p>" + text.replace(/\n/g, "<br>") + "</p>";
  const built = Email.buildMIMEMessage({
    from: "FeedRank <digest@example.test>",
    to: "reader@example.test",
    subject: "Digest",
    text,
    html,
    date: new Date(1759190400000),
    messageID: "<fixed-token@example.test>",
    boundary,
  });

  const textBody = mimeBody(built.message, boundary, 1);
  const htmlBody = mimeBody(built.message, boundary, 2);
  assert.equal(
    textBody.split(CRLF).join(""),
    Buffer.from(text, "utf8").toString("base64"),
  );
  assert.equal(Buffer.from(textBody.replace(/\r\n/g, ""), "base64").toString("utf8"), text);
  assert.equal(Buffer.from(htmlBody.replace(/\r\n/g, ""), "base64").toString("utf8"), html);

  for (const encoded of [textBody, htmlBody]) {
    const lines = encoded.split(CRLF);
    assert.ok(lines.length > 1, "the body must be wrapped across lines");
    assert.equal(Email.BASE64_LINE_LENGTH, 76);
    for (const line of lines.slice(0, -1)) assert.equal(line.length, 76);
    assert.ok(lines.at(-1).length <= 76);
  }
  const parts = built.message.split("--" + boundary);
  assert.match(parts[1], /Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n/);
  assert.match(parts[2], /Content-Type: text\/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n/);
  assert.equal(parts[0].split(CRLF + CRLF)[1], "This is a multi-part message in MIME format." + CRLF);
  assert.equal(parts[3], "--" + CRLF);
});

test("the MIME message is CRLF-only, rejects header injection, and refuses an oversize body", () => {
  const built = Email.buildMIMEMessage({
    from: "FeedRank <digest@example.test>",
    to: "reader@example.test",
    subject: "Digest",
    text: "body",
    html: "<p>body</p>",
    date: new Date(1759190400000),
    messageID: "<fixed-token@example.test>",
    boundary: "feedrank-fixedboundary",
  });
  assert.doesNotMatch(built.message, /(^|[^\r])\n/, "no bare LF may appear");
  assert.doesNotMatch(built.message, /\r([^\n]|$)/, "every CR must be followed by LF");
  for (const line of built.message.split(CRLF)) {
    assert.ok(line.length <= Email.SMTP_MAX_TEXT_LINE_LENGTH - 2, "MIME line exceeds the SMTP text-line limit");
  }

  const injection = { from: "FeedRank <digest@example.test>", to: "reader@example.test", text: "t", html: "<p>t</p>" };
  assert.throws(
    () => Email.buildMIMEMessage({ ...injection, subject: "Digest" + CRLF + "Bcc: attacker@example.test" }),
    /Subject must not contain a line break/,
  );
  assert.throws(
    () => Email.buildMIMEMessage({ ...injection, subject: "Digest\nBcc: attacker@example.test" }),
    /Subject must not contain a line break/,
  );
  assert.throws(
    () => Email.buildMIMEMessage({ ...injection, subject: "Digest", to: "reader@example.test" + CRLF + "Bcc: attacker@example.test" }),
    /one valid email address/,
  );
  assert.throws(
    () => Email.buildMIMEMessage({ ...injection, subject: "Digest", from: "FeedRank" + CRLF + "Bcc: attacker@example.test <digest@example.test>" }),
    /display name|From address/,
  );
  assert.throws(
    () => Email.buildMIMEMessage({ ...injection, subject: "Digest", from: "digest@example.test" + CRLF + "Bcc: attacker@example.test" }),
    /From address/,
  );
  assert.throws(
    () => Email.buildMIMEMessage({ ...injection, subject: "Digest", boundary: "short" }),
    /MIME boundary is malformed/,
  );
  assert.throws(
    () => Email.buildMIMEMessage({ ...injection, subject: "Digest", messageID: "not-a-message-id" }),
    /Message-ID is malformed/,
  );

  // base64 expansion means 80% of the octet limit already exceeds the limit.
  const filler = "x".repeat(Math.ceil(Email.MAX_MESSAGE_LENGTH * 0.8));
  assert.throws(
    () => Email.buildMIMEMessage({ ...injection, subject: "Digest", text: filler }),
    /exceeds FeedRank's sending limit/,
  );
});

// ---------------------------------------------------------------------------
// Dot stuffing
// ---------------------------------------------------------------------------

test("dotStuff doubles leading dots and its terminator cannot be escaped", () => {
  assert.equal(Email.dotStuff("line one" + CRLF + "line two"), "line one\r\nline two\r\n.\r\n");
  assert.equal(Email.dotStuff("unix\nafter"), "unix\r\nafter\r\n.\r\n");
  assert.equal(Email.dotStuff("first" + CRLF + "." + CRLF + "..third"), "first\r\n..\r\n...third\r\n.\r\n");

  const hostile = "hello" + CRLF + "." + CRLF;
  const stuffed = Email.dotStuff(hostile);
  assert.equal(stuffed, "hello\r\n..\r\n\r\n.\r\n");
  assert.equal(stuffed.endsWith(CRLF + "." + CRLF), true);
  // The body's own dot line was neutralised, so the *only* bare-dot line in the
  // transmitted data is the final terminator.
  assert.deepEqual(stuffed.split(CRLF).filter((line) => line === "."), ["."]);
  assert.doesNotMatch(stuffed, /(^|[^\r])\n/);

  // Un-stuffing the transmitted data recovers the original message exactly.
  const withoutTerminator = stuffed.slice(0, -1 * (CRLF + "." + CRLF).length);
  const recovered = withoutTerminator
    .split(CRLF)
    .map((line) => (line.startsWith("..") ? line.slice(1) : line))
    .join(CRLF);
  assert.equal(recovered.replace(/\r\n/g, "\n"), hostile.replace(/\r\n/g, "\n"));
});

// ---------------------------------------------------------------------------
// TLS admission
// ---------------------------------------------------------------------------

test("assertUsableTLS fails closed for every unsafe condition and passes only for TLS 1.2/1.3", () => {
  const failures = [
    // Nothing at all: neither an explicit security state nor a completed
    // handshake proves encryption, so credentials must not be sent.
    ["missing security state", {}, /neither the TLS security state nor a completed handshake/],
    // A version that was OBSERVED must be TLS 1.2 or 1.3. A version this build
    // did not report is no longer a refusal on its own — SSLVersionUsed reads
    // -1 or 772 on the same working server depending only on when it is asked —
    // so the admission is labelled `protocolConfirmed: false` instead.
    ["a TLS error reported by the state",
      { encrypted: false, hasSecurityError: true, sslVersionUsed: 0x0303 },
      /not encrypted/],
    // The handshake fallback must not become an override for real failures.
    ["handshake plus failed verification",
      { handshakeCompleted: true, failedVerification: true, sslVersionUsed: 0x0303 },
      /certificate verification failed/],
    ["handshake plus a failed chain",
      { handshakeCompleted: true, failedCertChain: true, sslVersionUsed: 0x0303 },
      /certificate chain did not validate/],
    ["handshake plus a security error",
      { handshakeCompleted: true, hasSecurityError: true, sslVersionUsed: 0x0303 },
      /reports an error/],
    ["failed verification", usableTLS({ failedVerification: true }), /certificate verification failed/],
    ["failed certificate chain", usableTLS({ failedCertChain: true }), /certificate chain did not validate/],
    ["security error", usableTLS({ hasSecurityError: true }), /reports an error/],
    ["plaintext fallback", usableTLS({ plaintextFallbackUsed: true }), /plaintext fallback was used/],
    ["SSL 3.0", usableTLS({ sslVersionUsed: 0x0300 }), /SSL 3\.0/],
    ["TLS 1.0", usableTLS({ sslVersionUsed: 0x0301 }), /TLS 1\.0/],
    ["TLS 1.1", usableTLS({ sslVersionUsed: 0x0302 }), /TLS 1\.1/],
    ["SSL 3.0 with no encryption verdict", { handshakeCompleted: true, sslVersionUsed: 0x0300 }, /SSL 3\.0/],
    // An implicit-TLS socket whose TLS record was NOT clean: `encrypted: false`
    // is read as positive evidence of a problem, so it is refused even though a
    // handshake is recorded. This is the shape the transport produces for a
    // recorded TLS error or a failed certificate chain.
    ["an unencrypted session with a recorded handshake",
      usableTLS({ encrypted: false, handshakeCompleted: true, sslVersionUsed: 0x0303 }),
      /not encrypted/],
    // A state that positively reports a failure is refused even with a resolved
    // handshake, because a failure flag is real evidence and the handshake is not
    // counter-evidence to it.
    ["a reported security error is never rescued by the handshake",
      { securityInfoPresent: true, handshakeCompleted: true, hasSecurityError: true, sslVersionUsed: 0x0303 },
      /not encrypted/],
    ["a security error with no handshake",
      { securityInfoPresent: true, encrypted: false, hasSecurityError: true, sslVersionUsed: 0x0303 },
      /not encrypted/],
  ];
  for (const [label, evidence, expected] of failures) {
    assert.throws(() => Email.assertUsableTLS(evidence), expected, label);
  }
  assert.deepEqual(Email.assertUsableTLS(usableTLS()),
    { protocol: "TLS 1.2", protocolConfirmed: true, failedVerification: false, verifiedBy: "security-info" });
  assert.deepEqual(Email.assertUsableTLS(usableTLS({ sslVersionUsed: 0x0304 })),
    { protocol: "TLS 1.3", protocolConfirmed: true, failedVerification: false, verifiedBy: "security-info" });
  // A verified session whose version this build did not report is admitted, and
  // says so. The live Outlook log read SSLVersionUsed as -1 on a TLS 1.3
  // connection, so demanding a version made the same server connect or fail at
  // random; the refusal is reserved for a version that WAS read and is too old.
  const unversioned = Email.assertUsableTLS(usableTLS({ sslVersionUsed: -1 }));
  assert.equal(unversioned.protocolConfirmed, false);
  assert.match(unversioned.protocol, /not reported by this build/);
  assert.equal(unversioned.verifiedBy, "security-info");
  // The security-info protocolVersion enum this build returns is read as the
  // version it names: 4 means TLS 1.3, and 3 means TLS 1.2.
  assert.equal(Email.assertUsableTLS({ encrypted: true, protocolVersion: 4 }).protocol, "TLS 1.3");
  assert.equal(Email.assertUsableTLS({ encrypted: true, protocolVersion: 3 }).protocol, "TLS 1.2");
  assert.throws(() => Email.assertUsableTLS({ encrypted: true, protocolVersion: 1 }), /TLS 1\.0/);
  // This build exposes no JS-readable securityInfo, so encryption is proven by
  // the resolved STARTTLS handshake instead. It must be labelled as such.
  assert.deepEqual(
    Email.assertUsableTLS({ securityInfoPresent: false, handshakeCompleted: true, sslVersionUsed: 0x0303 }),
    { protocol: "TLS 1.2", protocolConfirmed: true, failedVerification: false, verifiedBy: "completed-handshake" },
  );
  // The 32-bit protocolVersion encoding nsITransportSecurityInfo uses is read as
  // the same version, since SSLVersionUsed is not a readable member here.
  assert.equal(Email.assertUsableTLS({ encrypted: true, protocolVersion: 0x03040000 }).protocol, "TLS 1.3");
  assert.equal(Email.assertUsableTLS({ encrypted: true, protocolVersion: 0x03030000 }).protocol, "TLS 1.2");
  assert.throws(() => Email.assertUsableTLS({ encrypted: true, protocolVersion: 0x03010000 }), /TLS 1\.0/);
  assert.equal(Email.nextTLSVersionName(0x0304), "TLS 1.3");
  assert.equal(Email.nextTLSVersionName(0x0303), "TLS 1.2");
  assert.equal(Email.nextTLSVersionName(-1), "unknown");
});

test("securityForTLSMode maps each TLS mode and normalizeSMTPConfig refuses plaintext or unknown settings", () => {
  assert.equal(Email.securityForTLSMode("implicit"), "ssl");
  assert.equal(Email.securityForTLSMode("starttls"), "starttls");
  assert.equal(Email.securityForTLSMode("IMPLICIT"), "ssl");
  for (const mode of ["plaintext", "none", "ssl", "opportunistic", "", null, undefined]) {
    assert.throws(() => Email.securityForTLSMode(mode), /TLS mode/, "mode " + String(mode));
  }

  const implicit = Email.normalizeSMTPConfig(smtpConfig());
  assert.deepEqual(implicit, {
    host: "smtp.example.test",
    port: 465,
    tlsMode: "implicit",
    authMethod: "plain",
    username: "digest@example.test",
    from: "FeedRank <digest@example.test>",
    to: "reader@example.test",
    requireTLS: true,
  });
  assert.equal(Email.normalizeSMTPConfig(smtpConfig({ tlsMode: "starttls", port: "" })).port, 587);
  assert.equal(Email.normalizeSMTPConfig(smtpConfig({ tlsMode: "starttls", port: 2525 })).port, 2525);

  for (const tlsMode of ["plaintext", "none", "opportunistic", "PLAINTEXT"]) {
    assert.throws(() => Email.normalizeSMTPConfig(smtpConfig({ tlsMode })), /TLS mode/);
  }
  for (const authMethod of ["cram-md5", "none", "oauth2", "plaintext"]) {
    assert.throws(() => Email.normalizeSMTPConfig(smtpConfig({ authMethod })), /authentication method/);
  }
  assert.throws(() => Email.normalizeSMTPConfig(smtpConfig({ username: "   " })), /SMTP username/);
  assert.throws(() => Email.normalizeSMTPConfig(smtpConfig({ username: "u@example.test" + CRLF + "MAIL FROM:<x>" })), /SMTP username/);
  assert.throws(() => Email.normalizeSMTPConfig(smtpConfig({ username: "u".repeat(321) })), /SMTP username/);
  assert.throws(() => Email.normalizeSMTPConfig(smtpConfig({ host: "not a host" })), /host name/);
  assert.throws(() => Email.normalizeSMTPConfig(smtpConfig({ host: "" })), /host name/);
  assert.throws(() => Email.normalizeSMTPConfig(smtpConfig({ port: 70000 })), /port between 1 and 65535/);
  assert.throws(() => Email.normalizeSMTPConfig(smtpConfig({ port: "0" })), /port between 1 and 65535/);
  assert.throws(() => Email.normalizeSMTPConfig(smtpConfig({ from: "not an address" })), /From address/);
  assert.throws(() => Email.normalizeSMTPConfig(smtpConfig({ to: "a@example.test, c@example.test" })), /one valid email address/);
  assert.throws(() => Email.normalizeSMTPConfig(smtpConfig({ to: "" })), /one valid email address/);
  // An IP literal is accepted for a self-hosted server.
  assert.equal(Email.normalizeSMTPConfig(smtpConfig({ host: "[10.0.0.5]" })).host, "10.0.0.5");
});

// ---------------------------------------------------------------------------
// Password-free connection test
// ---------------------------------------------------------------------------

test("an unpopulated security state is not read as 'not encrypted'", () => {
  // The exact live failure, twice over. After STARTTLS this build returned a
  // securityInfo whose state read `securityState: 0` and `SSLVersionUsed: -1` on
  // a connection that was in fact TLS 1.3 with a valid Outlook certificate. The
  // state object is simply not populated at the instant a handshake resolves, so
  // it is no longer consulted as a verdict at all.
  //
  // What the transport does instead is settle `encrypted` from facts that can
  // only hold for an established session: a negotiated cipher, an empty TLS error
  // string, and a certificate chain that was built rather than failed.
  const admitted = {
    noSecurityObject: { securityInfoPresent: false, handshakeCompleted: true, sslVersionUsed: 0x0303 },
    unpopulatedState: {
      securityInfoPresent: true, encrypted: true, encryptionEvidence: "cipher TLS_AES_128_GCM_SHA256",
      handshakeCompleted: true, sslVersionUsed: -1, protocolVersion: -1,
    },
    silentState: {
      securityInfoPresent: true, encrypted: true, handshakeCompleted: true, sslVersionUsed: 0x0303,
    },
  };
  for (const [label, evidence] of Object.entries(admitted)) {
    const result = Email.assertUsableTLS(evidence);
    assert.ok(result.protocol.length > 0, label + " must be admitted");
  }
  // An unreadable version is recorded as unconfirmed, not treated as a downgrade.
  assert.equal(Email.assertUsableTLS(admitted.unpopulatedState).protocolConfirmed, false);
  assert.equal(Email.assertUsableTLS(admitted.noSecurityObject).protocolConfirmed, true);
  assert.equal(Email.assertUsableTLS(admitted.unpopulatedState).verifiedBy, "resolved TLS session");

  // Refusals come from positive evidence of failure, and nothing rescues them.
  assert.throws(
    () => Email.assertUsableTLS({
      securityInfoPresent: true, encrypted: false, hasSecurityError: true,
      handshakeCompleted: true, sslVersionUsed: 0x0303,
    }),
    /not encrypted/,
    "a reported TLS error must refuse even with a resolved handshake",
  );
  assert.throws(
    () => Email.assertUsableTLS({
      securityInfoPresent: true, encrypted: true, failedCertChain: true,
      handshakeCompleted: true, sslVersionUsed: 0x0303,
    }),
    /certificate chain did not validate/,
  );
  // A version that WAS observed and is too old is still refused.
  assert.throws(
    () => Email.assertUsableTLS({
      securityInfoPresent: true, encrypted: true, handshakeCompleted: true, sslVersionUsed: 0x0301,
    }),
    /TLS 1\.0/,
  );
  // Nothing at all is still a refusal: an unproven socket gets no credentials.
  // An absent `encrypted` field means "unknown" and falls through to the
  // handshake check, while a deliberate `false` is its own refusal.
  assert.throws(
    () => Email.assertUsableTLS({ securityInfoPresent: true, sslVersionUsed: 0x0303 }),
    /neither the TLS security state nor a completed handshake/,
  );
  assert.throws(
    () => Email.assertUsableTLS({ securityInfoPresent: true, encrypted: false, sslVersionUsed: 0x0303 }),
    /not encrypted/,
  );
  // And an unknown-encryption socket WITH a resolved handshake is admitted: the
  // handshake is real evidence even when the security record did not answer.
  assert.equal(
    Email.assertUsableTLS({ securityInfoPresent: true, handshakeCompleted: true, sslVersionUsed: 0x0303 }).protocol,
    "TLS 1.2",
  );
});

test("the transport reconciles an unpopulated security state against a resolved handshake", async () => {
  // Drives the real SMTPSocketConnection.startTLS() with a control object that
  // mimics the live shape: the synchronous securityInfo is empty, and the
  // asynchronous accessor returns the settled state.
  const SMTP = require("../chrome/content/email-smtp.js");

  const makeConnection = ({ asyncInfo, syncInfo }) => {
    const control = {
      asyncStartTLS: async () => undefined,
      SSLVersionUsed: -1,
      failedVerification: false,
      securityInfo: syncInfo,
      ...(asyncInfo === undefined ? {} : { asyncGetSecurityInfo: async () => asyncInfo }),
    };
    return Object.assign(Object.create(SMTP.SMTPSocketConnection.prototype), {
      security: "starttls",
      host: "smtp.example.test",
      port: 587,
      tlsStarted: false,
      handshakeCompleted: false,
      settledSecurityInfo: null,
      buffer: "leftover",
      evaluatedChecks: [],
      transport: { tlsSocketControl: control },
    });
  };

  const settledState = {
    securityState: { isSecure: true, isBroken: false },
    failedCertChain: [],
  };

  // Case 1: the async accessor exists and returns the real state.
  const settled = makeConnection({ asyncInfo: settledState, syncInfo: { securityState: null } });
  const evidence1 = await settled.startTLS();
  assert.equal(evidence1.handshakeCompleted, true);
  assert.equal(evidence1.encrypted, true, "the settled state must be preferred");
  assert.equal(evidence1.securityInfoPresent, true);
  assert.equal(settled.buffer, "", "pre-handshake bytes must be discarded");

  // Case 2: no async accessor and an unpopulated synchronous state. The resolved
  // handshake plus a clean TLS record is the evidence, not the emptiness.
  const silent = makeConnection({ syncInfo: { securityState: 0 } });
  const evidence2 = await silent.startTLS();
  assert.equal(evidence2.handshakeCompleted, true);
  assert.equal(evidence2.sslVersionUsed, -1);
  assert.equal(evidence2.protocolVersion, -1);
  // The state object said `securityState: 0`, which on this build means "not
  // populated yet", not "insecure". It must NOT be read as a verdict.
  const admitted = Email.assertUsableTLS(evidence2);
  assert.equal(admitted.protocolConfirmed, false);
  assert.match(admitted.protocol, /not reported by this build/);
  // With a version present the same evidence is fully confirmed.
  assert.equal(Email.assertUsableTLS({ ...evidence2, sslVersionUsed: 0x0303 }).protocol, "TLS 1.2");

  // Case 3: implicit TLS observes its version and is admitted.
  const implicit = makeConnection({ syncInfo: null });
  implicit.security = "ssl";
  implicit.transport.tlsSocketControl.SSLVersionUsed = 0x0303;
  const evidence3 = implicit.describeSecurity();
  assert.equal(evidence3.handshakeCompleted, true);
  assert.equal(evidence3.sslVersionUsed, 0x0303);
  assert.equal(Email.assertUsableTLS(evidence3).protocol, "TLS 1.2");

  // Case 4: a real failure reported by the settled state is still honoured.
  const broken = makeConnection({
    asyncInfo: { securityState: { isSecure: true, isBroken: true }, failedCertChain: [] },
    syncInfo: null,
  });
  const evidence4 = await broken.startTLS();
  assert.throws(() => Email.assertUsableTLS(evidence4), /reports an error/);
});

test("a security member that throws on read is recorded, not fatal", async () => {
  // The live failure, verbatim from the settings window:
  //   Component returned failure code: 0x80040111 (NS_ERROR_NOT_AVAILABLE)
  //   [nsITransportSecurityInfo.protocolVersion]
  // Reading the version THREW instead of returning undefined, so the unguarded
  // read turned a diagnosis into a component-failure message and the connection
  // log came out empty: the diagnostic died the same way the gate did.
  const SMTP = require("../chrome/content/email-smtp.js");
  const info = { securityState: { isSecure: true, isBroken: false }, failedCertChain: [] };
  Object.defineProperty(info, "protocolVersion", {
    enumerable: true,
    get() { throw new Error("Component returned failure code: 0x80040111 (NS_ERROR_NOT_AVAILABLE)"); },
  });
  const control = {
    asyncStartTLS: async () => undefined,
    SSLVersionUsed: 772,
    failedVerification: false,
    securityInfo: info,
    asyncGetSecurityInfo: async () => info,
  };
  const connection = Object.assign(Object.create(SMTP.SMTPSocketConnection.prototype), {
    security: "starttls", host: "smtp.example.test", port: 587, tlsStarted: false,
    handshakeCompleted: false, settledSecurityInfo: null, buffer: "",
    evaluatedChecks: [], transport: { tlsSocketControl: control },
  });

  // The read must not escape, and the version that IS readable must survive it.
  // This mirrors the live build exactly: SSLVersionUsed reads 772 (TLS 1.3) while
  // nsITransportSecurityInfo.protocolVersion raises instead of returning a value.
  const evidence = await connection.startTLS();
  assert.equal(evidence.sslVersionUsed, 772);
  assert.equal(evidence.encrypted, true, "the state that WAS readable must survive");
  assert.equal(evidence.handshakeCompleted, true);
  assert.ok(evidence.checks.some((check) => /protocolVersion THREW/.test(check.name)),
    "the throwing member must be recorded by name");

  // And the gate admits it at TLS 1.3, because SSLVersionUsed answered even though
  // the security info's copy of the version did not.
  const verdict = Email.assertUsableTLS(evidence);
  assert.equal(verdict.protocol, "TLS 1.3");
  assert.equal(verdict.verifiedBy, "resolved TLS session");
});

test("the connection test plan transmits no message and refuses a server without STARTTLS", () => {
  const implicit = Email.buildConnectionTestPlan({ config: smtpConfig({ tlsMode: "implicit" }) });
  assert.deepEqual(implicit.steps, ["greeting", "ehlo", "auth", "quit"]);
  assert.equal(implicit.transmitsMessage, false);
  assert.equal(implicit.security, "ssl");
  assert.deepEqual(implicit.commands, []);
  assert.equal(implicit.commands, Email.CONNECTION_TEST_COMMANDS);
  assert.equal(Email.assertNoMessageTransmission(implicit.steps), true);

  const upgraded = Email.buildConnectionTestPlan({ config: smtpConfig({ tlsMode: "starttls" }) });
  assert.deepEqual(upgraded.steps, ["greeting", "ehlo", "starttls", "auth", "quit"]);
  assert.equal(upgraded.security, "starttls");
  assert.equal(upgraded.transmitsMessage, false);
  assert.equal(Email.assertNoMessageTransmission(upgraded.steps), true);

  for (const plan of [implicit, upgraded]) {
    for (const step of ["mailFrom", "rcptTo", "data", "body"]) {
      assert.equal(plan.steps.includes(step), false, "a connection test must not include " + step);
    }
  }
  for (const step of ["mailFrom", "rcptTo", "data", "body"]) {
    assert.throws(
      () => Email.assertNoMessageTransmission([...implicit.steps, step]),
      new RegExp("found: " + step),
      step,
    );
  }
  assert.equal(Email.assertNoMessageTransmission(null), true);

  assert.throws(
    () => Email.buildConnectionTestPlan({
      config: smtpConfig({ tlsMode: "starttls" }),
      capabilities: { supportsStartTLS: false },
    }),
    /does not advertise STARTTLS/,
  );
  // A server that did advertise STARTTLS is allowed to be tested.
  assert.equal(
    Email.buildConnectionTestPlan({
      config: smtpConfig({ tlsMode: "starttls" }),
      capabilities: { supportsStartTLS: true },
    }).steps.includes("starttls"),
    true,
  );
  // An implicit-TLS connection never needs the STARTTLS capability at all.
  assert.equal(
    Email.buildConnectionTestPlan({
      config: smtpConfig({ tlsMode: "implicit" }),
      capabilities: { supportsStartTLS: false },
    }).security,
    "ssl",
  );
});

// ---------------------------------------------------------------------------
// Outcome recording
// ---------------------------------------------------------------------------

test("recordDeliveryOutcome records accepted, unknown, and provably-unsent retryable outcomes", () => {
  const accepted = Email.recordDeliveryOutcome(
    { attempts: 0, status: "submitting", messageSubmitted: false },
    { accepted: true, retryable: false, state: "accepted", messageSubmitted: true },
    { now: 500 },
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.attempts, 1);
  assert.equal(accepted.acceptedAt, 500);
  assert.equal(accepted.nextAttemptAt, null);
  assert.equal(accepted.serverAccepted, true);
  assert.equal(accepted.messageSubmitted, true);
  assert.equal(accepted.lastError, "");

  const unknown = Email.recordDeliveryOutcome(
    { attempts: 1, status: "submitting" },
    { accepted: false, state: "unknown", messageSubmitted: true, error: "The SMTP connection closed before a complete reply arrived" },
    { now: 600 },
  );
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.attempts, 2);
  assert.equal(unknown.messageSubmitted, true);
  assert.equal(unknown.nextAttemptAt, null);
  assert.equal(unknown.failedAt, 600);
  assert.match(unknown.lastError, /closed before a complete reply/);

  const retryable = Email.recordDeliveryOutcome(
    { attempts: 0, status: "submitting" },
    { accepted: false, retryable: true, state: "retryable", messageSubmitted: false, error: "450 greylisted" },
    { now: 700 },
  );
  assert.equal(retryable.status, "retryable");
  assert.equal(retryable.messageSubmitted, false);
  assert.equal(retryable.nextAttemptAt, null);
  assert.equal(Email.retryDelayMilliseconds(), null, "there is no automatic SMTP retry schedule");

  const failed = Email.recordDeliveryOutcome(
    { attempts: 0 },
    { accepted: false, retryable: false, state: "failed", messageSubmitted: false, error: "550 no such user" },
    { now: 750 },
  );
  assert.equal(failed.status, "failed");
  assert.match(failed.lastError, /550 no such user/);

  // CRITICAL: a result that may already have reached the server is NEVER
  // retryable, whatever the outcome object claims.
  const claimedRetryable = Email.recordDeliveryOutcome(
    { attempts: 0 },
    { accepted: false, retryable: true, messageSubmitted: true, error: "450 greylisted" },
    { now: 800 },
  );
  assert.notEqual(claimedRetryable.status, "retryable");
  assert.equal(claimedRetryable.status, "failed");
  assert.equal(claimedRetryable.messageSubmitted, true);

  const unknownAndRetryable = Email.recordDeliveryOutcome(
    { attempts: 0 },
    { accepted: false, retryable: true, state: "unknown", messageSubmitted: true, error: "socket timeout" },
    { now: 900 },
  );
  assert.equal(unknownAndRetryable.status, "unknown");
  assert.notEqual(unknownAndRetryable.status, "retryable");

  const missing = Email.recordDeliveryOutcome(
    { attempts: 0 },
    { accepted: false, retryable: true, state: "unknown", messageSubmitted: false },
    { now: 1000 },
  );
  assert.equal(missing.status, "unknown");
  assert.equal(missing.lastError, "The SMTP outcome is unknown");
});

test("classifySMTPError separates permanent, transient, and uncertain outcomes", () => {
  const permanent = Email.classifySMTPError(smtpError(550, "550 5.1.1 No such user here"), { phase: "rcptTo" });
  assert.equal(permanent.state, "failed");
  assert.equal(permanent.retryable, false);
  assert.equal(permanent.accepted, false);
  assert.equal(permanent.code, 550);
  assert.equal(permanent.messageSubmitted, false);

  const transient = Email.classifySMTPError(smtpError(450, "450 4.7.1 Greylisted"), { phase: "rcptTo" });
  assert.equal(transient.state, "retryable");
  assert.equal(transient.retryable, true);
  assert.equal(transient.messageSubmitted, false);
  assert.equal(transient.code, 450);

  // The same transient reply after the terminating dot is uncertainty, not a
  // safe retry.
  const afterDot = Email.classifySMTPError(smtpError(450, "450 4.7.1 Greylisted", "body"), {
    phase: "body",
    messageSubmitted: true,
  });
  assert.equal(afterDot.state, "unknown");
  assert.equal(afterDot.retryable, false);
  assert.equal(afterDot.messageSubmitted, true);
  assert.match(afterDot.error, /delivery is unknown/);

  const noReply = Email.classifySMTPError(new Error("The SMTP connection closed before a complete reply arrived"));
  assert.equal(noReply.state, "retryable");
  assert.equal(noReply.retryable, true);
  assert.equal(noReply.code, 0);
  assert.equal(noReply.messageSubmitted, false);

  const noReplySubmitted = Email.classifySMTPError(new Error("socket timeout"), { messageSubmitted: true });
  assert.equal(noReplySubmitted.state, "unknown");
  assert.equal(noReplySubmitted.retryable, false);
  assert.match(noReplySubmitted.error, /delivery is unknown/);

  // A positive reply to the wrong command is a protocol error: not retryable.
  const protocolError = Email.classifySMTPError(smtpError(250, "250 unexpected for this phase"), { phase: "data" });
  assert.equal(protocolError.state, "failed");
  assert.equal(protocolError.retryable, false);

  let thrown = null;
  try {
    Email.requireReply("rcptTo", "550 5.1.1 No such user here" + CRLF);
  } catch (error) {
    thrown = error;
  }
  const fromRequireReply = Email.classifySMTPError(thrown, { phase: "rcptTo" });
  assert.equal(fromRequireReply.code, 550);
  assert.equal(fromRequireReply.state, "failed");
  assert.equal(fromRequireReply.retryable, false);
});

// ---------------------------------------------------------------------------
// Frozen payload identity
// ---------------------------------------------------------------------------

test("makeSubmissionKey and payloadHash are deterministic, bounded, and payload-sensitive", () => {
  const payload = {
    from: "FeedRank <digest@example.test>",
    to: "reader@example.test",
    subject: Email.DIGEST_SUBJECT,
    text: "digest text",
    html: "<p>digest text</p>",
    message: "MIME-Version: 1.0" + CRLF,
  };
  const args = { date: "2026-09-30", runID: "10:ABC123/private-run", payload };
  const first = Email.makeSubmissionKey(args);
  assert.equal(first, Email.makeSubmissionKey({ ...args }));
  assert.match(first, /^feedrank-smtp\/2026-09-30\/[a-f0-9]{8}\/[a-f0-9]{8}$/);
  assert.ok(first.length <= 256);
  assert.doesNotMatch(first, /ABC123/, "the raw run identifier must not be embedded in the key");
  assert.equal(Email.payloadHash(payload), Email.payloadHash({ ...payload }));

  for (const field of ["from", "to", "subject", "text", "html", "message"]) {
    const changed = { ...payload, [field]: payload[field] + " changed" };
    assert.notEqual(Email.makeSubmissionKey({ ...args, payload: changed }), first, field + " must change the key");
    assert.notEqual(Email.payloadHash(changed), Email.payloadHash(payload), field + " must change the hash");
  }
  assert.notEqual(Email.makeSubmissionKey({ ...args, date: "2026-10-01" }), first);
  assert.notEqual(Email.makeSubmissionKey({ ...args, runID: "another-run" }), first);
  assert.throws(() => Email.makeSubmissionKey({ ...args, date: "30/09/2026" }), /YYYY-MM-DD/);
  assert.throws(() => Email.makeSubmissionKey({ ...args, runID: "   " }), /scoring-run identifier/);
  assert.equal(Email.makeSubmissionKey({ ...args, runID: "r".repeat(4000) }).length, first.length);

  const state = Email.createDeliveryState({ date: "2026-09-30", runID: "10:ABC123/private-run", payload, now: 1000 });
  assert.equal(state.submissionKey, first);
  assert.equal(state.payloadHash, Email.payloadHash(payload));
  assert.equal(state.status, "prepared");
  assert.equal(state.attempts, 0);
  assert.equal(state.serverAccepted, false);
  assert.doesNotMatch(JSON.stringify(state), /ABC123|reader@example/);
});

// ---------------------------------------------------------------------------
// Socket construction
//
// These calls are invisible offline: a mocked socket never exercises them, so
// two real defects reached the running add-on and only surfaced as a one-line
// XPCOM error in the live Test connection result:
//   "Not enough arguments [nsISocketTransportService.createTransport]"
// and a non-blocking input stream (read() would raise WOULD_BLOCK instead of
// waiting). Both are pinned down here against a fake XPCOM environment.
// ---------------------------------------------------------------------------

// A fake Cc/Ci that records exactly how the transport was constructed.
function fakeComponents({ failCreate = false, scriptable = true } = {}) {
  const calls = {
    createTransport: [], openInputStream: [], openOutputStream: [], timeouts: [],
    scriptableInit: [], createInstance: [],
  };
  // The raw socket stream deliberately has NO scriptable read method, exactly
  // like the real nsIInputStream that openInputStream() returns.
  const rawInput = { close() {} };
  const scriptableInput = {
    init(stream) { calls.scriptableInit.push(stream); },
    available: () => 0,
    read: () => "",
    close() {},
  };
  const transport = {
    setTimeout(type, seconds) { calls.timeouts.push([type, seconds]); },
    openInputStream(...args) {
      calls.openInputStream.push(args);
      return rawInput;
    },
    openOutputStream(...args) {
      calls.openOutputStream.push(args);
      return { write() {}, flush() {}, close() {} };
    },
    close() {},
  };
  const service = {
    createTransport(...args) {
      calls.createTransport.push(args);
      if (failCreate) throw new Error("createTransport refused");
      return transport;
    },
  };
  const classes = {
    "@mozilla.org/network/socket-transport-service;1": { getService: () => service },
    "@mozilla.org/scriptableinputstream;1": {
      createInstance() {
        calls.createInstance.push("scriptableinputstream");
        return scriptable ? scriptableInput : null;
      },
    },
  };
  const interfaces = new Proxy({
    nsISocketTransportService: {},
    nsIScriptableInputStream: {},
    nsIBinaryOutputStream: {},
    nsITimer: {},
  }, {
    get(target, key) {
      // Any interface the transport asks for is considered available.
      return key in target ? target[key] : {};
    },
  });
  return { calls, rawInput, scriptableInput, Components: { classes, interfaces } };
}

test("createTransport is called with the full 5-argument arity this Gecko requires", () => {
  // nsISocketTransportService.createTransport gained `aDnsRecord` as a fifth
  // parameter; passing four raises "Not enough arguments" at call time. The
  // service is C++-implemented, so there is no JS default to fall back on.
  const { calls, Components } = fakeComponents();
  const connection = SMTP.createSocketConnection({
    Components,
    host: "smtp.example.test",
    port: 587,
    security: "starttls",
  });
  connection.open();

  assert.equal(calls.createTransport.length, 1);
  const args = calls.createTransport[0];
  assert.equal(args.length, 5, "createTransport must receive exactly 5 arguments");
  assert.deepEqual(args[0], ["starttls"], "the socket type selects the TLS provider");
  assert.equal(args[1], "smtp.example.test");
  assert.equal(args[2], 587);
  assert.equal(args[3], null, "no proxy");
  assert.equal(args[4], null, "no pre-resolved DNS record");
  // The security provider is always one of Gecko's two TLS providers.
  assert.ok(["starttls", "ssl"].includes(args[0][0]));
});

test("the input stream is opened BLOCKING so read() waits instead of raising WOULD_BLOCK", () => {
  // nsITransport.OPEN_BLOCKING is 1 << 0. Opening with flags 0 yields a
  // non-blocking stream whose read() returns NS_BASE_STREAM_WOULD_BLOCK rather
  // than waiting for the server, which breaks the whole reply loop.
  assert.equal(SMTP.OPEN_BLOCKING, 1);
  const { calls, Components } = fakeComponents();
  const connection = SMTP.createSocketConnection({
    Components,
    host: "smtp.example.test",
    port: 465,
    security: "ssl",
  });
  connection.open();

  assert.equal(calls.openInputStream.length, 1);
  const inputFlags = calls.openInputStream[0][0];
  assert.equal(inputFlags & SMTP.OPEN_BLOCKING, SMTP.OPEN_BLOCKING,
    "the read stream must be opened with OPEN_BLOCKING");
  assert.equal(calls.openInputStream[0].length, 3, "openInputStream takes flags, segmentSize, segmentCount");
  assert.equal(calls.openOutputStream[0].length, 3, "openOutputStream takes flags, segmentSize, segmentCount");
  // Both socket timeouts are set, which is what bounds a stalled peer.
  assert.deepEqual(calls.timeouts.map((entry) => entry[0]), [SMTP.TIMEOUT_CONNECT, SMTP.TIMEOUT_READ_WRITE]);
  assert.ok(calls.timeouts.every((entry) => Number.isInteger(entry[1]) && entry[1] > 0));
});

test("the raw socket stream is wrapped in nsIScriptableInputStream before any read", () => {
  // openInputStream() returns a bare nsIInputStream, which has no scriptable
  // read()/available(). Without the wrapper the very first reply read fails with
  // "The SMTP input stream is not readable", which is exactly what happened on
  // the first live run against a real server.
  const { calls, rawInput, Components } = fakeComponents();
  const connection = SMTP.createSocketConnection({
    Components,
    host: "smtp.example.test",
    port: 587,
    security: "starttls",
  });
  connection.open();

  assert.deepEqual(calls.createInstance, ["scriptableinputstream"],
    "the scriptable wrapper must be instantiated");
  assert.equal(calls.scriptableInit.length, 1, "it must be initialised exactly once");
  assert.equal(calls.scriptableInit[0], rawInput,
    "it must wrap the stream openInputStream() actually returned");
  // The exposed input stream must be the wrapper, not the raw stream.
  assert.equal(connection.input, calls.scriptableInit[0] ? connection.input : null);
  assert.notEqual(connection.input, rawInput, "the raw stream must not be exposed as the reader");

  // readChunk() must report "nothing yet" distinctly from end of stream: the
  // socket layer is polled, and conflating the two is what produced
  // "the SMTP connection ended before a complete reply arrived" live.
  const idle = connection.readChunk();
  assert.deepEqual(idle, { data: "", eof: false },
    "an idle stream is not end of stream");
  connection.close();
});

test("readReplyText waits for a slow reply instead of treating it as EOF", async () => {
  // A server that answers in two chunks after a delay is the normal case: the
  // first poll sees nothing buffered. That must not be mistaken for a closed
  // connection, and the wait must be asynchronous so Zotero's main thread is not
  // stalled while it happens.
  // TCP may deliver a reply across several reads, with idle gaps between them.
  // The first chunk has no line terminator, so it is provably not a complete
  // reply; after it, the stream reports "nothing buffered yet" twice before the
  // remainder arrives. A reader that treats an empty poll as EOF gives up there
  // instead of waiting — which is the live bug this pins down.
  const first = "250-smtp.example.test\r\n250-AUTH LOGIN ";
  const second = "\r\n250 SIZE 100\r\n";
  let reads = 0;
  let idlePolls = 0;
  const stream = {
    available() {
      if (reads === 0) return first.length;
      if (idlePolls < 2) { idlePolls++; return 0; }
      return second.length;
    },
    read(count) {
      reads++;
      // The idle polls must not consume the outstanding chunk.
      if (reads === 1) return first.slice(0, count);
      return second.slice(0, count);
    },
    close() {},
  };
  const waits = [];
  const socket = {
    security: "ssl",
    input: stream,
    buffer: "",
    ioTimeoutMs: 5000,
    delay: (ms) => { waits.push(ms); return Promise.resolve(); },
    readChunk: SMTP.SMTPSocketConnection.prototype.readChunk,
  };
  // The premise: neither chunk on its own is a complete reply.
  assert.equal(SMTP.lastLineCompletesReply(first), false);
  assert.equal(SMTP.lastLineCompletesReply(second), false);
  // And an idle poll must be distinguishable from end of stream.
  assert.deepEqual(socket.readChunk.call({ input: { available: () => 0, read: () => "" } }),
    { data: "", eof: false });

  // Drive the real implementation with the fake stream attached.
  const text = await SMTP.SMTPSocketConnection.prototype.readReplyText.call(socket);
  assert.equal(text, first + second, "the full multi-chunk reply must be assembled");
  assert.ok(waits.length >= 1, "it must wait for the outstanding chunk rather than give up");
  assert.equal(idlePolls, 2, "both idle polls must have been waited out");
});

test("readReplyText fails closed when a reply never completes", async () => {
  const socket = {
    security: "ssl",
    // Never yields a complete reply, and always reports nothing buffered.
    input: { available: () => 0, read: () => "", close() {} },
    buffer: "",
    ioTimeoutMs: 60,
    delay: () => new Promise((resolve) => setTimeout(resolve, 10)),
    readChunk: SMTP.SMTPSocketConnection.prototype.readChunk,
  };
  await assert.rejects(
    () => SMTP.SMTPSocketConnection.prototype.readReplyText.call(socket),
    /did not finish its reply within|ended before a complete reply/,
  );
});

test("a build without nsIScriptableInputStream fails closed instead of reading blindly", () => {
  const { Components } = fakeComponents({ scriptable: false });
  const connection = SMTP.createSocketConnection({
    Components,
    host: "smtp.example.test",
    port: 587,
    security: "starttls",
  });
  assert.throws(() => connection.open(), /nsIScriptableInputStream is unavailable|Could not connect/);
});

test("an unreadable security record after STARTTLS is not read as 'not encrypted'", async () => {
  // The live shape, verbatim:
  //   securityInfo = [unprintable]   (a throwing getter)
  //   SSLVersionUsed = -1
  //   socket.handshakeCompleted = true
  //   evidence: encrypted = false, securityInfoPresent = false
  //   failure: "Refusing to send SMTP credentials: the connection is not encrypted"
  //
  // The transport defaulted `encrypted` to FALSE and never changed it, because the
  // security record was not readable in the window after the handshake resolved.
  // That default was then read as a deliberate negative verdict, which bypassed
  // the handshake fallback and refused a working Outlook connection.
  const SMTP = require("../chrome/content/email-smtp.js");
  // `securityInfo` itself raised, which is why the report showed `[unprintable]`
  // and `securityInfoPresent = false`: the transport got no record at all.
  const control = {
    asyncStartTLS: async () => undefined,
    SSLVersionUsed: -1,
    failedVerification: false,
  };
  Object.defineProperty(control, "securityInfo", {
    enumerable: true,
    get() { throw new Error("Component returned failure code: 0x80040111 (NS_ERROR_NOT_AVAILABLE)"); },
  });
  const connection = Object.assign(Object.create(SMTP.SMTPSocketConnection.prototype), {
    // `Email` is what the socket uses to record the gate's verdict for the
    // diagnostic; the real service passes it in openSocket().
    Email,
    security: "starttls", host: "smtp-mail.outlook.com", port: 587, tlsStarted: false,
    handshakeCompleted: false, settledSecurityInfo: null, buffer: "",
    evaluatedChecks: [], transport: { tlsSocketControl: control },
  });

  const evidence = await connection.startTLS();
  assert.equal(evidence.handshakeCompleted, true, "the handshake did resolve");
  assert.equal(evidence.sslVersionUsed, -1);
  // The crucial distinction: UNKNOWN, not false.
  assert.notEqual(evidence.encrypted, false, "an unreadable record is not a negative verdict");
  assert.equal(evidence.encrypted, null);
  assert.equal(evidence.verifiedBy, "completed-handshake");

  // And the gate admits it, reporting the session as encrypted but unconfirmed.
  const verdict = Email.assertUsableTLS(evidence);
  assert.equal(verdict.verifiedBy, "completed-handshake");
  assert.equal(verdict.protocolConfirmed, false);

  // describeSecurity() is idempotent, so a report built after the failure cannot
  // contradict the decision that was made.
  assert.deepEqual(connection.describeSecurity(), { ...evidence, checks: connection.evaluatedChecks });

  // The one shape that must still be refused: STARTTLS with no handshake and
  // nothing readable at all.
  const nothing = Object.assign(Object.create(SMTP.SMTPSocketConnection.prototype), {
    security: "starttls", host: "h", port: 587, tlsStarted: false,
    handshakeCompleted: false, settledSecurityInfo: null, buffer: "",
    evaluatedChecks: [], transport: { tlsSocketControl: { SSLVersionUsed: -1, securityInfo: null } },
  });
  assert.throws(() => Email.assertUsableTLS(nothing.describeSecurity()), /not encrypted/);
});

test("a new STARTTLS socket does not cache a pre-handshake negative TLS verdict", async () => {
  // This uses the real constructor, unlike the prototype-only fixtures above.
  // It guards against initializing the evidence cache with `encrypted: false`:
  // that value would be returned after asyncStartTLS() without reading the
  // completed handshake and would prevent any authentication attempt.
  const control = {
    asyncStartTLS: async () => undefined,
    SSLVersionUsed: -1,
    failedVerification: false,
  };
  Object.defineProperty(control, "securityInfo", {
    enumerable: true,
    get() { throw new Error("NS_ERROR_NOT_AVAILABLE"); },
  });
  const connection = SMTP.createSocketConnection({
    Components: {},
    Email,
    host: "smtp.example.test",
    port: 587,
    security: "starttls",
  });
  connection.transport = { tlsSocketControl: control };

  const evidence = await connection.startTLS();
  assert.equal(evidence.handshakeCompleted, true);
  assert.notEqual(evidence.encrypted, false);
  assert.ok(evidence.checks.length > 0, "the socket must record observed TLS reads");
  assert.equal(Email.assertUsableTLS(evidence).verifiedBy, "completed-handshake");
});

test("connection diagnostics summarize parsed EHLO capabilities", async () => {
  const replies = [
    "220 smtp.example.test ready\r\n",
    "250-smtp.example.test\r\n250-STARTTLS\r\n250 AUTH LOGIN\r\n",
    "220 Ready to start TLS\r\n",
    "250-smtp.example.test\r\n250-STARTTLS\r\n250 AUTH LOGIN\r\n",
    "334 VXNlcm5hbWU6\r\n",
    "334 UGFzc3dvcmQ6\r\n",
    "235 2.7.0 Accepted\r\n",
    "221 2.0.0 Bye\r\n",
  ];
  const evidence = usableTLS({ handshakeCompleted: true });
  const writes = [];
  const socket = {
    security: "starttls",
    transport: null,
    write(value) { writes.push(String(value)); },
    async readReplyText() {
      const reply = replies.shift();
      if (reply == null) throw new Error("test peer ran out of replies");
      return reply;
    },
    async startTLS() { return { ...evidence }; },
    describeSecurity() { return { ...evidence }; },
    tlsControl() { return null; },
    close() {},
  };
  const secret = "test-only-secret";
  const Diagnostics = {
    buildReport(_sources, context) { return JSON.stringify(context); },
    assertNoSecret(report, secrets) {
      for (const value of secrets) assert.equal(report.includes(value), false);
      return report;
    },
  };

  const result = await SMTP.runConnectionTest({
    Email,
    socket,
    credentials: { ...smtpConfig({ port: 587, tlsMode: "starttls" }), secret },
    Diagnostics,
  });
  assert.equal(result.ok, true);
  assert.match(result.diagnostics, /STARTTLS/);
  assert.match(result.diagnostics, /AUTH/);
  assert.doesNotMatch(result.diagnostics, new RegExp(secret));
  assert.ok(writes.every((line) => !/^MAIL FROM|^RCPT TO|^DATA\r?$/i.test(line)));
});

test("a credential rejection explains itself instead of only quoting the server code", () => {
  // The live failure: "535 5.7.3 Authentication unsuccessful [SL2P216CA...]". The
  // correlation id in that reply is the only part previously surfaced, and it
  // tells the user nothing they can act on.
  const rejection = new Error("SMTP authentication failed with 535 5.7.3 Authentication unsuccessful [SL2P216CA0098]");
  rejection.smtpCode = 535;
  rejection.smtpPhase = "auth";
  const classified = Email.classifySMTPError(rejection);
  assert.equal(classified.state, "failed");
  assert.equal(classified.retryable, false, "a rejected password is not retryable");
  assert.match(classified.error, /535/);
  assert.match(classified.error, /app password/);
  assert.match(classified.error, /officially permits/);
  const microsoft = Email.classifySMTPError(rejection, { authMethod: "login", host: "smtp-mail.outlook.com" });
  assert.match(microsoft.error, /OAuth2\/Modern Authentication/);
  assert.doesNotMatch(microsoft.error, /create an app password/);

  // An XOAUTH2 rejection gets the token explanation instead of the password one.
  const token = Email.classifySMTPError(rejection, { authMethod: "xoauth2" });
  assert.match(token.error, /access token/);
  assert.match(token.error, /SMTP\.Send|expired/);
  assert.doesNotMatch(token.error, /app password/);

  // The hint is specific to 535 and never invented for another code.
  assert.equal(Email.authenticationHint(535, "login").length > 0, true);
  assert.equal(Email.authenticationHint(534, "login"), "");
  assert.equal(Email.authenticationHint(0, "login"), "");

  // A server sentence, when the transport captured one, is included rather than
  // discarded. This is where a provider states that SMTP AUTH is disabled.
  const withReply = new Error("SMTP authentication failed with 535");
  withReply.smtpCode = 535;
  withReply.feedRankServerReply = "535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled";
  const detailed = Email.classifySMTPError(withReply);
  assert.match(detailed.error, /SmtpClientAuthentication is disabled/);
  // And it is not duplicated when the summary already contains it.
  const already = Email.classifySMTPError(Object.assign(new Error("535 SmtpClientAuthentication is disabled"), {
    smtpCode: 535,
    feedRankServerReply: "535 SmtpClientAuthentication is disabled",
  }));
  assert.equal((already.error.match(/SmtpClientAuthentication is disabled/g) || []).length, 1);
});

test("a transport that cannot be constructed fails closed without a plaintext fallback", () => {
  const { calls, Components } = fakeComponents({ failCreate: true });
  const connection = SMTP.createSocketConnection({
    Components,
    host: "smtp.example.test",
    port: 587,
    security: "starttls",
  });
  assert.throws(() => connection.open(), /createTransport refused|Could not connect/);
  // It must never retry with a weaker socket type.
  assert.equal(calls.createTransport.length, 1);
  assert.deepEqual(calls.createTransport[0][0], ["starttls"]);
  // A non-TLS socket type is refused before any XPCOM call.
  assert.throws(
    () => SMTP.createSocketConnection({
      Components, host: "smtp.example.test", port: 25, security: "plain",
    }),
    /refuses to open a non-TLS SMTP socket/,
  );
});

test("unstarted STARTTLS diagnostics never claim encryption from an empty error record", () => {
  const info = { securityState: 0, failedCertChain: [], errorCodeString: "" };
  Object.defineProperty(info, "protocolVersion", { get() { throw new Error("NS_ERROR_NOT_AVAILABLE"); } });
  const socket = SMTP.createSocketConnection({ Components: {}, Email, host: "smtp.example.test", port: 994, security: "starttls" });
  socket.transport = { tlsSocketControl: { SSLVersionUsed: -1, failedVerification: false, securityInfo: info } };
  const evidence = socket.describeSecurity();
  assert.equal(evidence.encrypted, false);
  assert.equal(evidence.handshakeCompleted, false);
  assert.equal(evidence.verifiedBy, "REFUSED");
  assert.match(evidence.encryptionEvidence, /STARTTLS has not started/);
  assert.doesNotMatch(evidence.protocolNote, /still encrypted/);
  assert.equal(evidence.checks.find((check) => check.name === "SSLVersionUsed").value, -1);
  assert.throws(() => Email.assertUsableTLS(evidence), /not encrypted/);
});

test("native TLS verification refreshes the early STARTTLS snapshot before AUTH", async () => {
  const info = { securityState: 0, failedCertChain: [], errorCodeString: "" };
  const control = { SSLVersionUsed: -1, failedVerification: false, securityInfo: info,
    asyncStartTLS: async () => {}, asyncGetSecurityInfo: async () => ({ ...info }) };
  const socket = SMTP.createSocketConnection({ Components: {}, Email, host: "smtp.example.test", port: 587, security: "starttls" });
  socket.transport = { tlsSocketControl: control };
  socket.describeSecurity(); // Pre-upgrade diagnostic must not poison the cache.
  await socket.startTLS();
  await assert.rejects(socket.verifyTLS(), /negotiated TLS 1.2 or 1.3 session could not be verified/);
  control.SSLVersionUsed = 772;
  Object.assign(info, { securityState: 2, protocolVersion: 4, cipherName: "TLS_AES_128_GCM_SHA256" });
  const verdict = await socket.verifyTLS();
  assert.equal(verdict.protocol, "TLS 1.3");
  assert.equal(verdict.protocolConfirmed, true);
  assert.equal(socket.describeSecurity().sslVersionUsed, 772);
  assert.equal(socket.describeSecurity().checks.find((entry) => entry.name === "securityState").value, 2);
});

test("native implicit TLS verification refuses missing or broken security before credentials", async () => {
  const info = { securityState: 0, failedCertChain: [], errorCodeString: "" };
  const control = { SSLVersionUsed: -1, failedVerification: false, securityInfo: info };
  const socket = SMTP.createSocketConnection({ Components: {}, Email, host: "smtp.example.test", port: 994, security: "ssl" });
  socket.transport = { tlsSocketControl: control };
  await assert.rejects(socket.verifyTLS(), /Refusing to send SMTP credentials/);
  control.SSLVersionUsed = 772;
  Object.assign(info, { securityState: 3, protocolVersion: 4 }); // secure + broken
  await assert.rejects(socket.verifyTLS(), /reports an error/);
  info.securityState = 2;
  assert.equal((await socket.verifyTLS()).protocol, "TLS 1.3");
});

test("a greeting failure explains implicit TLS and sends no AUTH or message", async () => {
  const writes = [];
  const socket = { security: "starttls", write(value) { writes.push(value); },
    async readReplyText() { throw new Error("The SMTP connection ended before a complete reply arrived"); },
    describeSecurity() { return { encrypted: false }; }, tlsControl() { return null; }, close() {} };
  await assert.rejects(SMTP.runConnectionTest({ Email, socket,
    credentials: { ...smtpConfig({ host: "smtp.example.test", port: 994, tlsMode: "starttls", authMethod: "login" }), secret: "mock-only" } }),
    /No authentication was attempted.*Implicit TLS/);
  assert.deepEqual(writes, []);
});

test("SMTP negotiation never crosses password and OAuth credential families", () => {
  const choose = (configured, authMechanisms) => SMTP.resolveAuthMethod({ Email, configured, capabilities: { authMechanisms } });
  assert.equal(choose("plain", ["LOGIN", "XOAUTH2"]).method, "login");
  assert.equal(choose("login", ["PLAIN"]).method, "plain");
  assert.equal(choose("plain", ["XOAUTH2"]).method, "plain");
  assert.equal(choose("xoauth2", ["LOGIN", "PLAIN"]).method, "xoauth2");
});

test("native STARTTLS refuses AUTH until the post-upgrade session version is confirmed", async () => {
  for (const confirmed of [false, true]) {
    const info = { securityState: 0, failedCertChain: [], errorCodeString: "" };
    const control = { SSLVersionUsed: -1, failedVerification: false, securityInfo: info,
      asyncStartTLS: async () => {}, asyncGetSecurityInfo: async () => ({ ...info }) };
    const socket = SMTP.createSocketConnection({ Components: {}, Email, host: "smtp.example.test", port: 587, security: "starttls" });
    socket.transport = { tlsSocketControl: control };
    const writes = [];
    const replies = ["220 Ready\r\n", "250-test\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n",
      "220 Upgrade\r\n", "250-test\r\n250 AUTH PLAIN\r\n", "235 Accepted\r\n", "221 Bye\r\n"];
    socket.write = (value) => writes.push(value);
    socket.readReplyText = async () => {
      if (confirmed && replies.length === 3) {
        control.SSLVersionUsed = 772;
        Object.assign(info, { securityState: 2, protocolVersion: 4 });
      }
      return replies.shift();
    };
    const run = SMTP.runConnectionTest({ Email, socket,
      credentials: { ...smtpConfig({ port: 587, tlsMode: "starttls" }), secret: "offline-only" } });
    if (confirmed) {
      assert.equal((await run).protocol, "TLS 1.3");
      assert.equal(writes.filter((line) => line.startsWith("AUTH ")).length, 1);
    } else {
      await assert.rejects(run, /negotiated TLS 1.2 or 1.3 session could not be verified/);
      assert.equal(writes.some((line) => line.startsWith("AUTH ")), false);
    }
    assert.equal(writes.some((line) => /^(MAIL FROM|RCPT TO|DATA)/.test(line)), false);
  }
});

// A reactive SMTP peer, not a canned reply sequence. It understands BOTH
// legal LOGIN forms. If the client supplies an initial username, its next
// challenge is Password:, so repeating the username really produces 535.
function reactiveLoginPeer({ username, secret, rejectAt = "" }) {
  let stage = "ready";
  const replies = ["220 mock.example.test ready\r\n"];
  const writes = [];
  return {
    security: "ssl", writes, transport: null,
    describeSecurity: () => usableTLS(), tlsControl: () => null, close() {},
    async readReplyText() {
      assert.ok(replies.length, "mock server must have a reply for the actual wire command");
      return replies.shift();
    },
    write(line) {
      writes.push(line);
      if (line.startsWith("EHLO ")) { replies.push("250-mock.example.test\r\n250 AUTH LOGIN\r\n"); return; }
      if (line === "QUIT\r\n") { replies.push("221 Bye\r\n"); return; }
      const auth = line.match(/^AUTH LOGIN(?: ([A-Za-z0-9+/=]+))?\r\n$/);
      if (auth) {
        if (rejectAt === "command") { replies.push("535 Authentication disabled\r\n"); return; }
        if (auth[1]) {
          assert.equal(Buffer.from(auth[1], "base64").toString("utf8"), username);
          stage = "secret";
          replies.push("334 UGFzc3dvcmQ6\r\n");
        } else {
          stage = "username";
          replies.push("334 VXNlcm5hbWU6\r\n");
        }
        return;
      }
      assert.ok(stage === "username" || stage === "secret", "unexpected SMTP command: " + line);
      const value = Buffer.from(line.trim(), "base64").toString("utf8");
      if (stage === "username") {
        if (value !== username || rejectAt === "username") {
          replies.push("535 Invalid username\r\n"); stage = "rejected";
        } else { replies.push("334 UGFzc3dvcmQ6\r\n"); stage = "secret"; }
      } else {
        const accepted = value === secret && rejectAt !== "secret";
        replies.push(accepted ? "235 Authentication successful\r\n" : "535 Authentication failed\r\n");
        stage = accepted ? "accepted" : "rejected";
      }
    },
  };
}

test("LOGIN regression: reactive initial-response-aware server rejects the old duplicate username but accepts FeedRank's corrected exchange", async () => {
  const username = "mock@example.test";
  const secret = "offline-only-credential";
  const legacy = reactiveLoginPeer({ username, secret });
  await legacy.readReplyText();
  legacy.write("AUTH LOGIN " + base64(username) + CRLF);
  assert.equal(await legacy.readReplyText(), "334 UGFzc3dvcmQ6\r\n");
  legacy.write(base64(username) + CRLF);
  assert.equal(await legacy.readReplyText(), "535 Authentication failed\r\n");

  const corrected = reactiveLoginPeer({ username, secret });
  const result = await SMTP.runConnectionTest({ Email, socket: corrected,
    credentials: { ...smtpConfig({ username, authMethod: "login" }), secret } });
  assert.equal(result.ok, true);
  assert.equal(result.authStage, "accepted");
  assert.deepEqual(corrected.writes.slice(1, 4), ["AUTH LOGIN\r\n", base64(username) + CRLF, base64(secret) + CRLF]);
  assert.equal(corrected.writes.filter((line) => line === base64(username) + CRLF).length, 1);
  assert.equal(corrected.writes.filter((line) => line === base64(secret) + CRLF).length, 1);
  assert.equal(corrected.writes.some((line) => /^(MAIL FROM|RCPT TO|DATA)/.test(line)), false);
});

test("LOGIN rejection diagnostics identify the exact step and never retry or expose credential values", async () => {
  const Diagnostics = require("../chrome/content/diagnostics.js");
  const username = "mock@example.test";
  const secret = "offline-only-credential";
  for (const [rejectAt, expectedStage, wireLines] of [
    ["command", "LOGIN command", 1], ["username", "LOGIN username", 2], ["secret", "LOGIN secret", 3],
  ]) {
    const socket = reactiveLoginPeer({ username, secret, rejectAt });
    let failure;
    try {
      await SMTP.runConnectionTest({ Email, socket, Diagnostics,
        credentials: { ...smtpConfig({ username, authMethod: "login" }), secret } });
    } catch (error) { failure = error; }
    assert.ok(failure);
    assert.equal(failure.smtpCode, 535);
    assert.equal(failure.smtpAuthStage, expectedStage);
    assert.ok(failure.feedRankDiagnostics.includes("authStage = " + expectedStage));
    assert.ok(failure.feedRankDiagnostics.includes(expectedStage + " → 535"));
    assert.equal(failure.feedRankDiagnostics.includes(secret), false);
    assert.equal(failure.feedRankDiagnostics.includes(base64(secret)), false);
    assert.equal(socket.writes.length, 1 + wireLines, "one EHLO and one bounded LOGIN attempt only");
  }
});

test("AUTH transcripts retain no plaintext or base64 credential for LOGIN, PLAIN, or XOAUTH2", async () => {
  const username = "mock@example.test";
  const secret = "offline-only-credential";
  for (const authMethod of ["login", "plain", "xoauth2"]) {
    const socket = authMethod === "login" ? reactiveLoginPeer({ username, secret }) : {
      security: "ssl", describeSecurity: () => usableTLS(), write() {},
      async readReplyText() { return "235 Accepted\r\n"; },
    };
    if (authMethod === "login") await socket.readReplyText();
    const session = new SMTP.SMTPSession({ Email, socket });
    await session.authenticate({ authMethod, username, secret });
    assert.equal(session.authenticationInProgress, false);
    assert.equal(session.authStage, "accepted");
    const trace = JSON.stringify(session.transcript);
    for (const value of [username, secret, base64(username), base64(secret)]) assert.equal(trace.includes(value), false);
    assert.deepEqual(session.authReplies.map((reply) => reply.code), authMethod === "login" ? [334, 334, 235] : [235]);
  }
});

// ---------------------------------------------------------------------------

async function run() {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.run();
      process.stdout.write("✓ " + entry.name + "\n");
    } catch (error) {
      failed++;
      process.stderr.write("✗ " + entry.name + "\n" + error.stack + "\n");
    }
  }
  if (failed) process.exitCode = 1;
  else process.stdout.write("\n" + tests.length + " email-core tests passed.\n");
}

run();
