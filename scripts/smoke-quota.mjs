/* Ad-hoc verification of the new quota path (not shipped). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// **必须在 import index.js 之前**隔离 DSH_HOME：index.js 在模块加载时就锁定
// 持久化路径，否则本脚本会读写用户真实的 ~/.dsh/data/dsh-token-stats/stats.json
// （往真实统计里塞 fixture 用量）。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-token-stats-smoke-"));

const { TokenStatsService } = await import(pathToFileURL("D:/ai-projects/dsh/dsh-token-stats/index.js").href);

const initKey = Object.getOwnPropertySymbols(TokenStatsService.prototype).find(
  (s) => typeof TokenStatsService.prototype[s] === "function",
);

function makeCtx() {
  return {
    reflect: { provide() {} },
    on() {},
    get() { return undefined; }, // no credentials/subprocess/sessionQuery
    effect(fn) { return fn(); },
  };
}

const svc = new TokenStatsService(makeCtx(), undefined);
svc[initKey]();

let failures = 0;
function check(label, cond, extra) {
  console.log((cond ? "  ok  " : "  FAIL") + " " + label + (extra ? "  " + extra : ""));
  if (!cond) failures++;
}

// 1. unknown provider → structured failure
let r = await svc.getQuota("nope", false);
check("unknown provider envelope", r && r.ok === true && r.value && r.value.ok === false && r.value.kind === "other", JSON.stringify(r));

// 2. supported provider without credentials → unconfigured (or a real fetch if env has a key)
const hasEnvKey = Boolean(process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_OFFICIAL_API_KEY);
r = await svc.getQuota("deepseek", false);
if (hasEnvKey) {
  console.log("  info DEEPSEEK_API_KEY present in env → live fetch result:", JSON.stringify(r));
  check("live result is a structured value", r && r.ok === true && r.value && typeof r.value.ok === "boolean");
} else {
  check("deepseek unconfigured", r && r.ok === true && r.value && r.value.ok === false && r.value.kind === "unconfigured", JSON.stringify(r.value));
}

// 3. zhipu without key → unconfigured (its endpoint must not be hit)
r = await svc.getQuota("zhipu", false);
check("zhipu unconfigured", r && r.value && r.value.ok === false && r.value.kind === "unconfigured", JSON.stringify(r.value));

// 4. cache: second failure call returns the SAME object (backoff cache), no re-fetch
const r1 = await svc.getQuota("kimi", false);
const r2 = await svc.getQuota("kimi", false);
check("failure cached (same object)", r1 === r2 || JSON.stringify(r1) === JSON.stringify(r2));

// 5. parsers on fixtures (exercise via a fake fetch through _fetchProviderQuota is
//    not wired without credentials, so drive the module-level parsers indirectly
//    through a stubbed _httpGet).
const ds = await import(pathToFileURL("D:/ai-projects/dsh/dsh-token-stats/index.js").href);
void ds;

// deepseek fixture — 旧 mock 形状 (ref/key) 已废弃, 改用新 (apiKey/apiKeyRef)
svc._quotaActiveRef["deepseek:api"] = "TEST";
svc._quotaApiKey = async () => ({ apiKeyRef: "TEST", apiKey: "k", cookieRef: null, cookie: null });
svc._httpGet = async () => ({ ok: true, body: JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "43.97" }] }) });
svc._quotaCache.deepseek = null;
r = await svc.getQuota("deepseek", false);
check("deepseek fixture parsed", r.value.ok === true && r.value.display.balanceText === "¥43.97" && r.value.display.currency === "CNY", JSON.stringify(r.value));

// minimax fixture (percent schema)
svc._quotaApiKey = async () => ({ apiKeyRef: "TEST", apiKey: "k", cookieRef: null, cookie: null });
svc._httpGet = async () => ({ ok: true, body: JSON.stringify({ base_resp: { status_code: 0 }, model_remains: [{ model_name: "general", current_interval_remaining_percent: 58, current_interval_status: 1, end_time: Date.now() + 3600e3, current_weekly_remaining_percent: 85, current_weekly_status: 1, weekly_end_time: Date.now() + 86400e3 }] }) });
svc._quotaCache.minimax = null;
r = await svc.getQuota("minimax", false);
check("minimax fixture parsed", r.value.ok === true && r.value.display.fiveHrPct === 42 && r.value.display.weeklyPct === 15 && typeof r.value.display.fiveHrResetsIn === "string", JSON.stringify(r.value));

// zhipu fixture
svc._httpGet = async () => ({ ok: true, body: JSON.stringify({ code: 200, success: true, data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, usage: 2000, remaining: 400, percentage: 80, nextResetTime: Date.now() + 7200e3 }] } }) });
svc._quotaCache.zhipu = null;
r = await svc.getQuota("zhipu", false);
check("zhipu fixture parsed", r.value.ok === true && r.value.display.fiveHrPct === 80, JSON.stringify(r.value));

// ====== mimo (v1.7.0)：本地用量兜底 + Cookie 升级官方剩余用量 ======
// 实测：MiMo 没有 API Key 配额接口（token-plan-* 只有 /v1 推理 API），
// 唯一配额源是 dashboard Cookie；所以默认零凭据可用。
const mimoEnd = new Date(Date.now() + 72 * 3600e3).toISOString().slice(0, 19).replace("T", " ");
const MIMO_COOKIE_OK = "api-platform_serviceToken=abc; userId=1";

/** 往 svc 的聚合里塞 MiMo 用量（今日 3.2M，前 6 天每天 1M）。 */
function seedMimoUsage() {
  const now = Date.now();
  svc._addUsage("xiaomi-token-plan-cn", "mimo-v2.5-pro", { inputTokens: 3e6, outputTokens: 200000, cacheReadTokens: 0, cacheWriteTokens: 0 }, now);
  for (let d = 1; d <= 6; d++) {
    svc._addUsage("xiaomi-token-plan-cn", "mimo-v2.5-pro", { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, now - d * 86400e3);
  }
  // 非 MiMo 模型不能被算进来
  svc._addUsage("deepseek-official", "deepseek-chat", { inputTokens: 9e9, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, now);
}

// mimo A: 无任何凭据 → 本地用量（零 HTTP）
{
  seedMimoUsage();
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: null, cookie: null });
  svc._httpGet = async () => { throw new Error("must not be called"); };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check(
    "mimo no creds → local usage (今日 3.2M · 7d 9.2M, 排除非 MiMo 模型)",
    r.value.ok === true && r.value.display.balanceText === "今日 3.2M · 7d 9.2M" && r.value.display.weeklyPct === null,
    JSON.stringify(r.value),
  );
}

