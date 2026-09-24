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
 *
 * A second Remote method, `getQuota(provider, force)`, reports one provider's
 * coding-plan quota / balance (minimax / deepseek / kimi / openrouter / zhipu /
 * mimo) for the composer readout — adapted from dsh-musage (MIT). It resolves
 * the user-configured API key through the `credentials` service, GETs the
 * provider's endpoint (global fetch, curl via `subprocess` as fallback), and
 * caches per provider (30 s TTL, exponential backoff on failure). In-memory
 * only; nothing below touches the persisted stats store.
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

/* ======================================================================
 * Provider quota / balance (套餐余额) — adapted from dsh-musage
 * (https://github.com/Thedeergod666/dsh-musage, MIT).
 *
 * Per provider: resolve the user's already-configured API key through the
 * DSH `credentials` service (ref naming follows the settings page's
 * `<ROUTE>_API_KEY` derivation, e.g. minimax-cn → MINIMAX_CN_API_KEY;
 * deepseek-official ships an explicit apiKeyEnv: DEEPSEEK_API_KEY), GET the
 * provider's plan/balance endpoint (global fetch first — the host runs on a
 * modern Node/Electron runtime; curl via the `subprocess` service as the
 * fallback), parse into a compact `display` payload, and cache per provider
 * (30 s TTL on success, exponential backoff up to 30 min on failure).
 * ==================================================================== */

const QUOTA_CACHE_TTL_MS = 30000;
const QUOTA_BACKOFF_BASE_MS = 5000;
const QUOTA_BACKOFF_MAX_MS = 30 * 60 * 1000;
const QUOTA_REQUEST_TIMEOUT_MS = 15000;

const QUOTA_PROVIDERS = {
  minimax: {
    refs: ["MINIMAX_CN_API_KEY", "MINIMAX_EN_API_KEY", "MINIMAX_API_KEY"],
    urls: {
      MINIMAX_CN_API_KEY: "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
      MINIMAX_EN_API_KEY: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
      MINIMAX_API_KEY: "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
    },
    parse: parseMinimaxResponse,
  },
  deepseek: {
    refs: ["DEEPSEEK_API_KEY", "DEEPSEEK_OFFICIAL_API_KEY"],
    urls: {
      DEEPSEEK_API_KEY: "https://api.deepseek.com/user/balance",
      DEEPSEEK_OFFICIAL_API_KEY: "https://api.deepseek.com/user/balance",
    },
    parse: parseDeepseekBalance,
  },
  kimi: {
    refs: ["KIMI_CODING_API_KEY", "KIMI_API_KEY"],
    urls: {
      KIMI_CODING_API_KEY: "https://api.kimi.com/coding/v1/usages",
      KIMI_API_KEY: "https://api.kimi.com/coding/v1/usages",
    },
    parse: parseKimiResponse,
  },
  openrouter: {
    refs: ["OPENROUTER_API_KEY"],
    urls: {
      OPENROUTER_API_KEY: "https://openrouter.ai/api/v1/credits",
    },
    parse: parseOpenrouterResponse,
  },
  zhipu: {
    refs: ["ZAI_CODING_CN_API_KEY", "ZHIPU_API_KEY"],
    urls: {
      ZAI_CODING_CN_API_KEY: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
      ZHIPU_API_KEY: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    },
    parse: parseZhipuResponse,
    // 智谱特殊: Authorization 不加 "Bearer " 前缀 (来自 Musage zhipu.rs 注释)
    authStyle: "raw",
  },
  // Xiaomi MiMo Token Plan — dashboard admin API（非公开 endpoint）：
  // Bearer 实测 401（session 守护），可靠路径是登录 Cookie；单个凭证值先
  // Bearer 后 Cookie 自动重试（对齐 Musage xiaomi.rs 的 BearerThenCookie）。
  // 在 DSH 凭据里把浏览器 DevTools 复制的完整 Cookie 或 API Key 配到
  // XIAOMI_MIMO_API_KEY / XIAOMI_MIMO_COOKIE（或 MIMO_*）任一 ref。
  mimo: {
    refs: ["XIAOMI_MIMO_API_KEY", "XIAOMI_MIMO_COOKIE", "MIMO_API_KEY", "MIMO_COOKIE"],
    urls: {
      XIAOMI_MIMO_API_KEY: "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage",
      XIAOMI_MIMO_COOKIE: "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage",
      MIMO_API_KEY: "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage",
      MIMO_COOKIE: "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage",
    },
    parse: parseMimoResponse,
  },
};

