/**
 * Regression for fork/seeded-session inheritance dedup (issue #1) + the
 * STORE_VERSION 1→2 self-heal, against THIS package's own index.js.
 *
 * Background (AGENTS.md 机制 4「FORK 继承切点」): DSH fork / seeded subagent
 * sessions copy the parent log prefix verbatim (same seq/time/message.id), so
 * counting every event in the child double-counts the parent's history. The
 * authoritative cut point is `readSession(id).inheritedEventCount`; older hosts
 * fall back to the last `session/end-seed { inherited: true }` marker; a seeded
 * log with neither means "everything is inherited".
 *
 * Harness is the same shape as scripts/smoke-store.mjs:
 *   - `DSH_HOME` is set to a fresh tmp dir BEFORE index.js is imported
 *     (index.js locks the persistence paths at module load, and the whole
 *     script must share that one home);
 *   - TOKEN_STATS_PLUGIN still overrides the file under test;
 *   - ctx / Service.init symbol / backfill polling / check() are copied.
 *
 * Because there is only ONE home, every scenario starts by deleting
 * stats.json / quota-prefs.json so the instance is clean; scenarios that need
 * persistence boot a second instance on the same home.
 *
 * Scenarios (each asserts today's aggregate total):
 *   1. authoritative cut (inheritedEventCount) → 465, NOT 930
 *   2. marker fallback (no count, seeded header) → 465
 *   3. full inheritance (no count, no marker) → 450 (parent only)
 *   4. empty prefix (inheritedEventCount: 0) → 15 (child's own events)
 *   5. live path defence (`event.seq < session.inheritedEventCount`) → 15
 *   6. polluted v1 store is discarded → full rescan 465, store rewritten as v2
 *   7. watermarks survive a restart (folded sessions never re-read) → 465
 *   8. plain (non-seeded) session regression → folded like the old version
 */
