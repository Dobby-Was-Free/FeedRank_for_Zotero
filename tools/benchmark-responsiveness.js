"use strict";

// Synthetic, offline diagnostics only. Not included in the XPI and never opens
// Zotero, a socket, a credential store or a model connection.
const { performance } = require("node:perf_hooks");
const Core = require("../chrome/content/core.js");
require("../chrome/content/main.js");
const preferences = new Map();
const writes = [];
const Zotero = { Prefs: {
  get: (key) => preferences.get(key) || "",
  set: (key, value) => { writes.push({ key, bytes: Buffer.byteLength(value, "utf8") }); preferences.set(key, value); },
  clear: (key) => preferences.delete(key),
} };
const service = globalThis.FeedRankerMain.create({ Zotero, Services: {}, Core });
let yields = 0, longestSliceMs = 0, sliceStarted = performance.now();
service.delay = async () => {
  longestSliceMs = Math.max(longestSliceMs, performance.now() - sliceStarted);
  yields++;
  await new Promise((resolve) => setImmediate(resolve));
  sliceStarted = performance.now();
};

async function measure(label, action) {
  writes.length = 0;
  yields = 0;
  longestSliceMs = 0;
  sliceStarted = performance.now();
  const started = performance.now();
  await action();
  longestSliceMs = Math.max(longestSliceMs, performance.now() - sliceStarted);
  process.stdout.write(JSON.stringify({ label, elapsedMs: +(performance.now() - started).toFixed(1),
    yields, longestObservedSliceMs: +longestSliceMs.toFixed(1),
    preferenceWrites: writes.length, bytesWritten: writes.reduce((sum, write) => sum + write.bytes, 0),
    scoreShardWrites: writes.filter((write) => write.key.includes(".ranks.")).length,
    candidateShardWrites: writes.filter((write) => write.key.includes(".candidates.")).length,
  }) + "\n");
}

(async () => {
  const config = service.loadConfig();
  const records = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => {
    const record = { id: "1:PAPER" + index, itemID: index + 1, libraryID: 1,
      title: "Synthetic paper " + index, source: "Offline feed", date: Core.localDay(),
      score: index % 101, confidence: "medium", reason: "Bounded explanation 研究 ".repeat(50),
      rankedAt: "2026-10-05T00:00:00.000Z" };
    record.fingerprint = Core.cacheFingerprint(record, config);
    record.configFingerprint = Core.rankingConfigFingerprint(config);
    return [record.id, record];
  }));
  await measure("save 2000 scores and rerun references", () => service.mutateState((state) => {
    state.ranks = records; state.lastCandidates = Object.values(records);
  }, { returnState: false }));
  await measure("change frozen email status only", () => service.mutateState((state) => {
    state.emailSubmissions = { retained: { status: "unknown", message: "Frozen MIME 论文 &\r\n".repeat(18000) } };
  }, { returnState: false }));
  await measure("schedule log only", () => service.mutateState((state) => {
    state.weeklyLog = ["Synthetic completed event"];
  }, { returnState: false }));
  await measure("select digest from stored scores", () => service.weeklyDigestSelectionAsync());
  process.stdout.write(JSON.stringify({ retainedScores: Object.keys(service.loadState().ranks).length,
    maximumPreferenceBytes: Math.max(...[...preferences.values()].map((value) => Buffer.byteLength(value, "utf8"))),
    note: "Node mocks, not measured in Zotero; timings vary by machine and load." }) + "\n");
})().catch((error) => { process.stderr.write(String(error?.stack || error) + "\n"); process.exitCode = 1; });