/** Xiaomi MiMo dashboard admin API endpoints（usage + detail，鉴权同一凭证）。 */
const MIMO_USAGE_URL = "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage";
const MIMO_DETAIL_URL = "https://platform.xiaomimimo.com/api/v1/tokenPlan/detail";

function quotaBackoffMs(streak) {
  if (streak <= 0) return 0;
  return Math.min(QUOTA_BACKOFF_MAX_MS, QUOTA_BACKOFF_BASE_MS * Math.pow(2, streak - 1));
}

function parseEndTime(v) {
  if (typeof v !== "number") return null;
  if (v >= 1e12 && v <= 4e12) return v;
  return Date.now() + v * 1000;
}

// ----- minimax parser (2026-06-01 起 percent-based / count-based 双 schema) -----

function parseMinimaxResponse(body) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, kind: "parse", message: "JSON 解析失败" };
  }
  const baseResp = json && json.base_resp;
  if (!baseResp || baseResp.status_code !== 0) {
    return {
      ok: false,
      kind: "server_error",
      message: (baseResp && baseResp.status_msg) || "API 返回 base_resp.status_code != 0",
    };
  }
  const arr = json && json.model_remains;
  if (!Array.isArray(arr) || arr.length === 0) {
    return { ok: false, kind: "parse", message: "model_remains 为空" };
  }
  const entry = arr.find((r) => r && r.model_name === "general") || arr[0];
  if (!entry) return { ok: false, kind: "parse", message: "找不到可用 model_remains 条目" };

  const fiveHour = parseMinimaxWindow(entry, "current_interval_", "current_interval_usage_count", "current_interval_total_count", "end_time");
  const weekly = parseMinimaxWindow(entry, "current_weekly_", "current_weekly_usage_count", "current_weekly_total_count", "weekly_end_time");

  if (!fiveHour && !weekly) {
    return { ok: false, kind: "schema_unknown", message: "MiniMax 响应字段都不认识" };
  }
  return {
    ok: true,
    provider: "minimax",
    display: {
      fiveHrPct: fiveHour ? Math.max(0, Math.min(100, Math.round(fiveHour.usedPercent))) : null,
      weeklyPct: weekly ? Math.max(0, Math.min(100, Math.round(weekly.usedPercent))) : null,
      fiveHrResetsIn: fiveHour ? formatResetsIn(fiveHour.resetsAt) : null,
      weeklyResetsIn: weekly ? formatResetsIn(weekly.resetsAt) : null,
    },
  };
}

function parseMinimaxWindow(entry, prefix, legacyRemaining, legacyTotal, endTimeKey) {
  const newPercent = entry[prefix + "remaining_percent"];
  const newStatus = entry[prefix + "status"];
  if (typeof newPercent === "number" && newStatus === 1) {
    return {
      usedPercent: Math.max(0, 100 - newPercent),
      resetsAt: parseEndTime(entry[endTimeKey]),
    };
  }
  const total = entry[prefix + "total_count"];
  const remaining = entry[legacyRemaining] || entry[prefix + "usage_count"];
  if (typeof total === "number" && total > 0 && typeof remaining === "number") {
    return {
      usedPercent: Math.max(0, ((total - remaining) / total) * 100),
      resetsAt: parseEndTime(entry[endTimeKey]),
    };
  }
  return null;
}

// ----- deepseek balance parser -----
//   { "is_available": true,
//     "balance_infos": [ { "currency": "CNY", "total_balance": "43.97",
//                            "granted_balance": "0.00", "topped_up_balance": "43.97" } ] }

