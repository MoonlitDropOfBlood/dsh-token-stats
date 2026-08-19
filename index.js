/**
 * dsh-token-stats — Host half.
 *
 * A Cordis "class plugin": this module exports a `TokenStatsService` extending
 * `TypertRemoteService`. The DSH loader instantiates the class and registers it
 * as the `tokenStats` service; the Typert Gateway exposes its `@Remote`-marked
 * methods to the browser Client half under the `tokenStats` Remote namespace.
 *
 * Data collection (single authoritative source = the session log):
 *   - LIVE: `session/event` feed — every `assistant/message` append carries the
 *     step's `TokenUsage` plus the model/provider provenance
 *     (`message.source`, kind === 'model'). A root-mounted plugin context is
 *     untagged, so the dsh-scope filter admits it for every session.
 *   - HISTORY: `sessionQuery.readSession(id)` backfills each persisted session
 *     once, folding events that happened before the plugin started.
 *   - DEDUP: a per-session seq watermark — each event is folded exactly once,
 *     whichever source (live feed or backfill) reaches it first. Both paths
 *     do the check-and-set synchronously, so no event is ever double counted.
 *   - PERSIST: aggregates, watermarks and the set of fully-folded sessions
 *     are written to `<DSH_HOME>/data/dsh-token-stats/stats.json` (debounced,
 *     atomic tmp+rename, flushed synchronously on dispose). A cold start
 *     restores them and skips `readSession` for already-folded sessions;
 *     only sessions created since the last run are scanned. Delete the file
 *     to force a full rescan.
 *
 * Aggregates are kept per local calendar day per model key
 * (`<provider>::<model>`), which is exactly what the Client charts consume.
 */

import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { Service } from "@deepseek-ai/cordis";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DAY_MS = 86400000;
/** How many days of history to keep (a bit over one year). */
const WINDOW_DAYS = 400;

/**
 * Durable store path. The session pool lives under `<DSH_HOME>/sessions`
 * (global, not per-profile), so the store sits next to it under
 * `<DSH_HOME>/data/dsh-token-stats/` and survives plugin reinstall/upgrade.
 */
const STORE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 1500;
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const STORE_DIR = join(DSH_HOME, "data", "dsh-token-stats");
const STORE_FILE = join(STORE_DIR, "stats.json");

/**
 * Mark one instance method as a Remote export without relying on decorator
 * syntax (Node ESM does not support the proposal decorators here). We drive
 * the same `Remote(name)` decorator manually through a synthetic decorator
 * context and run the registered initializers against the instance.
 *
 * @param {object} instance - live service instance whose prototype is marked.
 * @param {string} method - public instance method name.
 * @param {string} [exportName] - wire export name; defaults to the method name.
 */
function markRemoteMethod(instance, method, exportName) {
  const decorator = Remote(method, undefined);
  const initializers = [];
  decorator(undefined, {
    kind: "method",
    name: method,
    static: false,
    private: false,
    addInitializer: (fn) => initializers.push(fn),
  });
  for (const fn of initializers) fn.call(instance);
}

export class TokenStatsService extends TypertRemoteService {
  /**
   * No hard service dependencies: `sessionQuery` is read through `ctx.get()`
   * and backfill retries on the first `getStats()` call if it was not mounted
   * when the plugin activated.
   */
  static inject = [];

  /**
   * Cordis instantiates class plugins with `new Callback(ctx, config)` — the
   * second argument is the plugin config, NOT the service key. Pass the exact
   * service key to `super()` (see dsh-archive-manager's constructor fix).
   */
  constructor(ctx, config) {
    super(ctx, "tokenStats");
  }

  /**
   * Cordis class-plugin initializer: runs right after construction, before the
   * service is published. Mark the Remote method, then start collecting.
   */
  [Service.init]() {
    markRemoteMethod(this, "getStats", "getStats");

    /** dayKey ('YYYY-MM-DD', local) -> Map<modelKey, day aggregate>. */
    this._byDay = new Map();
    /** modelKey -> { key, name, provider }. */
    this._modelMeta = new Map();
    /** sessionId -> highest folded event seq (dedup watermark). */
    this._watermark = new Map();
    this._backfill = { started: false, done: false, total: 0, doneCount: 0, error: null };
    /** sessionIds whose complete log (up to the watermark) has been folded. */
    this._folded = new Set();
    this._dirty = false;
    this._saveTimer = null;
    this._saving = false;

    // Restore the previous run's aggregates so a cold start only scans new sessions.
    this._loadStore();

    // Best-effort synchronous flush when the plugin fiber is disposed.
    this.ctx.effect(() => () => {
      if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
      }
      if (this._dirty) this._saveSync();
    });

    // Live capture: every committed session append.
    this.ctx.on("session/event", (session, event) => this._onSessionEvent(session, event));

