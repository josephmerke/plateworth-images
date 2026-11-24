#!/usr/bin/env node
// Plateworth food-image generator.
// Reads assets/food/image-inventory.csv and creates the photos with the OpenAI Images API.
//
// SAFE BY DEFAULT:
//   * Without --run it only PRINTS what it would do. No API call, no cost, no key needed.
//   * It never overwrites a file that exists. --force <ids> is the only way, and the old file is kept in _replaced/.
//   * Every attempt (good or bad) is appended to assets/food/generation-log.jsonl.
//   * The API key is read ONLY from the OPENAI_API_KEY environment variable. It is never printed or saved.
//
// Usage:  node generate-images.js [options]
//   --limit N          how many images to make this time (default 3, at most 25)
//   --priority N       only rows with this priority (1 = dishes, 2 = recipes, 3 = ingredients)
//   --type T           only dish, recipe or food
//   --only a,b         only these ids (comma separated)
//   --force a,b        regenerate these exact ids even if the file exists (ids required, never "all")
//   --run              really call the API (without it: dry run)
//   --model M          default gpt-image-2.5-flare  (or env OPENAI_IMAGE_MODEL)
//   --size S           default 1536x1024 (3:2; cropped to 4:3). 1600x1200 is also valid for this model and needs no crop.
//   --report           print totals from the log and the CSV, then stop
//   --dir D --csv F    folders/files (defaults: assets/food and ./image-inventory.csv)
const fs = require("fs"), path = require("path");

const A = process.argv.slice(2);
const flag = n => A.includes("--" + n);
const val = (n, d) => { const i = A.indexOf("--" + n); return i >= 0 && A[i + 1] && !A[i + 1].startsWith("--") ? A[i + 1] : d; };
const list = n => (val(n, "") || "").split(",").map(s => s.trim()).filter(Boolean);

const DIR = val("dir", "assets/food");
const CSV = val("csv", fs.existsSync("image-inventory.csv") ? "image-inventory.csv" : path.join(DIR, "image-inventory.csv"));
const LOG = path.join(DIR, "generation-log.jsonl");
const MODEL = (val("model", process.env.OPENAI_IMAGE_MODEL || "") || "gpt-image-2.5-flare").trim();
const SIZE = val("size", "1536x1024");
const QUALITY = "medium";
const BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
const RUN = flag("run");
const RETIRED = ["gpt-image-1"];   // OpenAI shut gpt-image-1 down on 23 Oct 2026
const HARD_MAX = 25;
const MASTER_W = 1600, MASTER_H = 1200, MAX_BYTES = 250 * 1024, VARIANTS = [1200, 480];