function parseDeepseekBalance(body) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, kind: "parse", message: "JSON 解析失败" };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, kind: "parse", message: "DeepSeek 响应不是对象" };
  }
  if (json.is_available === false) {
    return { ok: false, kind: "server_error", message: "DeepSeek 账号 is_available=false" };
  }
  const infos = json.balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) {
    return { ok: false, kind: "parse", message: "balance_infos 字段为空" };
  }
  const first = infos[0];
  const totalStr = first && first.total_balance;
  if (typeof totalStr !== "string" && typeof totalStr !== "number") {
    return { ok: false, kind: "parse", message: "balance_infos[0].total_balance 不存在" };
  }
  const balance = parseFloat(totalStr);
  if (!isFinite(balance)) {
    return { ok: false, kind: "parse", message: "balance 解析成数字失败: " + totalStr };
  }
  const currency = (first && first.currency) || "USD";
  return {
    ok: true,
    provider: "deepseek",
    currency,
    display: {
      balanceUsd: balance,
      balanceText: formatBalance(balance, currency),
    },
  };
}

// ----- kimi parser (5h 窗口 + 7d 窗口) -----
//   { "limits": [ { "detail": { "limit": 100, "remaining": 72, "resetTime": "..." } } ],
//     "usage": { "limit": 1000, "remaining": 742, "resetTime": 1749840000 } }

function parseKimiResponse(body) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, kind: "parse", message: "JSON 解析失败" };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, kind: "parse", message: "Kimi 响应不是对象" };
  }
  if (json.code && json.code !== 200 && json.code !== "200") {
    return { ok: false, kind: "server_error", message: "Kimi 返错: " + (json.code || "?") + " · " + (json.msg || "") };
  }
  const firstLimit = Array.isArray(json.limits) && json.limits[0] && json.limits[0].detail;
  const five = firstLimit || {};
  const fiveHrLimit = Number(five.limit) || 0;
  const fiveHrRemaining = Number(five.remaining) || 0;
  const fiveHrResetsAt = parseKimiResetTime(five.resetTime);
  const week = json.usage || {};
  const weeklyLimit = Number(week.limit) || 0;
  const weeklyRemaining = Number(week.remaining) || 0;
  const weeklyResetsAt = parseKimiResetTime(week.resetTime);
  if (!fiveHrLimit && !weeklyLimit) {
    return { ok: false, kind: "parse", message: "Kimi 响应没有 5h/7d 限额" };
  }
  return {
    ok: true,
    provider: "kimi",
    display: {
      fiveHrPct: fiveHrLimit > 0 ? Math.round(((fiveHrLimit - fiveHrRemaining) / fiveHrLimit) * 100) : null,
      weeklyPct: weeklyLimit > 0 ? Math.round(((weeklyLimit - weeklyRemaining) / weeklyLimit) * 100) : null,
      fiveHrResetsIn: fiveHrResetsAt ? formatResetsIn(fiveHrResetsAt) : null,
      weeklyResetsIn: weeklyResetsAt ? formatResetsIn(weeklyResetsAt) : null,
    },
  };
}

function parseKimiResetTime(v) {
  if (typeof v === "number") {
    if (v >= 1e12 && v <= 4e12) return v;
    if (v > 1e9) return v * 1000;
    return null;
  }
  if (typeof v === "string" && v.length > 0) {
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  return null;
}

// ----- openrouter parser (total_credits - total_usage) -----

function parseOpenrouterResponse(body) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, kind: "parse", message: "JSON 解析失败" };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, kind: "parse", message: "OpenRouter 响应不是对象" };
  }
  const data = json.data;
  if (!data || typeof data !== "object") {
    return { ok: false, kind: "parse", message: "data 字段缺失" };
  }
  const total = Number(data.total_credits);
  const used = Number(data.total_usage);
  if (!isFinite(total) || !isFinite(used)) {
    return { ok: false, kind: "parse", message: "total_credits / total_usage 不是数字" };
  }
  const remaining = total - used;
  return {
    ok: true,
    provider: "openrouter",
    currency: "USD",
    display: {
      balanceUsd: remaining,
      balanceText: formatBalance(remaining, "USD"),
    },
  };
}

