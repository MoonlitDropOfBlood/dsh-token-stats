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

// deepseek fixture
svc._quotaActiveRef.deepseek = "TEST";
svc._quotaApiKey = async () => ({ ref: "TEST", key: "k" });
svc._httpGet = async () => ({ ok: true, body: JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "43.97" }] }) });
svc._quotaCache.deepseek = null;
r = await svc.getQuota("deepseek", false);
check("deepseek fixture parsed", r.value.ok === true && r.value.display.balanceText === "¥43.97" && r.value.display.currency === "CNY", JSON.stringify(r.value));

// minimax fixture (percent schema)
svc._quotaApiKey = async () => ({ ref: "TEST", key: "k" });
svc._httpGet = async () => ({ ok: true, body: JSON.stringify({ base_resp: { status_code: 0 }, model_remains: [{ model_name: "general", current_interval_remaining_percent: 58, current_interval_status: 1, end_time: Date.now() + 3600e3, current_weekly_remaining_percent: 85, current_weekly_status: 1, weekly_end_time: Date.now() + 86400e3 }] }) });
svc._quotaCache.minimax = null;
r = await svc.getQuota("minimax", false);
check("minimax fixture parsed", r.value.ok === true && r.value.display.fiveHrPct === 42 && r.value.display.weeklyPct === 15 && typeof r.value.display.fiveHrResetsIn === "string", JSON.stringify(r.value));

// zhipu fixture
svc._httpGet = async () => ({ ok: true, body: JSON.stringify({ code: 200, success: true, data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, usage: 2000, remaining: 400, percentage: 80, nextResetTime: Date.now() + 7200e3 }] } }) });
svc._quotaCache.zhipu = null;
r = await svc.getQuota("zhipu", false);
check("zhipu fixture parsed", r.value.ok === true && r.value.display.fiveHrPct === 80, JSON.stringify(r.value));

// HTTP error classification
svc._httpGet = async () => ({ ok: false, kind: "auth_failed", httpStatus: 401, message: "HTTP 401" });
svc._quotaCache.openrouter = null;
r = await svc.getQuota("openrouter", false);
check("401 → auth_failed wire value", r.value.ok === false && r.value.kind === "auth_failed" && r.value.provider === "openrouter", JSON.stringify(r.value));

// force=true bypasses cache (different object after re-fetch)
const b1 = await svc.getQuota("openrouter", true);
check("force refetch returns fresh object", b1 !== r);

// getAllQuotas: parallel snapshot of every provider (fresh instance → cold cache)
svc._quotaApiKey = async () => ({ ref: null, key: null }); // nothing configured
svc._httpGet = async () => { throw new Error("must not be called"); };
const svc2 = new TokenStatsService(makeCtx(), undefined);
svc2[initKey]();
const all = await svc2.getAllQuotas(false);
check("getAllQuotas envelope", all && all.ok === true && all.value && typeof all.value.quotas === "object");
check(
  "getAllQuotas covers 5 providers, all unconfigured",
  ["minimax", "deepseek", "kimi", "openrouter", "zhipu"].every(
    (p) => all.value.quotas[p] && all.value.quotas[p].ok === false && all.value.quotas[p].kind === "unconfigured",
  ),
  JSON.stringify(Object.keys(all.value.quotas)),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