function parseCsv(t) {
  const rows = []; let r = [], f = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { r.push(f); f = ""; }
    else if (c === "\n") { r.push(f); rows.push(r); r = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f !== "" || r.length) { r.push(f); rows.push(r); }
  const h = rows.shift();
  return rows.filter(x => x.length > 1).map(x => Object.fromEntries(h.map((k, i) => [k, x[i] || ""])));
}
function readLog() {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function logLine(o) { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(LOG, JSON.stringify(Object.assign({ time: new Date().toISOString() }, o)) + "\n"); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exists = f => fs.existsSync(path.join(DIR, f));

function fail(msg) { console.error("\nSTOPPED: " + msg + "\n"); process.exit(1); }

if (RETIRED.includes(MODEL)) fail(MODEL + " has been retired by OpenAI. Use gpt-image-2.5-flare (the default). Nothing was sent.");
{ // size rules from OpenAI's docs: WxH, both multiples of 16, ratio 1:3..3:1, edges <= 3840, 655,360..8,294,400 pixels
  const m = /^(\d+)x(\d+)$/.exec(SIZE), w = m && +m[1], h = m && +m[2];
  const okSize = m && w % 16 === 0 && h % 16 === 0 && w <= 3840 && h <= 3840 && w * h >= 655360 && w * h <= 8294400 && w / h <= 3 && h / w <= 3;
  if (!okSize) fail("Size " + SIZE + " is not allowed. Use 1536x1024 or 1600x1200.");
}
if (!fs.existsSync(CSV)) fail("Can't find " + CSV);
const rows = parseCsv(fs.readFileSync(CSV, "utf8"));
const log = readLog();
const lastStatus = {}; for (const e of log) lastStatus[e.id] = e.status;

// ---------- report ----------
if (flag("report")) {
  const own = rows.filter(r => r.need === "individual");
  const done = own.filter(r => exists(r.file)).length;
  const bad = own.filter(r => !exists(r.file) && /^(failed|blocked)$/.test(lastStatus[r.id] || ""));
  const fix = own.filter(r => !r.prompt.trim() || ((r.type === "dish" || r.type === "recipe") && !r.must_show.trim()));
  const ok = log.filter(e => e.status === "ok").length, nf = log.filter(e => e.status === "failed" || e.status === "blocked").length;
  console.log(`Images needed: ${own.length}  | made: ${done}  | still to make: ${own.length - done}`);
  console.log(`Shared (no own photo): ${rows.length - own.length}`);
  console.log(`Log: ${ok} successful, ${nf} failed or blocked attempts in total`);
  if (bad.length) console.log("Last attempt failed for:\n  " + bad.map(r => r.id + " (" + lastStatus[r.id] + ")").join("\n  "));
  if (fix.length) console.log("Rows with a prompt problem (skipped until fixed in the CSV):\n  " + fix.map(r => r.id).join("\n  "));
  process.exit(0);
}

// ---------- choose what to make ----------
const force = list("force"), only = list("only");
if (flag("force") && !force.length) fail("--force needs the exact ids to redo, for example --force dish:protein-shake. It cannot mean 'everything'.");
if (force.length && !RUN) console.log("(dry run) --force noted; nothing will change without --run.");
let limit = parseInt(val("limit", "3"), 10);
if (!(limit > 0)) fail("--limit must be a number above 0.");
if (limit > HARD_MAX) { console.log(`Limit lowered from ${limit} to ${HARD_MAX} (safety cap).`); limit = HARD_MAX; }
const prio = val("priority", ""), type = val("type", "");
for (const id of force.concat(only)) if (!rows.some(r => r.id === id)) fail("Unknown id: " + id);

const skipped = { shared: [], exists: [], needsFix: [], filtered: 0 };
let cand = [];
for (const r of rows) {
  if (force.length && !only.length) { if (!force.includes(r.id)) { skipped.filtered++; continue; } }  // --force alone means ONLY those ids
  else if (only.length && !only.includes(r.id) && !force.includes(r.id)) { skipped.filtered++; continue; }
  if (prio && r.priority !== prio) { skipped.filtered++; continue; }
  if (type && r.type !== type) { skipped.filtered++; continue; }
  if (r.need !== "individual") { skipped.shared.push(r.id); continue; }
  if (!/^[a-z0-9][a-z0-9._-]*\.webp$/i.test(r.file)) { skipped.needsFix.push(r.id + " (bad file name)"); continue; }
  const needsList = r.type === "dish" || r.type === "recipe";
  if (!r.prompt.trim() || (needsList && !r.must_show.trim())) { skipped.needsFix.push(r.id + (r.prompt.trim() ? " (no foods listed in must_show)" : " (prompt is empty)")); continue; }
  if (exists(r.file) && !force.includes(r.id)) { skipped.exists.push(r.id); continue; }
  cand.push(r);
}
// untried first, then ones that failed last time
cand = cand.filter(r => !/^(failed|blocked)$/.test(lastStatus[r.id] || "")).concat(cand.filter(r => /^(failed|blocked)$/.test(lastStatus[r.id] || "")));
const batch = cand.slice(0, limit);

console.log(`\nPlateworth image generator  (${RUN ? "REAL RUN" : "DRY RUN: nothing will be generated or charged"})`);
console.log(`Model ${MODEL} | quality ${QUALITY} | size ${SIZE} | batch limit ${limit}`);
console.log(`Already exist (skipped): ${skipped.exists.length} | shared (no own photo): ${skipped.shared.length} | prompt needs fixing: ${skipped.needsFix.length}`);
if (skipped.needsFix.length) console.log("  Needs fixing in the CSV (never sent): " + skipped.needsFix.slice(0, 5).join("; ") + (skipped.needsFix.length > 5 ? "; and " + (skipped.needsFix.length - 5) + " more" : ""));
console.log(`Waiting to be made: ${cand.length}. This batch: ${batch.length}`);
batch.forEach((r, i) => console.log(`  ${i + 1}. ${r.id} -> ${r.file}${force.includes(r.id) && exists(r.file) ? "  (REPLACE, old copy is kept)" : ""}${lastStatus[r.id] === "failed" || lastStatus[r.id] === "blocked" ? "  (retry)" : ""}`));
if (!batch.length) { console.log("\nNothing to do."); process.exit(0); }
if (!RUN) { console.log(`\nDry run finished. Up to ${batch.length} image request(s) would be sent. Add --run to really generate.`); process.exit(0); }

const KEY = process.env.OPENAI_API_KEY;
if (!KEY || !KEY.trim()) fail("No API key found. The key must be stored as a secret called OPENAI_API_KEY (see HOW-TO-RUN.md). Nothing was sent.");

async function callApi(prompt) {
  let attempt = 0;
  for (;;) {
    attempt++;
    let res, body;
    try {
      res = await fetch(BASE + "/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
        body: JSON.stringify({ model: MODEL, prompt, size: SIZE, quality: QUALITY, n: 1 }),
        signal: AbortSignal.timeout(240000)
      });
      body = await res.json().catch(() => ({}));
    } catch (e) {
      if (attempt <= 2) { await sleep(4000 * attempt); continue; }
      return { error: "network: " + (e.message || e), kind: "failed" };
    }
    if (res.ok) {
      const b64 = body && body.data && body.data[0] && body.data[0].b64_json;
      return b64 ? { b64 } : { error: "response had no image data", kind: "failed" };
    }
    const msg = ((body && body.error && body.error.message) || res.statusText || "error").slice(0, 300);
    const code = (body && body.error && body.error.code) || "";
    if (res.status === 401 || res.status === 403) return { error: res.status + ": " + msg, kind: "auth" };
    if (res.status === 429 && /quota|billing|insufficient/i.test(msg + code)) return { error: "429: " + msg, kind: "auth" };
    if ((res.status === 429 || res.status >= 500) && attempt <= 2) { await sleep(6000 * attempt); continue; }
    if (res.status === 400 && /safety|moderation|content_policy/i.test(msg + code)) return { error: "400: " + msg, kind: "blocked" };
    return { error: res.status + ": " + msg, kind: "failed" };
  }
}

async function save(b64, file) {
  const sharp = require("sharp");
  const src = Buffer.from(b64, "base64");
  let q = 84, out;
  for (;;) {
    out = await sharp(src).rotate().resize(MASTER_W, MASTER_H, { fit: "cover", position: "centre" }).webp({ quality: q }).toBuffer();
    if (out.length <= MAX_BYTES || q <= 60) break;
    q -= 6;
  }
  const final = path.join(DIR, file), tmp = final + ".tmp";
  fs.mkdirSync(DIR, { recursive: true });
  if (fs.existsSync(final)) {
    fs.mkdirSync(path.join(DIR, "_replaced"), { recursive: true });
    fs.renameSync(final, path.join(DIR, "_replaced", Date.now() + "-" + file));
  }
  fs.writeFileSync(tmp, out); fs.renameSync(tmp, final);
  for (const w of VARIANTS) {
    const v = path.join(DIR, file.replace(/(\.[a-z]+)$/i, "-" + w + "$1"));
    const buf = await sharp(out).resize(w, Math.round(w * 3 / 4)).webp({ quality: 80 }).toBuffer();
    fs.writeFileSync(v + ".tmp", buf); fs.renameSync(v + ".tmp", v);
  }
  return { bytes: out.length, quality: q };
}

(async () => {
  let ok = 0, bad = 0, consec = 0;
  for (const r of batch) {
    process.stdout.write(`Making ${r.id} ... `);
    const res = await callApi(r.prompt);
    if (res.b64) {
      try {
        const s = await save(res.b64, r.file);
        logLine({ id: r.id, file: r.file, status: "ok", model: MODEL, quality: QUALITY, size: SIZE, bytes: s.bytes, forced: force.includes(r.id) });
        console.log(`done (${Math.round(s.bytes / 1024)} KB)`); ok++; consec = 0;
      } catch (e) {
        logLine({ id: r.id, file: r.file, status: "failed", model: MODEL, error: "save: " + (e.message || e) });
        console.log("FAILED while saving: " + (e.message || e)); bad++; consec++;
      }
    } else {
      logLine({ id: r.id, file: r.file, status: res.kind === "blocked" ? "blocked" : "failed", model: MODEL, quality: QUALITY, size: SIZE, error: res.error });
      console.log((res.kind === "blocked" ? "BLOCKED: " : "FAILED: ") + res.error); bad++; consec++;
      if (res.kind === "auth") { console.log("\nStopped early: the account or key was refused. Check the key and billing. Remaining images were not attempted."); break; }
    }
    if (consec >= 3) { console.log("\nStopped early: 3 failures in a row. Nothing else was attempted."); break; }
    await sleep(parseInt(process.env.IMAGEGEN_DELAY_MS || "1500", 10));
  }
  console.log(`\nFinished. Successful: ${ok}. Failed or blocked: ${bad}. Details: ${LOG}`);
  process.exit(bad && !ok ? 1 : 0);
})();
