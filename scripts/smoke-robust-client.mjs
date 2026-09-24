// Throwaway robustness check (not part of the package): run the client bundle
// factory with hostile browser/ctx seams and assert apply() never rejects.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "client.js"), "utf8");

function makeReact() {
  const hooks = () => { throw new Error("react hooks unavailable in this harness"); };
  return {
    createElement: (...args) => ({ __el: args[0], props: args[1] }),
    memo: (fn) => fn,
    useState: hooks,
    useEffect: hooks,
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
  };
}

function loadBundle({ remoteBehavior, slotsBehavior }) {
  let captured = null;
  const sandbox = {
    console,
    window: {},
    document: {
      createElement: () => ({ remove() {} }),
      head: { appendChild() {} },
      querySelectorAll: () => [],
      body: {},
    },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    setInterval, clearInterval, setTimeout, clearTimeout,
  };
  sandbox.window.__ModuleLoader__ = {
    load(entry) { captured = entry; },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  if (!captured) throw new Error("bundle did not register via __ModuleLoader__.load");
  const exports = captured.factory((name) => {
    if (name === "react") return makeReact();
    throw new Error("unexpected require: " + name);
  });
  return { exports, sandbox };
}

async function scenario(name, { remoteBehavior, slotsBehavior, injectBehavior }) {
  const { exports } = loadBundle({});
  const registrations = [];
  const ctx = {
    remote: {
      async $mount() {
        if (remoteBehavior === "mount-throws") throw new Error("descriptor schema drift");
        if (remoteBehavior === "get-throws") return undefined;
        return async () => {};
      },
    },
    get(name) {
      if (name === "remote.tokenStats") {
        if (remoteBehavior === "get-throws") throw new Error("namespace missing");
        return remoteBehavior === "null" ? undefined : { getStats: async () => ({ ok: true, value: { ok: true, value: { ready: true, collecting: false, progress: { done: 0, total: 0 }, error: null, days: [], models: [] } } }) };
      }
      return undefined;
    },
    effect(fn) { return fn(); },
    slots: {
      inject(slot, register) {
        if (slotsBehavior === "inject-throws") throw new Error("slots seam unavailable");
        registrations.push(slot);
        return register();
      },
      register() { return () => {}; },
    },
    inject(deps, cb) {
      if (injectBehavior === "inject-throws") throw new Error("scoped inject unavailable");
      cb({ slots: ctx.slots, modelDirectories: {} });
    },
  };
  try {
    await exports.apply(ctx);
    console.log(name, "=> apply resolved; slots registered:", registrations.join(",") || "(none)");
  } catch (e) {
    console.log(name, "=> APPLY REJECTED (bad):", e.message);
    process.exitCode = 1;
  }
}

await scenario("healthy seams        ", { remoteBehavior: "ok", slotsBehavior: "ok" });
await scenario("remote.$mount throws ", { remoteBehavior: "mount-throws", slotsBehavior: "ok" });
await scenario("remote.tokenStats mis", { remoteBehavior: "get-throws", slotsBehavior: "ok" });
await scenario("slots.inject throws  ", { remoteBehavior: "ok", slotsBehavior: "inject-throws" });
await scenario("ctx.inject throws    ", { remoteBehavior: "ok", slotsBehavior: "ok", injectBehavior: "inject-throws" });
console.log("done");
