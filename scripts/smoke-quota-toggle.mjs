// 套餐开关「点击链路」行为回归（issue #5）。
//
// 背景：v1.12.0 的开关布尔极性接反——QuotaToggle.onChange 发出的是 nextOn
// （下一个「显示」状态），而 QuotaSection 的 onToggle/toggle 期望 nextHidden
// （下一个「隐藏」状态），中间没人反转，于是两个方向都调成 setQuotaHidden(p, false)
// = 空操作，开关点不动。既有冒烟全部直接驱动 host API（__proto__ stub），
// 从没模拟过「点按钮」这条链路，所以漏了。
//
// 本脚本不碰 host，只做 client 侧行为回归：
//   1. 用 vm 加载真实 client.js（QUOTA_TOGGLE_CLIENT 可覆盖被测文件）；
//   2. 跑真实 apply(ctx)，捕获 settings.section 注册的 TokenStatsPage；
//   3. 用 mini-hooks React stub 渲染 TokenStatsPage → 找 QuotaSection 元素；
//   4. 渲染 QuotaSection → 找 QuotaCard → 找 QuotaToggle 的 <button>；
//   5. 真正调 button.props.onClick()，断言 remote.setQuotaHidden 收到的布尔方向
//      与重渲染后的开关/卡片状态。
//
// 对修复前的 client.js（极性未反转）本脚本必须红。
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_JS = process.env.QUOTA_TOGGLE_CLIENT || join(root, "client.js");
const source = readFileSync(CLIENT_JS, "utf8");

let passed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log("  ok   " + label);
  } else {
    failures.push(label);
    console.log("  FAIL " + label + (detail === undefined ? "" : "  → " + detail));
  }
  return !!cond;
}