// ----- zhipu (智谱 GLM Coding Plan) parser -----
//   { "code": 200, "success": true,
//     "data": { "limits": [ { "type": "CREDIT_LIMIT", "unit": 3, "usage": 2000,
//                "remaining": 0, "percentage": 100, "nextResetTime": 1786969101067 }, ... ] } }
// unit=3 是 5h 窗口, unit=6 是周窗口. percentage 直接是已用 0-100 (服务器算好).

function parseZhipuResponse(body) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, kind: "parse", message: "JSON 解析失败" };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, kind: "parse", message: "智谱响应不是对象" };
  }
  if (json.success === false) {
    return { ok: false, kind: "server_error", message: "智谱 success=false · " + (json.msg || "") };
  }
  const data = json.data;
  if (!data || !Array.isArray(data.limits)) {
    return { ok: false, kind: "parse", message: "data.limits 缺失" };
  }
  const fiveHr = data.limits.find((l) => l && (l.unit === 3 || l.unit === "3"));
  const weekly = data.limits.find((l) => l && (l.unit === 6 || l.unit === "6"));
  if (!fiveHr && !weekly) {
    return { ok: false, kind: "parse", message: "找不到 unit=3 (5h) 或 unit=6 (周) 的 limit" };
  }
  function pickWindow(w) {
    if (!w) return null;
    const limit = Number(w.usage) || 0;
    const remaining = Number(w.remaining) || 0;
    const pct = typeof w.percentage === "number" ? w.percentage : limit > 0 ? Math.round(((limit - remaining) / limit) * 100) : null;
    const resetsAt = parseEndTime(w.nextResetTime);
    return { usedPercent: pct, resetsAt };
  }
  const f = pickWindow(fiveHr);
  const w = pickWindow(weekly);
  return {
    ok: true,
    provider: "zhipu",
    display: {
      fiveHrPct: f ? f.usedPercent : null,
      weeklyPct: w ? w.usedPercent : null,
      fiveHrResetsIn: f && f.resetsAt ? formatResetsIn(f.resetsAt) : null,
      weeklyResetsIn: w && w.resetsAt ? formatResetsIn(w.resetsAt) : null,
    },
  };
}

function formatBalance(n, currency) {
  const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : "";
  return symbol + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
}

// ----- xiaomi mimo (小米 MiMo Token Plan) parser -----
//   { "code": 0,
//     "data": {
//       "usage":      { "items": [ {"name":"plan_total_token","percent":0.13}, ... ] },
//       "monthUsage": { "items": [ {"name":"month_total_token","percent":0.42} ] } } }
// percent 是 0-1 小数（×100 得百分比）；detail 端给 currentPeriodEnd（UTC 字符串）
// 与 expired。套餐/总额度相差 <0.5pt 视为同一份额度（去重，对齐 Musage）。
// 业务 code 40100..40199 等价于 HTTP 401（凭据失效）。

function mimoItemPct(item) {
  if (!item || typeof item !== "object") return null;
  if (typeof item.percent === "number" && isFinite(item.percent)) {
    return Math.max(0, Math.min(100, Math.round(item.percent * 100)));
  }
  const used = Number(item.used);
  const limit = Number(item.limit);
  if (isFinite(used) && isFinite(limit) && limit > 0) {
    return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
  }
  return null;
}

