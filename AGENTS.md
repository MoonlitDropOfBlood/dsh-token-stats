# AGENTS.md — dsh-token-stats

面向 AI agent 与协作者的开发指南。**读这里再动手**，尤其"关键机制"和"重要注意事项"，记录了本项目踩过的大量坑。

## 项目是什么

一个 **DeepSeek Harness（DSH）双面（Host + Client）插件**：在 DSH Web UI 的**设置**面板里展示 Token 消耗统计。

- 设置面板新增 **Token 统计** 页（`settings.section`，order 25，位于"模型/插件/智能体预设"之后）。
- **近 7 天 / 近 30 天** 两个 Tab（均包含今天）：堆叠柱状图（每天 × 每个模型）+ 饼图（每个模型区间总消耗）。
- **GitHub 风格热力图**：近一年每日活跃，天数随容器宽度自适应（最多 365 天）。
- 数据来自 DSH **会话日志**（`assistant/message` 的 `usage`），按本地日 × 模型聚合，历史自动回填。

## 目录结构

```
dsh-token-stats/
├── package.json          # ESM 双面包：dsh.client: {platform:"web"} + exports(., /client, /typert, /package.json)
├── index.js              # Host 半：TokenStatsService（TypertRemoteService 子类，类插件）
├── client.js             # Client 半：window.__ModuleLoader__.load bundle（设置页 Slot UI + Remote 调用）
├── typert.host.js        # Typert Host manifest：tokenStats Remote 服务的 schema/调用描述
├── scripts/install.mjs   # 本地安装脚本：复制到 profile + 写入 patch
├── .github/workflows/release.yml  # 打 v* 标签时构建并发布 GitHub Release
├── AGENTS.md             # 本文件
├── README.md
└── LICENSE               # MIT
```

## 关键机制

### 1. DSH 正式插件 = 三件套（Host / Client / Typert）

一个"正式"（非动态运行时）DSH 插件需要**三个文件协作**，缺一不可：

| 文件 | 作用 | 被谁加载 |
|---|---|---|
| `index.js` | Host 半：Cordis **类插件**（导出 Service 类），注册 `tokenStats` 服务 | cordis loader（composition `insert` 行） |
| `client.js` | Client 半：浏览器 UI bundle | `client-modules`（扫描 `dsh.client` 声明 → 注入 `window.__DSH_BOOT__`） |
| `typert.host.js` | 描述 `tokenStats` 服务的 Remote 方法（wire schema / invocation） | `typert-loader`（扫描包的 `./typert` 导出） |

三者的**关键名字必须一致**：
- `index.js` 导出的类名 → `TokenStatsService`
- `typert.host.js` 的 `model.services[].key` / `exportName` → `tokenStats` / `TokenStatsService`
- `client.js` 的 `CLIENT_REMOTE` 描述符 id → `dsh-token-stats#tokenStats/getStats`，调用走 `ctx.get("remote.tokenStats").getStats()`
- `package.json` 的 `exports`：`"."`、`"./client"`、`"./typert"`、`"./package.json"`（**必须**有 `./package.json`，否则 `require.resolve("<pkg>/package.json")` 失败）

### 2. Host 半：类插件 + Remote 方法

```js
export class TokenStatsService extends TypertRemoteService {
  static inject = [];
  constructor(ctx, config) {
    super(ctx, "tokenStats");   // 必须传精确服务键，否则 validateName 抛错
  }
  [Service.init]() {
    markRemoteMethod(this, "getStats", "getStats");
    // 在这里初始化采集（事件监听、回填）
  }
  async getStats() { ... }
}
```

- `TypertRemoteService` 来自 `@deepseek-ai/dsh-typert-protocol`，构造函数 `ctx.reflect.provide(name, this)` 注册服务。
- **不要导出插件对象 `{apply}`**；导出 Service 类即可（`isConstructor` 为真时 `new Callback(ctx, config)` 实例化）。

### 3. Remote 标记不能直接用装饰器语法

Node ESM 不支持 Stage 3 装饰器（`@Remote("x")` 直接写会 `SyntaxError`）。用与 `dsh-archive-manager` 相同的 `markRemoteMethod(instance, method, exportName)` 手动驱动 `Remote()` 装饰器，并在 `[Service.init]()`（构造后、发布前）调用。

### 4. 数据采集：会话日志是唯一权威源