    this._startBackfill();
  }

  // ---- data helpers ---------------------------------------------------------

  _dayKeyOf(time) {
    const d = new Date(time);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${dd}`;
  }

  _ensureModel(provider, model) {
    const key = `${provider || "?"}::${model}`;
    let meta = this._modelMeta.get(key);
    if (!meta) {
      meta = { key, name: model, provider: provider || "" };
      this._modelMeta.set(key, meta);
    }
    return key;
  }

  _addUsage(provider, model, usage, time) {
    if (!usage || typeof usage !== "object") return false;
    const input = Number(usage.inputTokens) || 0;
    const output = Number(usage.outputTokens) || 0;
    const cr = Number(usage.cacheReadTokens) || 0;
    const cw = Number(usage.cacheWriteTokens) || 0;
    const reason = Number(usage.reasoningTokens) || 0;
    const total = input + output + cr + cw;
    if (total <= 0) return false;
    const key = this._ensureModel(provider, model);
    const dk = this._dayKeyOf(time);
    let day = this._byDay.get(dk);
    if (!day) {
      day = new Map();
      this._byDay.set(dk, day);
    }
    let rec = day.get(key);
    if (!rec) {
      rec = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
      day.set(key, rec);
    }
    rec.input += input;
    rec.output += output;
    rec.cacheRead += cr;
    rec.cacheWrite += cw;
    rec.reasoning += reason;
    rec.total += total;
    return true;
  }

  /** Fold one `assistant/message` event (model provenance + usage). */
  _foldEvent(event) {
    try {
      if (!event || typeof event !== "object" || event.type !== "assistant/message") return false;
      const data = event.data;
      if (!data || !data.usage) return false;
      const src = data.message && data.message.source;
      if (!src || src.kind !== "model") return false;
      return this._addUsage(
        src.provider || "",
        src.model || "",
        data.usage,
        typeof event.time === "number" ? event.time : Date.now(),
      );
    } catch (e) {
      /* keep stats robust */
      return false;
    }
  }

  _onSessionEvent(session, event) {
    try {
      if (!event || event.type !== "assistant/message") return;
      const sid = session && session.id;
      if (!sid || typeof event.seq !== "number") return;
      const wm = this._watermark.get(sid) ?? -1;
      if (event.seq <= wm) return;
      this._watermark.set(sid, event.seq);
      if (this._foldEvent(event)) this._scheduleSave();
    } catch (e) {
      /* keep stats robust */
    }
  }

  // ---- backfill -------------------------------------------------------------

  async _startBackfill() {
    if (this._backfill.started || this._backfill.done) return;
    const sessionQuery = this.ctx.get("sessionQuery");
    if (!sessionQuery || typeof sessionQuery.listSessions !== "function") return;
    this._backfill.started = true;
    try {
      let sessions = [];
      try {
        sessions = (await sessionQuery.listSessions()) || [];
      } catch (e) {
        sessions = [];
      }
      this._backfill.total = sessions.length;
      let next = 0;
      const worker = async () => {
        for (;;) {
          const idx = next++;
          if (idx >= sessions.length) return;
          const rec = sessions[idx];
          const header = rec && rec.header;
          if (!header || !header.id) {
            this._backfill.doneCount++;
            continue;
          }
          // Restored from the store: this session's log was fully folded in a
          // previous run — skip the expensive readSession entirely.
          if (this._folded.has(header.id)) {
            this._backfill.doneCount++;
            continue;
          }
          try {
            const snap = await sessionQuery.readSession(header.id);
            if (snap && Array.isArray(snap.events)) {
              let wm = this._watermark.get(header.id) ?? -1;
              for (const ev of snap.events) {
                if (!ev || typeof ev.seq !== "number" || ev.seq <= wm) continue;
                wm = ev.seq;
                this._foldEvent(ev);
              }
              this._watermark.set(header.id, wm);
            }
            this._folded.add(header.id);
            this._scheduleSave();
          } catch (e) {
            /* skip unreadable session */
          }
          this._backfill.doneCount++;
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      this._backfill.done = true;
      this._saveNow();
    } catch (e) {
      this._backfill.error = String((e && e.message) || e);
      this._backfill.done = true;
      this._saveNow();
    }
  }

  // ---- persistence ----------------------------------------------------------

  _serializeStore() {
    const cutoff = Date.now() - WINDOW_DAYS * DAY_MS;
    const days = {};
    for (const [dk, day] of this._byDay) {
      const t = new Date(`${dk}T00:00:00`).getTime();
      if (!Number.isNaN(t) && t < cutoff) continue;
      const models = {};
      for (const [key, rec] of day) {
        models[key] = {
          input: rec.input,
          output: rec.output,
          cacheRead: rec.cacheRead,
          cacheWrite: rec.cacheWrite,
          reasoning: rec.reasoning,
          total: rec.total,
        };
      }
      days[dk] = models;
    }
    const watermarks = {};
    for (const [sid, seq] of this._watermark) watermarks[sid] = seq;
    const modelMeta = {};
    for (const [key, meta] of this._modelMeta) {
      modelMeta[key] = { key: meta.key, name: meta.name, provider: meta.provider };
    }
    return JSON.stringify({
      version: STORE_VERSION,
      savedAt: Date.now(),
      folded: [...this._folded],
      watermarks,
      modelMeta,
      days,
    });
  }

  _loadStore() {
    try {
      const data = JSON.parse(readFileSync(STORE_FILE, "utf8"));
      if (!data || data.version !== STORE_VERSION) return;
      const watermarks = data.watermarks || {};
      for (const sid of Object.keys(watermarks)) {
        const seq = watermarks[sid];
        if (typeof seq === "number" && Number.isFinite(seq)) this._watermark.set(sid, seq);
      }
      const folded = Array.isArray(data.folded) ? data.folded : [];
      for (const sid of folded) {
        // A folded id is only meaningful together with its watermark.
        if (typeof sid === "string" && this._watermark.has(sid)) this._folded.add(sid);
      }
      const modelMeta = data.modelMeta || {};
      for (const key of Object.keys(modelMeta)) {
        const meta = modelMeta[key];
        if (!meta || typeof meta !== "object") continue;
        this._modelMeta.set(key, {
          key: typeof meta.key === "string" ? meta.key : key,
          name: typeof meta.name === "string" ? meta.name : key,
          provider: typeof meta.provider === "string" ? meta.provider : "",
        });
      }
      const days = data.days || {};
      for (const dk of Object.keys(days)) {
        const models = days[dk];
        if (!models || typeof models !== "object") continue;
        const day = new Map();
        for (const key of Object.keys(models)) {
          const rec = models[key];
          if (!rec || typeof rec !== "object") continue;
          day.set(key, {
            input: Number(rec.input) || 0,
            output: Number(rec.output) || 0,
            cacheRead: Number(rec.cacheRead) || 0,
            cacheWrite: Number(rec.cacheWrite) || 0,
            reasoning: Number(rec.reasoning) || 0,
            total: Number(rec.total) || 0,
          });
        }
        if (day.size > 0) this._byDay.set(dk, day);
      }
    } catch (e) {
      /* missing or corrupt store: start empty and let backfill do a full scan */
    }
  }

  /** Debounced async persist (trailing edge); cheap to call on every fold. */
  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveNow();
    }, SAVE_DEBOUNCE_MS);
    if (typeof this._saveTimer.unref === "function") this._saveTimer.unref();
  }

  async _saveNow() {
    if (!this._dirty || this._saving) return;
    this._dirty = false;
    this._saving = true;
    try {
      const text = this._serializeStore();
      await mkdir(STORE_DIR, { recursive: true });
      const tmp = `${STORE_FILE}.tmp`;
      await writeFile(tmp, text, "utf8");
      await rename(tmp, STORE_FILE);
    } catch (e) {
      this._dirty = true; // retried on the next trigger or the dispose flush
    } finally {
      this._saving = false;
    }
  }

  /** Synchronous flush for plugin disposal (async may not get loop turns). */
  _saveSync() {
    try {
      const text = this._serializeStore();
      mkdirSync(STORE_DIR, { recursive: true });
      const tmp = `${STORE_FILE}.tmp`;
      writeFileSync(tmp, text, "utf8");
      renameSync(tmp, STORE_FILE);
      this._dirty = false;
    } catch (e) {
      /* shutdown flush is best-effort */
    }
  }

  // ---- Remote API -----------------------------------------------------------

  /**
   * Whole-dataset snapshot for the Client: every day (last WINDOW_DAYS) with
   * per-model aggregates, plus the ordered model list. The Client derives the
   * 7/30-day windows, the stacked bar chart, the donut, and the heatmap from
   * this single payload, so tab switching needs no extra round trips.
   */
  async getStats() {
    if (!this._backfill.started && !this._backfill.done) this._startBackfill();
    const cutoff = Date.now() - WINDOW_DAYS * DAY_MS;
    const days = [];
    for (const [dk, day] of this._byDay) {
      const t = new Date(`${dk}T00:00:00`).getTime();
      if (!Number.isNaN(t) && t < cutoff) continue;
      const models = [];
      let total = 0;
      for (const [key, rec] of day) {
        const meta = this._modelMeta.get(key) || { key, name: key, provider: "" };
        models.push({
          key: meta.key,
          name: meta.name,
          provider: meta.provider,
          input: rec.input,
          output: rec.output,
          cacheRead: rec.cacheRead,
          cacheWrite: rec.cacheWrite,
          reasoning: rec.reasoning,
          total: rec.total,
        });
        total += rec.total;
      }
      models.sort((a, b) => b.total - a.total);
      days.push({ date: dk, total, models });
    }
    days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const models = [];
    for (const meta of this._modelMeta.values()) {
      models.push({ key: meta.key, name: meta.name, provider: meta.provider });
    }
    return {
      ok: true,
      value: {
        ready: this._backfill.done,
        collecting: this._backfill.started && !this._backfill.done,
        progress: { done: this._backfill.doneCount, total: this._backfill.total },
        error: this._backfill.error,
        days,
        models,
      },
    };
  }
}

export default TokenStatsService;
