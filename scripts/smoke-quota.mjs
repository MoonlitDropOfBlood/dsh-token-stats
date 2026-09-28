/* Ad-hoc verification of the new quota path (not shipped). */
import { pathToFileURL } from "node:url";

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

// ====== mimo 多端点探测链 (v1.6.0 起) ======
const mimoEnd = new Date(Date.now() + 72 * 3600e3).toISOString().slice(0, 19).replace("T", " ");

// mimo A: 仅 API Key (Bearer), /v1/user/balance PAYG 路径
{
  const calls = [];
  svc._quotaApiKey = async () => ({ apiKeyRef: "XIAOMI_MIMO_API_KEY", apiKey: "tp-test-key", cookieRef: null, cookie: null });
  svc._httpGet = async (url, key, style) => {
    calls.push({ url: url.replace(/^https?:\/\//, ""), style: style || "bearer" });
    if (url.endsWith("/v1/user/balance") && url.includes("api.xiaomimimo.com")) {
      return { ok: true, body: JSON.stringify({ data: { balance: "12.50", charge_balance: "10.00", granted_balance: "2.50", plan: "PAYG" } }) };
    }
    return { ok: false, kind: "auth_failed", httpStatus: 401, message: "HTTP 401" };
  };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check(
    "mimo Bearer API Key → /v1/user/balance (PAYG CNY) parsed",
    r.value.ok === true && r.value.display.balanceText === "¥12.50" && r.value.display.currency === "CNY",
    JSON.stringify(r.value),
  );
  check(
    "mimo Bearer stopped at PAYG balance (no Cookie probe)",
    calls.length === 2 && calls[0].url.includes("token-plan-sgp.xiaomimimo.com/v1/user/balance") && calls[1].url.includes("api.xiaomimimo.com/v1/user/balance"),
    JSON.stringify(calls),
  );
}

// mimo B: 仅 API Key (Bearer), /v1/user/balance Token Plan SGP 路径
{
  svc._quotaApiKey = async () => ({ apiKeyRef: "XIAOMI_MIMO_API_KEY", apiKey: "tp-test-key", cookieRef: null, cookie: null });
  svc._httpGet = async (url, key, style) => {
    if (url.includes("token-plan-sgp") && url.endsWith("/v1/user/balance")) {
      return { ok: true, body: JSON.stringify({ data: { token_balance: 700000, token_limit: 1000000, plan_name: "Pro" } }) };
    }
    return { ok: false, kind: "auth_failed", httpStatus: 401, message: "HTTP 401" };
  };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check(
    "mimo Bearer API Key → /v1/user/balance (Token Plan) parsed",
    r.value.ok === true && r.value.display.fiveHrPct === 30,
    JSON.stringify(r.value),
  );
}

// mimo C: Bearer API Key + /tokenPlan/usage 完整 shape
{
  svc._quotaApiKey = async () => ({ apiKeyRef: "XIAOMI_MIMO_API_KEY", apiKey: "tp-test-key", cookieRef: null, cookie: null });
  svc._httpGet = async (url, key, style) => {
    if (url.includes("token-plan-sgp") && url.includes("/api/v1/tokenPlan/usage")) {
      return { ok: true, body: JSON.stringify({ code: 0, data: { usage: { items: [{ name: "plan_total_token", percent: 0.13 }] }, monthUsage: { items: [{ name: "month_total_token", percent: 0.42 }] } } }) };
    }
    if (url.includes("token-plan-sgp") && url.includes("/detail")) {
      return { ok: true, body: JSON.stringify({ code: 0, data: { planName: "Standard", currentPeriodEnd: mimoEnd, expired: false } }) };
    }
    return { ok: false, kind: "auth_failed", httpStatus: 401, message: "HTTP 401" };
  };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check(
    "mimo Bearer → /tokenPlan/usage (SGP) parsed with detail",
    r.value.ok === true && r.value.display.fiveHrPct === 13 && r.value.display.weeklyPct === 42 && typeof r.value.display.fiveHrResetsIn === "string",
    JSON.stringify(r.value),
  );
}

// mimo D: 仅 Cookie (dashboard) — 旧用户路径保留; Bearer 全部 401 后回退 Cookie
{
  const calls = [];
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: "XIAOMI_MIMO_COOKIE", cookie: "api-platform_serviceToken=abc; userId=1" });
  svc._httpGet = async (url, key, style) => {
    calls.push({ url: url.replace(/^https?:\/\//, ""), style: style || "bearer" });
    if (style === "cookie" && url.includes("platform.xiaomimimo.com") && url.includes("/api/v1/tokenPlan/usage")) {
      return { ok: true, body: JSON.stringify({ code: 0, data: { usage: { items: [{ name: "plan_total_token", percent: 0.13 }, { name: "compensation_total_token", percent: 1 }] }, monthUsage: { items: [{ name: "month_total_token", percent: 0.42 }] } } }) };
    }
    if (style === "cookie" && url.includes("/detail")) {
      return { ok: true, body: JSON.stringify({ code: 0, data: { planName: "Standard", currentPeriodEnd: mimoEnd, expired: false } }) };
    }
    return { ok: false, kind: "auth_failed", httpStatus: 401, message: "HTTP 401" };
  };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check(
    "mimo Cookie-only → /tokenPlan/usage parsed (no API Key)",
    r.value.ok === true && r.value.display.fiveHrPct === 13 && r.value.display.weeklyPct === 42 && typeof r.value.display.fiveHrResetsIn === "string",
    JSON.stringify(r.value),
  );
  check(
    "mimo Cookie path skipped Bearer probes (apiKey=null)",
    calls.length === 2 && calls[0].style === "cookie" && calls[1].url.includes("/detail"),
    JSON.stringify(calls),
  );
}

// mimo E: API Key + Cookie 都配置, Bearer 优先生效
{
  const calls = [];
  svc._quotaApiKey = async () => ({ apiKeyRef: "XIAOMI_MIMO_API_KEY", apiKey: "tp-fresh-key", cookieRef: "XIAOMI_MIMO_COOKIE", cookie: "stale-cookie" });
  svc._httpGet = async (url, key, style) => {
    calls.push({ url: url.replace(/^https?:\/\//, ""), style: style || "bearer", keyPrefix: typeof key === "string" ? key.slice(0, 6) : "" });
    // Bearer 路径在 host 里 authStyle 传 undefined, 用 !== "cookie" 判定 (含 undefined/raw).
    if (style !== "cookie" && url.includes("token-plan-sgp") && url.endsWith("/v1/user/balance")) {
      return { ok: true, body: JSON.stringify({ data: { token_balance: 800000, token_limit: 1000000, plan_name: "Pro" } }) };
    }
    return { ok: false, kind: "auth_failed", httpStatus: 401, message: "HTTP 401" };
  };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check(
    "mimo Bearer wins over Cookie (no Cookie probe)",
    r.value.ok === true && r.value.display.fiveHrPct === 20 && calls.every((c) => c.style === "bearer"),
    JSON.stringify(r.value),
  );
}

// mimo F: dedup: month within 0.5pt of plan → month dropped
{
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: "XIAOMI_MIMO_COOKIE", cookie: "x" });
  svc._httpGet = async (url, key, style) => {
    if (style === "cookie" && url.includes("/usage")) {
      return { ok: true, body: JSON.stringify({ code: 0, data: { usage: { items: [{ name: "plan_total_token", percent: 0.5 }] }, monthUsage: { items: [{ name: "month_total_token", percent: 0.504 }] } } }) };
    }
    if (style === "cookie" && url.includes("/detail")) return { ok: true, body: JSON.stringify({ code: 0, data: { expired: false } }) };
    return { ok: false, kind: "auth_failed", httpStatus: 401, message: "HTTP 401" };
  };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check("mimo dedups month≈plan (<0.5pt)", r.value.ok === true && r.value.display.fiveHrPct === 50 && r.value.display.weeklyPct === null, JSON.stringify(r.value));
}

// mimo G: 业务 40101 → auth_failed
{
  svc._quotaApiKey = async () => ({ apiKeyRef: "XIAOMI_MIMO_API_KEY", apiKey: "k", cookieRef: null, cookie: null });
  svc._httpGet = async () => ({ ok: true, body: JSON.stringify({ code: 40101, message: "未登录" }) });
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check("mimo business 401xx → auth_failed", r.value.ok === false && r.value.kind === "auth_failed" && r.value.message.indexOf("API Key") >= 0, JSON.stringify(r.value));
}

// mimo H: expired plan → plan_expired
{
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: "XIAOMI_MIMO_COOKIE", cookie: "x" });
  svc._httpGet = async (url, key, style) => {
    if (style === "cookie" && url.includes("/usage")) {
      return { ok: true, body: JSON.stringify({ code: 0, data: { usage: { items: [] }, monthUsage: { items: [] } } }) };
    }
    if (style === "cookie" && url.includes("/detail")) return { ok: true, body: JSON.stringify({ code: 0, data: { planName: "Standard", currentPeriodEnd: "2026-06-27 23:59:59", expired: true } }) };
    return { ok: false, kind: "auth_failed", httpStatus: 401, message: "HTTP 401" };
  };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check("mimo expired → plan_expired", r.value.ok === false && r.value.kind === "plan_expired" && r.value.message.indexOf("platform.xiaomimimo.com") >= 0, JSON.stringify(r.value));
}

// mimo I: 凭据都没配 → unconfigured
{
  svc._quotaApiKey = async () => ({ apiKeyRef: null, apiKey: null, cookieRef: null, cookie: null });
  svc._httpGet = async () => { throw new Error("must not be called"); };
  svc._quotaCache.mimo = null;
  r = await svc.getQuota("mimo", false);
  check("mimo no creds → unconfigured", r.value.ok === false && r.value.kind === "unconfigured", JSON.stringify(r.value));
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
  "getAllQuotas covers 6 providers, all unconfigured",
  ["minimax", "deepseek", "kimi", "openrouter", "zhipu", "mimo"].every(
    (p) => all.value.quotas[p] && all.value.quotas[p].ok === false && all.value.quotas[p].kind === "unconfigured",
  ),
  JSON.stringify(Object.keys(all.value.quotas)),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
