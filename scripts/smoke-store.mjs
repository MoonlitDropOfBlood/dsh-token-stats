/**
 * Smoke test for dsh-token-stats persistence (runs against the INSTALLED copy).
 *
 * Scenario:
 *   1. Instance A (fresh, empty DSH_HOME): fold 2 live events, flush to disk.
 *   2. Instance B (same DSH_HOME): cold start restores store; backfill must
 *      SKIP the already-folded session and only read the brand-new one.
 *   3. Replaying the same events into B must not double count (watermark).
 */
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const fakeHome = mkdtempSync(join(tmpdir(), "dsh-ts-home-"));
process.env.DSH_HOME = fakeHome;

const PLUGIN =
  process.env.TOKEN_STATS_PLUGIN ||
  "C:/Users/wwhby/.dsh/profiles/web/node_modules/dsh-token-stats/index.js";
const { TokenStatsService } = await import(pathToFileURL(PLUGIN).href);

const initKey = Object.getOwnPropertySymbols(TokenStatsService.prototype).find(
  (s) => typeof TokenStatsService.prototype[s] === "function",
);
if (!initKey) throw new Error("Service.init symbol not found on prototype");

function makeCtx(sessionQuery) {
  return {
    reflect: { provide() {} },
    on() {},
    get(name) {
      return name === "sessionQuery" ? sessionQuery : undefined;
    },
    effect(fn) {
      return fn();
    },
  };
}

function ev(seq, input, output, model) {
  return {
    type: "assistant/message",
    seq,
    time: Date.now(),
    data: {
      usage: { inputTokens: input, outputTokens: output },
      message: { source: { kind: "model", provider: "p", model } },
    },
  };
}

let failures = 0;
function check(label, cond) {
  console.log((cond ? "  ok  " : "  FAIL") + " " + label);
  if (!cond) failures++;
}

// _startBackfill() is already triggered by init; later calls no-op. Poll the
// shared backfill state instead of awaiting a second call.
async function waitBackfill(svc) {
  for (let i = 0; i < 500 && !svc._backfill.done; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---- run 1: instance A folds live events and flushes -----------------------
const a = new TokenStatsService(makeCtx(undefined), undefined);
a[initKey]();
a._onSessionEvent({ id: "s1" }, ev(0, 100, 50, "m"));
a._onSessionEvent({ id: "s1" }, ev(1, 200, 100, "m"));
a._saveSync();

const storeFile = join(fakeHome, "data", "dsh-token-stats", "stats.json");
check("store file written", existsSync(storeFile));
const stored = JSON.parse(readFileSync(storeFile, "utf8"));
check("watermark s1 = 1", stored.watermarks.s1 === 1);
check("folded contains s1? (expected NO: live-only session)", !stored.folded.includes("s1"));

// ---- run 2: instance B cold-starts from the store --------------------------
const readCalls = [];
const sessionQuery = {
  async listSessions() {
    return [{ header: { id: "s1" } }, { header: { id: "s2" } }, { header: { id: "s3" } }];
  },
  async readSession(id) {
    readCalls.push(id);
    if (id === "s1") return { events: [ev(0, 100, 50, "m"), ev(1, 200, 100, "m")] };
    if (id === "s2") return { events: [ev(0, 10, 5, "m2")] };
    return { events: [] };
  },
};
const b = new TokenStatsService(makeCtx(sessionQuery), undefined);
b[initKey]();
check("B restored watermark s1 = 1", b._watermark.get("s1") === 1);
check("B did NOT mark live-only s1 folded", !b._folded.has("s1"));

// B folds s1 fully via backfill; next run must skip it.
await waitBackfill(b);
check("backfill read s1 (had no folded mark)", readCalls.includes("s1"));
check("backfill read s2 (new session)", readCalls.includes("s2"));
check("backfill read s3 (new, empty session)", readCalls.includes("s3"));
check("B now marks s1 folded", b._folded.has("s1"));

let stats = await b.getStats();
const today = new Date();
const dk = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
const day = stats.value.days.find((d) => d.date === dk);
check("day aggregate present", !!day);
check("total = 150+300+15 = 465 (no double count)", day && day.total === 465);

// replaying the same events into B must be a no-op (watermark dedup)
b._onSessionEvent({ id: "s1" }, ev(0, 100, 50, "m"));
b._onSessionEvent({ id: "s1" }, ev(1, 200, 100, "m"));
stats = await b.getStats();
const day2 = stats.value.days.find((d) => d.date === dk);
check("replay deduped, total still 465", day2 && day2.total === 465);

b._saveSync();

// ---- run 3: instance C — every existing session skipped --------------------
readCalls.length = 0;
const c = new TokenStatsService(makeCtx(sessionQuery), undefined);
c[initKey]();
await waitBackfill(c);
check("C backfill done", c._backfill.done === true);
check("C read NO session (all folded)", readCalls.length === 0);
stats = await c.getStats();
const day3 = stats.value.days.find((d) => d.date === dk);
check("C restored total = 465", day3 && day3.total === 465);
check("C ready immediately", stats.value.ready === true);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
