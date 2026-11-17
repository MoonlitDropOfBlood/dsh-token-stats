<p align="center">
  <svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" color="#4D6BFE"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 14h3"/><path d="M12 14h5"/></svg>
</p>

<h3 align="center">DeepSeek Harness Token 用量统计插件</h3>

<p align="center">
  <img src="https://img.shields.io/badge/DSH-Plugin-4D6BFE?style=flat" alt="DSH plugin">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Web%20UI-Yes-22C55E?style=flat" alt="Web UI">
</p>

<p align="center"><sub>中文</sub></p>

---

为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) Web UI 打造的 **Token 消耗统计**插件：在**设置**面板里一目了然每个模型每天、每个统计区间的 token 用量。

## 功能

| 功能 | 说明 |
|---|---|
| 📊 两个 Tab | **近 7 天** / **近 30 天**，两个区间都**包含今天** |
| 📈 堆叠柱状图 | 统计区间内**每个模型每天**的消耗（悬停查看具体数字） |
| 🥧 饼图 | 统计区间内**每个模型的总消耗**占比 + 图例（精确值 + 百分比） |
| 🔥 GitHub 风格热力图 | 「近一年」每日活跃；**天数随容器宽度自适应**，最多显示 365 天（一年） |
| 🗂 汇总卡片 | 区间总 Tokens / 输入(含缓存) / 输出 |
| 💾 本地持久化 | 聚合结果落盘 `<DSH_HOME>/data/dsh-token-stats/stats.json`，冷启动只扫描新会话、秒开；删除该文件可强制全量重扫 |
| ⏱ 自动刷新 | 页面打开期间每 30s 刷新；历史回填期间每 2s 轮询进度 |
| 💰 套餐余额 | 输入框工具行（model 选择器左侧）内联显示当前 provider 的**余额/套餐用量**，跟随当前模型自动切换；支持 minimax / deepseek / kimi / openrouter / zhipu / mimo（小米）/ opencode-go / **bailian（阿里云百炼 Token Plan）**；60s 轮询，点击立即刷新 |
| 🔑 百炼凭据配置 | 设置页「百炼 Token Plan 凭据」卡片：**仅当配置了 qwen token plan 模型时显示**；填写阿里云 RAM AK/SK 即可查套餐用量（AK/SK 自动换短期 token，免 Cookie、免手动续期） |
| 🌗 主题适配 | 全部使用 DSH 设计 token，明暗主题自动跟随 |

