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
 * Host communication goes through the `tokenStats` Remote namespace
 * (`ctx.remote.tokenStats.getStats()`), published by the Host half in
 * `index.js`.
 */
window.__ModuleLoader__.load({
  id: "dsh-token-stats",
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
.ts-legend-dot{width:10px;height:10px;border-radius:3px;flex:none;display:inline-block}
.ts-pie-wrap{display:flex;flex-wrap:wrap;gap:20px;align-items:center}
.ts-legend{display:flex;flex-direction:column;gap:8px;min-width:180px;flex:1}
.ts-legend-row{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px}
.ts-legend-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ts-legend-val{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ts-heat-0{fill:var(--dsw-alias-bg-layer-2)}
.ts-heat-1{fill:var(--dsw-alias-state-success-primary);opacity:0.25}
.ts-heat-2{fill:var(--dsw-alias-state-success-primary);opacity:0.5}
.ts-heat-3{fill:var(--dsw-alias-state-success-primary);opacity:0.75}
.ts-heat-4{fill:var(--dsw-alias-state-success-primary);opacity:1}
.ts-heat-legend{display:flex;align-items:center;gap:3px}
.ts-heat-legend-cell{width:10px;height:10px;border-radius:2px}
.ts-heat-legend-label{color:var(--dsw-alias-label-secondary);font-size:11px;margin:0 6px}
.ts-empty{color:var(--dsw-alias-label-secondary);font-size:13px;padding:24px 0}
`;

    // ---- Client Remote contribution ----------------------------------------
    // The browser-side `remote.tokenStats` service only exists after this
    // module mounts its namespace via ctx.remote.$mount(): dsh-api-remotes'
    // client assembly mounts only the five official namespaces, so a plugin
    // must mount its own. Mirrors the invocation in typert.host.js (id,
    // service/namespace/method). zod is not requirable in the browser module
    // loader, so codecs use passthrough schemas — the runtime contract only
    // requires typeSymbol + schema.parse().
    const passthrough = () => ({ parse: (v) => v });
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
          },
        },
      ],
    };

    async function apply(ctx) {
      // Mount the tokenStats namespace before anything touches it; the mount's
      // lifetime is bound to this plugin's context by $mount itself.
      await ctx.remote.$mount(CLIENT_REMOTE);

      const styleTag = document.createElement("style");
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
      ctx.effect(() => () => styleTag.remove());

      // ctx.get() reads the service without the property-accessor inject guard.
      const remote = ctx.get("remote.tokenStats");

      const PALETTE = [
        "#5b8cff", "#f26d7a", "#3ecf8e", "#f5b942", "#a78bfa", "#38bdf8",
        "#fb923c", "#34d399", "#f472b6", "#60a5fa", "#fbbf24", "#c084fc",
        "#2dd4bf", "#f87171",
      ];
      const MONTHS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

      function fmtCompact(n) {
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

      function fmtExact(n) {
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
          for (const m of day.models) totals.set(m.key, (totals.get(m.key) || 0) + m.total);
        }
        const rangeModels = [];
        for (const [key, total] of totals) rangeModels.push({ key, total });
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
                React.createElement("title", null, day.label + " · " + rec.name + ": " + fmtExact(rec.total)),
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
            "span", { key: m.key, className: "ts-legend-chip" },
            React.createElement("span", { className: "ts-legend-dot", style: { background: PALETTE[i % PALETTE.length] } }),
            m.name,
          ),
        );
        return React.createElement("div", { className: "ts-bar-legend" }, rows);
      }

      function ringPath(cx, cy, rOuter, rInner, a0, a1) {
        const x0 = cx + rOuter * Math.cos(a0);
        const y0 = cy + rOuter * Math.sin(a0);
        const x1 = cx + rOuter * Math.cos(a1);
        const y1 = cy + rOuter * Math.sin(a1);
        const x2 = cx + rInner * Math.cos(a1);
        const y2 = cy + rInner * Math.sin(a1);
        const x3 = cx + rInner * Math.cos(a0);
        const y3 = cy + rInner * Math.sin(a0);
        const large = a1 - a0 > Math.PI ? 1 : 0;
        return (
          "M" + x0 + " " + y0 +
          " A" + rOuter + " " + rOuter + " 0 " + large + " 1 " + x1 + " " + y1 +
          " L" + x2 + " " + y2 +
          " A" + rInner + " " + rInner + " 0 " + large + " 0 " + x3 + " " + y3 +
          " Z"
        );
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
        const els = [];
        if (total <= 0) {
          els.push(
            React.createElement("circle", {
              key: "e", cx, cy, r: rInner, fill: "none",
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
          let angle = -Math.PI / 2;
          rangeModels.forEach((m, i) => {
            if (m.total <= 0) return;
            const sweep = (m.total / total) * Math.PI * 2;
            const a0 = angle;
            const a1 = angle + sweep;
            angle = a1;
            els.push(
              React.createElement(
                "path",
                { key: "w" + i, d: ringPath(cx, cy, rOuter, rInner, a0, a1), fill: PALETTE[i % PALETTE.length] },
                React.createElement("title", null, m.name + ": " + fmtExact(m.total) + " (" + ((m.total / total) * 100).toFixed(1) + "%)"),
              ),
            );
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
              fmtExact(m.total) + " · " + (total > 0 ? ((m.total / total) * 100).toFixed(1) : "0") + "%",
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
                className: "ts-heat-" + heatLevel(v, max),
              },
              React.createElement("title", null, (d.getMonth() + 1) + "/" + d.getDate() + " · " + fmtExact(v) + " tokens"),
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
          cells.push(React.createElement("span", { key: i, className: "ts-heat-" + i + " ts-heat-legend-cell" }));
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
          ["总 Tokens", fmtExact(sum.total)],
          ["输入(含缓存)", fmtExact(sum.input + sum.cacheRead + sum.cacheWrite)],
          ["输出", fmtExact(sum.output)],
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

      function TokenStatsPage(props) {
        const [data, setData] = React.useState(null);
        const [tab, setTab] = React.useState(7);
        const [error, setError] = React.useState(null);
        const [width, setWidth] = React.useState(0);
        const rootRef = React.useRef(null);

        const load = React.useCallback(async () => {
          try {
            const res = await remote.getStats();
            if (res && res.ok) {
              setData(res.value);
              setError(null);
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
          body = React.createElement("div", { className: "ts-empty" }, "加载失败：" + error);
        } else if (!data) {
          body = React.createElement("div", { className: "ts-empty" }, "加载中…");
        } else {
          const range = buildRange(data, tab);
          const daysMap = {};
          for (const d of data.days) daysMap[d.date] = d.total;
          const chartWidth = Math.min(width, 720);
          body = React.createElement(
            "div", { className: "ts-body" },
            React.createElement(SummaryCards, { sum: range.sum }),
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
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: "token-stats", order: 25, label: () => "Token 统计" },
          TokenStatsPage,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return module.exports;
  },
});