function parseMimoResponse(body, detailBody) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, provider: "mimo", kind: "parse", message: "JSON 解析失败" };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, provider: "mimo", kind: "parse", message: "MiMo 响应不是对象" };
  }
  if (typeof json.code === "number" && json.code !== 0) {
    if (json.code >= 40100 && json.code < 40200) {
      return {
        ok: false,
        provider: "mimo",
        kind: "auth_failed",
        message: "MiMo 凭据已失效（Cookie 过期或未登录），请到 platform.xiaomimimo.com 重新复制",
      };
    }
    return {
      ok: false,
      provider: "mimo",
      kind: "server_error",
      message: "MiMo 业务错误 code=" + json.code + " · " + (json.message || ""),
    };
  }
  const data = json.data;
  if (!data || typeof data !== "object") {
    return { ok: false, provider: "mimo", kind: "parse", message: "MiMo 响应缺少 data 字段" };
  }

  let resetsAt = null;
  let expired = false;
  if (detailBody) {
    let detail;
    try {
      detail = typeof detailBody === "string" ? JSON.parse(detailBody) : detailBody;
    } catch {
      detail = null;
    }
    const dd = detail && detail.data;
    if (dd && typeof dd === "object") {
      if (dd.expired === true) expired = true;
      if (typeof dd.currentPeriodEnd === "string" && dd.currentPeriodEnd) {
        const t = Date.parse(dd.currentPeriodEnd.replace(" ", "T") + "Z");
        if (!isNaN(t)) resetsAt = t;
      }
    }
  }
  if (expired) {
    return {
      ok: false,
      provider: "mimo",
      kind: "plan_expired",
      message: "MiMo Token 套餐已过期，请到 platform.xiaomimimo.com 续费",
    };
  }

  const usageItems = data.usage && Array.isArray(data.usage.items) ? data.usage.items : [];
  const monthItems = data.monthUsage && Array.isArray(data.monthUsage.items) ? data.monthUsage.items : [];
  const findPct = (items, name) => {
    const hit = items.find((it) => it && it.name === name);
    return hit ? mimoItemPct(hit) : null;
  };
  let planPct = findPct(usageItems, "plan_total_token");
  let monthPct = findPct(monthItems, "month_total_token");

  if (planPct === null && monthPct === null) {
    if (usageItems.length > 0 || monthItems.length > 0) {
      const names = usageItems.concat(monthItems).map((it) => it && it.name).filter(Boolean).join(",");
      return {
        ok: false,
        provider: "mimo",
        kind: "schema_unknown",
        message: "MiMo 响应字段都不认识（items: " + names + "）",
      };
    }
    return { ok: false, provider: "mimo", kind: "parse", message: "MiMo usage.items 为空（套餐可能已过期）" };
  }
  // 套餐与月度总额度是同一份额度时只显示一行（Musage 0.5pt 去重阈值）
  if (planPct !== null && monthPct !== null && Math.abs(monthPct - planPct) < 0.5) {
    monthPct = null;
  }
  const resetsIn = resetsAt ? formatResetsIn(resetsAt) : null;
  return {
    ok: true,
    provider: "mimo",
    display: {
      fiveHrPct: planPct,
      weeklyPct: monthPct,
      fiveHrResetsIn: planPct !== null ? resetsIn : null,
      weeklyResetsIn: monthPct !== null ? resetsIn : null,
      balanceText: null,
      balanceUsd: null,
      currency: null,
    },
  };
}

function formatResetsIn(resetsAtMs) {
  if (typeof resetsAtMs !== "number" || !resetsAtMs) return "";
  const ms = resetsAtMs - Date.now();
  if (ms <= 0) return "即将重置";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return h + "h" + m + "m 后重置";
  return m + "m 后重置";
}

function classifyQuotaHttpStatus(status) {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth_failed";
  return "server_error";
}

function parseCurlOutput(rawText) {
  if (typeof rawText !== "string") return { body: "", statusCode: 0 };
  const lastNl = rawText.lastIndexOf("\n");
  if (lastNl < 0) return { body: rawText, statusCode: 0 };
  const body = rawText.slice(0, lastNl);
  const statusCode = parseInt(rawText.slice(lastNl + 1).trim(), 10);
  if (isNaN(statusCode)) return { body: rawText, statusCode: 0 };
  return { body, statusCode };
}

