/**
 * Offline reproduction of the CLIENT-side $mount for the tokenStats namespace,
 * using the REAL deployed client gateway bundle (dsh-api-gateway/lib/client.js)
 * on a real cordis Context.
 *
 * The descriptors are NOT copied by hand any more (the v1.5.2 hardcoded copy
 * could drift from client.js and kept testing 3 of 7 methods). This repro
 * evaluates the REAL client.js bundle in a vm sandbox — the same harness as
 * scripts/smoke-robust-client.mjs — runs its `apply(stubCtx)` and captures the
 * spec it passes to `ctx.remote.$mount(CLIENT_REMOTE)`. Whatever the gateway
 * rejects is then the gateway's own error, i.e. what the browser would see.
 *
 * Tests:
 *   [1]  real client.js bundle loaded + descriptors captured (7 since v1.12.0)
 *   [2]  a fresh mount — failure sets exit code 1; after mount the namespace
 *        must expose `setQuotaHidden`
 *   [3]  a duplicate mount (print-only: pre-existing gateway "already mounted"
 *        guard, the install->remove->install churn scenario)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { Context } from "@deepseek-ai/cordis";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";

// ---- 1. load the REAL client.js in a vm sandbox and capture CLIENT_REMOTE ---
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "client.js"), "utf8");

function makeReact() {
  // apply() must never call hooks; render-only hooks stay benign no-ops so a
  // stray call cannot masquerade as a bundle failure here.
  return {
    createElement: (...args) => ({ __el: args[0], props: args[1] }),
    memo: (fn) => fn,
    Fragment: "Fragment",
    useState: (init) => [typeof init === "function" ? init() : init, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init === undefined ? null : init }),
  };
}

let capturedBundle = null;
const sandbox = {
  console,
  window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } },
  CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
  document: {
    createElement: () => ({ remove() {}, setAttribute() {}, textContent: "" }),
    head: { appendChild() {} },
    body: {},
    querySelectorAll: () => [],
  },
  MutationObserver: class { observe() {} disconnect() {} },
  ResizeObserver: class { observe() {} disconnect() {} },
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
};
sandbox.window.__ModuleLoader__ = {
  load(entry) {
    capturedBundle = entry;
  },
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

let failures = 0;
function check(label, cond, extra) {
  console.log((cond ? "  ok  " : "  FAIL") + " " + label + (extra ? "  " + extra : ""));
  if (!cond) failures++;
}

check("[1] client.js registered via __ModuleLoader__.load", capturedBundle !== null);
if (!capturedBundle) {
  console.log("DONE (WITH FAILURES)");
  process.exit(1);
}
check("[1] bundle id matches the module id", capturedBundle.id === "@duke-dsh-plugins/dsh-token-stats", String(capturedBundle.id));

const bundleExports = capturedBundle.factory((name) => {
  if (name === "react") return makeReact();
  throw new Error(`repro: no stub for require(${name})`);
});

// Stub client ctx: the only job of $mount here is to hand us the real spec.
let CLIENT_REMOTE = null;
const stubCtx = {
  remote: {
    async $mount(spec) {
      CLIENT_REMOTE = spec;
      return async () => {};
    },
  },
  get: () => null,
  effect: (fn) => {
    try {
      return fn();
    } catch (e) {
      return undefined;
    }
  },
  slots: { inject: () => {}, register: () => () => {} },
  inject: () => {},
};
await bundleExports.apply(stubCtx);

const descriptors = CLIENT_REMOTE && Array.isArray(CLIENT_REMOTE.descriptors) ? CLIENT_REMOTE.descriptors : null;
check("[1] captured CLIENT_REMOTE", CLIENT_REMOTE !== null && CLIENT_REMOTE.package === "dsh-token-stats");
check("[1] descriptors.length === 7 (v1.12.0 surface)", !!descriptors && descriptors.length === 7, descriptors ? String(descriptors.length) : "none");
if (descriptors) console.log("      ids:", descriptors.map((d) => d.method).join(", "));
check(
  "[1] setQuotaHidden descriptor present",
  !!descriptors && descriptors.some((d) => d && d.method === "setQuotaHidden" && d.id === "dsh-token-stats#tokenStats/setQuotaHidden"),
);
if (!descriptors) {
  console.log("DONE (WITH FAILURES)");
  process.exit(1);
}

// ---- 2. real client gateway bundle + a real cordis Context -----------------
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
// DSH 0.2.1-rc.2 split the gateway client bundle: lib/client.browser.js keeps
// the __ModuleLoader__ wrapper this repro drives, lib/client.node.js is a
// plain-ESM build, and older deployments shipped a single lib/client.js
// wrapper. Prefer the browser wrapper, fall back to the legacy single file.
const gatewayRoot =
  "C:/Users/wwhby/AppData/Roaming/DeepSeek Harness Desktop/dsh/node_modules/@deepseek-ai/dsh-api-gateway";
const gatewayBundle = existsSync(`${gatewayRoot}/lib/client.browser.js`)
  ? `${gatewayRoot}/lib/client.browser.js`
  : `${gatewayRoot}/lib/client.js`;
await import(pathToFileURL(gatewayBundle).href);

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
console.log("[2] ctx.remote ready:", remote !== undefined);

// ---- 3. fresh mount of the REAL descriptors -------------------------------
try {
  await remote.$mount(CLIENT_REMOTE);
  const ns = ctx.get("remote.tokenStats");
  check("[2] mount #1 OK; remote.tokenStats present", ns !== undefined);
  check("[2] remote.tokenStats.setQuotaHidden is a function", !!ns && typeof ns.setQuotaHidden === "function");
} catch (error) {
  check("[2] mount #1 OK", false, error && error.message ? error.message : String(error));
}

// ---- 4. duplicate mount without dispose (print-only, pre-existing guard) ---
try {
  await remote.$mount(CLIENT_REMOTE);
  console.log("[3] duplicate mount OK");
} catch (error) {
  console.log("[3] duplicate mount FAILED:", error.message);
}

console.log(failures === 0 ? "DONE — ALL PASS" : "DONE (WITH FAILURES)");
process.exitCode = failures === 0 ? 0 : 1;