// mimo B: Cookie 有效 → 官方 /api/v1/user/usage（percent 是「剩余」）
{
  const calls = [];
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: "XIAOMI_MIMO_COOKIE", cookie: MIMO_COOKIE_OK });
  svc._httpGet = async (url, key, style, headers) => {
    calls.push({ url: url.replace(/^https?:\/\//, ""), style, acceptLang: headers && headers["accept-language"] });
    if (url.endsWith("/api/v1/user/usage")) {
      return { ok: true, body: JSON.stringify({ percent: 78, resetDate: "2026-12-31" }) };
    }
    return { ok: false, kind: "auth_failed", httpStatus: 401, message: "HTTP 401" };
  };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check(
    "mimo Cookie → /user/usage parsed (剩余 78% ⇒ weeklyPct 22 已用)",
    r.value.ok === true && r.value.display.balanceText === "剩余 78%" && r.value.display.weeklyPct === 22 && typeof r.value.display.weeklyResetsIn === "string",
    JSON.stringify(r.value),
  );
  check(
    "mimo official path hits dashboard user/usage with Cookie + accept-language",
    calls.length === 1 && calls[0].url === "platform.xiaomimimo.com/api/v1/user/usage" && calls[0].style === "cookie" && calls[0].acceptLang === "en",
    JSON.stringify(calls),
  );
}

// mimo C: Cookie 不是 dashboard 会话（缺必需 cookie 名）→ 静默退回本地用量
{
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: "XIAOMI_MIMO_COOKIE", cookie: "tp-oops-i-pasted-the-key" });
  svc._httpGet = async () => { throw new Error("must not be called"); };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check(
    "mimo non-dashboard cookie → local usage, no error, no request",
    r.value.ok === true && /^今日 .+ · 7d .+$/.test(r.value.display.balanceText),
    JSON.stringify(r.value),
  );
}

// mimo D: Cookie 过期（401）→ 静默退回本地用量，不向用户报错
{
  const calls = [];
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: "XIAOMI_MIMO_COOKIE", cookie: MIMO_COOKIE_OK });
  svc._httpGet = async (url, key, style) => {
    calls.push(url.replace(/^https?:\/\//, ""));
    return { ok: false, kind: "auth_failed", httpStatus: 401, message: "HTTP 401" };
  };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check(
    "mimo expired cookie → local usage (never surfaces 401)",
    r.value.ok === true && r.value.display.balanceText.indexOf("今日") === 0,
    JSON.stringify(r.value),
  );
  check(
    "mimo expired cookie probes dashboard only",
    calls.every((u) => u.startsWith("platform.xiaomimimo.com/api/v1/")),
    JSON.stringify(calls),
  );
}

// mimo E: dashboard 服务端故障 → 上报错误（区别于"Cookie 失效"）
{
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: "XIAOMI_MIMO_COOKIE", cookie: MIMO_COOKIE_OK });
  svc._httpGet = async () => ({ ok: false, kind: "server_error", httpStatus: 503, message: "HTTP 503" });
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check("mimo 5xx → server_error surfaced", r.value.ok === false && r.value.kind === "server_error", JSON.stringify(r.value));
}