- **LIVE**：`this.ctx.on("session/event", handler)`。根组合挂载的插件 ctx 是 untagged，`dsh-scope` 的 `scopeTarget` 过滤器会放行（`tag === undefined → true`），所以**能收到所有会话**的追加事件。
- **只有 `assistant/message` 事件带 usage**：`event.data.usage`（TokenUsage）+ `event.data.message.source`（`{ kind: 'model', provider, model }`）给出模型归属。`total = input + output + cacheRead + cacheWrite`（不把 reasoningTokens 重复计入 total）。
- **HISTORY**：`this.ctx.get("sessionQuery")` → `listSessions()` + `readSession(id)` 一次性回填（并发 4）。只用 `ev.time < 插件启动时间` 之外的全部历史（实际上通过水位线去重，无需按时间切分）。
- **DEDUP 水位线**：`_watermark: Map<sessionId, maxSeq>`。实时监听和回填两条路径都做 `if (seq <= wm) skip; wm = seq; fold`（同步 check-and-set，单线程下无竞态），**任何一条先到谁计数，绝不重复**。
- 实时监听从插件激活起累计；回填处理插件激活前的历史；两者通过水位线无缝合并。

### 5. Client 半：bundle 格式

Client 半必须是 `window.__ModuleLoader__.load({ id, factory })` 格式（否则报 "loaded without registering via __ModuleLoader__.load"）：

```js
window.__ModuleLoader__.load({
  id: "dsh-token-stats",
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    const React = require("react");
    async function apply(ctx) { ... }
    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return module.exports;
  }
});
```

要点：
- `exports.inject` 声明依赖：`["slots", "remote"]`。用 `ctx.slots` 必须声明 `"slots"`；`remote.tokenStats` 命名空间是**自挂载**的（见下），用 `ctx.get("remote.tokenStats")` 读取，不要把它写进 inject。
- **Remote 命名空间必须自挂载**：`await ctx.remote.$mount(CLIENT_REMOTE)`（`dsh-api-remotes` 只挂载官方命名空间）。描述符与 `typert.host.js` 的 invocation 一一对应；浏览器没有 zod，用 passthrough schema（`{ parse: (v) => v }`）。
- **CSS 注入**用 `document.createElement("style")` + `ctx.effect(() => () => styleTag.remove())` 清理（动态插件的 `styles.insert` 在这里不存在）。
- **轮询/延迟**用浏览器原生 `setInterval`/`setTimeout`，在 `React.useEffect` 里返回清理函数。
- **宽度自适应**用 `ResizeObserver` 监听页面容器，热力图天数由宽度计算（`weeks = min(floor((w - pads)/(cell+gap)), 53)`，`days = min(365, weeks*7)`）。
- 设置页注册：`ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "token-stats", order: 25, label: () => "Token 统计" }, TokenStatsPage))`。

### 6. 本地安装 = 复制包 + composition patch

流程（`scripts/install.mjs` 自动做）：
1. 把插件包复制到 `<DSH_HOME>/profiles/web/node_modules/dsh-token-stats/`。
2. 在 `<DSH_HOME>/profiles/web/cordis.patch.yml` 里 **`- insert:`** 新增行（**不要**用普通 `- id:` 覆盖）：

```yaml
- insert:
  - id: token-stats
    name: 'dsh-token-stats'
```

3. 重启 DSH。**必须重启**，Host 加载、typert 注册、client bundle 注入都在启动时发生。

## 开发 / 验证

```bash
npm run check            # node --check index.js client.js typert.host.js
node scripts/install.mjs # 安装到本机 DSH profile
```

改插件后**必须重启 DSH 进程**才生效（动态 HMR 不适用于正式安装的插件）。验证：
1. 设置 → 侧栏导航出现 **Token 统计**。
2. 打开页面：汇总卡片、柱状图、饼图、热力图渲染正常。
3. 切 7/30 天 Tab，数据随区间变化；等历史回填完成后 `ready: true`。
4. 有新对话产生后，刷新按钮/30s 自动刷新能看到当天数据增长。

## 发布

打 `v1.0.0` 标签推送到 GitHub，`.github/workflows/release.yml` 会自动构建 `npm pack` 产物并发布为 GitHub Release（需要 `GH_TOKEN` secret，权限 `contents:write`）。

## 常规注意事项

- **不要直接编辑 `~/.dsh/profiles/web/cordis.yml`**（那是生成的文件，patch 覆盖在 `cordis.patch.yml`）。
- `cordis.patch.yml` 顶层是一个 patch 数组：`- insert:` 用于新增行，`- id:` 用于覆盖已有行。
- `client.js` 用 `require("react")`（bundle 的模块表提供），**不要** `import` 或动态插件的 `styles`/`host` 全局。
- `typert.host.js` 的 result schema 是 **strict**：`getStats()` 的返回值必须与 schema 完全匹配（字段不缺席、类型正确），否则网关校验失败。
- 误删/重复计数风险：任何新增的采集路径都必须走 `_watermark` 水位线，否则同一事件会被计数两次。
- 时间以**本地时区**的日历日聚合（`dayKeyOf` 用本地 getFullYear/getMonth/getDate）。
