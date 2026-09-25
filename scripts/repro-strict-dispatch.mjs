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
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import { TYPERT } from "../typert.host.js";
import { TokenStatsService } from "../index.js";

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
for (const endpoint of ["tokenStats/getStats", "tokenStats/getQuota", "tokenStats/getAllQuotas"]) {
  const descriptor = typert.local.get(endpoint);
  console.log(`[3] local.get(${JSON.stringify(endpoint)}):`, descriptor === undefined ? "UNDEFINED" : JSON.stringify(shallow(descriptor), errorReplacer));
}

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
];
for (const [endpoint, payload] of cases) {
  console.log(`[5] invokeRpc ${endpoint} …`);
  const result = await gateway.invokeRpc(endpoint, payload, undefined, undefined);
  console.log(`[5] ${endpoint} =>`, JSON.stringify(result, errorReplacer));
}
console.log("DONE");