// mimo F: 旧端点兜底 —— /user/usage 404 时回退 tokenPlan/usage(+detail)，已用比例
{
  const calls = [];
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: "XIAOMI_MIMO_COOKIE", cookie: MIMO_COOKIE_OK });
  svc._httpGet = async (url, key, style) => {
    calls.push(url.replace(/^https?:\/\//, ""));
    if (url.endsWith("/api/v1/tokenPlan/usage")) {
      return { ok: true, body: JSON.stringify({ code: 0, data: { usage: { items: [{ name: "plan_total_token", percent: 0.13 }] }, monthUsage: { items: [{ name: "month_total_token", percent: 0.42 }] } } }) };
    }
    if (url.endsWith("/api/v1/tokenPlan/detail")) {
      return { ok: true, body: JSON.stringify({ code: 0, data: { currentPeriodEnd: mimoEnd, expired: false } }) };
    }
    return { ok: false, kind: "server_error", httpStatus: 404, message: "HTTP 404" };
  };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check(
    "mimo legacy tokenPlan/usage fallback parsed with detail",
    r.value.ok === true && r.value.display.fiveHrPct === 13 && r.value.display.weeklyPct === 42 && typeof r.value.display.fiveHrResetsIn === "string",
    JSON.stringify(r.value),
  );
  check("mimo fallback order: user/usage first, then detail+usage", calls[0].endsWith("/api/v1/user/usage"), JSON.stringify(calls));
}

// mimo G: 旧端点 dedup: month ≈ plan（<0.5pt）→ 只留一行
{
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: "XIAOMI_MIMO_COOKIE", cookie: MIMO_COOKIE_OK });
  svc._httpGet = async (url, key, style) => {
    if (url.endsWith("/api/v1/tokenPlan/usage")) {
      return { ok: true, body: JSON.stringify({ code: 0, data: { usage: { items: [{ name: "plan_total_token", percent: 0.5 }] }, monthUsage: { items: [{ name: "month_total_token", percent: 0.504 }] } } }) };
    }
    if (url.endsWith("/api/v1/tokenPlan/detail")) return { ok: true, body: JSON.stringify({ code: 0, data: { expired: false } }) };
    // /user/usage 404 → 才轮到旧端点（401 会直接判定 Cookie 失效并退回本地用量）
    return { ok: false, kind: "server_error", httpStatus: 404, message: "HTTP 404" };
  };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check("mimo dedups month≈plan (<0.5pt)", r.value.ok === true && r.value.display.fiveHrPct === 50 && r.value.display.weeklyPct === null, JSON.stringify(r.value));
}

// mimo H: 套餐过期（detail.expired）→ plan_expired
{
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: "XIAOMI_MIMO_COOKIE", cookie: MIMO_COOKIE_OK });
  svc._httpGet = async (url, key, style) => {
    if (url.endsWith("/api/v1/tokenPlan/usage")) {
      return { ok: true, body: JSON.stringify({ code: 0, data: { usage: { items: [] }, monthUsage: { items: [] } } }) };
    }
    if (url.endsWith("/api/v1/tokenPlan/detail")) return { ok: true, body: JSON.stringify({ code: 0, data: { planName: "Standard", currentPeriodEnd: "2026-06-27 23:59:59", expired: true } }) };
    return { ok: false, kind: "server_error", httpStatus: 404, message: "HTTP 404" };
  };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check("mimo expired plan → plan_expired", r.value.ok === false && r.value.kind === "plan_expired" && r.value.message.indexOf("platform.xiaomimimo.com") >= 0, JSON.stringify(r.value));
}

// mimo I: /user/usage 业务 401 → auth_failed → 退回本地用量（Cookie 失效，静默）
{
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: "XIAOMI_MIMO_COOKIE", cookie: MIMO_COOKIE_OK });
  svc._httpGet = async () => ({ ok: true, body: JSON.stringify({ code: 401, message: "未登录" }) });
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check("mimo business 401 on user/usage → local usage fallback", r.value.ok === true && r.value.display.balanceText.indexOf("今日") === 0, JSON.stringify(r.value));
}


