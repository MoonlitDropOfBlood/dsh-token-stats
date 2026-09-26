/**
 * dsh-token-stats — Client half (web bundle).
 *
 * Rendered by the DSH web shell via `window.__ModuleLoader__.load`. Registers
 * a "Token 统计" page in the Settings panel (`settings.section`) with:
 *   - two tabs (近 7 天 / 近 30 天, both include today),
 *   - a stacked bar chart (per-model daily consumption over the range),
 *   - a donut + legend (per-model total share over the range),
 *   - a GitHub-contributions-style heatmap whose day range adapts to the
 *     container width (capped at one year / 365 days).
 *
 * It also registers a compact 套餐余额/用量 readout in the composer tool row
 * (`conversation.input.right`, immediately left of the model select — the
 * same seat dsh-musage uses), following the session's active provider and
 * polling `tokenStats.getQuota` (click forces a cache-bypassing refresh).
 *
 * Host communication goes through the `tokenStats` Remote namespace
 * (`ctx.remote.tokenStats.getStats()/getQuota()`), published by the Host half
 * in `index.js`.
 */
window.__ModuleLoader__.load({
  id: "@duke-dsh-plugins/dsh-token-stats",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    // ---- CSS (package-owned, mirrors DSH design tokens) --------------------
    const CSS = `
.ts-page{max-width:720px;width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}
.ts-head{display:flex;align-items:center;gap:10px}
.ts-head-title{font-size:16px;font-weight:500;line-height:24px;margin:0;flex:1}
.ts-refresh{box-sizing:border-box;height:28px;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:transparent;color:var(--dsw-alias-label-secondary);padding:0 12px;font-size:12px;line-height:26px}
.ts-refresh:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.ts-cred-block{display:flex;flex-direction:column;gap:8px}
.ts-cred-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ts-cred-label{min-width:64px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ts-cred-input{box-sizing:border-box;height:28px;flex:1;min-width:220px;font:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 10px;font-size:12px}
.ts-cred-input:focus{outline:none;border-color:var(--dsw-alias-border-l1)}
.ts-cred-save{box-sizing:border-box;height:28px;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:0 12px;font-size:12px}
.ts-cred-save:hover{border-color:var(--dsw-alias-border-l1)}
.ts-cred-save:disabled{opacity:.5;cursor:default}
.ts-cred-msg{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ts-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-height:18px}
.ts-tabs{display:inline-flex;gap:4px;padding:3px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;align-self:flex-start}
.ts-tab{box-sizing:border-box;height:26px;font:inherit;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;padding:0 14px;font-size:13px;line-height:26px}
.ts-tab-active{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,0.08)}
.ts-body{display:flex;flex-direction:column;gap:16px}
.ts-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.ts-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:4px}
.ts-card-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.ts-card-value{font-size:18px;font-weight:600;line-height:26px}
.ts-block{display:flex;flex-direction:column;gap:8px}
.ts-block-title{color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px}
.ts-bar-legend{display:flex;flex-wrap:wrap;gap:6px 14px}
.ts-legend-chip{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.ts-bar-legend .ts-legend-name{color:var(--dsw-alias-label-primary)}
.ts-legend-dot{width:10px;height:10px;border-radius:3px;flex:none;display:inline-block}
.ts-pie-wrap{display:flex;flex-wrap:wrap;gap:20px;align-items:center}
.ts-legend{display:flex;flex-direction:column;gap:8px;min-width:180px;flex:1}
.ts-legend-row{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px}
.ts-legend-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ts-legend-val{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ts-heat{stroke:var(--dsw-alias-border-l1);stroke-width:0.5}
.ts-quota{position:relative;display:inline-flex}
.ts-quota-pop{position:absolute;bottom:calc(100% + 8px);right:0;width:230px;box-sizing:border-box;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:var(--dsw-elevation-soft,0 6px 24px rgba(0,0,0,0.18));padding:10px 12px;display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);z-index:60;pointer-events:none;animation:ts-pop-in .12s ease-out}
.ts-quota-pop-head{display:flex;align-items:center;justify-content:space-between;gap:12px;font-weight:600;font-size:12px}
.ts-quota-pop-sub{color:var(--dsw-alias-label-secondary);font-size:11px}
.ts-quota-pop-row{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-secondary)}
.ts-quota-pop-row b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}
.ts-quota-pop-bar{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.ts-quota-pop-bar i{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary,var(--dsh-accent,#4D6BFE))}
.ts-quota-pop-err{color:var(--dsw-alias-state-error-primary,#e5534b);word-break:break-all}
@keyframes ts-pop-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.ts-quota-card{display:flex;flex-direction:column;gap:6px}
.ts-quota-list{display:flex;flex-direction:column;gap:10px}
.ts-quota-list .ts-card{width:100%;box-sizing:border-box}
.ts-quota-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.ts-quota-card-name{font-size:13px;font-weight:600;line-height:20px}
.ts-quota-card-status{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.ts-quota-card-status.ts-quota-err{color:var(--dsw-alias-state-error-primary,#e5534b)}
.ts-quota-card-value{font-size:18px;font-weight:600;line-height:26px;font-variant-numeric:tabular-nums}
.ts-quota-card-bar{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.ts-quota-card-bar i{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary,var(--dsh-accent,#4D6BFE))}
.ts-heat-0{fill:var(--dsw-alias-bg-layer-2);fill:color-mix(in srgb,var(--dsw-alias-border-l1) 45%,transparent);background:var(--dsw-alias-bg-layer-2);background:color-mix(in srgb,var(--dsw-alias-border-l1) 45%,transparent)}
.ts-heat-1{fill:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-primary);opacity:0.3}
.ts-heat-2{fill:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-primary);opacity:0.5}
.ts-heat-3{fill:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-primary);opacity:0.75}
.ts-heat-4{fill:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-primary);opacity:1}
.ts-heat-legend{display:flex;align-items:center;gap:3px}
.ts-heat-legend-cell{width:10px;height:10px;border-radius:2px}
.ts-heat-legend-label{color:var(--dsw-alias-label-secondary);font-size:11px;margin:0 6px}
.ts-empty{color:var(--dsw-alias-label-secondary);font-size:13px;padding:24px 0}
.ts-error{color:var(--dsw-alias-state-error-primary)}
.ts-loading{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-label-secondary);font-size:13px;padding:24px 0}
.ts-spinner{width:16px;height:16px;border-radius:50%;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-brand-primary);animation:ts-spin .8s linear infinite;flex:none}
@keyframes ts-spin{to{transform:rotate(360deg)}}

/* Settings nav icon: DSH 0.1.x settings.section only projects id/order/
   label, and the settings shell paints a generic gear for every external
   section (client-ui-settings-general's navIcon()). registerSettingsNavIcon
   marks our own nav row; hide the shell's gear and draw the chart-column
   Lucide glyph as a currentColor mask so it follows the native nav
   hover/active colors without changing the shell's 16px icon rhythm. */
[data-dsh-token-stats-settings-nav]>svg:first-child{display:none}
[data-dsh-token-stats-settings-nav]::before{content:'';flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 3v16a2 2 0 0 0 2 2h16'/%3E%3Cpath d='M18 17V9'/%3E%3Cpath d='M13 17V5'/%3E%3Cpath d='M8 17v-3'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 3v16a2 2 0 0 0 2 2h16'/%3E%3Cpath d='M18 17V9'/%3E%3Cpath d='M13 17V5'/%3E%3Cpath d='M8 17v-3'/%3E%3C/svg%3E") center/contain no-repeat}
`;

    // ---- Settings nav icon --------------------------------------------------
    // DSH 0.1.x does not yet carry an icon through the settings.section
    // registration contract: its shell projects only id/order/label and
    // paints a generic gear for every external section. Mark only this
    // plugin's localized nav row so the CSS above can replace the fallback
    // gear; the disposer clears the marker for HMR / plugin disable.
    const SETTINGS_LABEL = "Token 统计";
    const SETTINGS_NAV_MARKER = "data-dsh-token-stats-settings-nav";

    function registerSettingsNavIcon(label) {
      let disposed = false;
      const sync = function () {
        if (disposed) return;
        const currentLabel = String(label).trim();
        const buttons = document.querySelectorAll('[role="dialog"] nav button');
        for (let i = 0; i < buttons.length; i++) {
          const button = buttons[i];
          const text = button.textContent ? button.textContent.trim() : "";
          if (currentLabel.length > 0 && text === currentLabel) {
            button.setAttribute(SETTINGS_NAV_MARKER, "");
          } else {
            button.removeAttribute(SETTINGS_NAV_MARKER);
          }
        }
      };
      sync();
      const observer = new MutationObserver(sync);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      return function () {
        disposed = true;
        observer.disconnect();
        const marked = document.querySelectorAll("[" + SETTINGS_NAV_MARKER + "]");
        for (let i = 0; i < marked.length; i++) marked[i].removeAttribute(SETTINGS_NAV_MARKER);
      };
    }

    // ---- Client Remote contribution ----------------------------------------
    // The browser-side `remote.tokenStats` service only exists after this
    // module mounts its namespace via ctx.remote.$mount(): dsh-api-remotes'
    // client assembly mounts only the five official namespaces, so a plugin
    // must mount its own. Mirrors the invocation in typert.host.js (id,
    // service/namespace/method). zod is not requirable in the browser module
    // loader, so codecs use passthrough schemas. 0.1.7's client-side typert
    // remote store REJECTS strict codecs without a create() factory (same
    // contract as typert-loader — v1.5.1 shipped without these and every
    // $mount failed with "has no create() factory", dead Remote namespace).
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
          result: {
            mode: "strict",
            typeSymbol: "dsh-token-stats#TokenStatsResult",
            schema: passthrough(),
            create: createPassthrough,
          },
        },
        {
          id: "dsh-token-stats#tokenStats/getQuota",
          service: "tokenStats",
          namespace: "tokenStats",
          method: "getQuota",
          invocation: { kind: "direct" },
          parameters: [
            {
              name: "provider",
              wire: "provider",
              source: "json",
              codec: { mode: "strict", typeSymbol: "dsh-token-stats#tokenStats/getQuota:provider", schema: passthrough(), create: createPassthrough },
            },
            {
              name: "force",
              wire: "force",
              source: "json",
              codec: { mode: "strict", typeSymbol: "dsh-token-stats#tokenStats/getQuota:force", schema: passthrough(), create: createPassthrough },
            },
          ],
          result: {
            mode: "strict",
            typeSymbol: "dsh-token-stats#TokenStatsQuotaResult",
            schema: passthrough(),
            create: createPassthrough,
          },
        },
        {
          id: "dsh-token-stats#tokenStats/getAllQuotas",
          service: "tokenStats",
          namespace: "tokenStats",
          method: "getAllQuotas",
          invocation: { kind: "direct" },
          parameters: [
            {
              name: "force",
              wire: "force",
              source: "json",
              codec: { mode: "strict", typeSymbol: "dsh-token-stats#tokenStats/getAllQuotas:force", schema: passthrough(), create: createPassthrough },
            },
          ],
          result: {
            mode: "strict",
            typeSymbol: "dsh-token-stats#TokenStatsAllQuotasResult",
            schema: passthrough(),
            create: createPassthrough,
          },
        },
      ],
    };

    async function apply(ctx) {
      // 0.1.7-rc.1 hardening: a client bundle that rejects can keep the whole
      // web app from reaching the conversation page. Every optional step below
      // degrades independently so this plugin never blocks DSH boot; the last
      // resort catch keeps apply() itself from rejecting.
      try {
        await applyInner(ctx);
      } catch (e) {
        // eslint-disable-next-line no-console
        (typeof console !== "undefined" && console.error ? console.error : () => {})(
          "[dsh-token-stats] client apply failed; plugin disabled for this session:",
          e,
        );
      }
    }

    async function applyInner(ctx) {
      // Mount the tokenStats namespace before anything touches it; the mount's
      // lifetime is bound to this plugin's context by $mount itself. A mount
      // failure (descriptor schema drift in a future dsh) downgrades the UI to
      // an error state instead of failing the whole bundle.
      let remote = null;
      try {
        await ctx.remote.$mount(CLIENT_REMOTE);
        remote = ctx.get("remote.tokenStats") || null;
      } catch (e) {
        // eslint-disable-next-line no-console
        (typeof console !== "undefined" && console.warn ? console.warn : () => {})(
          "[dsh-token-stats] remote.$mount failed; stats page will show an error state:",
          e,
        );
      }

      let styleTag = null;
      try {
        styleTag = document.createElement("style");
        styleTag.textContent = CSS;
        document.head.appendChild(styleTag);
        ctx.effect(() => () => styleTag && styleTag.remove());
      } catch (e) {
        /* cosmetic only */
      }

      // Mark our settings-nav row so the CSS above replaces the shell's
      // fallback gear (no icon field exists in settings.section yet).
      try {
        ctx.effect(() => registerSettingsNavIcon(SETTINGS_LABEL));
      } catch (e) {
        /* cosmetic only */
      }

      const PALETTE = [
        "#5b8cff", "#f26d7a", "#3ecf8e", "#f5b942", "#a78bfa", "#38bdf8",
        "#fb923c", "#34d399", "#f472b6", "#60a5fa", "#fbbf24", "#c084fc",
        "#2dd4bf", "#f87171",
      ];
      const MONTHS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

      function fmtCompact(n) {
        if (n >= 1e9) {
          const v = n / 1e9;
          return (v >= 100 ? Math.round(v) : v.toFixed(1)) + "B";
        }
        if (n >= 1e6) {
          const v = n / 1e6;
          return (v >= 100 ? Math.round(v) : v.toFixed(1)) + "M";
        }
        if (n >= 1e3) {
          const v = n / 1e3;
          return (v >= 100 ? Math.round(v) : v.toFixed(1)) + "K";
        }
        return String(n);
      }

      function keyOf(d) {
        return (
          d.getFullYear() +
          "-" +
          String(d.getMonth() + 1).padStart(2, "0") +
          "-" +
          String(d.getDate()).padStart(2, "0")
        );
      }

      function dayOffset(offset) {
        const d = new Date();
        d.setDate(d.getDate() + offset);
        return keyOf(d);
      }

      function heatLevel(v, max) {
        if (!v || v <= 0 || !max || max <= 0) return 0;
        const r = v / max;
        if (r >= 0.75) return 4;
        if (r >= 0.5) return 3;
        if (r >= 0.25) return 2;
        return 1;
      }

      function buildRange(data, rangeDays) {
        const byDate = {};
        for (const d of data.days) byDate[d.date] = d;
        const start = new Date(dayOffset(-(rangeDays - 1)) + "T00:00:00");
        const dayList = [];
        for (let i = 0; i < rangeDays; i++) {
          const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
          const k = keyOf(d);
          const entry = byDate[k];
          dayList.push({
            date: k,
            label: d.getMonth() + 1 + "/" + d.getDate(),
            total: entry ? entry.total : 0,
            models: entry ? entry.models : [],
          });
        }
        const totals = new Map();
        for (const day of dayList) {
          for (const m of day.models) {
            let agg = totals.get(m.key);
            if (!agg) {
              agg = { total: 0, name: m.name };
              totals.set(m.key, agg);
            }
            agg.total += m.total;
          }
        }
        const rangeModels = [];
        for (const [key, agg] of totals) rangeModels.push({ key, total: agg.total, name: agg.name });
        rangeModels.sort((a, b) => b.total - a.total);
        const sum = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        for (const day of dayList) {
          sum.total += day.total;
          for (const m of day.models) {
            sum.input += m.input;
            sum.output += m.output;
            sum.cacheRead += m.cacheRead;
            sum.cacheWrite += m.cacheWrite;
          }
        }
        return { dayList, rangeModels, sum };
      }

      function BarChart(props) {
        const dayList = props.dayList;
        const rangeModels = props.rangeModels;
        const width = props.width;
        const n = dayList.length;
        const plotLeft = 44;
        const plotRight = 6;
        const plotTop = 10;
        const plotBottom = 26;
        const plotW = Math.max(10, width - plotLeft - plotRight);
        const plotH = 176;
        const maxTotal = Math.max(1, ...dayList.map((d) => d.total));
        const step = plotW / n;
        const barW = Math.max(2, step * 0.66);
        const colorOf = {};
        rangeModels.forEach((m, i) => {
          colorOf[m.key] = PALETTE[i % PALETTE.length];
        });
        const els = [];
        const gridR = [1, 0.75, 0.5, 0.25, 0];
        gridR.forEach((r, gi) => {
          const y = plotTop + plotH - r * plotH;
          els.push(
            React.createElement("line", {
              key: "g" + gi,
              x1: plotLeft, y1: y, x2: plotLeft + plotW, y2: y,
              stroke: "var(--dsw-alias-border-l1)", strokeWidth: 1,
            }),
          );
          els.push(
            React.createElement("text", {
              key: "gt" + gi,
              x: plotLeft - 5, y: y + 3, textAnchor: "end", fontSize: 10,
              fill: "var(--dsw-alias-label-secondary)",
            }, fmtCompact(maxTotal * r)),
          );
        });
        dayList.forEach((day, i) => {
          const x = plotLeft + i * step + (step - barW) / 2;
          const byKey = {};
          for (const m of day.models) byKey[m.key] = m;
          let y = plotTop + plotH;
          for (const m of rangeModels) {
            const rec = byKey[m.key];
            if (!rec || rec.total <= 0) continue;
            const h = Math.max(1, (rec.total / maxTotal) * plotH);
            y -= h;
            els.push(
              React.createElement(
                "rect",
                { key: "b" + i + "_" + m.key, x, y, width: barW, height: h, fill: colorOf[m.key] },
                React.createElement("title", null, day.label + " · " + rec.name + ": " + fmtCompact(rec.total)),
              ),
            );
          }
        });
        const labelEvery = n > 12 ? Math.ceil(n / 8) : 1;
        dayList.forEach((day, i) => {
          if (i % labelEvery !== 0 && i !== n - 1) return;
          const x = plotLeft + i * step + step / 2;
          els.push(
            React.createElement("text", {
              key: "xl" + i, x, y: plotTop + plotH + 16, textAnchor: "middle", fontSize: 10,
              fill: "var(--dsw-alias-label-secondary)",
            }, day.label),
          );
        });
        return React.createElement("svg", {
          width, height: plotTop + plotH + plotBottom,
          viewBox: "0 0 " + width + " " + (plotTop + plotH + plotBottom),
        }, els);
      }

      function BarLegend(props) {
        const rows = props.rangeModels.map((m, i) =>
          React.createElement(
            "span", { key: m.key, className: "ts-legend-chip", title: m.key },
            React.createElement("span", { className: "ts-legend-dot", style: { background: PALETTE[i % PALETTE.length] } }),
            React.createElement("span", { className: "ts-legend-name" }, m.name),
            React.createElement("span", { className: "ts-legend-val" }, fmtCompact(m.total)),
          ),
        );
        return React.createElement("div", { className: "ts-bar-legend" }, rows);
      }

      function PieChart(props) {
        const rangeModels = props.rangeModels;
        const sum = props.sum;
        const size = props.size;
        const total = sum.total || 0;
        const cx = size / 2;
        const cy = size / 2;
        const rOuter = size / 2 - 8;
        const rInner = rOuter * 0.58;
        const rMid = (rOuter + rInner) / 2;
        const strokeWidth = rOuter - rInner;
        const C = 2 * Math.PI * rMid;
        const els = [];
        if (total <= 0) {
          els.push(
            React.createElement("circle", {
              key: "e", cx, cy, r: rMid, fill: "none",
              stroke: "var(--dsw-alias-border-l1)", strokeWidth: 1,
            }),
          );
          els.push(
            React.createElement("text", {
              key: "et", x: cx, y: cy + 4, textAnchor: "middle", fontSize: 12,
              fill: "var(--dsw-alias-label-secondary)",
            }, "暂无数据"),
          );
        } else {
          els.push(
            React.createElement("circle", {
              key: "track", cx, cy, r: rMid, fill: "none",
              stroke: "var(--dsw-alias-bg-layer-2)", strokeWidth,
            }),
          );
          let offset = 0;
          rangeModels.forEach((m, i) => {
            if (m.total <= 0) return;
            const dash = (m.total / total) * C;
            els.push(
              React.createElement(
                "circle",
                {
                  key: "w" + i, cx, cy, r: rMid, fill: "none",
                  stroke: PALETTE[i % PALETTE.length],
                  strokeWidth,
                  strokeDasharray: dash + " " + (C - dash),
                  strokeDashoffset: -offset,
                  transform: "rotate(-90 " + cx + " " + cy + ")",
                },
                React.createElement("title", null, m.name + ": " + fmtCompact(m.total) + " (" + ((m.total / total) * 100).toFixed(1) + "%)"),
              ),
            );
            offset += dash;
          });
          els.push(
            React.createElement("text", {
              key: "c", x: cx, y: cy - 2, textAnchor: "middle", fontSize: 18, fontWeight: 600,
              fill: "var(--dsw-alias-label-primary)",
            }, fmtCompact(total)),
          );
          els.push(
            React.createElement("text", {
              key: "cl", x: cx, y: cy + 14, textAnchor: "middle", fontSize: 10,
              fill: "var(--dsw-alias-label-secondary)",
            }, "Tokens"),
          );
        }
        return React.createElement("svg", { width: size, height: size, viewBox: "0 0 " + size + " " + size }, els);
      }

      function PieLegend(props) {
        const total = props.total;
        const rows = props.rangeModels.map((m, i) =>
          React.createElement(
            "div", { key: m.key, className: "ts-legend-row" },
            React.createElement("span", { className: "ts-legend-dot", style: { background: PALETTE[i % PALETTE.length] } }),
            React.createElement("span", { className: "ts-legend-name", title: m.key }, m.name),
            React.createElement(
              "span", { className: "ts-legend-val" },
              fmtCompact(m.total) + " · " + (total > 0 ? ((m.total / total) * 100).toFixed(1) : "0") + "%",
            ),
          ),
        );
        return React.createElement("div", { className: "ts-legend" }, rows);
      }

      function Heatmap(props) {
        const daysMap = props.daysMap;
        const width = props.width;
        const cell = 10;
        const gap = 2;
        const padLeft = 34;
        const padTop = 22;
        const padRight = 10;
        const availWeeks = Math.max(1, Math.floor((width - padLeft - padRight) / (cell + gap)));
        const weeks = Math.min(availWeeks, 53);
        const totalDays = Math.min(365, weeks * 7);
        const today = new Date();
        const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (totalDays - 1));
        let max = 0;
        for (let i = 0; i < totalDays; i++) {
          const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
          const v = daysMap[keyOf(d)] || 0;
          if (v > max) max = v;
        }
        const els = [];
        let prevMonth = -1;
        let lastLabelX = -100;
        for (let i = 0; i < totalDays; i++) {
          const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
          const v = daysMap[keyOf(d)] || 0;
          const w = Math.floor(i / 7);
          const r = i % 7;
          const x = padLeft + w * (cell + gap);
          const y = padTop + r * (cell + gap);
          els.push(
            React.createElement(
              "rect",
              {
                key: "c" + i, x, y, width: cell, height: cell, rx: 2,
                className: "ts-heat ts-heat-" + heatLevel(v, max),
              },
              React.createElement("title", null, (d.getMonth() + 1) + "/" + d.getDate() + " · " + fmtCompact(v) + " tokens"),
            ),
          );
          const m = d.getMonth();
          if (m !== prevMonth && x - lastLabelX >= 22) {
            prevMonth = m;
            lastLabelX = x;
            els.push(
              React.createElement("text", {
                key: "ml" + i, x: x + 2, y: 12, fontSize: 10,
                fill: "var(--dsw-alias-label-secondary)",
              }, MONTHS[m]),
            );
          }
        }
        const weekdays = [["Mon", 1], ["Wed", 3], ["Fri", 5]];
        weekdays.forEach((wd) => {
          const y = padTop + wd[1] * (cell + gap) + cell / 2 + 3;
          els.push(
            React.createElement("text", {
              key: "wl" + wd[0], x: padLeft - 6, y, textAnchor: "end", fontSize: 9,
              fill: "var(--dsw-alias-label-secondary)",
            }, wd[0]),
          );
        });
        const gridH = padTop + 7 * (cell + gap) - gap + 6;
        const fullW = padLeft + weeks * (cell + gap) - gap + padRight;
        return React.createElement("svg", { width, height: gridH, viewBox: "0 0 " + fullW + " " + gridH }, els);
      }

      function HeatLegend() {
        const cells = [];
        for (let i = 0; i < 5; i++) {
          cells.push(React.createElement("span", { key: i, className: "ts-heat ts-heat-" + i + " ts-heat-legend-cell" }));
        }
        return React.createElement(
          "div", { className: "ts-heat-legend" },
          React.createElement("span", { className: "ts-heat-legend-label" }, "少"),
          cells,
          React.createElement("span", { className: "ts-heat-legend-label" }, "多"),
        );
      }

      function SummaryCards(props) {
        const sum = props.sum;
        const items = [
          ["总 Tokens", fmtCompact(sum.total)],
          ["输入(含缓存)", fmtCompact(sum.input + sum.cacheRead + sum.cacheWrite)],
          ["输出", fmtCompact(sum.output)],
        ];
        return React.createElement(
          "div", { className: "ts-cards" },
          items.map((it, i) =>
            React.createElement(
              "div", { key: i, className: "ts-card" },
              React.createElement("div", { className: "ts-card-label" }, it[0]),
              React.createElement("div", { className: "ts-card-value" }, it[1]),
            ),
          ),
        );
      }

      // ---- Composer quota readout ------------------------------------------
      // 套餐余额/用量读数, 显示位置与 dsh-musage 一致: `conversation.input.right`
      // 槽位 (composer 卡内工具行, 紧贴 model select 左侧; margin-left:auto 在
      // .trailing flex 容器内把读数推到最右). 跟随当前会话的模型选择
      // (modelDirectories.directoryFor(sessionId).store), 切 provider 自动重取.
      const QUOTA_REFRESH_MS = 60000;

      // DSH provider route id → 内部 provider key (与 host 半 QUOTA_PROVIDERS 对应).
      const PROVIDER_ALIASES = {
        "minimax-cn": "minimax",
        "minimax-en": "minimax",
        "minimax": "minimax",
        "deepseek": "deepseek",
        "deepseek-official": "deepseek",
        "kimi-coding": "kimi",
        "kimi": "kimi",
        "openrouter": "openrouter",
        "zai-coding-cn": "zhipu",
        "zhipu": "zhipu",
        // Xiaomi MiMo：route id 由用户添加 provider 时命名，覆盖常见拼法。
        "xiaomi-mimo": "mimo",
        "xiaomimimo": "mimo",
        "xiaomi-token-plan-cn": "mimo",
        "mimo": "mimo",
      };
      /** route id → 内部 key：精确查表未命中时对 mimo 做包含回退（route id 用户自由命名，如 xiaomi-token-plan-cn）。 */
      function providerKeyForRoute(route) {
        if (!route) return null;
        const exact = PROVIDER_ALIASES[route];
        if (exact !== undefined) return exact;
        const lower = String(route).toLowerCase();
        if (lower.includes("mimo") || lower.includes("xiaomi")) return "mimo";
        return null;
      }
      // 凭据设置行写入的 ref — 与 host QUOTA_PROVIDERS.refs 首选项对齐。
      // mimo 写 XIAOMI_MIMO_COOKIE（README 文档路径），不触碰 LLM 路由的
      // API Key ref（host probe 顺序 Cookie 优先，v1.5.4）。
      const QUOTA_CRED_REFS = {
        minimax: "MINIMAX_CN_API_KEY",
        deepseek: "DEEPSEEK_API_KEY",
        kimi: "KIMI_CODING_API_KEY",
        openrouter: "OPENROUTER_API_KEY",
        zhipu: "ZAI_CODING_CN_API_KEY",
        mimo: "XIAOMI_MIMO_COOKIE",
      };
      const QUOTA_PROVIDER_ORDER = ["minimax", "deepseek", "kimi", "openrouter", "zhipu", "mimo"];

      function quotaProviderLabel(p) {
        if (p === "minimax") return "MiniMax";
        if (p === "deepseek") return "DeepSeek";
        if (p === "kimi") return "Kimi";
        if (p === "openrouter") return "OpenRouter";
        if (p === "zhipu") return "Zhipu";
        if (p === "mimo") return "MiMo";
        return p;
      }

      /** 双层信封解包: remote 网关返回 res.value = host 方法的 { ok, value }. */
      function unwrapRemote(res) {
        const v = res && res.value;
        if (v && typeof v === "object" && v.ok === true && v.value && typeof v.value === "object") return v.value;
        if (v && typeof v === "object" && v.ok === false && v.error) {
          return { ok: false, kind: "other", message: (v.error && (v.error.message || v.error.code)) || "获取失败" };
        }
        return v;
      }

      function quotaValueSpans(provider, d) {
        const strong = { fontWeight: 600, color: "var(--dsw-alias-label-primary, #eee)" };
        const labelEl = React.createElement("span", { key: "p", style: { fontWeight: 500 } }, quotaProviderLabel(provider));
        if (provider === "deepseek" || provider === "openrouter") {
          const txt = d.balanceText || (typeof d.balanceUsd === "number" ? "$" + d.balanceUsd.toFixed(2) : "—");
          return [labelEl, React.createElement("span", { key: "b", style: strong }, txt)];
        }
        if (provider === "mimo") {
          // MiMo Token Plan：套餐已用% + 本月总额度%（detail 缺失时可能只有一行）
          const parts = [labelEl];
          if (typeof d.fiveHrPct === "number") {
            parts.push(React.createElement("span", { key: "plan", style: strong }, "套餐 " + d.fiveHrPct + "%"));
          }
          if (typeof d.weeklyPct === "number") {
            if (parts.length > 1) parts.push(React.createElement("span", { key: "sep", style: { opacity: 0.5, fontSize: 10 } }, "|"));
            parts.push(React.createElement("span", { key: "month", style: strong }, "本月 " + d.weeklyPct + "%"));
          }
          if (parts.length === 1) parts.push(React.createElement("span", { key: "na", style: strong }, "—"));
          return parts;
        }
        // minimax / kimi / zhipu: 5h + 7d 双窗口套餐
        const five = typeof d.fiveHrPct === "number" ? d.fiveHrPct + "%" : "—";
        const week = typeof d.weeklyPct === "number" ? d.weeklyPct + "%" : "—";
        return [
          labelEl,
          React.createElement("span", { key: "5", style: strong }, "5h " + five),
          React.createElement("span", { key: "sep", style: { opacity: 0.5, fontSize: 10 } }, "|"),
          React.createElement("span", { key: "7", style: strong }, "7d " + week),
        ];
      }

      /** 自定义悬停面板 (替代原生 title): 结构化展示余额/窗口用量 + 进度条. */
      function QuotaHoverCard(props) {
        const label = quotaProviderLabel(props.provider);
        const rows = [];
        if (props.ok && props.display) {
          const d = props.display;
          if (typeof d.balanceText === "string" && d.balanceText) {
            rows.push(
              React.createElement(
                "div", { key: "bal", className: "ts-quota-pop-row" },
                React.createElement("span", null, "账户余额" + (d.currency ? " (" + d.currency + ")" : "")),
                React.createElement("b", null, d.balanceText),
              ),
            );
          }
          const windows =
            props.provider === "mimo"
              ? [
                  ["套餐已用", d.fiveHrPct, d.fiveHrResetsIn],
                  ["本月总额度", d.weeklyPct, d.weeklyResetsIn],
                ]
              : [
                  ["5h 窗口", d.fiveHrPct, d.fiveHrResetsIn],
                  ["7d 窗口", d.weeklyPct, d.weeklyResetsIn],
                ];
          for (const w of windows) {
            if (typeof w[1] !== "number") continue;
            rows.push(
              React.createElement(
                "div", { key: w[0], style: { display: "flex", flexDirection: "column", gap: 4 } },
                React.createElement(
                  "div", { className: "ts-quota-pop-row" },
                  React.createElement("span", null, w[0] + "已用"),
                  React.createElement("b", null, w[1] + "%" + (w[2] ? " · " + w[2] : "")),
                ),
                React.createElement(
                  "div", { className: "ts-quota-pop-bar" },
                  React.createElement("i", { style: { width: Math.max(0, Math.min(100, w[1])) + "%" } }),
                ),
              ),
            );
          }
        } else {
          rows.push(React.createElement("div", { key: "err", className: "ts-quota-pop-err" }, props.message || "获取失败"));
        }
        return React.createElement(
          "div", { className: "ts-quota-pop" },
          React.createElement(
            "div", { className: "ts-quota-pop-head" },
            React.createElement("span", null, label),
            React.createElement("span", { className: "ts-quota-pop-sub" }, "套餐余额"),
          ),
          ...rows,
        );
      }

      function QuotaReadout(props) {
        const models = props.models;
        const sessionId = props.sessionId;
        const [provider, setProvider] = React.useState(null);
        const [state, setState] = React.useState({ loaded: false, ok: false });
        const [hover, setHover] = React.useState(false);
        const loadRef = React.useRef(null);

        // 订阅会话级 model directory, 提取 active provider route id.
        React.useEffect(() => {
          if (!models || !sessionId) {
            setProvider(null);
            return undefined;
          }
          let directory = null;
          try {
            directory = models.directoryFor(sessionId);
          } catch (e) {
            directory = null;
          }
          if (!directory || !directory.store) {
            setProvider(null);
            return undefined;
          }
          const update = () => {
            try {
              const snap = directory.store.getSnapshot();
              const route = snap && snap.current && snap.current.provider;
              setProvider(providerKeyForRoute(route));
            } catch (e) {
              setProvider(null);
            }
          };
          update();
          const stop = directory.store.subscribe(update);
          return () => {
            try {
              stop();
            } catch (e) { /* ignore */ }
          };
        }, [models, sessionId]);

        // provider 切换时重取; 60s 轮询; 点击 = 绕过缓存强制刷新.
        React.useEffect(() => {
          loadRef.current = null;
          if (!provider) {
            setState({ loaded: false, ok: false });
            return undefined;
          }
          let alive = true;
          const load = async (force) => {
            try {
              const payload = unwrapRemote(await remote.getQuota(provider, force === true));
              if (!alive) return;
              if (payload && typeof payload === "object" && typeof payload.ok === "boolean") {
                setState({ loaded: true, ...payload });
              } else {
                setState({ loaded: true, ok: false, kind: "other", message: "响应格式异常" });
              }
            } catch (e) {
              if (alive) setState({ loaded: true, ok: false, kind: "network", message: String((e && e.message) || e) });
            }
          };
          loadRef.current = load;
          load(false);
          const t = setInterval(() => load(false), QUOTA_REFRESH_MS);
          return () => {
            alive = false;
            clearInterval(t);
          };
        }, [provider]);

        // 当前路由不在支持列表 → 完全不占位.
        if (!provider) return null;

        const label = quotaProviderLabel(provider);
        const containerStyle = {
          display: "inline-flex",
          alignItems: "center",
          marginLeft: "auto",
          gap: 4,
          padding: "2px 8px",
          fontSize: 11,
          fontVariantNumeric: "tabular-nums",
          userSelect: "none",
          cursor: "pointer",
          color: "var(--dsw-alias-label-secondary, #888)",
        };
        const hoverProps = {
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        };
        const onRefresh = () => {
          const fn = loadRef.current;
          if (fn) fn(true);
        };
        const card = hover
          ? React.createElement(QuotaHoverCard, {
              provider,
              ok: state.ok === true,
              display: state.display || null,
              message: state.message || null,
            })
          : null;

        if (!state.loaded) {
          return React.createElement(
            "div",
            Object.assign({ className: "ts-quota", style: containerStyle }, hoverProps),
            React.createElement("span", { style: { fontWeight: 500 } }, label),
            React.createElement("span", { style: { opacity: 0.6, fontSize: 10 } }, "···"),
          );
        }

        if (!state.ok) {
          return React.createElement(
            "div",
            Object.assign(
              {
                className: "ts-quota",
                style: Object.assign({}, containerStyle, {
                  color: "var(--dsw-alias-state-warning-primary, var(--dsh-text-warning, #f5a623))",
                }),
                onClick: onRefresh,
              },
              hoverProps,
            ),
            React.createElement("span", { style: { fontWeight: 500 } }, label),
            React.createElement("span", { style: { fontWeight: 600 } }, "⚠"),
            card,
          );
        }

        const d = state.display || {};
        return React.createElement(
          "div",
          Object.assign({ className: "ts-quota", style: containerStyle, onClick: onRefresh }, hoverProps),
          ...quotaValueSpans(provider, d),
          card,
        );
      }

      // ---- Settings 页余额区块 ----------------------------------------------
      // 卡片 = 已配置的 provider；未配置或凭据失效（auth_failed）的 provider
      // 在「凭据设置」行里粘贴凭据（remote.credentials.set → force 重拉）。

      function QuotaCard(props) {
        const p = props.provider;
        const v = props.value;
        const label = quotaProviderLabel(p);
        if (!v || v.ok !== true) {
          const msg = (v && v.message) || "获取失败";
          return React.createElement(
            "div", { className: "ts-card ts-quota-card" },
            React.createElement(
              "div", { className: "ts-quota-card-head" },
              React.createElement("span", { className: "ts-quota-card-name" }, label),
              React.createElement("span", { className: "ts-quota-card-status ts-quota-err" }, "获取失败"),
            ),
            React.createElement("div", { className: "ts-card-label", title: msg }, msg),
          );
        }
        const d = v.display || {};
        if (typeof d.balanceText === "string" && d.balanceText) {
          return React.createElement(
            "div", { className: "ts-card ts-quota-card" },
            React.createElement(
              "div", { className: "ts-quota-card-head" },
              React.createElement("span", { className: "ts-quota-card-name" }, label),
              React.createElement("span", { className: "ts-quota-card-status" }, "账户余额" + (d.currency ? " · " + d.currency : "")),
            ),
            React.createElement("div", { className: "ts-quota-card-value" }, d.balanceText),
          );
        }
        const windows =
          p === "mimo"
            ? [
                ["套餐已用", d.fiveHrPct, d.fiveHrResetsIn],
                ["本月总额度", d.weeklyPct, d.weeklyResetsIn],
              ]
            : [
                ["5h 窗口", d.fiveHrPct, d.fiveHrResetsIn],
                ["7d 窗口", d.weeklyPct, d.weeklyResetsIn],
              ];
        return React.createElement(
          "div", { className: "ts-card ts-quota-card" },
          React.createElement(
            "div", { className: "ts-quota-card-head" },
            React.createElement("span", { className: "ts-quota-card-name" }, label),
            React.createElement("span", { className: "ts-quota-card-status" }, "套餐用量"),
          ),
          windows.map((w) =>
            typeof w[1] !== "number"
              ? null
              : React.createElement(
                  "div", { key: w[0], style: { display: "flex", flexDirection: "column", gap: 4 } },
                  React.createElement(
                    "div", { className: "ts-quota-pop-row" },
                    React.createElement("span", null, w[0] + "已用"),
                    React.createElement("b", null, w[1] + "%" + (w[2] ? " · " + w[2] : "")),
                  ),
                  React.createElement(
                    "div", { className: "ts-quota-card-bar" },
                    React.createElement("i", { style: { width: Math.max(0, Math.min(100, w[1])) + "%" } }),
                  ),
                ),
          ),
        );
      }

      function QuotaSection() {
        const [quotas, setQuotas] = React.useState(null);
        const [credDrafts, setCredDrafts] = React.useState({});
        const [credMsgs, setCredMsgs] = React.useState({});
        const [credSaving, setCredSaving] = React.useState({});
        const load = React.useCallback(async (force) => {
          try {
            const payload = unwrapRemote(await remote.getAllQuotas(force === true));
            if (payload && typeof payload === "object" && payload.quotas && typeof payload.quotas === "object") {
              setQuotas(payload.quotas);
            }
          } catch (e) { /* 余额区块失败不影响统计页 */ }
        }, []);
        React.useEffect(() => {
          load(false);
          const t = setInterval(() => load(false), QUOTA_REFRESH_MS);
          return () => clearInterval(t);
        }, [load]);

        const saveCred = React.useCallback(async (p, value) => {
          const ref = QUOTA_CRED_REFS[p];
          const trimmed = typeof value === "string" ? value.trim() : "";
          if (!ref || !trimmed) return;
          setCredSaving((s) => ({ ...s, [p]: true }));
          try {
            // 官方 credentials 命名空间（settings-models 同款用法）；不写进
            // inject 硬依赖，保存时才惰性取，取不到就提示错误。
            const ns = (ctx.remote && ctx.remote.credentials) || ctx.get("remote.credentials");
            if (!ns || typeof ns.set !== "function") throw new Error("credentials Remote 不可用");
            const r = await ns.set(ref, trimmed);
            if (r && r.ok) {
              setCredDrafts((d) => ({ ...d, [p]: "" }));
              setCredMsgs((m) => ({ ...m, [p]: "已保存，正在拉取…" }));
              await load(true);
              setCredMsgs((m) => ({ ...m, [p]: "已保存 ✓" }));
            } else {
              const msg = r && r.error && r.error.message ? r.error.message : "保存失败";
              setCredMsgs((m) => ({ ...m, [p]: msg }));
            }
          } catch (e) {
            setCredMsgs((m) => ({ ...m, [p]: e instanceof Error ? e.message : String(e) }));
          } finally {
            setCredSaving((s) => ({ ...s, [p]: false }));
          }
        }, [load]);

        if (!quotas) return null;
        const names = QUOTA_PROVIDER_ORDER.filter((p) => quotas[p]);
        // 卡片 = 非 unconfigured；设置行 = unconfigured 或 auth_failed。
        const configured = names.filter((p) => !(quotas[p] && quotas[p].ok === false && quotas[p].kind === "unconfigured"));
        const needsCred = names.filter(
          (p) => quotas[p] && quotas[p].ok === false && (quotas[p].kind === "unconfigured" || quotas[p].kind === "auth_failed"),
        );
        if (configured.length === 0 && needsCred.length === 0) return null;
        return React.createElement(
          "div", { className: "ts-block" },
          React.createElement(
            "div", { className: "ts-block-title" },
            "套餐余额",
            " ",
            React.createElement(
              "a",
              {
                href: "#",
                style: { color: "inherit", textDecoration: "none", cursor: "pointer" },
                onClick: (e) => {
                  e.preventDefault();
                  load(true);
                },
              },
              "(刷新)",
            ),
          ),
          configured.length > 0
            ? React.createElement(
                "div", { className: "ts-quota-list" },
                configured.map((p) => React.createElement(QuotaCard, { key: p, provider: p, value: quotas[p] })),
              )
            : null,
          needsCred.length > 0
            ? React.createElement(
                "div", { className: "ts-cred-block" },
                React.createElement("div", { className: "ts-block-title" }, "凭据设置（粘贴后保存，自动重新拉取）"),
                needsCred.map((p) => {
                  const isAuthFailed = quotas[p] && quotas[p].kind === "auth_failed";
                  return React.createElement(
                    "div", { key: p, className: "ts-cred-row" },
                    React.createElement("span", { className: "ts-cred-label" }, quotaProviderLabel(p)),
                    React.createElement("input", {
                      type: "password",
                      className: "ts-cred-input",
                      placeholder: p === "mimo"
                        ? (isAuthFailed ? "凭据已失效：重新粘贴 Cookie 或 API Key" : "粘贴登录 Cookie 或 API Key")
                        : "粘贴 API Key",
                      value: credDrafts[p] || "",
                      onChange: (e) => setCredDrafts((d) => ({ ...d, [p]: e.target.value })),
                      onKeyDown: (e) => {
                        if (e.key === "Enter") saveCred(p, credDrafts[p] || "");
                      },
                    }),
                    React.createElement(
                      "button", {
                        className: "ts-cred-save",
                        disabled: !!credSaving[p] || !(credDrafts[p] && credDrafts[p].trim()),
                        onClick: () => saveCred(p, credDrafts[p] || ""),
                      },
                      credSaving[p] ? "保存中…" : "保存",
                    ),
                    credMsgs[p] ? React.createElement("span", { className: "ts-cred-msg" }, credMsgs[p]) : null,
                  );
                }),
              )
            : null,
        );
      }

      function TokenStatsPage(props) {
        const [data, setData] = React.useState(null);
        const [tab, setTab] = React.useState(7);
        const [error, setError] = React.useState(null);
        const [width, setWidth] = React.useState(0);
        const rootRef = React.useRef(null);

        const load = React.useCallback(async () => {
          try {
            if (!remote) {
              setError("tokenStats Remote 未就绪（宿主插件可能加载失败）");
              return;
            }
            const res = await remote.getStats();
            if (res && res.ok) {
              // The Remote gateway returns `res.value` = the Host method's full
              // `{ ok, value }` envelope; unwrap it (tolerate both shapes).
              const v = res.value;
              const payload =
                v && typeof v === "object" && v.ok === true && v.value && typeof v.value === "object"
                  ? v.value
                  : v;
              if (payload && typeof payload === "object" && Array.isArray(payload.days)) {
                setData(payload);
                setError(null);
              } else {
                setError("统计数据格式异常");
              }
            } else {
              const err = res && res.error;
              setError((err && err.message) || (err && err.code) || "获取统计数据失败");
            }
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }, []);

        React.useEffect(() => {
          load();
          const t = setInterval(() => load(), 30000);
          return () => clearInterval(t);
        }, [load]);

        React.useEffect(() => {
          if (data && !data.ready) {
            const t = setTimeout(() => load(), 2000);
            return () => clearTimeout(t);
          }
          return undefined;
        }, [data, load]);

        React.useEffect(() => {
          const el = rootRef.current;
          if (!el) return undefined;
          const measure = () => setWidth(el.clientWidth);
          measure();
          if (typeof ResizeObserver !== "undefined") {
            const ro = new ResizeObserver(measure);
            ro.observe(el);
            return () => ro.disconnect();
          }
          return undefined;
        }, []);

        const tabs = React.createElement(
          "div", { className: "ts-tabs" },
          React.createElement(
            "button", { className: "ts-tab" + (tab === 7 ? " ts-tab-active" : ""), onClick: () => setTab(7) },
            "近 7 天",
          ),
          React.createElement(
            "button", { className: "ts-tab" + (tab === 30 ? " ts-tab-active" : ""), onClick: () => setTab(30) },
            "近 30 天",
          ),
        );

        let body;
        if (error) {
          body = React.createElement("div", { className: "ts-empty ts-error" }, "加载失败：" + error);
        } else if (!data) {
          body = React.createElement(
            "div", { className: "ts-loading" },
            React.createElement("span", { className: "ts-spinner", "aria-hidden": true }),
            React.createElement("span", null, "正在加载统计数据…"),
          );
        } else {
          let range = null;
          const daysMap = {};
          let renderError = null;
          try {
            range = buildRange(data, tab);
            for (const d of data.days) daysMap[d.date] = d.total;
          } catch (e) {
            renderError = e instanceof Error ? e.message : String(e);
          }
          if (renderError || !range) {
            body = React.createElement(
              "div", { className: "ts-empty ts-error" },
              "数据渲染失败：" + (renderError || "未知错误"),
            );
          } else {
            const chartWidth = Math.min(width, 720);
            body = React.createElement(
              "div", { className: "ts-body" },
              React.createElement(SummaryCards, { sum: range.sum }),
              React.createElement(QuotaSection, null),
              React.createElement(
                "div", { className: "ts-block" },
                React.createElement("div", { className: "ts-block-title" }, "每日消耗 · 按模型"),
                width > 0
                  ? React.createElement(BarChart, { dayList: range.dayList, rangeModels: range.rangeModels, width: chartWidth })
                  : null,
                React.createElement(BarLegend, { rangeModels: range.rangeModels }),
              ),
              React.createElement(
                "div", { className: "ts-block" },
                React.createElement("div", { className: "ts-block-title" }, "模型总消耗占比"),
                React.createElement(
                  "div", { className: "ts-pie-wrap" },
                  React.createElement(PieChart, { rangeModels: range.rangeModels, sum: range.sum, size: 190 }),
                  React.createElement(PieLegend, { rangeModels: range.rangeModels, total: range.sum.total }),
                ),
              ),
              React.createElement(
                "div", { className: "ts-block" },
                React.createElement("div", { className: "ts-block-title" }, "每日活跃 · 近一年（随宽度自适应）"),
                width > 0 ? React.createElement(Heatmap, { daysMap, width: chartWidth }) : null,
                React.createElement(HeatLegend, null),
              ),
            );
          }
        }

        const status =
          data && !data.ready
            ? "正在统计历史记录… (" + data.progress.done + "/" + data.progress.total + ")"
            : data && data.ready
              ? "统计范围：近 " + tab + " 天（含今天）"
              : "";

        return React.createElement(
          "div", { className: "ts-page", ref: rootRef },
          React.createElement(
            "div", { className: "ts-head" },
            React.createElement("div", { className: "ts-head-title" }, "Token 用量统计"),
            React.createElement("button", { className: "ts-refresh", onClick: () => load() }, "刷新"),
          ),
          React.createElement("div", { className: "ts-status" }, status),
          tabs,
          body,
        );
      }

      // Settings entry: a full page under the sidebar Settings panel.
      try {
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            { name: "settings.section", id: "token-stats", order: 25, label: () => SETTINGS_LABEL },
            TokenStatsPage,
          ),
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        (typeof console !== "undefined" && console.warn ? console.warn : () => {})(
          "[dsh-token-stats] settings.section registration failed:",
          e,
        );
      }

      // Composer quota readout (余额/套餐用量), same seat as dsh-musage:
      // `conversation.input.right`, immediately left of the model select. Only
      // registered while the model-selection service is mounted (it owns the
      // per-session model directory the readout follows); scoped inject keeps
      // deployments without it completely unaffected.
      if (typeof ctx.inject === "function") {
        try {
          ctx.inject(["slots", "modelDirectories"], (scope) => {
            try {
              scope.slots.inject("conversation.input.right", () =>
                scope.slots.register(
                  { name: "conversation.input.right", id: "token-stats-quota", order: 0, label: "Token quota" },
                  (props) =>
                    React.createElement(QuotaReadout, {
                      sessionId: props && props.sessionId,
                      models: scope.modelDirectories,
                    }),
                ),
              );
            } catch (e) {
              // eslint-disable-next-line no-console
              (typeof console !== "undefined" && console.warn ? console.warn : () => {})(
                "[dsh-token-stats] conversation.input.right registration failed:",
                e,
              );
            }
          });
        } catch (e) {
          // eslint-disable-next-line no-console
          (typeof console !== "undefined" && console.warn ? console.warn : () => {})(
            "[dsh-token-stats] modelDirectories scoped inject failed:",
            e,
          );
        }
      }
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return module.exports;
  },
});