import { mkdtempSync, existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fakeHome = mkdtempSync(join(tmpdir(), "dsh-ts-seed-"));
process.env.DSH_HOME = fakeHome;

// Default to THIS package's own index.js so `npm run smoke:seed` is
// self-contained; TOKEN_STATS_PLUGIN still overrides.
const PLUGIN =
  process.env.TOKEN_STATS_PLUGIN ||
  fileURLToPath(new URL("../index.js", import.meta.url));
const { TokenStatsService } = await import(pathToFileURL(PLUGIN).href);

const initKey = Object.getOwnPropertySymbols(TokenStatsService.prototype).find(
  (s) => typeof TokenStatsService.prototype[s] === "function",
);
if (!initKey) throw new Error("Service.init symbol not found on prototype");

const statsFile = join(fakeHome, "data", "dsh-token-stats", "stats.json");
const prefsFile = join(fakeHome, "data", "dsh-token-stats", "quota-prefs.json");

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

/** Parent log spliced into a fork; the marker sits at the cut point (seq 2). */
const SEED_MARKER = { type: "session/end-seed", seq: 2, time: Date.now(), data: { inherited: true } };
/** Fork's synthetic tail events: no usage, must be ignored by the folder. */
const SYNTHETIC_TAIL = { type: "tool/result", seq: 3, time: Date.now(), data: {} };
const PARENT_HEADER = { id: "s1" };
const SEEDED_HEADER = { id: "s2", isSeeded: true, parentSession: "s1" };

let failures = 0;
function check(label, cond, extra) {
  console.log((cond ? "  ok  " : "  FAIL") + " " + label + (extra ? "  " + extra : ""));
  if (!cond) failures++;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function waitBackfill(svc) {
  for (let i = 0; i < 500 && !svc._backfill.done; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function todayTotal(svc) {
  const stats = await svc.getStats();
  const day = stats.value.days.find((d) => d.date === todayKey());
  return day ? day.total : 0;
}

// Every instance is tracked so a scenario's still-pending debounce timer cannot
// write into the NEXT scenario's home files after they were cleaned.
const instances = [];

function boot(sessionQuery) {
  const svc = new TokenStatsService(makeCtx(sessionQuery), undefined);
  svc[initKey]();
  instances.push(svc);
  return svc;
}

/** Clean slate for one scenario: quiesce previous instances, delete both files. */
async function reset() {
  for (const svc of instances) {
    if (svc._saveTimer) {
      clearTimeout(svc._saveTimer);
      svc._saveTimer = null;
    }
    svc._dirty = false;
  }
  instances.length = 0;
  // Let any in-flight async _saveNow() (started by backfill) settle first.
  await new Promise((r) => setTimeout(r, 80));
  for (const file of [statsFile, prefsFile]) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch (e) {
      /* nothing to clean */
    }
  }
}

function sessions(s2Snap, reads) {
  return {
    async listSessions() {
      return [{ header: { id: "s1" } }, { header: { id: "s2", isSeeded: true, parentSession: "s1" } }];
    },
    async readSession(id) {
      if (reads) reads.push(id);
      if (id === "s1") {
        // Plain session: no isSeeded field, unchanged pre-issue-#1 behaviour.
        return { session: { id: "s1" }, events: [ev(0, 100, 50, "m"), ev(1, 200, 100, "m")] };
      }
      if (id === "s2") return s2Snap;
      return { events: [] };
    },
  };
}

/** Snapshot of the fork used by scenarios 1/2 and 6/7 (count + marker agree). */
function seededSnap() {
  return {
    session: { id: "s2", isSeeded: true, parentSession: "s1" },
    inheritedEventCount: 2,
    events: [
      ev(0, 100, 50, "m"),
      ev(1, 200, 100, "m"),
      SEED_MARKER,
      SYNTHETIC_TAIL,
      ev(4, 10, 5, "m"),
    ],
  };
}

// ==== scenario 1: authoritative cut point (inheritedEventCount) =============
console.log("[1] authoritative cut via inheritedEventCount");
await reset();
{
  const svc = boot(sessions(seededSnap()));
  await waitBackfill(svc);
  check("backfill done", svc._backfill.done === true);
  check("total = 150+300+15 = 465 (fork prefix not double counted, not 930)", (await todayTotal(svc)) === 465);
  check("s2 watermark advanced past the whole log (= 4)", svc._watermark.get("s2") === 4);
  check("s1 watermark = 1 (plain session folded normally)", svc._watermark.get("s1") === 1);
  check("both sessions marked folded", svc._folded.has("s1") && svc._folded.has("s2"));
}

// ==== scenario 2: no count field → end-seed marker fallback =================
console.log("[2] marker fallback (host without inheritedEventCount)");
await reset();
{
  const snap = seededSnap();
  delete snap.inheritedEventCount; // old host: only the seeded header + marker
  const svc = boot(sessions(snap));
  await waitBackfill(svc);
  check("backfill done", svc._backfill.done === true);
  check("total = 465 (marker seq 2 is the cut)", (await todayTotal(svc)) === 465);
  check("s2 watermark = 4", svc._watermark.get("s2") === 4);
}

// ==== scenario 3: seeded but no count and no marker → everything inherited ===
console.log("[3] full inheritance (no count, no marker)");
await reset();
{
  const svc = boot(
    sessions({
      session: { id: "s2", isSeeded: true, parentSession: "s1" },
      events: [
        // copies of the parent prefix, then the fork's own live event — but
        // without any cut evidence the WHOLE log is treated as inherited.
        ev(0, 100, 50, "m"),
        ev(1, 200, 100, "m"),
        ev(4, 10, 5, "m"),
      ],
    }),
  );
  await waitBackfill(svc);
  check("backfill done", svc._backfill.done === true);
  check("total = 450 (parent only)", (await todayTotal(svc)) === 450);
  check("s2 watermark still advanced to 4", svc._watermark.get("s2") === 4);
}

// ==== scenario 4: explicit empty prefix → everything counts =================
console.log("[4] explicit empty prefix (inheritedEventCount: 0)");
await reset();
{
  const svc = boot({
    async listSessions() {
      // Child only: the parent is irrelevant for an explicitly empty prefix.
      return [{ header: { id: "s2", isSeeded: true, parentSession: "s1" } }];
    },
    async readSession(id) {
      if (id !== "s2") return { events: [] };
      return {
        session: { id: "s2", isSeeded: true, parentSession: "s1" },
        inheritedEventCount: 0,
        events: [ev(0, 10, 5, "m")],
      };
    },
  });
  await waitBackfill(svc);
  check("backfill done", svc._backfill.done === true);
  check("total = 15 (inheritedEventCount 0 must not be mistaken for Infinity)", (await todayTotal(svc)) === 15);
}

// ==== scenario 5: live path defence ========================================
console.log("[5] live path skips event.seq < session.inheritedEventCount");
await reset();
{
  const svc = boot(undefined); // no sessionQuery → no backfill, live only
  svc._onSessionEvent({ id: "sX", inheritedEventCount: 5 }, ev(3, 100, 50, "m"));
  check("inherited live event (seq 3 < 5) not counted", (await todayTotal(svc)) === 0);
  svc._onSessionEvent({ id: "sX", inheritedEventCount: 5 }, ev(5, 10, 5, "m"));
  check("own live event (seq 5) counted → total 15", (await todayTotal(svc)) === 15);
  check("watermark sX = 5", svc._watermark.get("sX") === 5);
}

// ==== scenario 6: polluted v1 store is discarded → full rescan ==============
console.log("[6] STORE_VERSION 1 store is ignored and rewritten as v2");
await reset();
{
  mkdirSync(dirname(statsFile), { recursive: true });
  writeFileSync(
    statsFile,
    JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      folded: ["s1", "s2"],
      watermarks: { s1: 1, s2: 4 },
      modelMeta: {},
      // The exact damage issue #1 shipped: fork copies already folded twice.
      days: {
        [todayKey()]: {
          "p::m": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 99999 },
        },
      },
    }),
    "utf8",
  );
  const svc = boot(sessions(seededSnap()));
  check("v1 store did not restore folded ids", !svc._folded.has("s1") && !svc._folded.has("s2"));
  await waitBackfill(svc);
  check("full rescan repaired the total = 465", (await todayTotal(svc)) === 465);
  svc._saveSync();
  const stored = JSON.parse(readFileSync(statsFile, "utf8"));
  const storedDay = stored && stored.days && stored.days[todayKey()];
  check("store rewritten as version 2", stored && stored.version === 2);
  check(
    "repaired aggregate persisted (not 99999)",
    !!(storedDay && storedDay["p::m"] && storedDay["p::m"].total === 465),
    JSON.stringify(storedDay),
  );
}

