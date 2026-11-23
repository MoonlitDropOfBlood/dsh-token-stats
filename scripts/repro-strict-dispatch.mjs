/**
 * Offline reproduction of the strict Remote dispatch for tokenStats/*.
 *
 * Boots the REAL deployed cordis Context + TypertRegistry + TypertGatewayService
 * (no HTTP, no loader), registers this package's TYPERT manifest directly,
 * instantiates TokenStatsService, then drives gateway.invokeRpc exactly the way
 * the host dispatch does. Whatever fails surfaces as the gateway's own
 * rpcFailure payload — the error the browser would see as a failed RPC.
 *
 * Needs the workspace node_modules junctions (see AGENTS.md):
 *   node_modules/@deepseek-ai -> <DSH deployment>/node_modules/@deepseek-ai
 *   node_modules/zod          -> <DSH deployment>/node_modules/zod
 *
 * Drives every tokenStats Remote method (7 of them since v1.12.0):
 *   getStats / getQuota / getAllQuotas / getBailianSetup /
 *   saveBailianCredentials / clearBailianCredentials / setQuotaHidden
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import { TYPERT } from "../typert.host.js";

// **必须在 import index.js 之前**隔离 DSH_HOME：index.js 在模块加载时就锁定
// 持久化路径，而 setQuotaHidden 会写 <DSH_HOME>/data/dsh-token-stats/quota-prefs.json
// ——不隔离就会把「隐藏 deepseek」写进用户真实的 ~/.dsh 偏好。
// （cordis / typert / gateway 的静态 import 无此副作用，保留静态形式。）
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-ts-strict-"));
const { TokenStatsService } = await import("../index.js");

const errorReplacer = (_key, value) => {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, cause: value.cause instanceof Error ? value.cause.message : value.cause };
  }
  return value;
};

const shallow = (value, depth = 3) => {
  if (value === null || typeof value !== "object") return typeof value === "function" ? "fn" : value;
  if (depth <= 0) return Array.isArray(value) ? `[array ${value.length}]` : "{…}";
  if (Array.isArray(value)) return value.map((item) => shallow(item, depth - 1));
  const out = {};
  for (const key of Object.keys(value)) out[key] = shallow(value[key], depth - 1);
  return out;
};

const ctx = new Context();

// 1. typert registry service (the host mounts it as the `typert` plugin).
const registry = new TypertRegistry(ctx);
const typert = ctx.typert ?? (ctx.set("typert", registry), ctx.typert);
console.log("[1] ctx.typert ready:", typert === registry);

// 2. register the manifest the way typert-loader would.
const disposer = typert.register(TYPERT);
console.log("[2] TYPERT.register ok:", typeof disposer);

// 3. inspect the stored strict descriptors — the exact objects the gateway resolves.
for (const endpoint of [
  "tokenStats/getStats",
  "tokenStats/getQuota",
  "tokenStats/getAllQuotas",
  "tokenStats/getBailianSetup",
  "tokenStats/saveBailianCredentials",
  "tokenStats/clearBailianCredentials",
  "tokenStats/setQuotaHidden",
]) {
  const descriptor = typert.local.get(endpoint);
  console.log(`[3] local.get(${JSON.stringify(endpoint)}):`, descriptor === undefined ? "UNDEFINED" : JSON.stringify(shallow(descriptor), errorReplacer));
}

// 3b. credentials stub：让 bailian setup/save/clear 走成功分支（离线，不碰真实凭据库）。
//     有状态：set 写入内存 map、resolve 读 map（模型 key 恒命中 → 门控成立）、unset 删除。
//     cordis 契约：未 provide 的名字不能 ctx.set（"cannot set property without provide"）。
const credStore = new Map();
const credCalls = { set: [], unset: [] };
ctx.provide("credentials", {
  resolve: async (ref) => {
    if (credStore.has(ref)) return { value: credStore.get(ref) };
    if (ref === "QWEN_TOKEN_PLAN_CN_API_KEY") return { value: "sk-sp-repro-fake" };
    return undefined;
  },
  set: async (ref, value) => { credCalls.set.push([ref, value]); credStore.set(ref, value); },
  unset: async (ref) => { credCalls.unset.push(ref); credStore.delete(ref); },
});

// 4. host service instance (constructor + the manual Service.init the class plugin lifecycle runs).
const service = new TokenStatsService(ctx, {});
await service[Service.init]();
console.log("[4] TokenStatsService instantiated; reflect has tokenStats:", ctx.reflect.props !== undefined ? Object.keys(ctx.reflect.props).includes("tokenStats") : "reflect.props unavailable");

// 5. real gateway, real dispatch.
const config = { websocketHeartbeatIntervalMs: 30000, streamInboxBytes: 4194304 };
const gateway = new TypertGatewayService(ctx, config);
const cases = [
  ["tokenStats/getStats", { args: {} }],
  ["tokenStats/getQuota", { args: { provider: "nope", force: false } }],
  ["tokenStats/getAllQuotas", { args: { force: false } }],
  ["tokenStats/getBailianSetup", { args: {} }],
  ["tokenStats/saveBailianCredentials", { args: { input: { accessKeyId: "LTAI5tReproFakeKey", accessKeySecret: "repro-fake-secret-do-not-echo" } } }],
  ["tokenStats/getBailianSetup", { args: {} }],
  ["tokenStats/clearBailianCredentials", { args: {} }],
  ["tokenStats/getBailianSetup", { args: {} }],
  // issue #3：套餐读数开关（隐藏 → 短路读数 → 恢复 → 未知 provider）。
  ["tokenStats/setQuotaHidden", { args: { provider: "deepseek", hidden: true } }],
  ["tokenStats/getAllQuotas", { args: { force: false } }],
  ["tokenStats/getQuota", { args: { provider: "deepseek", force: false } }],
  ["tokenStats/setQuotaHidden", { args: { provider: "deepseek", hidden: false } }],
  ["tokenStats/setQuotaHidden", { args: { provider: "nope", hidden: true } }],
];
// DSH 0.2.1-rc.2's gateway dispatches on behalf of a Peer: assertPeerLive
// reads peer.signal.aborted and owner principals skip the remoteAccess
// decision — pass the minimal live owner peer (the old signature's undefined
// fourth argument used to get away with).
const peer = { signal: new AbortController().signal, principal: { kind: "owner" } };
const results = [];
for (const [endpoint, payload] of cases) {
  console.log(`[5] invokeRpc ${endpoint} …`);
  const result = await gateway.invokeRpc(endpoint, payload, undefined, peer);
  results.push(result);
  console.log(`[5] ${endpoint} =>`, JSON.stringify(result, errorReplacer));
}

// 6. v1.11.0 bailian 断言：门控/保存/清除的成功分支 + 密钥绝不回显。
const assert = (cond, msg) => {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  ", msg);
};
// 双层信封：gateway {ok,value} → host 方法 {ok,value} → payload（与 client unwrapRemote 同款）。
const inner = (r) => {
  const host = r && r.ok === true && r.value && typeof r.value === "object" ? r.value : null;
  return host && host.ok === true && host.value && typeof host.value === "object" ? host.value : null;
};
const setupBefore = inner(results[3]);
const saveResult = inner(results[4]);
const setupAfterSave = inner(results[5]);
const clearResult = inner(results[6]);
const setupAfterClear = inner(results[7]);
assert(setupBefore && setupBefore.modelConfigured === true, "getBailianSetup: 模型 key 命中 → modelConfigured=true（门控成立）");
assert(setupBefore && setupBefore.akConfigured === false && setupBefore.maskedAk === null, "getBailianSetup: 未配 AK/SK → akConfigured=false, maskedAk=null");
assert(saveResult && saveResult.saved === true, "saveBailianCredentials: 成功分支 saved=true");
assert(saveResult && saveResult.maskedAk === "LTAI****eKey", "saveBailianCredentials: maskedAk 前4后4（LTAI****eKey）");
assert(!JSON.stringify(results[4]).includes("repro-fake-secret-do-not-echo"), "saveBailianCredentials: Secret 绝不出现在返回值里");
assert(credCalls.set.length === 2 && credCalls.set[0][0] === "ALIBABA_CLOUD_ACCESS_KEY_ID" && credCalls.set[1][0] === "ALIBABA_CLOUD_ACCESS_KEY_SECRET", "saveBailianCredentials: 写入官方凭据库两个 ref");
assert(setupAfterSave && setupAfterSave.akConfigured === true, "保存后 getBailianSetup: akConfigured=true");
assert(clearResult && clearResult.cleared === true, "clearBailianCredentials: 成功分支 cleared=true");
assert(credCalls.unset.includes("ALIBABA_CLOUD_ACCESS_KEY_ID") && credCalls.unset.includes("ALIBABA_CLOUD_ACCESS_KEY_SECRET"), "clearBailianCredentials: unset 两个 ref");
assert(setupAfterClear && setupAfterClear.akConfigured === false, "清除后 getBailianSetup: akConfigured=false");
const allQuotas = inner(results[2]);
assert(allQuotas && allQuotas.quotas && allQuotas.quotas.bailian && allQuotas.quotas.bailian.kind === "unconfigured", "getAllQuotas: bailian 无 AK/SK → unconfigured（不造假读数）");

// 7. issue #3（v1.12.0）：setQuotaHidden 走 strict dispatch，隐藏后读数短路。
//    失败语义是宿主业务信封 {ok:false, error:{code}}（不是网关 rpcFailure），
//    所以单独取「宿主外层信封」而不能用 inner()（inner 只认 ok:true 的 value）。
const hostEnvelope = (r) => (r && r.ok === true ? r.value : r);
const prefsHidden = inner(results[8]);
assert(prefsHidden && Array.isArray(prefsHidden.hidden) && prefsHidden.hidden.includes("deepseek"), "setQuotaHidden(deepseek,true): value.hidden 含 deepseek");
const hiddenQuotas = inner(results[9]);
assert(
  hiddenQuotas && hiddenQuotas.quotas && hiddenQuotas.quotas.deepseek && hiddenQuotas.quotas.deepseek.kind === "hidden",
  "getAllQuotas: 隐藏后 quotas.deepseek.kind === hidden",
);
// getQuota 的 value 就是 quota value（不是再一层 ok/value 信封）。
const hiddenQuota = inner(results[10]);
assert(
  hiddenQuota && hiddenQuota.ok === false && hiddenQuota.kind === "hidden" && hiddenQuota.provider === "deepseek",
  "getQuota(deepseek): 隐藏时返回 {ok:false, kind:'hidden'}",
);
const prefsVisible = inner(results[11]);
assert(prefsVisible && Array.isArray(prefsVisible.hidden) && !prefsVisible.hidden.includes("deepseek"), "setQuotaHidden(deepseek,false): value.hidden 不含 deepseek");
const unknownPrefs = hostEnvelope(results[12]);
assert(
  unknownPrefs && unknownPrefs.ok === false && unknownPrefs.error && unknownPrefs.error.code === "unknown_provider",
  "setQuotaHidden(nope): 宿主信封 ok=false, error.code=unknown_provider",
);
console.log(process.exitCode === 1 ? "DONE (WITH FAILURES)" : "DONE — ALL PASS");