// ---------------------------------------------------------------------------
// mini-hooks React stub
// ---------------------------------------------------------------------------
function makeReactHarness() {
  const instances = new WeakMap(); // component fn -> instance
  const renderQueue = new Set(); // instances needing a re-render
  const pendingEffects = []; // { inst, index } in registration order
  let current = null; // instance being rendered
  let hookIndex = 0;
  let inFlush = false; // suppress synchronous draining while flushAll owns the loop
  let inRender = false;

  function depsEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }

  function slotOf(inst, index, init) {
    let slot = inst.hooks[index];
    if (!slot) slot = inst.hooks[index] = init;
    return slot;
  }

  function useState(init) {
    const inst = current;
    const index = hookIndex++;
    const slot = slotOf(inst, index, { value: undefined, initialized: false });
    if (!slot.initialized) {
      slot.value = typeof init === "function" ? init() : init;
      slot.initialized = true;
    }
    const setter = function (next) {
      const value = typeof next === "function" ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      scheduleRender(inst);
    };
    return [slot.value, setter];
  }

  function useCallback(fn, deps) {
    const inst = current;
    const index = hookIndex++;
    const slot = slotOf(inst, index, { init: false, value: undefined, deps: undefined });
    if (!slot.init || !depsEqual(slot.deps, deps)) {
      slot.value = fn;
      slot.deps = Array.isArray(deps) ? deps.slice() : deps;
      slot.init = true;
    }
    return slot.value;
  }

  function useEffect(fn, deps) {
    const inst = current;
    const index = hookIndex++;
    const slot = slotOf(inst, index, {
      hasRun: false,
      deps: undefined,
      nextDeps: undefined,
      cleanup: undefined,
      pendingFn: null,
    });
    const changed = !slot.hasRun || !depsEqual(slot.deps, deps);
    if (changed) {
      slot.pendingFn = fn;
      slot.nextDeps = Array.isArray(deps) ? deps.slice() : deps;
      pendingEffects.push({ inst, index });
    }
  }

  function useRef(init) {
    const inst = current;
    const index = hookIndex++;
    const slot = slotOf(inst, index, { ref: { current: init } });
    return slot.ref;
  }

  function createElement(type, props, ...children) {
    return {
      type,
      props: Object.assign({}, props, { children: children.flat() }),
      key: props && props.key,
    };
  }

  const React = {
    createElement,
    memo: (f) => f,
    useState,
    useEffect,
    useCallback,
    useRef,
  };

  function instanceOf(fn) {
    let inst = instances.get(fn);
    if (!inst) {
      inst = { fn, hooks: [], props: undefined, lastTree: null, renders: 0 };
      instances.set(fn, inst);
    }
    return inst;
  }

  function renderInstance(inst) {
    const prev = current;
    const prevIndex = hookIndex;
    current = inst;
    hookIndex = 0;
    inRender = true;
    try {
      inst.lastTree = inst.fn(inst.props);
      inst.renders += 1;
    } finally {
      inRender = false;
      current = prev;
      hookIndex = prevIndex;
    }
    return inst.lastTree;
  }

  function drainRenders(limit) {
    let guard = 0;
    const cap = limit || 50;
    while (renderQueue.size && guard < cap) {
      const batch = Array.from(renderQueue);
      renderQueue.clear();
      for (const inst of batch) renderInstance(inst);
      guard += 1;
    }
    if (renderQueue.size) renderQueue.clear(); // 防无限循环：丢弃剩余
  }

  function scheduleRender(inst) {
    renderQueue.add(inst);
    // 和真 React 一样：setState 不在渲染/批量刷新过程中时同步跟一次重渲染。
    if (!inFlush && !inRender) drainRenders();
  }

  function renderComponent(fn, props) {
    const inst = instanceOf(fn);
    inst.props = props;
    renderInstance(inst);
    if (!inFlush) drainRenders();
    return inst.lastTree;
  }

  function lastTree(fn) {
    const inst = instances.get(fn);
    return inst ? inst.lastTree : null;
  }

  function runEffect(inst, index) {
    const slot = inst.hooks[index];
    if (!slot || !slot.pendingFn) return false; // 已被更新的渲染取代
    const fn = slot.pendingFn;
    slot.pendingFn = null;
    slot.hasRun = true;
    slot.deps = slot.nextDeps;
    if (typeof slot.cleanup === "function") {
      try {
        slot.cleanup();
      } catch (e) {
        /* 清理失败不影响断言 */
      }
    }
    const cleanup = fn();
    slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    return true;
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** 跑 effect → 让 async load 的微任务落地 → 跑重渲染队列，直到连续两轮无事可做。 */
  async function flushAll(maxRounds) {
    const cap = maxRounds || 50;
    const prevFlush = inFlush;
    inFlush = true;
    let idle = 0;
    try {
      for (let round = 0; round < cap; round++) {
        let progressed = false;
        while (pendingEffects.length) {
          const job = pendingEffects.shift();
          if (runEffect(job.inst, job.index)) progressed = true;
        }
        await settle();
        if (renderQueue.size) {
          drainRenders();
          progressed = true;
        }
        if (pendingEffects.length) progressed = true;
        if (progressed) idle = 0;
        else idle += 1;
        if (idle >= 2) return;
      }
    } finally {
      inFlush = prevFlush;
    }
  }

  return { React, renderComponent, flushAll, lastTree };
}

// ---------------------------------------------------------------------------
// 元素树工具
// ---------------------------------------------------------------------------
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  const children = node.props && node.props.children;
  if (Array.isArray(children)) for (const child of children) walk(child, visit);
}

function findAll(node, componentName) {
  const out = [];
  walk(node, (el) => {
    if (typeof el.type === "function" && el.type.name === componentName) out.push(el);
  });
  return out;
}

function textOf(node) {
  let text = "";
  walk(node, (el) => {
    const children = el.props && el.props.children;
    if (!Array.isArray(children)) return;
    for (const child of children) if (typeof child === "string") text += child;
  });
  return text;
}