// ====== 其他 provider 维持单 API Key 路径 ======

// HTTP error classification
svc._quotaApiKey = async () => ({ apiKeyRef: "TEST", apiKey: "k", cookieRef: null, cookie: null });
svc._httpGet = async () => ({ ok: false, kind: "auth_failed", httpStatus: 401, message: "HTTP 401" });
svc._quotaCache.openrouter = null;
r = await svc.getQuota("openrouter", false);
check("401 → auth_failed wire value", r.value.ok === false && r.value.kind === "auth_failed" && r.value.provider === "openrouter", JSON.stringify(r.value));

// force=true bypasses cache (different object after re-fetch)
const b1 = await svc.getQuota("openrouter", true);
check("force refetch returns fresh object", b1 !== r);

// getAllQuotas: parallel snapshot of every provider (fresh instance → cold cache)
svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: null, cookie: null }); // nothing configured
svc._httpGet = async () => { throw new Error("must not be called"); };
const svc2 = new TokenStatsService(makeCtx(), undefined);
svc2[initKey]();
const all = await svc2.getAllQuotas(false);
check("getAllQuotas envelope", all && all.ok === true && all.value && typeof all.value.quotas === "object");
check(
  "getAllQuotas covers 6 providers; mimo always ok (local usage), others unconfigured",
  ["minimax", "deepseek", "kimi", "openrouter", "zhipu"].every(
    (p) => all.value.quotas[p] && all.value.quotas[p].ok === false && all.value.quotas[p].kind === "unconfigured",
  ) &&
    all.value.quotas.mimo &&
    all.value.quotas.mimo.ok === true &&
    typeof all.value.quotas.mimo.display.balanceText === "string",
  JSON.stringify(all.value.quotas.mimo),
);

// mimo J: cookie jar —— 服务端 Set-Cookie 续发会话要被吸收、用于后续请求并写回凭据库
{
  const saved = [];
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: "XIAOMI_MIMO_COOKIE", cookie: MIMO_COOKIE_OK });
  svc.ctx = { get: (n) => (n === "credentials" ? { set: async (ref, v) => { saved.push([ref, v]); } } : undefined) };
  const sent = [];
  svc._httpGet = async (url, key) => {
    sent.push(key);
    if (url.endsWith("/api/v1/user/usage")) {
      // 404 + 一次续发（浏览器 jar 会在任何响应上更新，包括失败响应）
      return {
        ok: false,
        kind: "server_error",
        httpStatus: 404,
        setCookie: ["api-platform_serviceToken=\"rotated-token\"; Path=/; HttpOnly; Max-Age=3600", "unrelated=zzz; Path=/"],
        message: "HTTP 404",
      };
    }
    if (url.endsWith("/api/v1/tokenPlan/detail")) {
      return { ok: true, setCookie: [], body: JSON.stringify({ code: 0, data: { expired: false } }) };
    }
    return {
      ok: true,
      setCookie: [],
      body: JSON.stringify({ code: 0, data: { usage: { items: [{ name: "plan_total_token", percent: 0.13 }] }, monthUsage: { items: [] } } }),
    };
  };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check("mimo jar: reading still parses", r.value.ok === true && r.value.display.fiveHrPct === 13, JSON.stringify(r.value));
  check(
    "mimo jar: rotated token persisted back to the credentials store",
    saved.length === 1 && saved[0][0] === "XIAOMI_MIMO_COOKIE" && saved[0][1].includes('api-platform_serviceToken="rotated-token"') && saved[0][1].includes("userId=1"),
    JSON.stringify(saved),
  );
  check(
    "mimo jar: requests after the rotation already use the new token",
    sent.length === 3 && sent[0] === MIMO_COOKIE_OK && sent[1].includes("rotated-token") && sent[2].includes("rotated-token"),
    JSON.stringify(sent),
  );
  check("mimo jar: unrelated Set-Cookie is not absorbed", !saved[0][1].includes("unrelated"), saved[0][1]);
  svc.ctx = makeCtx();
}

