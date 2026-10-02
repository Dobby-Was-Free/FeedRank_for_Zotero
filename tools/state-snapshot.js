"use strict";
/*
 * Record the FeedRank state, and detect any later change.
 *
 * The scores live in preference shards, and a silent change there is exactly what went unnoticed
 * before. This takes a snapshot of everything the state is made of -- the pointer, the descriptor's
 * counts and hashes, every shard, and each rank record's own hash -- and compares two snapshots by
 * id, so "the scores changed" becomes "these three records changed and the generation is the same".
 *
 * Usage:
 *   node tools/state-snapshot.js                 record a snapshot
 *   node tools/state-snapshot.js --compare       compare the two newest snapshots
 *   node tools/state-snapshot.js --profile DIR   use a specific Zotero profile
 *   node tools/state-snapshot.js --out DIR       write snapshots somewhere else
 *
 * It only reads. Run it while Zotero is closed for the cleanest reading, and never while a run is
 * in progress.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};

function findProfile() {
  const explicit = flag("--profile");
  if (explicit) return explicit;
  const root = path.join(process.env.APPDATA || "", "Zotero", "Zotero", "Profiles");
  if (!fs.existsSync(root)) throw new Error("no Zotero profile directory at " + root);
  const candidates = fs.readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((dir) => fs.existsSync(path.join(dir, "prefs.js")));
  if (!candidates.length) throw new Error("no profile with a prefs.js under " + root);
  // The one written most recently is the profile in use.
  return candidates.sort((a, b) =>
    fs.statSync(path.join(b, "prefs.js")).mtimeMs - fs.statSync(path.join(a, "prefs.js")).mtimeMs)[0];
}

function readPrefs(profile) {
  const file = path.join(profile, "prefs.js");
  const text = fs.readFileSync(file, "utf8");
  const values = new Map();
  for (const line of text.split("\n")) {
    const match = line.match(/^user_pref\("([^"]+)",\s*"(.*)"\);\s*$/);
    if (!match) continue;
    if (!/feedranker/i.test(match[1])) continue;
    let value = match[2];
    try { value = JSON.parse('"' + match[2] + '"'); } catch (_) {}
    values.set(match[1], value);
  }
  return { file, text, values, mtime: fs.statSync(file).mtime.toISOString() };
}

const hash = (text) => crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
const bare = (key) => key.replace(/^extensions\.zotero\./, "");

function snapshot(profile) {
  const { values, mtime, file } = readPrefs(profile);
  const keys = {};
  for (const [key, value] of values) keys[bare(key)] = { characters: value.length, hash: hash(value) };

  const stateKey = "extensions.zotero.feedranker.state";
  const state = values.get(stateKey) ? JSON.parse(values.get(stateKey)) : {};
  const generation = state.stateStorage?.generation || "";
  const ranks = state.ranks || {};
  const journalCache = state.journalCache || {};

  // The shards are where the records actually live.
  const shards = {};
  for (const [key, value] of values) {
    const short = bare(key);
    if (!/^feedranker\.state\.[^.]+\.(ranks|candidates)\.\d+$/.test(short)) continue;
    shards[short] = { characters: value.length, hash: hash(value) };
  }

  // Every rank record, by id, with its own hash: a changed score is a changed hash.
  const records = {};
  for (const [key, value] of values) {
    const short = bare(key);
    const shard = short.match(/^feedranker\.state\.([^.]+)\.ranks\.\d+$/);
    if (!shard) continue;
    let entries = [];
    try { entries = JSON.parse(value); } catch (_) {}
    for (const pair of Array.isArray(entries) ? entries : []) {
      const [id, record] = Array.isArray(pair) ? pair : [pair?.[0], pair?.[1]];
      if (!id || !record) continue;
      records[id] = {
        score: record.score ?? null,
        confidence: record.confidence ?? null,
        rankedAt: record.rankedAt || null,
        hash: hash(JSON.stringify(record)),
        shard: short,
        generation: shard[1],
        active: shard[1] === generation,
      };
    }
  }
  // A state that still keeps ranks in the pointer itself (an older layout) counts too.
  for (const [id, record] of Object.entries(ranks)) {
    if (records[id]) continue;
    records[id] = {
      score: record?.score ?? null,
      confidence: record?.confidence ?? null,
      rankedAt: record?.rankedAt || null,
      hash: hash(JSON.stringify(record)),
      shard: "(primary)",
      generation,
      active: true,
    };
  }

  return {
    takenAt: new Date().toISOString(),
    profile,
    prefsFile: file,
    prefsMtime: mtime,
    keys,
    state: {
      schema: state.schema ?? null,
      generation,
      weeklyPromptWeek: state.weeklyPromptWeek ?? null,
      descriptor: state.stateStorage ? {
        ranks: state.stateStorage.ranks || null,
        candidates: state.stateStorage.candidates || null,
      } : null,
      rankCount: Object.values(records).filter((record) => record.active).length,
      orphanedRankCount: Object.values(records).filter((record) => !record.active).length,
      generations: [...new Set(Object.values(records).map((record) => record.generation))],
      journalCacheCount: Object.keys(journalCache).length,
      journalCache: Object.fromEntries(Object.entries(journalCache).map(([name, entry]) =>
        [name, { hash: hash(JSON.stringify(entry)), retrievedAt: entry?.retrievedAt ?? null }])),
      weeklyLogLines: Array.isArray(state.weeklyLog) ? state.weeklyLog.length : 0,
    },
    shards,
    records,
  };
}

function compare(before, after) {
  const lines = [];
  const say = (text) => lines.push(text);
  say("from " + before.takenAt + "  to  " + after.takenAt);

  if (before.state.generation !== after.state.generation) {
    say("GENERATION CHANGED: " + before.state.generation + " -> " + after.state.generation);
  } else {
    say("generation unchanged: " + after.state.generation);
  }
  say("schema: " + before.state.schema + " -> " + after.state.schema);

  const active = (snapshot) => Object.entries(snapshot.records)
    .filter(([, record]) => record.active).map(([id]) => id);
  const ids = new Set([...active(before), ...active(after)]);
  const added = [];
  const removed = [];
  const changed = [];
  for (const id of ids) {
    const was = before.records[id];
    const now = after.records[id];
    if (!was) added.push(id);
    else if (!now) removed.push(id);
    else if (was.hash !== now.hash) changed.push(id + " (" + was.score + " -> " + now.score + ")");
  }
  // Orphans are kept deliberately: they are earlier generations, not losses.
  const orphanChanges = new Set();
  for (const [id, record] of Object.entries(after.records)) {
    if (record.active) continue;
    if (!before.records[id] || before.records[id].hash !== record.hash) orphanChanges.add(record.generation);
  }
  if (orphanChanges.size) say("orphaned generations touched: " + [...orphanChanges].join(", "));
  say("ACTIVE rank records: " + before.state.rankCount + " -> " + after.state.rankCount +
    "   (orphaned from earlier generations: " + (before.state.orphanedRankCount ?? 0) + " -> " +
    (after.state.orphanedRankCount ?? 0) + ")");
  if ((after.state.generations || []).length > 1) {
    say("   generations on disk: " + after.state.generations.join(", "));
  }
  say("   added: " + (added.length ? added.length + " e.g. " + added.slice(0, 5).join(", ") : "none"));
  say("   REMOVED: " + (removed.length ? removed.length + " e.g. " + removed.slice(0, 5).join(", ") : "none"));
  say("   changed: " + (changed.length ? changed.length + " e.g. " + changed.slice(0, 5).join("; ") : "none"));

  say("journal cache: " + before.state.journalCacheCount + " -> " + after.state.journalCacheCount);
  const cacheGone = Object.keys(before.state.journalCache || {}).filter((name) => !after.state.journalCache?.[name]);
  if (cacheGone.length) say("   entries gone: " + cacheGone.slice(0, 6).join(", "));

  const shardNames = new Set([...Object.keys(before.shards || {}), ...Object.keys(after.shards || {})]);
  const shardChanges = [...shardNames].filter((name) =>
    before.shards?.[name]?.hash !== after.shards?.[name]?.hash);
  say("shards: " + Object.keys(before.shards || {}).length + " -> " + Object.keys(after.shards || {}).length +
    (shardChanges.length ? "   changed: " + shardChanges.slice(0, 6).join(", ") : "   all identical"));

  const keyNames = new Set([...Object.keys(before.keys || {}), ...Object.keys(after.keys || {})]);
  const keyChanges = [...keyNames].filter((name) => before.keys?.[name]?.hash !== after.keys?.[name]?.hash);
  say("preferences: " + keyNames.size + " total" +
    (keyChanges.length ? "   changed: " + keyChanges.join(", ") : "   none changed"));

  const lost = removed.length > 0 || cacheGone.length > 0 ||
    (before.state.rankCount > 0 && after.state.rankCount === 0);
  say("");
  say(lost ? "VERDICT: something was LOST" :
    (added.length || changed.length ? "VERDICT: scores changed, nothing lost" : "VERDICT: unchanged"));
  return lines.join("\n");
}

const profile = findProfile();
// `private/` is excluded by .gitignore. A snapshot names preference files and contains article ids
// and reading state, so it is personal material: never commit it, never attach it to an issue.
const outDir = flag("--out") || path.join(__dirname, "..", "private", "state-backup");
fs.mkdirSync(outDir, { recursive: true });

if (args.includes("--compare")) {
  const files = fs.readdirSync(outDir).filter((name) => /^state-.*\.json$/.test(name)).sort();
  if (files.length < 2) {
    console.log("only " + files.length + " snapshot(s) in " + outDir + " -- nothing to compare yet");
    process.exitCode = 0;
  } else {
    const before = JSON.parse(fs.readFileSync(path.join(outDir, files[files.length - 2]), "utf8"));
    const after = JSON.parse(fs.readFileSync(path.join(outDir, files[files.length - 1]), "utf8"));
    console.log("comparing " + files[files.length - 2] + " with " + files[files.length - 1]);
    console.log(compare(before, after));
  }
} else {
  const current = snapshot(profile);
  const existing = fs.readdirSync(outDir).filter((name) => /^state-.*\.json$/.test(name)).sort();
  const newest = existing.length ? JSON.parse(fs.readFileSync(path.join(outDir, existing[existing.length - 1]), "utf8")) : null;
  if (newest && newest.state.generation === current.state.generation &&
      JSON.stringify(newest.records) === JSON.stringify(current.records) &&
      JSON.stringify(newest.state.descriptor) === JSON.stringify(current.state.descriptor)) {
    console.log("unchanged since " + newest.takenAt + " (" + existing[existing.length - 1] + ")");
    console.log("profile: " + profile);
    console.log("   active rank records: " + current.state.rankCount +
      ", orphaned: " + current.state.orphanedRankCount + ", journal cache: " + current.state.journalCacheCount);
    process.exit(0);
  }
  const stamp = current.takenAt.replace(/[:.]/g, "-").slice(0, 19);
  const target = path.join(outDir, "state-" + stamp + ".json");
  fs.writeFileSync(target, JSON.stringify(current, null, 1) + "\n", "utf8");
  console.log("profile: " + profile);
  console.log("snapshot: " + target);
  console.log("   schema " + current.state.schema + ", generation " + current.state.generation);
  console.log("   ACTIVE rank records: " + current.state.rankCount +
    ", orphaned from earlier generations: " + current.state.orphanedRankCount +
    ", journal cache: " + current.state.journalCacheCount);
  console.log("   descriptor: " + JSON.stringify(current.state.descriptor));
  console.log("   shards: " + Object.keys(current.shards).length + ", run log lines: " + current.state.weeklyLogLines);
  const previous = fs.readdirSync(outDir).filter((name) => /^state-.*\.json$/.test(name)).sort();
  if (previous.length > 1) {
    const before = JSON.parse(fs.readFileSync(path.join(outDir, previous[previous.length - 2]), "utf8"));
    console.log("\n=== change since " + before.takenAt);
    console.log(compare(before, current));
  }
}