> 套餐余额功能参考自 [dsh-musage](https://github.com/Thedeergod666/dsh-musage)（MIT），API Key 直接复用 DSH 模型设置里已配置的凭据（`credentials` 服务），无需重复配置。

## 安装

### 标准安装（推荐）

本插件是**标准 DSH bundle**：`package.json` 声明 `dsh.bundle.patch`，包内自带 `cordis.patch.yml`，用官方 `dsh plugin` 命令安装：

```bash
# 本地开发：pnpm 软链到本仓库，改代码即生效（无需重新复制）
dsh plugin --profile web add /path/to/dsh-token-stats

# 正式发布：从 GitHub Release tarball 安装
dsh plugin --profile web add https://github.com/MoonlitDropOfBlood/dsh-token-stats/releases/download/v1.10.0/duke-dsh-plugins-dsh-token-stats-1.10.0.tgz
```

重启 DSH 后，打开 DSH Web UI 的设置（侧栏底部），左侧导航会出现 **Token 统计** 页。

> `dsh plugin add` 把插件装成 profile 的 npm 依赖并追加到 `dsh.profile.bundles`，启动时 DSH 自动应用包内的 `cordis.patch.yml` 挂载插件。卸载：`dsh plugin --profile web remove dsh-token-stats`。

## 使用

1. 打开 **设置** → **Token 统计**。
2. 在 **近 7 天 / 近 30 天** 两个 Tab 间切换：
   - 柱状图展示区间内每天、每个模型的消耗（堆叠）。
   - 饼图展示区间内每个模型的总消耗占比。
   - 顶部卡片给出区间总 Tokens / 输入 / 输出。
3. 下方 **每日活跃** 热力图展示更长时间范围：格子越多 = 容器越宽，最多覆盖近一年。
4. **会话输入框工具行**（model 选择器左侧）内联显示当前 provider 的套餐余额：
   - DeepSeek / OpenRouter 显示余额（如 `¥43.97` / `$12.50`）；
   - MiniMax / Kimi / 智谱 显示 `5h X% | 7d Y%`（5 小时 / 7 天窗口已用百分比，悬停查看重置时间）；
   - 小米 MiMo 与其他 provider 同规则：未配置时显示 `⚠`；配置 dashboard 登录 Cookie（环境变量 `XIAOMI_MIMO_COOKIE`，见下）后显示官方 `剩余 X%` + 周重置倒计时；Cookie 失效时自动退回本地用量统计 `今日 X · 7d Y`，不报错；
   - OpenCode Go 显示 `5h X% | 7d Y% | 30d Z%`（三个窗口的已用百分比，来自官方 `opencode.ai/zen/go/v1/usage` 接口）；
   - 百炼 Token Plan 显示 `月 X%`（订阅月 Credits 已用百分比 + 重置倒计时；悬停看套餐/加购包信息）；
   - 切换模型时自动切换 provider；每 60s 自动刷新，**点击读数立即强制刷新**；
   - 未配置对应 API Key 或拉取失败时显示 `⚠`（悬停查看原因）；当前 provider 不在支持列表时不占位。

> **MiMo（小米）配置**：MiMo 与其他 provider 同规则——不配置就没有读数（composer `⚠`、设置页无卡片）。它没有 API Key 配额接口（`token-plan-*` 与 `api.` 主机只有 OpenAI 兼容的 `/v1` 推理 API，实测所有 Bearer 配额路径均 404；key 还与区域强绑定，CN key 在 SGP/AMS 主机一律 401），**唯一配额数据源是 dashboard 账号会话 Cookie**。
>
> 想要**官方剩余用量百分比**：打开 platform.xiaomimimo.com 登录后，F12 → Network 任一 `/api/v1/*` 请求 → 复制完整 `Cookie` 请求头（含 `api-platform_serviceToken` 与 `userId`）→ 设置环境变量 `XIAOMI_MIMO_COOKIE`（写入 DSH 进程环境后重启生效；凭据库里已存过该 ref 的话直接可用）。插件内置最小 cookie jar：服务端若在响应里 `Set-Cookie` 续发会话会被自动吸收并写回凭据库（跨轮询、跨重启生效）；**Cookie 彻底失效时自动静默退回本地用量统计（今日 / 近 7 天消耗），不会报错**。composer 读数按 route id 匹配（`xiaomi-mimo` / `xiaomimimo` / `xiaomi-token-plan-cn` / 名字含 xiaomi 或 mimo 均可）。

> **OpenCode Go 配置**：与其他 provider 同规则——**不配置就没有读数**（composer `⚠`、设置页无卡片）。在 DSH 模型设置里给 `opencode-go` 这个 provider 填好 API Key 即可（插件读 `OPENCODE_GO_API_KEY`，同时也认 `OPENCODE_API_KEY` / `OPENCODE_GO_KEY` / `OPENCODE_ZERO_API_KEY` 这几个同义变量名）。数据来自 OpenCode 官方 JSON 接口 `GET https://opencode.ai/zen/go/v1/usage`（`Authorization: Bearer <key>`），返回 rolling / weekly / monthly 三个窗口的**已用**百分比（5 小时滚动 / 7 天 / 30 天）与重置时间。⚠️ 这个接口**只给百分比、不给金额**（社区插件显示的美元金额是按硬编码额度自己算的），所以插件只渲染百分比。

> **百炼 Token Plan 配置（v1.11.0 起）**：模型 API Key（`sk-sp-` 前缀）**只授权推理、查不了配额**（实测推理网关无用量端点、浏览器控制台网关只认 Cookie）。插件走**官方 CLI 同款通道**：阿里云 RAM AK/SK → ACS3-HMAC-SHA256 签名调 `GenerateCLIAccessToken` 换短期 `cliAccessToken` → Bearer 调 `bailian-cs.console.aliyun.com/cli/api.json` 查个人版 usage/subscription/addon。**AK/SK 长期有效、token 失效自动重换，没有 Cookie 过期痛点。**
>
> 配置入口：**设置 → Token 统计 → 「百炼 Token Plan 凭据」卡片**（仅当 DSH 里配置了 qwen token plan 模型时显示）。RAM 用户需要：① 自定义策略 `modelstudio:GenerateCLIAccessToken`（Resource `*`）；② 系统策略 `AliyunTokenPlanReadOnlyAccess`；③ **加入百炼业务空间**（否则网关返回 `BailianGateway.Team.NotAuthorised`）。AK/SK 存入 DSH 官方凭据库（`ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET`，也支持同名环境变量回退），仅发往阿里云官方端点，界面只回显掩码。
>
> 读数语义：个人版按 **Credits** 计量（≠token，随模型单价/缓存/夜间折扣浮动），当前只有**订阅月**窗口（官方 2026-08/09 先后取消 5h/周限额）；`per*Percentage` 是 0-1 比值，插件 ×100 展示。加购包（用量包）余额与套餐剩余天数在悬停面板/设置卡片显示。route 匹配：`qwen-token-plan-cn` / `qwen-token-plan` / `qwen-token-plan-individual` / 名字含 `qwen-token-plan`、`bailian-tpp`、`bailian-token`（按量付费的普通 `bailian`/dashscope 路由不匹配——没有套餐配额）。
>
> **RAM 子账号报 `BailianGateway.Team.NotAuthorised`？** RAM 策略与百炼业务空间是两套独立权限——策略齐全后还需把 RAM 用户加入业务空间。跑 `npm run fix:bailian-workspace` 即可（官方 `bl workspace init` 的授权子集：CreateUser → ListWorkspaces → ChangeUserPermissions，用 RAM 用户自己的 AK/SK，**不含后付费开通等计费操作**）；或在百炼控制台成员管理里手动添加该 RAM 用户。

## 工作原理

```
DSH 会话日志（唯一权威数据源）
  ├─ LIVE   : session/event  → assistant/message(usage)   [插件启动后实时累计]
  ├─ HISTORY: sessionQuery.readSession() → 回填历史        [仅扫描从未回填过的会话]
  ├─ DEDUP  : 按 session+seq 水位线去重，绝不重复计数
  └─ PERSIST: 聚合 + 水位线落盘 stats.json（防抖写盘 + 停止时 flush）
        │
        ▼
TokenStatsService.getStats()   ← ctx.remote.tokenStats.getStats()（Client 调用）
TokenStatsService.getQuota()   ← ctx.remote.tokenStats.getQuota(provider, force)
        │
        ├─ getStats → 设置面板「Token 统计」页（柱状图 / 饼图 / 热力图）
        └─ getQuota → composer 工具行内联读数（conversation.input.right，
                      紧贴 model select 左侧；跟随当前会话模型自动切 provider）
```

- 数据按**本地日历天** × **模型**（`provider::model`）聚合；`total = input + output + cacheRead + cacheWrite`。
- 历史回填只统计插件启动前发生的调用，实时监听只统计启动后的，两者通过每个会话的事件序号水位线合并，不会重复。
- 模型/模型来自 `assistant/message` 的 `message.source`（kind = 'model'），无需自行解析请求头。
- 套餐余额：Host 半经 `credentials` 服务解析用户在模型设置里已配置的 API Key（引用命名遵循 `<ROUTE>_API_KEY` 约定；凭据库未命中时回退同名环境变量），GET provider 官方端点（宿主全局 fetch 优先，无 fetch 时回退 `subprocess` curl）；30s 缓存 + 失败指数退避（5s→30min），不落盘。**小米 MiMo 没有 API Key 配额接口**：配了 dashboard Cookie（`XIAOMI_MIMO_COOKIE`）走官方剩余用量 %，Cookie 失效时静默退回本地用量统计；未配置则与其他 provider 一样视为未配置。**OpenCode Go** 走官方 JSON 接口 `opencode.ai/zen/go/v1/usage`，给出 5h / 7d / 30d 三个窗口的已用百分比。

## 目录结构

```
dsh-token-stats/
├── index.js            # Host 半：TokenStatsService（Remote 服务，采集 + 回填 + 配额）
├── bailian-quota.js    # 百炼 Token Plan 纯函数层（ACS3 签名 / 网关信封 / 窗口解析）
├── client.js           # Client 半：设置页「Token 统计」UI bundle
├── typert.host.js      # Typert Host manifest（tokenStats 6 个 Remote 方法描述）
├── cordis.patch.yml    # dsh bundle patch（挂载行）
├── scripts/            # 冒烟 / repro / 探针（smoke-bailian、probe-bailian 等）
├── .github/workflows/  # GitHub Actions 发布
├── AGENTS.md           # 面向 AI agent 的开发指南（含踩坑）
└── LICENSE             # MIT
```

## 开发

```bash
npm run check           # node --check index.js bailian-quota.js client.js typert.host.js
npm run smoke:bailian   # 百炼纯逻辑冒烟（ACS3 金标准向量 / 信封 / 窗口 / display）
npm run probe:bailian   # 百炼 AK/SK 全链路只读探针（不打印密钥）
npm run fix:bailian-workspace  # 修复 RAM 子账号「未加入百炼业务空间」导致的 NotAuthorised（无计费操作）
npm run e2e             # 全量验收（check + 全部 smoke + 3 个 repro）
dsh plugin --profile web add /path/to/dsh-token-stats   # 安装/重装到本机 DSH profile
```

> `probe:bailian` / `fix:bailian-workspace` / `smoke:bailian` 三个脚本随 npm 包一起分发——装完 npm 版也能直接在插件目录里跑（凭据从 `~/.dsh/.credentials.yaml` 或环境变量 `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET` 读取，脚本不打印密钥明文）。

详见 [AGENTS.md](AGENTS.md)——记录了 DSH 正式插件（Host/Client/Typert 三件套）的完整机制和踩坑。

## License

本项目遵循 [MIT License](LICENSE)。

> 本项目是基于 DeepSeek Harness 构建的社区插件，并非 DeepSeek 官方产品。
