"use strict";

/*
 * EasyScholar journal-metadata lookup.
 *
 * Replaces the previous Green Frog dependency. Green Frog keeps its journal
 * updates in private bundled closures with no public API, so FeedRank could only
 * ever re-read values another add-on happened to have written. EasyScholar
 * publishes a documented endpoint for per-user keys, so FeedRank can retrieve
 * journal metrics directly, with the user's own credential and the user's own
 * consent, and write nothing into the Zotero item.
 *
 * API CONTRACT (verified 2026-09-30 against two independent clients):
 *   GET https://www.easyscholar.cc/open/getPublicationRank
 *       ?secretKey=<user key>&publicationName=<journal name>
 *   200 application/json with a top-level `code` (200 = success) and `msg`,
 *   and for a hit a `data` object carrying:
 *     data.officialRank.all.<key>      - official metrics (e.g. sciif, jci, esi)
 *     data.officialRank.select.<key>   - the user's own selected systems
 *   The secret key is obtained by the user from their own EasyScholar account
 *   (register -> user centre -> secret key). This module never bundles, guesses,
 *   scrapes, or derives a key, and never reads another add-on's storage.
 *
 * A `code` of 200 with no usable metric is treated as "journal not found",
 * not as success, so the UI can say so plainly.
 */
(function exposeFeedRankerJournal(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.FeedRankerJournal = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createJournalCore() {
  const API_ORIGIN = "https://www.easyscholar.cc";
  const API_PATH = "/open/getPublicationRank";
  // How long one EasyScholar request may take. journal-service.js enforces it with an
// AbortController, because the request no longer goes through Zotero.HTTP's timeout option.
const REQUEST_TIMEOUT_MS = 15000;
  const MAX_PUBLICATION_NAME_LENGTH = 300;
  const MAX_CACHE_ENTRIES = 300;
  const MAX_METRIC_LENGTH = 120;

  // Metrics FeedRank reads, in display order. `select` entries are the systems
  // the user has enabled in their EasyScholar account; `official` entries are
  // always-present official data. A missing key is simply omitted.
  const METRIC_LABELS = Object.freeze([
    Object.freeze({ key: "sciif", from: "official", label: "Impact factor" }),
    Object.freeze({ key: "sciif5", from: "select", label: "5-year impact factor" }),
    Object.freeze({ key: "sci", from: "select", label: "JCR quartile" }),
    Object.freeze({ key: "sciBase", from: "select", label: "CAS zone" }),
    Object.freeze({ key: "sciUp", from: "select", label: "CAS zone (upgraded)" }),
    Object.freeze({ key: "sciUpTop", from: "select", label: "CAS zone TOP" }),
    Object.freeze({ key: "jci", from: "official", label: "JCI" }),
    Object.freeze({ key: "esi", from: "official", label: "ESI subject" }),
    Object.freeze({ key: "eii", from: "official", label: "EI" }),
    Object.freeze({ key: "sciWarning", from: "official", label: "CAS early warning" }),
    Object.freeze({ key: "cssci", from: "official", label: "CSSCI" }),
    Object.freeze({ key: "pku", from: "official", label: "PKU core" }),
    Object.freeze({ key: "cscd", from: "official", label: "CSCD" }),
    Object.freeze({ key: "ccf", from: "official", label: "CCF" }),
    Object.freeze({ key: "abdc", from: "official", label: "ABDC" }),
    Object.freeze({ key: "ajg", from: "official", label: "AJG (ABS)" }),
  ]);

  // The two metrics the local Priority calculation can actually use.
  const IMPACT_FACTOR_KEY = "sciif";
  const FIVE_YEAR_KEY = "sciif5";

  function text(value, maximum = 500) {
    return String(value == null ? "" : value)
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, Math.max(0, maximum));
  }

  function metricValue(value) {
    if (value == null) return "";
    if (typeof value === "number") {
      return Number.isFinite(value) ? String(value) : "";
    }
    return text(value, MAX_METRIC_LENGTH);
  }

  // A user key is an opaque token issued by EasyScholar. Only its shape is
  // validated here; it is never logged, stored in a preference, or echoed into
  // an error message.
  function normalizeSecretKey(value) {
    const key = String(value == null ? "" : value).trim();
    if (!key) throw new Error("Enter your EasyScholar secret key");
    if (key.length < 8 || key.length > 200) {
      throw new Error("That EasyScholar secret key does not look valid");
    }
    if (!/^[A-Za-z0-9._~-]+$/.test(key)) {
      throw new Error("The EasyScholar secret key contains an unsupported character");
    }
    return key;
  }

  function normalizePublicationName(value) {
    const name = text(value, MAX_PUBLICATION_NAME_LENGTH);
    if (!name) throw new Error("This item has no publication title to look up");
    return name;
  }

  // The cache key is the publication name, lowercased and stripped of
  // punctuation, so "Nature" and "nature." share one entry.
  function publicationCacheKey(value) {
    return text(value, MAX_PUBLICATION_NAME_LENGTH)
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
      .trim()
      .slice(0, 200);
  }


  /*
   * The lookup request, as a fetch descriptor plus a MASKED display URL.
   *
   * The key has to travel as the API's `secretKey` query parameter, so the real URL
   * contains it and must never be handed to anything that logs -- see the note in
   * journal-service.js. `displayURL` exists for the opposite reason: any message,
   * error or diagnostic this add-on produces can quote it freely.
   */
  function buildRankRequest({ secretKey, publicationName } = {}) {
    const key = normalizeSecretKey(secretKey);
    const name = normalizePublicationName(publicationName);
    const secret = encodeURIComponent(key);
    return {
      url: API_ORIGIN + API_PATH +
        "?secretKey=" + secret +
        "&publicationName=" + encodeURIComponent(name),
      displayURL: API_ORIGIN + API_PATH +
        "?secretKey=********&publicationName=" + encodeURIComponent(name),
      fetchOptions: {
        method: "GET",
        // No ambient cookies and no cache: a credential-bearing response must not be
        // replayed from, or left in, a shared HTTP cache.
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        headers: { "Accept": "application/json" },
      },
      // Returned separately so a caller can show the journal name without ever
      // having to parse it back out of the credential-bearing URL.
      publicationName: name,
      // Never hand this to a logger; it exists so a caller can avoid rebuilding
      // the request after a retry.
      secretKey: key,
    };
  }

  // Turn one API payload into a flat, bounded result. Returns `found: false`
  // for a well-formed answer that carries no metrics, which is the documented
  // "journal not in the database" case rather than an error.
  function parseRankResponse(payload, { publicationName = "" } = {}) {
    const body = payload && typeof payload === "object" ? payload : {};
    const code = Number(body.code);
    if (code !== 200) {
      return {
        ok: false,
        found: false,
        code: Number.isFinite(code) ? code : 0,
        message: text(body.msg || body.message || "EasyScholar rejected the request", 300),
        metrics: [],
      };
    }
    const data = body.data && typeof body.data === "object" ? body.data : null;
    if (!data) {
      return { ok: true, found: false, code, message: "", metrics: [], journalName: "" };
    }
    const officialRank = data.officialRank && typeof data.officialRank === "object"
      ? data.officialRank
      : {};
    const official = officialRank.all && typeof officialRank.all === "object" ? officialRank.all : {};
    const select = officialRank.select && typeof officialRank.select === "object" ? officialRank.select : {};

    const metrics = [];
    for (const spec of METRIC_LABELS) {
      const source = spec.from === "select" ? select : official;
      const value = metricValue(source[spec.key]);
      if (value) metrics.push({ key: spec.key, label: spec.label, value });
    }
    const journalName = text(
      data.publicationName || data.journalName || official.name || publicationName,
      300,
    );
    return {
      ok: true,
      found: metrics.length > 0,
      code,
      message: "",
      journalName,
      metrics,
      impactFactor: metricValue(official[IMPACT_FACTOR_KEY]) || metricValue(select[IMPACT_FACTOR_KEY]),
      fiveYearImpactFactor: metricValue(select[FIVE_YEAR_KEY]) || metricValue(official[FIVE_YEAR_KEY]),
      jcrQuartile: metricValue(select.sci) || metricValue(official.sci),
    };
  }

  function safeResponseBody(raw) {
    if (raw && typeof raw === "object") return raw;
    try {
      const parsed = JSON.parse(String(raw == null ? "" : raw));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  // Turn one lookup into the shape the details pane and the Priority
  // calculation already understand, so nothing downstream needs to know that
  // the source changed from Green Frog to EasyScholar.
  function toJournalEvidence(result) {
    if (!result || result.found !== true) {
      return {
        source: "easyscholar",
        impactFactor: null,
        fiveYearImpactFactor: null,
        jcrQuartile: "",
        available: false,
      };
    }
    const quartile = result.metrics.find((metric) => metric.key === "sci");
    const impact = result.metrics.find((metric) => metric.key === IMPACT_FACTOR_KEY);
    const fiveYear = result.metrics.find((metric) => metric.key === FIVE_YEAR_KEY);
    return {
      // Same field names and semantics as the Green Frog Extra evidence, so the
      // Priority calculation is unchanged; only the named source differs.
      source: "easyscholar",
      impactFactor: impact ? impact.value : null,
      fiveYearImpactFactor: fiveYear ? fiveYear.value : null,
      jcrQuartile: quartile ? quartile.value : "",
      available: true,
      journalName: text(result.journalName, 300),
      metrics: result.metrics.map((metric) => ({ ...metric })),
      retrievedAt: Number.isFinite(Number(result.retrievedAt)) ? Number(result.retrievedAt) : null,
    };
  }

  // Bound the persisted cache: newest first, and never unbounded.
  function pruneCache(rawCache) {
    const entries = Object.entries(rawCache && typeof rawCache === "object" ? rawCache : {})
      .filter(([, entry]) => entry && typeof entry === "object" && text(entry.cacheKey))
      .sort((left, right) => (Number(right[1].retrievedAt) || 0) - (Number(left[1].retrievedAt) || 0));
    return Object.fromEntries(entries.slice(0, MAX_CACHE_ENTRIES));
  }

  return Object.freeze({
    API_ORIGIN,
    API_PATH,
    REQUEST_TIMEOUT_MS,
    MAX_PUBLICATION_NAME_LENGTH,
    MAX_CACHE_ENTRIES,
    METRIC_LABELS,
    IMPACT_FACTOR_KEY,
    FIVE_YEAR_KEY,
    text,
    metricValue,
    normalizeSecretKey,
    normalizePublicationName,
    publicationCacheKey,
    buildRankRequest,
    parseRankResponse,
    safeResponseBody,
    toJournalEvidence,
    pruneCache,
  });
});
