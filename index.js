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
 *
 * Aggregates are kept per local calendar day per model key
 * (`<provider>::<model>`), which is exactly what the Client charts consume.
 */

import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { Service } from "@deepseek-ai/cordis";

const DAY_MS = 86400000;
/** How many days of history to keep (a bit over one year). */
const WINDOW_DAYS = 400;

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
    if (!usage || typeof usage !== "object") return;
    const input = Number(usage.inputTokens) || 0;
    const output = Number(usage.outputTokens) || 0;
    const cr = Number(usage.cacheReadTokens) || 0;
    const cw = Number(usage.cacheWriteTokens) || 0;
    const reason = Number(usage.reasoningTokens) || 0;
    const total = input + output + cr + cw;
    if (total <= 0) return;
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
  }

  /** Fold one `assistant/message` event (model provenance + usage). */
  _foldEvent(event) {
    try {
      if (!event || typeof event !== "object" || event.type !== "assistant/message") return;
      const data = event.data;
      if (!data || !data.usage) return;
      const src = data.message && data.message.source;
      if (!src || src.kind !== "model") return;
      this._addUsage(
        src.provider || "",
        src.model || "",
        data.usage,
        typeof event.time === "number" ? event.time : Date.now(),
      );
    } catch (e) {
      /* keep stats robust */
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
      this._foldEvent(event);
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
          } catch (e) {
            /* skip unreadable session */
          }
          this._backfill.doneCount++;
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      this._backfill.done = true;
    } catch (e) {
      this._backfill.error = String((e && e.message) || e);
      this._backfill.done = true;
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
