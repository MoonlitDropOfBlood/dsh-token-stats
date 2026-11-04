// Settings nav icon regression check (not part of the package).
//
// DSH 0.2.2-rc.1 changed the settings navigation twice over:
//   1. it added the `settings.section.icon` slot, so a plugin can contribute
//      the nav glyph for its own section id, and
//   2. it wrapped the shell's glyph in a decorative `span.navIcon`, so the
//      legacy fallback selector `button > svg:first-child` no longer matches
//      the core gear.
//
// The bug this guards: on such a shell the legacy CSS fallback kept drawing
// its own glyph while the shell/slot drew another one — two icons at once.
// The fix keeps the two paths mutually exclusive: the slot contribution owns
// the glyph on 0.2.2+, and the CSS fallback only applies while the nav button
// still has the legacy shape (gear `<svg>` as its first element child).
//
// Asserts, against the real client bundle:
//   - `settings.section.icon` is registered under the SAME id as the
//     `settings.section` contribution (the slot matches by id),
//   - the contributed component renders one stroke-only SVG glyph in
//     currentColor at the requested size,
//   - the slot glyph and the legacy CSS-mask fallback draw the SAME paths,
//   - a legacy-shaped nav row is marked (CSS fallback applies),
//   - a 0.2.2+-shaped nav row is NOT marked (no second glyph).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "client.js"), "utf8");

const MARKER = "data-dsh-token-stats-settings-nav";
const SECTION_ID = "token-stats";

let failures = 0;
function check(ok, label, detail) {
  if (ok) {
    console.log("  ok   " + label);
  } else {
    failures += 1;
    console.log("  FAIL " + label + (detail ? " — " + detail : ""));
  }
}

function makeReact() {
  const hooks = () => { throw new Error("react hooks unavailable in this harness"); };
  return {
    createElement: (...args) => ({ __el: args[0], props: args[1], children: args.slice(2) }),
    memo: (fn) => fn,
    useState: hooks,
    useEffect: hooks,
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
  };
}

// A nav button in one of the two shell shapes. `firstElementChild` is the
// discriminator the bundle uses: legacy = the gear <svg> itself, 0.2.2+ = the
// shell's <span> wrapper around the glyph.
function makeButton(text, shape) {
  const attrs = new Map();
  return {
    textContent: text,
    firstElementChild: shape === "legacy" ? { tagName: "SVG" } : { tagName: "SPAN" },
    setAttribute(name, value) { attrs.set(name, value); },
    removeAttribute(name) { attrs.delete(name); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    hasAttribute(name) { return attrs.has(name); },
  };
}

function loadBundle(buttons) {
  let captured = null;
  const observers = [];
  const sandbox = {
    console,
    window: {},
    document: {
      createElement: () => ({ remove() {} }),
      head: { appendChild() {} },
      body: {},
      querySelectorAll(selector) {
        if (selector === '[role="dialog"] nav button') return buttons;
        if (selector === "[" + MARKER + "]") {
          return buttons.filter((b) => b.hasAttribute(MARKER));
        }
        return [];
      },
    },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class { observe() {} disconnect() {} },
    setInterval, clearInterval, setTimeout, clearTimeout,
  };
  sandbox.window.__ModuleLoader__ = { load(entry) { captured = entry; } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  if (!captured) throw new Error("bundle did not register via __ModuleLoader__.load");
  const exports = captured.factory((name) => {
    if (name === "react") return makeReact();
    throw new Error("unexpected require: " + name);
  });
  return { exports, observers };
}

function makeCtx(registrations) {
  return {
    remote: { async $mount() { return async () => {}; } },
    get() { return undefined; },
    effect(fn) { return fn(); },
    slots: {
      inject(slot, register) { return register(); },
      register(options, component) {
        registrations.push({ slot: options.name, options, component });
        return () => {};
      },
    },
    inject(deps, cb) { cb({ slots: this.slots, modelDirectories: {} }); },
  };
}

// ---- 1. slot registration + glyph shape ------------------------------------
console.log("settings.section.icon slot");
const registrations = [];
const buttons = [];
const { exports } = loadBundle(buttons);
await exports.apply(makeCtx(registrations));

const section = registrations.find((r) => r.slot === "settings.section");
const icon = registrations.find((r) => r.slot === "settings.section.icon");
check(!!section, "settings.section is registered");
check(!!icon, "settings.section.icon is registered");
check(
  !!section && !!icon && section.options.id === icon.options.id,
  "icon id matches the section id",
  `section=${section && section.options.id} icon=${icon && icon.options.id}`,
);
check(
  !!icon && icon.options.id === SECTION_ID,
  "icon id is " + SECTION_ID,
  icon && icon.options.id,
);

if (icon) {
  const el = icon.component({ size: 16, active: false });
  check(el && el.__el === "svg", "icon component renders an <svg>");
  check(el && el.props.width === 16 && el.props.height === 16, "icon honors the requested size");
  check(el && el.props.stroke === "currentColor", "icon is stroked in currentColor");
  check(el && el.props.fill === "none", "icon is stroke-only (no fill)");
  const paths = (el && el.children) || [];
  check(paths.length === 4, "icon draws 4 paths (axis + 3 bars)", "got " + paths.length);
  const ds = paths.map((p) => p.props.d);
  check(
    ds.join("|") === "M3 3v16a2 2 0 0 0 2 2h16|M18 17V9|M13 17V5|M8 17v-3",
    "icon paths are the Lucide chart-column glyph",
    ds.join("|"),
  );
  const fallback = icon.component({});
  check(fallback && fallback.props.width === 16, "icon falls back to 16px without a size prop");
}

// The legacy CSS mask must draw the SAME glyph, so switching shells never
// changes the icon the user sees.
const css = (source.match(/const CSS = `([\s\S]*?)`;/) || [])[1] || "";
check(css.includes("[" + MARKER + "]>svg:first-child{display:none}"), "legacy fallback still hides the direct-svg gear");
// Comments may name the new wrapper; only the RULES matter.
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, "");
check(
  !/>span>svg/.test(cssRules) && !/navIcon/.test(cssRules),
  "legacy CSS rules do not target the 0.2.2+ span.navIcon glyph",
);

// ---- 2. the two nav shapes --------------------------------------------------
console.log("nav shell shapes");
const legacyButton = makeButton("Token 统计", "legacy");
const modernButton = makeButton("Token 统计", "modern");
const otherButton = makeButton("通用", "modern");

const regs2 = [];
const { exports: exports2, observers } = loadBundle([legacyButton, modernButton, otherButton]);
await exports2.apply(makeCtx(regs2));

check(
  legacyButton.hasAttribute(MARKER),
  "legacy-shaped row is marked (CSS fallback replaces the gear)",
);
check(
  !modernButton.hasAttribute(MARKER),
  "0.2.2+-shaped row is NOT marked (slot glyph is not doubled)",
);
check(
  !otherButton.hasAttribute(MARKER),
  "another section's row is NOT marked",
);

// The MutationObserver must re-evaluate when the shell re-renders the row.
legacyButton.firstElementChild = { tagName: "SPAN" };
for (const observer of observers) observer.cb();
check(
  !legacyButton.hasAttribute(MARKER),
  "re-rendered 0.2.2+ row drops the legacy marker",
);
legacyButton.firstElementChild = { tagName: "SVG" };
for (const observer of observers) observer.cb();
check(
  legacyButton.hasAttribute(MARKER),
  "re-rendered legacy row keeps the legacy marker",
);

console.log(failures === 0 ? "done (all checks passed)" : `done (${failures} FAILED)`);
if (failures > 0) process.exitCode = 1;
