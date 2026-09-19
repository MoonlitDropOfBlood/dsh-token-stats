# AGENTS.md — dsh-token-stats

面向 AI agent 与协作者的开发指南。**读这里再动手**，尤其"关键机制"和"重要注意事项"，记录了本项目踩过的大量坑。

## 项目是什么

一个 **DeepSeek Harness（DSH）双面（Host + Client）插件**：在 DSH Web UI 的**设置**面板里展示 Token 消耗统计。

- 设置面板新增 **Token 统计** 页（`settings.section`，order 25，位于"模型/插件/智能体预设"之后）。
- **近 7 天 / 近 30 天** 两个 Tab（均包含今天）：堆叠柱状图（每天 × 每个模型）+ 饼图（每个模型区间总消耗）。
- **GitHub 风格热力图**：近一年每日活跃，天数随容器宽度自适应（最多 365 天）。
- **套餐余额读数**：composer 工具行内联显示当前 provider 的余额/用量（参考 dsh-musage，MIT），跟随当前模型自动切换。
- 数据来自 DSH **会话日志**（`assistant/message` 的 `usage`），按本地日 × 模型聚合，历史自动回填。

## 目录结构

```
dsh-token-stats/
├── package.json          # ESM 双面包：dsh.client: {platform:"web"} + exports(., /client, /typert, /package.json)
├── index.js              # Host 半：TokenStatsService（TypertRemoteService 子类，类插件）
├── client.js             # Client 半：window.__ModuleLoader__.load bundle（设置页 Slot UI + Remote 调用）
├── typert.host.js        # Typert Host manifest：tokenStats Remote 服务的 schema/调用描述
├── cordis.patch.yml      # dsh bundle patch（挂载行）
├── .github/workflows/release.yml  # 打 v* 标签时构建并发布 GitHub Release
├── scripts/smoke-store.mjs   # store 持久化冒烟（TOKEN_STATS_PLUGIN 指定被测 index.js）
├── scripts/smoke-quota.mjs   # quota 路径冒烟（stub _httpGet/_quotaApiKey 驱动各 provider fixture）
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
- **PERSIST 落盘**：聚合（`_byDay`）、水位线、`_folded`（已完整回填的会话集合）、`_modelMeta` 持久化到 `<DSH_HOME>/data/dsh-token-stats/stats.json`（`DSH_HOME` 读进程环境变量，缺省 `~/.dsh`；会话池是全局的，存储也放全局而非 profile 下）。变更后 1.5s 防抖写盘（tmp+rename 原子替换），`ctx.effect` 的 disposer 里同步 flush。**冷启动跳过 `_folded` 里的会话（不读 `readSession`），只扫新会话**；文件缺失/损坏/version 不匹配时退化为全量扫描。删除该文件可强制全量重扫。
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
- 设置页注册：`ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "token-stats", order: 25, label: () => SETTINGS_LABEL }, TokenStatsPage))`。
- **设置导航图标**：DSH 0.1.x 的 `settings.section` 只投影 `id/order/label`，设置壳对每个外部 section 统一画通用齿轮（`client-ui-settings-general` 的 `navIcon()`，没有公开图标字段）。client.js 里 `registerSettingsNavIcon(SETTINGS_LABEL)` 用 MutationObserver 给 `[role="dialog"] nav button` 中文本等于 section label 的行打 `data-dsh-token-stats-settings-nav` 标记，CSS 再隐藏 `>svg:first-child` 齿轮、用 `currentColor` mask 画 chart-column Lucide 图标（16px，跟随原生 hover/active 颜色）。换图标只需替换 CSS 里 data URI 的 SVG path（Lucide，24×24，stroke-width 2，stroke 用 black——mask 只取 alpha）。

### 6. 标准安装 = dsh bundle（package.json 声明 + 包内 cordis.patch.yml）

本插件是**标准 DSH bundle**：`package.json` 的 `dsh.bundle.patch` 指向包内 `cordis.patch.yml`。用官方 `dsh plugin` 命令安装：

1. `dsh plugin --profile web add <本地路径或包>`：pnpm 把插件装成 profile 的 npm 依赖（本地路径走 `link:` 软链，改代码即生效），并把包名追加到 profile `package.json` 的 `dsh.profile.bundles`。
2. 启动时 DSH 应用包内 `cordis.patch.yml` 的 `- insert:` 行挂载插件（**不要**再在 profile 的 `cordis.patch.yml` 里手工插一行，否则同一 id 重复挂载）：

```yaml
# cordis.patch.yml（随包分发）
- insert:
  - id: token-stats
    name: '@duke-dsh-plugins/dsh-token-stats'