// ---------------------------------------------------------------------------
// sandbox（document / 观察者 / 定时器 / window）
// ---------------------------------------------------------------------------
function makeSandbox() {
  const styleTags = [];
  const intervals = [];
  const listeners = {};
  const documentStub = {
    createElement(tag) {
      const el = {
        tagName: String(tag).toUpperCase(),
        style: {},
        textContent: "",
        attrs: {},
        setAttribute(name, value) {
          el.attrs[name] = value;
        },
        getAttribute(name) {
          return el.attrs[name];
        },
        removeAttribute(name) {
          delete el.attrs[name];
        },
        remove() {
          const i = styleTags.indexOf(el);
          if (i >= 0) styleTags.splice(i, 1);
        },
      };
      return el;
    },
    head: {
      appendChild(el) {
        styleTags.push(el);
      },
    },
    body: {},
    querySelectorAll() {
      return [];
    },
  };
  const sandbox = {
    console,
    document: documentStub,
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class ResizeObserver {
      observe() {}
      disconnect() {}
    },
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    // 记录但不触发：轮询在回归里是噪音。
    setInterval(fn, ms) {
      const id = { fn, ms };
      intervals.push(id);
      return id;
    },
    clearInterval(id) {
      const i = intervals.indexOf(id);
      if (i >= 0) intervals.splice(i, 1);
    },
    // 真实（但压到 ≤5ms）：统计页的延迟重试 / effect 里的 await 需要真正让出。
    setTimeout(fn, ms) {
      return globalThis.setTimeout(fn, Math.min(Number(ms) || 0, 5));
    },
    clearTimeout(id) {
      globalThis.clearTimeout(id);
    },
    window: {
      addEventListener(type, handler) {
        (listeners[type] = listeners[type] || []).push(handler);
      },
      removeEventListener(type, handler) {
        const list = listeners[type] || [];
        const i = list.indexOf(handler);
        if (i >= 0) list.splice(i, 1);
      },
      dispatchEvent(event) {
        const list = (listeners[event && event.type] || []).slice();
        for (const handler of list) handler(event);
        return true;
      },
    },
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.document = documentStub;
  return { sandbox, styleTags, intervals, listeners };
}

// ---------------------------------------------------------------------------
// 有状态 host remote stub
// ---------------------------------------------------------------------------
function makeRemoteStub() {
  const state = {
    hidden: new Set(),
    setQuotaHiddenCalls: [],
    getAllQuotasForces: [],
  };

  const statsOk = {
    ok: true,
    value: {
      ok: true,
      value: { ready: true, collecting: false, progress: { done: 0, total: 0 }, error: null, days: [], models: [] },
    },
  };

  function minimaxValue() {
    if (state.hidden.has("minimax")) {
      return { ok: false, provider: "minimax", kind: "hidden", message: "已隐藏" };
    }
    return {
      ok: true,
      provider: "minimax",
      display: {
        fiveHrPct: 3,
        weeklyPct: 1,
        monthlyPct: null,
        fiveHrResetsIn: "39m",
        weeklyResetsIn: "153h",
        monthlyResetsIn: null,
        balanceText: null,
        balanceUsd: null,
        currency: null,
      },
    };
  }

  const remote = {
    async getStats() {
      return statsOk;
    },
    async getAllQuotas(force) {
      state.getAllQuotasForces.push(force === true);
      return {
        ok: true,
        value: {
          ok: true,
          value: {
            quotas: {
              minimax: minimaxValue(),
              deepseek: { ok: false, provider: "deepseek", kind: "unconfigured", message: "未配置" },
            },
          },
        },
      };
    },
    async setQuotaHidden(provider, hidden) {
      state.setQuotaHiddenCalls.push([provider, hidden]);
      if (hidden === true) state.hidden.add(provider);
      else state.hidden.delete(provider);
      return { ok: true, value: { hidden: Array.from(state.hidden).sort() } };
    },
    async getBailianSetup() {
      // 门控为 false：BailianSetupCard 完全不渲染（本回归只关心配额卡）。
      return {
        ok: true,
        value: {
          ok: true,
          value: {
            modelConfigured: false,
            akConfigured: false,
            maskedAk: null,
            region: "cn-beijing",
            site: "domestic",
            routes: [],
          },
        },
      };
    },
    async getQuota(provider) {
      return { ok: true, value: { ok: true, value: minimaxValue() } };
    },
    async saveBailianCredentials() {
      return { ok: true, value: { ok: true, value: { saved: false, message: "unused in this smoke" } } };
    },
    async clearBailianCredentials() {
      return { ok: true, value: { ok: true, value: { cleared: false, message: "unused in this smoke" } } };
    },
  };

  return { remote, state };
}

// ---------------------------------------------------------------------------
// 加载真实 client.js + 跑真实 apply(ctx)
// ---------------------------------------------------------------------------
async function bootClient() {
  const H = makeReactHarness();
  const { sandbox, styleTags } = makeSandbox();
  const { remote, state } = makeRemoteStub();

  let captured = null;
  sandbox.window.__ModuleLoader__ = {
    load(entry) {
      captured = entry;
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: CLIENT_JS });
  if (!captured) throw new Error("client bundle 没有通过 __ModuleLoader__.load 注册");

  const exports = captured.factory((name) => {
    if (name === "react") return H.React;
    throw new Error("unexpected require: " + name);
  });

  const registrations = new Map(); // slot name -> { spec, comp }
  const mountedSpecs = [];
  const slots = {
    inject(slot, register) {
      return register();
    },
    register(spec, comp) {
      registrations.set(spec && spec.name, { spec, comp });
      return () => {};
    },
  };

  const ctx = {
    remote: {
      async $mount(spec) {
        mountedSpecs.push(spec);
        return async () => {};
      },
    },
    get(name) {
      if (name === "remote.tokenStats") return remote;
      return undefined;
    },
    effect(fn) {
      return fn();
    },
    slots,
    inject(deps, cb) {
      cb({ slots, modelDirectories: {} });
    },
  };

  await exports.apply(ctx);

  return { H, remote, state, registrations, mountedSpecs, styleTags };
}

// ---------------------------------------------------------------------------
// 断言主体
// ---------------------------------------------------------------------------
async function main() {
  console.log("smoke-quota-toggle: 被测文件 = " + CLIENT_JS);
  const { H, remote, state, registrations, mountedSpecs, styleTags } = await bootClient();

  check("client apply() 挂上了 tokenStats Remote 命名空间（$mount 收到描述符）", mountedSpecs.length === 1);
  check("样式表注入成功（document.head 收到带 data-plugin 的 style）",
    styleTags.length === 1 && styleTags[0].attrs["data-plugin"] !== undefined,
    "styleTags=" + styleTags.length);

  // ---- 1. settings.section 注册 -------------------------------------------------
  const sectionReg = registrations.get("settings.section");
  check("client 注册了 settings.section 槽", !!sectionReg);
  if (!sectionReg) throw new Error("没有 settings.section 注册，无法继续");
  const TokenStatsPage = sectionReg.comp;
  check("settings.section 的组件是 TokenStatsPage", TokenStatsPage && TokenStatsPage.name === "TokenStatsPage",
    TokenStatsPage && TokenStatsPage.name);
  check("settings.section id 是 token-stats", sectionReg.spec && sectionReg.spec.id === "token-stats");

  // ---- 2. 渲染统计页并找到 QuotaSection 元素 ------------------------------------
  H.renderComponent(TokenStatsPage, {});
  await H.flushAll();
  const pageTree = H.lastTree(TokenStatsPage);
  check("TokenStatsPage 渲染出了元素树", !!pageTree && typeof pageTree === "object");
  const pageText = textOf(pageTree);
  check("统计页没有落到「加载失败」错误态", pageText.indexOf("加载失败") < 0, pageText.slice(0, 120));
  check("统计页显示了标题（effect 里的 getStats 已落地）", pageText.indexOf("Token 用量统计") >= 0);

  const sectionEls = findAll(pageTree, "QuotaSection");
  check("统计页树里找到 QuotaSection 元素（getStats ready 后才会渲染）", sectionEls.length === 1,
    "found=" + sectionEls.length);
  if (sectionEls.length !== 1) throw new Error("QuotaSection 缺失，无法继续");
  const QuotaSection = sectionEls[0].type;

  // ---- 3. 渲染 QuotaSection（真实 hooks + getAllQuotas effect） ----------------
  H.renderComponent(QuotaSection, sectionEls[0].props);
  await H.flushAll();
  let sectionTree = H.lastTree(QuotaSection);
  check("QuotaSection 渲染出了元素树", !!sectionTree && typeof sectionTree === "object");

  let cards = findAll(sectionTree, "QuotaCard");
  check("只有 minimax 一张配额卡（deepseek unconfigured 不渲染）", cards.length === 1, "cards=" + cards.length);
  if (cards.length !== 1) throw new Error("配额卡数量不符，无法继续");
  check("卡片 provider 是 minimax", cards[0].props && cards[0].props.provider === "minimax",
    cards[0].props && cards[0].props.provider);
  check("卡片初始不是隐藏变体", cards[0].props.hidden !== true);

  // ---- 4. 可见卡的开关初始态 + 模拟点击 ---------------------------------------
  function toggleButtonOf(cardEl) {
    const cardTree = cardEl.type(cardEl.props); // QuotaCard 无 hooks，纯函数
    const toggles = findAll(cardTree, "QuotaToggle");
    if (toggles.length !== 1) throw new Error("卡片里 QuotaToggle 数量 = " + toggles.length);
    const toggleEl = toggles[0];
    const button = toggleEl.type(toggleEl.props); // QuotaToggle 无 hooks
    if (!button || button.type !== "button") throw new Error("QuotaToggle 没渲染出 button");
    return { cardTree, QuotaToggle: toggleEl.type, toggleProps: toggleEl.props, button };
  }

  const visible = toggleButtonOf(cards[0]);
  check("可见卡开关 className 含 ts-quota-switch-on",
    String(visible.button.props.className || "").indexOf("ts-quota-switch-on") >= 0,
    visible.button.props.className);
  check("可见卡开关 aria-checked === true", visible.button.props["aria-checked"] === true,
    visible.button.props["aria-checked"]);
  check("开关是 role=switch 的 button", visible.button.props.role === "switch" && visible.button.type === "button");
  check("点击前没有调用过 setQuotaHidden", state.setQuotaHiddenCalls.length === 0,
    JSON.stringify(state.setQuotaHiddenCalls));

  let stopPropagations = 0;
  const clickEvent = () => ({ stopPropagation() { stopPropagations += 1; } });

  // 真实点击链路：button.onClick → QuotaToggle.onChange(!on) → QuotaCard.onToggle → QuotaSection.toggle
  visible.button.props.onClick(clickEvent());
  await H.flushAll();

  const callsAfterFirst = state.setQuotaHiddenCalls;
  check("点击开关触发了 remote.setQuotaHidden", callsAfterFirst.length === 1, JSON.stringify(callsAfterFirst));
  check(
    "极性：可见 → 隐藏必须传 true（v1.12.0 的极性 bug 会传 false，此断言红）",
    callsAfterFirst.length === 1 && callsAfterFirst[0][0] === "minimax" && callsAfterFirst[0][1] === true,
    JSON.stringify(callsAfterFirst[0]),
  );
  check("点击时调用了 stopPropagation", stopPropagations === 1, "stopPropagations=" + stopPropagations);
  check("host 侧隐藏集合已更新（minimax 隐藏）", state.hidden.has("minimax"));
  check("toggle 后强制重取配额（load(true) → getAllQuotas(true)）",
    state.getAllQuotasForces.length >= 2 && state.getAllQuotasForces[state.getAllQuotasForces.length - 1] === true,
    JSON.stringify(state.getAllQuotasForces));

  // ---- 5. 重渲染后卡片应变成隐藏变体 -----------------------------------------
  sectionTree = H.lastTree(QuotaSection);
  cards = findAll(sectionTree, "QuotaCard");
  check("重渲染后仍只有一张配额卡", cards.length === 1, "cards=" + cards.length);
  if (cards.length !== 1) throw new Error("重渲染后卡片数量不符");

  const hiddenCardText = textOf(cards[0].type(cards[0].props));
  check("重渲染后卡片是隐藏变体（子树含「已隐藏」）", hiddenCardText.indexOf("已隐藏") >= 0,
    JSON.stringify(hiddenCardText.slice(0, 120)));

  const hidden = toggleButtonOf(cards[0]);
  check("隐藏卡开关 className 不再含 ts-quota-switch-on",
    String(hidden.button.props.className || "").indexOf("ts-quota-switch-on") < 0,
    hidden.button.props.className);
  check("隐藏卡开关 aria-checked === false", hidden.button.props["aria-checked"] === false,
    hidden.button.props["aria-checked"]);

  // ---- 6. 再点一次：隐藏 → 可见 ------------------------------------------------
  hidden.button.props.onClick(clickEvent());
  await H.flushAll();

  const callsAfterSecond = state.setQuotaHiddenCalls;
  check("再次点击开关又触发了一次 setQuotaHidden", callsAfterSecond.length === 2,
    JSON.stringify(callsAfterSecond));
  check(
    "极性：隐藏 → 可见必须传 false",
    callsAfterSecond.length === 2 &&
      callsAfterSecond[1][0] === "minimax" &&
      callsAfterSecond[1][1] === false,
    JSON.stringify(callsAfterSecond[1]),
  );
  check("host 侧隐藏集合已清空（minimax 重新显示）", state.hidden.has("minimax") === false);

  sectionTree = H.lastTree(QuotaSection);
  cards = findAll(sectionTree, "QuotaCard");
  check("恢复后仍只有一张配额卡", cards.length === 1, "cards=" + cards.length);
  if (cards.length !== 1) throw new Error("恢复后卡片数量不符");

  const restored = toggleButtonOf(cards[0]);
  const restoredText = textOf(cards[0].type(cards[0].props));
  check("恢复后卡片不再是隐藏变体（不含「已隐藏」）", restoredText.indexOf("已隐藏") < 0,
    JSON.stringify(restoredText.slice(0, 120)));
  check("恢复后开关 className 重新含 ts-quota-switch-on",
    String(restored.button.props.className || "").indexOf("ts-quota-switch-on") >= 0,
    restored.button.props.className);
  check("恢复后开关 aria-checked === true", restored.button.props["aria-checked"] === true,
    restored.button.props["aria-checked"]);

  // ---- 7. QuotaToggle 纯函数契约（钉住组件语义，不依赖上层接线） --------------
  const seen = [];
  const onToggle = restored.QuotaToggle({ on: true, onChange: (next) => seen.push(next) });
  onToggle.props.onClick(clickEvent());
  check("QuotaToggle 契约：on=true 点击发 nextOn=false", seen.length === 1 && seen[0] === false,
    JSON.stringify(seen));

  seen.length = 0;
  const offToggle = restored.QuotaToggle({ on: false, onChange: (next) => seen.push(next) });
  check("QuotaToggle 契约：on=false 时 aria-checked=false 且无 -on class",
    offToggle.props["aria-checked"] === false &&
      String(offToggle.props.className || "").indexOf("ts-quota-switch-on") < 0,
    offToggle.props.className);
  offToggle.props.onClick(clickEvent());
  check("QuotaToggle 契约：on=false 点击发 nextOn=true", seen.length === 1 && seen[0] === true,
    JSON.stringify(seen));

  // ---- 8. 汇总 ----------------------------------------------------------------
  console.log("");
  if (failures.length === 0) {
    console.log("ALL PASS (" + passed + " checks)");
  } else {
    console.log(failures.length + " FAILURES (" + passed + " passed)");
  }
  process.exitCode = failures.length === 0 ? 0 : 1;
}

try {
  await main();
} catch (e) {
  console.log("");
  console.log("HARNESS ERROR: " + ((e && e.stack) || e));
  console.log(failures.length + " FAILURES (" + passed + " passed)");
  process.exitCode = 1;
}