// ==== scenario 7: watermarks / folded survive a restart =====================
console.log("[7] restart: folded sessions are not re-read");
await reset();
{
  const first = boot(sessions(seededSnap()));
  await waitBackfill(first);
  check("run 1 total = 465", (await todayTotal(first)) === 465);
  first._saveSync();

  const reads = [];
  const second = boot(sessions(seededSnap(), reads));
  await waitBackfill(second);
  check("backfill done after restart", second._backfill.done === true);
  check("readSession calls = 0 (both sessions folded)", reads.length === 0);
  check("restart total still 465", (await todayTotal(second)) === 465);
  // Replaying the fork's last live event must not double count.
  second._onSessionEvent({ id: "s2" }, ev(4, 10, 5, "m"));
  check("replayed live event deduped → 465", (await todayTotal(second)) === 465);
}

// ==== scenario 8: plain-session regression ================================
console.log("[8] plain (non-seeded) session regression");
await reset();
{
  const svc = boot({
    async listSessions() {
      return [{ header: PARENT_HEADER }];
    },
    async readSession(id) {
      if (id === "s1") return { session: { id: "s1" }, events: [ev(0, 100, 50, "m"), ev(1, 200, 100, "m")] };
      return { events: [] };
    },
  });
  await waitBackfill(svc);
  check("plain session counts every event → 450", (await todayTotal(svc)) === 450);
  check("plain session watermark = 1", svc._watermark.get("s1") === 1);
  check("plain session folded", svc._folded.has("s1"));
}

// Leave no debounce timer behind (the script exits explicitly anyway).
for (const svc of instances) {
  if (svc._saveTimer) {
    clearTimeout(svc._saveTimer);
    svc._saveTimer = null;
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);