```

3. 重启 DSH。**必须重启**，Host 加载、typert 注册、client bundle 注入都在启动时发生。
4. 卸载：`dsh plugin --profile web remove dsh-token-stats`（自动从 bundles 列表移除）。

### 7. 套餐余额（getQuota，参考 dsh-musage MIT 实现）

`tokenStats.getQuota(provider, force)` 给 composer 工具行的内联读数供数；`tokenStats.getAllQuotas(force)` 并行拉全部 5 个 provider（设置页「套餐余额」区块用，返回 `{ quotas: Record<provider, QuotaValue> }`）：

- **凭据**：`ctx.get("credentials").resolve(ref)`；ref 候选遵循设置页派生规则 `<ROUTE>_API_KEY`（`provider.toUpperCase().replace(/[^A-Z0-9]+/g,"_")+"_API_KEY"`，见 `dsh-client-ui-settings-models` 的 `deriveKeyRef`）+ 各 provider 的内置默认 `apiKeyEnv`（deepseek-official 路由实际用 `DEEPSEEK_API_KEY`，见 `dsh-base/cordis.patch.yml`）。无 credentials 服务时回退 `process.env[ref]`。**不要**自己存 keys。
- **HTTP**：宿主全局 `fetch` 优先（Electron/Node 18+ 必有），`AbortSignal.timeout(15s)`；`typeof fetch !== "function"` 时回退 `ctx.get("subprocess")` spawn curl（musage 的形态）。zhipu 的 `Authorization` **不加** `Bearer ` 前缀（`authStyle: "raw"`）。
- **缓存**：每 provider 成功 30s TTL；失败指数退避 5s→30min（`streak` 递增）；`force=true` 先清缓存再拉（客户端点击读数时传）。
- **wire 形状**：`{ ok:true, value }` 信封内 `value` 是判别联合——成功 `{ ok:true, provider, display:{fiveHrPct,weeklyPct,fiveHrResetsIn,weeklyResetsIn,balanceText,balanceUsd,currency} }`（7 个字段恒在，缺省为 null），失败 `{ ok:false, provider, kind, message }`。typert.host.js 的 zod schema 与此**逐字段对应**，改返回值必须同步改 schema（网关 strict 校验）。
- **不落盘**：quota 状态纯内存（`_quotaCache`/`_quotaActiveRef`），与 stats store 完全无关，STORE_VERSION 不需要动。
- **解析器**是模块级纯函数（minimax 双 schema / deepseek balance_infos / kimi limits+usage / openrouter credits / zhipu unit=3|6），改动后跑 `npm run smoke:quota`（脚本 stub `_httpGet`/`_quotaApiKey` 驱动各 provider fixture）。

**Client 侧显示位置**（与 dsh-musage 相同）：`conversation.input.right` 槽位——composer 卡内 `.trailing` 工具行，**紧贴 model select 左侧**；容器 `inline-flex + margin-left:auto + gap:4 + fontSize:11 + tabular-nums`。要点：

- 该槽位 `kind:"list", scope:"session"`，**standardProps 自带 `sessionId`**（ownerProps 为空 `{}`；`renderSlot("conversation.input.right", {})` 不传业务 props）。
- 当前 provider 从 `modelDirectories.directoryFor(sessionId).store` 订阅（`getSnapshot().current.provider` 是 DSH **route id**，经 `PROVIDER_ALIASES` 映射成内部 key，如 `deepseek-official→deepseek`、`zai-coding-cn→zhipu`）。route 不在映射表 → 返回 `null` 完全不占位。
- 注册用 **`ctx.inject(["slots", "modelDirectories"], scope => scope.slots.inject(...))`** 包裹：该服务由 `dsh-client-ui-model-selection` 提供，缺它的部署里读数不注册、其余功能不受影响。**不要**写进 `exports.inject` 硬依赖（会拖住整个 client 插件）；scope 里用到的每个服务（含 `slots`）都要写进这个 inject 列表（对照 `dsh-client-ui-model-selection` 的写法）。
- 60s `setInterval` 轮询 + 点击 `loadRef.current(true)` 强制刷新；provider 切换即重取。
- **悬停面板是自绘的**（`.ts-quota` 容器 `position:relative` + `.ts-quota-pop` 绝对定位卡片，DSW 设计 token + 进度条），**不要退回原生 `title`**（用户嫌丑）。
- 设置页余额区块 `QuotaSection` 走 `getAllQuotas`；**只渲染非 `unconfigured` 的 provider**（全部未配置 → 整块返回 null 不渲染）；失败卡片照常显示错误。
- 本地没有 node_modules 时，把 DSH 部署的 `@deepseek-ai`/`zod` junction 进 `node_modules/` 即可跑两个 smoke 脚本（已 gitignore）。

## 开发 / 验证

```bash
npm run check            # node --check index.js client.js typert.host.js
npm run smoke:quota      # quota 解析/缓存/信封冒烟（无需 DSH）
dsh plugin --profile web add /path/to/dsh-token-stats   # 安装/重装到本机 DSH profile
```

改插件后**必须重启 DSH 进程**才生效（动态 HMR 不适用于正式安装的插件）。验证：
1. 设置 → 侧栏导航出现 **Token 统计**。
2. 打开页面：汇总卡片、柱状图、饼图、热力图渲染正常。
3. 切 7/30 天 Tab，数据随区间变化；等历史回填完成后 `ready: true`。
4. 有新对话产生后，刷新按钮/30s 自动刷新能看到当天数据增长。
5. 会话输入框工具行（model 选择器左侧）出现当前 provider 的余额读数；切换模型跟随变化；点击读数强制刷新。

## 发布

打 `v1.0.0` 标签推送到 GitHub，`.github/workflows/release.yml` 会自动构建 `npm pack` 产物并发布为 GitHub Release。凭证优先取 secret `GH_TOKEN`（PAT，`contents:write`），缺省回退内置 `GITHUB_TOKEN`（workflow 已声明 `permissions: contents: write`）。**仓库没有 lockfile，setup-node 不可开 `cache: npm`**（找不到锁文件会直接失败）。

## 常规注意事项

- **不要直接编辑 `~/.dsh/profiles/web/cordis.yml`**（那是生成的文件，patch 覆盖在 `cordis.patch.yml`）。
- `cordis.patch.yml` 顶层是一个 patch 数组：`- insert:` 用于新增行，`- id:` 用于覆盖已有行。
- `client.js` 用 `require("react")`（bundle 的模块表提供），**不要** `import` 或动态插件的 `styles`/`host` 全局。
- `typert.host.js` 的 result schema 是 **strict**：`getStats()` 的返回值必须与 schema 完全匹配（字段不缺席、类型正确），否则网关校验失败。
- 误删/重复计数风险：任何新增的采集路径都必须走 `_watermark` 水位线，否则同一事件会被计数两次。
- 时间以**本地时区**的日历日聚合（`dayKeyOf` 用本地 getFullYear/getMonth/getDate）。