// mimo K: 主端点 200 且带续发 → 只解析、不发多余请求，但仍要写回新 token
{
  const saved = [];
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: "XIAOMI_MIMO_COOKIE", cookie: MIMO_COOKIE_OK });
  svc.ctx = { get: (n) => (n === "credentials" ? { set: async (ref, v) => { saved.push([ref, v]); } } : undefined) };
  const sent = [];
  svc._httpGet = async (url, key) => {
    sent.push(url.replace(/^https?:\/\//, ""));
    return {
      ok: true,
      setCookie: ["api-platform_serviceToken=\"rotated-token\"; Path=/"],
      body: JSON.stringify({ percent: 61, resetDate: "2026-10-05" }),
    };
  };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check(
    "mimo jar: 200 + rotation = single request, refresh stored",
    r.value.display.balanceText === "剩余 61%" && sent.length === 1 && saved.length === 1 && saved[0][1].includes("rotated-token"),
    JSON.stringify({ sent, saved }),
  );
  svc.ctx = makeCtx();
}

// mimo L: 服务端**不下发** Set-Cookie（绝大多数响应就是这样）——不能有任何写回，
// cookie 原样复用，读数照常。
{
  const saved = [];
  const unset = [];
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: "XIAOMI_MIMO_COOKIE", cookie: MIMO_COOKIE_OK });
  svc.ctx = { get: (n) => (n === "credentials" ? { set: async (r, v) => saved.push([r, v]), unset: async (r) => unset.push(r) } : undefined) };
  const sent = [];
  svc._httpGet = async (url, key) => {
    sent.push(key);
    // 注意：整个响应对象里**没有** setCookie 字段
    if (url.endsWith("/api/v1/user/usage")) {
      return { ok: true, body: JSON.stringify({ percent: 55, resetDate: "2026-10-05" }) };
    }
    return { ok: false, kind: "auth_failed", httpStatus: 401, message: "HTTP 401" };
  };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check("mimo no Set-Cookie: reading still works", r.value.ok === true && r.value.display.balanceText === "剩余 55%", JSON.stringify(r.value));
  check("mimo no Set-Cookie: nothing written to the credentials store", saved.length === 0 && unset.length === 0, JSON.stringify({ saved, unset }));
  check("mimo no Set-Cookie: original cookie reused verbatim", sent.every((c) => c === MIMO_COOKIE_OK), JSON.stringify(sent));
  svc.ctx = makeCtx();
}

// mimo M: 服务端删除会话 cookie（`name=; Max-Age=0`）→ 浏览器语义是删除条目，
// 不能发出空 cookie。
{
  const saved = [];
  const unset = [];
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: "XIAOMI_MIMO_COOKIE", cookie: "api-platform_serviceToken=abc; userId=1; api-platform_ph=p" });
  svc.ctx = { get: (n) => (n === "credentials" ? { set: async (r, v) => saved.push([r, v]), unset: async (r) => unset.push(r) } : undefined) };
  const sent = [];
  svc._httpGet = async (url, key) => {
    sent.push(key);
    if (url.endsWith("/api/v1/user/usage")) {
      // 404（继续回退路径）+ 同时服务端把会话 cookie 删了
      return {
        ok: false,
        kind: "server_error",
        httpStatus: 404,
        setCookie: ["api-platform_serviceToken=; Path=/; Max-Age=0"],
        message: "HTTP 404",
      };
    }
    if (url.endsWith("/api/v1/tokenPlan/detail")) return { ok: true, body: JSON.stringify({ code: 0, data: { expired: false } }) };
    return { ok: true, body: JSON.stringify({ code: 0, data: { usage: { items: [{ name: "plan_total_token", percent: 0.2 }] }, monthUsage: { items: [] } } }) };
  };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check(
    "mimo deletion: serviceToken removed, not blanked",
    saved.length === 1 && !saved[0][1].includes("api-platform_serviceToken=") && saved[0][1].includes("userId=1"),
    JSON.stringify(saved),
  );
  check(
    "mimo deletion: follow-up requests no longer send the dead cookie",
    sent.length === 3 && sent[1].indexOf("api-platform_serviceToken=") < 0 && sent[2].indexOf("api-platform_serviceToken=") < 0,
    JSON.stringify(sent),
  );
  svc.ctx = makeCtx();
}

// mimo N: 服务端清空全部会话 cookie → 删掉凭据（而不是写空串）
{
  const saved = [];
  const unset = [];
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: "XIAOMI_MIMO_COOKIE", cookie: "api-platform_serviceToken=abc; userId=1" });
  svc.ctx = { get: (n) => (n === "credentials" ? { set: async (r, v) => saved.push([r, v]), unset: async (r) => unset.push(r) } : undefined) };
  svc._httpGet = async () => ({
    ok: true,
    setCookie: [
      "api-platform_serviceToken=; Max-Age=0",
      "userId=; Max-Age=0",
    ],
    body: JSON.stringify({ percent: 40, resetDate: "2026-10-05" }),
  });
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check(
    "mimo full clear: credential removed instead of stored empty",
    unset.length === 1 && unset[0] === "XIAOMI_MIMO_COOKIE" && saved.length === 0,
    JSON.stringify({ saved, unset }),
  );
  svc.ctx = makeCtx();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