/** Trim a parser result to the exact wire shape declared in typert.host.js. */
function quotaWireValue(parsed) {
  if (!parsed || parsed.ok !== true) {
    return {
      ok: false,
      provider: (parsed && parsed.provider) || "",
      kind: (parsed && parsed.kind) || "other",
      message: (parsed && parsed.message) || "未知错误",
    };
  }
  const d = parsed.display || {};
  return {
    ok: true,
    provider: parsed.provider,
    display: {
      fiveHrPct: typeof d.fiveHrPct === "number" && isFinite(d.fiveHrPct) ? d.fiveHrPct : null,
      weeklyPct: typeof d.weeklyPct === "number" && isFinite(d.weeklyPct) ? d.weeklyPct : null,
      fiveHrResetsIn: typeof d.fiveHrResetsIn === "string" && d.fiveHrResetsIn ? d.fiveHrResetsIn : null,
      weeklyResetsIn: typeof d.weeklyResetsIn === "string" && d.weeklyResetsIn ? d.weeklyResetsIn : null,
      balanceText: typeof d.balanceText === "string" && d.balanceText ? d.balanceText : null,
      balanceUsd: typeof d.balanceUsd === "number" && isFinite(d.balanceUsd) ? d.balanceUsd : null,
      currency: typeof parsed.currency === "string" ? parsed.currency : null,
    },
  };
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
   * service is published. Mark the Remote methods, then start collecting.
   *
   * 0.1.7-rc.1 hardening: with dsh 0.1.7, a required plugin whose activation
   * rejects can take the whole profile down (the startup page names the failing
   * plugin and DSH never reaches the chat). So every step after the state
   * fields are initialized is best-effort: a failure leaves the service
   * registered and answering (getStats reports the error) instead of failing
   * activation.
   */
  [Service.init]() {
    // State first: whatever later step fails, the Remote methods below must
    // always find consistent in-memory state to answer with.
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

    // Quota fetch state: per-provider cache entries + the credential ref that
    // last resolved for each provider. In-memory only (no persistence).
    this._quotaCache = Object.create(null);
    this._quotaActiveRef = Object.create(null);
    this._curlPath = null;

    try {
      markRemoteMethod(this, "getStats", "getStats");
    } catch (e) {
      this._backfill.error = "getStats 未发布: " + String((e && e.message) || e);
    }
    try {
      markRemoteMethod(this, "getQuota", "getQuota");
    } catch (e) {
      this._backfill.error = "getQuota 未发布: " + String((e && e.message) || e);
    }
    try {
      markRemoteMethod(this, "getAllQuotas", "getAllQuotas");
    } catch (e) {
      this._backfill.error = "getAllQuotas 未发布: " + String((e && e.message) || e);
    }

    // Restore the previous run's aggregates so a cold start only scans new sessions.
    try {
      this._loadStore();
    } catch (e) {
      /* missing or corrupt store: start empty and let backfill do a full scan */
    }

    // Best-effort synchronous flush when the plugin fiber is disposed.
    try {
      this.ctx.effect(() => () => {
        if (this._saveTimer) {
          clearTimeout(this._saveTimer);
          this._saveTimer = null;
        }
        if (this._dirty) this._saveSync();
      });
    } catch (e) {
      this._backfill.error = "持久化刷新未注册: " + String((e && e.message) || e);
    }

    // Live capture: every committed session append.
    try {
      this.ctx.on("session/event", (session, event) => this._onSessionEvent(session, event));
    } catch (e) {
      this._backfill.error = "实时采集未注册: " + String((e && e.message) || e);
    }

    try {
      const backfill = this._startBackfill();
      if (backfill && typeof backfill.catch === "function") backfill.catch(() => {});
    } catch (e) {
      this._backfill.error = "历史回填启动失败: " + String((e && e.message) || e);
    }
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

  // ---- quota / balance (套餐余额) --------------------------------------------

  /**
   * Resolve the API key for one provider through the DSH credentials seam.
   * Ref candidates follow the settings page's `<ROUTE>_API_KEY` derivation and
   * each provider's shipped default `apiKeyEnv`; without the credentials
   * service (headless deployment) the process environment is consulted.
   */
  async _quotaApiKey(provider) {
    const cfg = QUOTA_PROVIDERS[provider];
    if (!cfg) return { ref: null, key: null };
    const credentials = this.ctx.get("credentials");
    const candidates = this._quotaActiveRef[provider]
      ? [this._quotaActiveRef[provider], ...cfg.refs.filter((r) => r !== this._quotaActiveRef[provider])]
      : cfg.refs;
    for (const ref of candidates) {
      try {
        if (credentials && typeof credentials.resolve === "function") {
          const hit = await credentials.resolve(ref);
          if (hit && hit.value) {
            this._quotaActiveRef[provider] = ref;
            return { ref, key: hit.value };
          }
        } else if (typeof process !== "undefined" && process.env && process.env[ref]) {
          this._quotaActiveRef[provider] = ref;
          return { ref, key: process.env[ref] };
        }
      } catch (e) {
        /* try the next ref */
      }
    }
    return { ref: null, key: null };
  }

  async _resolveCurl() {
    if (this._curlPath) return this._curlPath;
    const subprocess = this.ctx.get("subprocess");
    if (!subprocess || typeof subprocess.resolveExecutable !== "function") {
      throw new Error("subprocess service 不可用, 且宿主无全局 fetch");
    }
    this._curlPath = await subprocess.resolveExecutable("curl");
    return this._curlPath;
  }

  /** curl fallback for hosts without a global fetch (same shape as musage). */
  async _curlGet(url, key, authStyle) {
    const subprocess = this.ctx.get("subprocess");
    if (!subprocess || typeof subprocess.spawn !== "function") {
      return { ok: false, kind: "network", message: "subprocess service 不可用, 且宿主无全局 fetch" };
    }
    const c = await this._resolveCurl();
    const authHeader =
      authStyle === "raw"
        ? "Authorization: " + key
        : authStyle === "cookie"
          ? "Cookie: " + key
          : "Authorization: Bearer " + key;
    const handle = subprocess.spawn({
      argv: [
        c, "-sS",
        "--max-time", String(Math.floor(QUOTA_REQUEST_TIMEOUT_MS / 1000)),
        "-w", "\n%{http_code}",
        "-H", authHeader,
        "-H", "Accept: application/json",
        url,
      ],
      cwd: "/",
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: 8 * 1024 * 1024 },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: QUOTA_REQUEST_TIMEOUT_MS,
    });
    const outcome = await handle.done;
    const stdout = handle.collected && handle.collected.stdout
      ? handle.collected.stdout.readFrom(0)
      : { text: "" };
    const stderr = handle.collected && handle.collected.stderr
      ? handle.collected.stderr.readFrom(0)
      : { text: "" };
    if (outcome.exitCode !== 0) {
      return { ok: false, kind: "network", message: "curl 退出 " + outcome.exitCode + " · " + stderr.text.slice(0, 200) };
    }
    const { body, statusCode } = parseCurlOutput(stdout.text);
    if (statusCode === 0) {
      return { ok: false, kind: "network", message: "curl 输出没拿到 HTTP 状态: " + stdout.text.slice(0, 200) };
    }
    if (statusCode !== 200) {
      return {
        ok: false,
        kind: classifyQuotaHttpStatus(statusCode),
        httpStatus: statusCode,
        message: "HTTP " + statusCode + " · " + body.slice(0, 200),
      };
    }
    return { ok: true, body };
  }

  /** GET one provider endpoint with its API key; fetch first, curl fallback. */
  async _httpGet(url, key, authStyle) {
    if (typeof fetch === "function") {
      try {
        const headers = { accept: "application/json" };
        // authStyle: undefined → Bearer； "raw" → 原样 Authorization（智谱）；
        // "cookie" → 整串 Cookie 头（小米 MiMo dashboard admin API）。
        if (authStyle === "cookie") headers.cookie = key;
        else headers.authorization = authStyle === "raw" ? key : "Bearer " + key;
        const res = await fetch(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(QUOTA_REQUEST_TIMEOUT_MS),
        });
        const body = await res.text();
        if (res.status !== 200) {
          return {
            ok: false,
            kind: classifyQuotaHttpStatus(res.status),
            httpStatus: res.status,
            message: "HTTP " + res.status + " · " + body.slice(0, 200),
          };
        }
        return { ok: true, body };
      } catch (e) {
        return { ok: false, kind: "network", message: "fetch 失败: " + String((e && e.message) || e) };
      }
    }
    return this._curlGet(url, key, authStyle);
  }

  async _fetchProviderQuota(provider) {
    const cfg = QUOTA_PROVIDERS[provider];
    if (!cfg) {
      return { ok: false, provider, kind: "other", message: "未知 provider: " + provider };
    }
    const { ref, key } = await this._quotaApiKey(provider);
    if (!key) {
      return {
        ok: false,
        provider,
        kind: "unconfigured",
        message: "未配置 " + provider + " API Key (在 DSH 模型设置里配置对应 provider)",
      };
    }
    if (provider === "mimo") return this._fetchMimoQuota(key);
    const url = cfg.urls[ref] || cfg.urls[cfg.refs[0]];
    const raw = await this._httpGet(url, key, cfg.authStyle);
    if (!raw.ok) return { ...raw, provider };
    return cfg.parse(raw.body);
  }

  /**
   * Xiaomi MiMo Token Plan（dashboard admin API，契约来自 Musage xiaomi.rs）：
   * 同一凭证值先按 Bearer 试，401/403 时原样改 `Cookie:` 头重试；usage 成功
   * 后再 best-effort 拉一次 detail（周期结束时间 / 过期标记）。detail 失败
   * 不影响 usage 结果（只是没有重置倒计时）。
   */
  async _fetchMimoQuota(key) {
    let raw = await this._httpGet(MIMO_USAGE_URL, key, undefined);
    let cookie = false;
    if (!raw.ok && (raw.httpStatus === 401 || raw.httpStatus === 403)) {
      raw = await this._httpGet(MIMO_USAGE_URL, key, "cookie");
      cookie = true;
    }
    if (!raw.ok) return { ...raw, provider: "mimo" };
    const detail = await this._httpGet(MIMO_DETAIL_URL, key, cookie ? "cookie" : undefined);
    return parseMimoResponse(raw.body, detail && detail.ok ? detail.body : null);
  }

  /**
   * Cached per-provider quota read. Success caches for 30 s; failures cache
   * with exponential backoff (5 s → 30 min cap) so a broken provider is not
   * hammered. `force` drops the cached entry before reading (手动刷新).
   */
  async _getQuotaCached(provider, force) {
    if (force) this._quotaCache[provider] = null;
    const c = this._quotaCache[provider];
    if (c && c.expiresAt > Date.now()) return c.value;
    const value = quotaWireValue(await this._fetchProviderQuota(provider));
    if (value.ok) {
      this._quotaCache[provider] = { value, expiresAt: Date.now() + QUOTA_CACHE_TTL_MS, streak: 0 };
    } else {
      const streak = (c ? c.streak : 0) + 1;
      this._quotaCache[provider] = { value, expiresAt: Date.now() + quotaBackoffMs(streak), streak };
    }
    return value;
  }

  /**
   * Plan quota / balance for one provider (`minimax` | `deepseek` | `kimi` |
   * `openrouter` | `zhipu` | `mimo`). The composer readout in the Client half
   * calls this for the session's active provider (and on click with force=true).
   */
  async getQuota(provider, force) {
    const p = typeof provider === "string" ? provider : "";
    if (!QUOTA_PROVIDERS[p]) {
      return { ok: true, value: { ok: false, provider: p, kind: "other", message: "未知 provider: " + p } };
    }
    try {
      return { ok: true, value: await this._getQuotaCached(p, force === true) };
    } catch (e) {
      return { ok: true, value: { ok: false, provider: p, kind: "other", message: String((e && e.message) || e) } };
    }
  }

  /**
   * Quota snapshot for every supported provider at once (设置页余额区块).
   * Providers are queried in parallel; each entry is the same wire value
   * getQuota returns. `force` bypasses every provider's cache.
   */
  async getAllQuotas(force) {
    const names = Object.keys(QUOTA_PROVIDERS);
    const values = await Promise.all(
      names.map(async (p) => {
        try {
          return await this._getQuotaCached(p, force === true);
        } catch (e) {
          return quotaWireValue({ ok: false, provider: p, kind: "other", message: String((e && e.message) || e) });
        }
      }),
    );
    const quotas = {};
    for (let i = 0; i < names.length; i++) quotas[names[i]] = values[i];
    return { ok: true, value: { quotas } };
  }
}

export default TokenStatsService;
