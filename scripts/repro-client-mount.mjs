/**
 * Offline reproduction of the CLIENT-side $mount for the tokenStats namespace,
 * using the REAL deployed client gateway bundle (dsh-api-gateway/lib/client.js)
 * on a real cordis Context. Tests:
 *   [2] a fresh mount
 *   [3] a duplicate mount (the install->remove->install churn scenario, where
 *       the browser page stays open across graph changes)
 */
import { Context } from "@deepseek-ai/cordis";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { pathToFileURL } from "node:url";

// 1. stub the browser module loader and load the REAL client gateway bundle.
const cordis = await import("@deepseek-ai/cordis");
let clientLib;
globalThis.window ??= {};
globalThis.window.__ModuleLoader__ = {
  load: ({ factory }) => {
    clientLib = factory((spec) => {
      if (spec === "@deepseek-ai/cordis") return cordis;
      throw new Error(`repro: no stub for require(${spec})`);
    });
    return clientLib;
  },
};
await import(
  pathToFileURL("C:/Users/wwhby/AppData/Roaming/DeepSeek Harness Desktop/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.js").href
);

// 2. client-side context: typert registry + a connection stub.
const ctx = new Context();
const registry = new TypertRegistry(ctx);
const typert = ctx.typert ?? (ctx.set("typert", registry), ctx.typert);
ctx.reflect.provide("connection", {
  rpc: { open: () => undefined },
  operator: { id: "repro" },
  registerGenerationSource: () => () => {},
  start: (listener) => {},
});
clientLib.apply(ctx);
const remote = ctx.get("remote");
console.log("[1] ctx.remote ready:", remote !== undefined);

// 3. descriptor copied verbatim from workspace client.js (v1.5.2).
const passthrough = () => ({ parse: (v) => v });
const createPassthrough = () => passthrough();
const CLIENT_REMOTE = {
  package: "dsh-token-stats",
  descriptors: [
    {
      id: "dsh-token-stats#tokenStats/getStats",
      service: "tokenStats",
      namespace: "tokenStats",
      method: "getStats",
      invocation: { kind: "direct" },
      parameters: [],
      result: { mode: "strict", typeSymbol: "dsh-token-stats#TokenStatsResult", schema: passthrough(), create: createPassthrough },
    },
    {
      id: "dsh-token-stats#tokenStats/getQuota",
      service: "tokenStats",
      namespace: "tokenStats",
      method: "getQuota",
      invocation: { kind: "direct" },
      parameters: [
        { name: "provider", wire: "provider", source: "json", codec: { mode: "strict", typeSymbol: "dsh-token-stats#tokenStats/getQuota:provider", schema: passthrough(), create: createPassthrough } },
        { name: "force", wire: "force", source: "json", codec: { mode: "strict", typeSymbol: "dsh-token-stats#tokenStats/getQuota:force", schema: passthrough(), create: createPassthrough } },
      ],
      result: { mode: "strict", typeSymbol: "dsh-token-stats#TokenStatsQuotaResult", schema: passthrough(), create: createPassthrough },
    },
    {
      id: "dsh-token-stats#tokenStats/getAllQuotas",
      service: "tokenStats",
      namespace: "tokenStats",
      method: "getAllQuotas",
      invocation: { kind: "direct" },
      parameters: [
        { name: "force", wire: "force", source: "json", codec: { mode: "strict", typeSymbol: "dsh-token-stats#tokenStats/getAllQuotas:force", schema: passthrough(), create: createPassthrough } },
      ],
      result: { mode: "strict", typeSymbol: "dsh-token-stats#TokenStatsAllQuotasResult", schema: passthrough(), create: createPassthrough },
    },
  ],
};

// 4. fresh mount.
try {
  await remote.$mount(CLIENT_REMOTE);
  const ns = ctx.get("remote.tokenStats");
  console.log("[2] mount #1 OK; remote.tokenStats:", ns !== undefined ? "present" : "MISSING");
} catch (error) {
  console.log("[2] mount #1 FAILED:", error.message);
}

// 5. duplicate mount without dispose (page-open install/remove/install churn).
try {
  await remote.$mount(CLIENT_REMOTE);
  console.log("[3] duplicate mount OK");
} catch (error) {
  console.log("[3] duplicate mount FAILED:", error.message);
}
console.log("DONE");
