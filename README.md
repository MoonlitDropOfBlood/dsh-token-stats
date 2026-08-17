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
| ⏱ 自动刷新 | 页面打开期间每 30s 刷新；历史回填期间每 2s 轮询进度 |
| 🌗 主题适配 | 全部使用 DSH 设计 token，明暗主题自动跟随 |

## 安装

### 本地安装

```bash
# 1. 克隆本仓库
git clone <your-github>/dsh-token-stats.git
cd dsh-token-stats

# 2. 安装到本机 DSH profile（复制插件包 + 写入 cordis.patch.yml）
node scripts/install.mjs

# 3. 重启 DSH（命令行：node <dsh bin> web --profile web）
```

重启后，打开 DSH Web UI 的设置（侧栏底部），左侧导航会出现 **Token 统计** 页。

> 需要插件能在 profile 的 `node_modules` 解析到依赖（`zod`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-typert-protocol`）。若本机 DSH 未提供这些依赖，先在插件目录 `npm install`，再手动把 `node_modules` 一并复制，或把插件作为依赖加入 profile。

### 手动安装（原理）

1. 将插件包放入 `<DSH_HOME>/profiles/web/node_modules/dsh-token-stats/`。
2. 在 `<DSH_HOME>/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
  - id: token-stats
    name: 'dsh-token-stats'
```

3. 重启 DSH。

## 使用

1. 打开 **设置** → **Token 统计**。
2. 在 **近 7 天 / 近 30 天** 两个 Tab 间切换：
   - 柱状图展示区间内每天、每个模型的消耗（堆叠）。
   - 饼图展示区间内每个模型的总消耗占比。
   - 顶部卡片给出区间总 Tokens / 输入 / 输出。
3. 下方 **每日活跃** 热力图展示更长时间范围：格子越多 = 容器越宽，最多覆盖近一年。

## 工作原理

```
DSH 会话日志（唯一权威数据源）
  ├─ LIVE   : session/event  → assistant/message(usage)   [插件启动后实时累计]
  ├─ HISTORY: sessionQuery.readSession() → 回填历史        [插件启动时一次性回填]
  └─ DEDUP  : 按 session+seq 水位线去重，绝不重复计数
        │
        ▼
TokenStatsService.getStats()   ← ctx.remote.tokenStats.getStats()（Client 调用）
        │
        ▼
设置面板「Token 统计」页（柱状图 / 饼图 / 热力图，全部由同一份数据派生）
```

- 数据按**本地日历天** × **模型**（`provider::model`）聚合；`total = input + output + cacheRead + cacheWrite`。
- 历史回填只统计插件启动前发生的调用，实时监听只统计启动后的，两者通过每个会话的事件序号水位线合并，不会重复。
- 模型/模型来自 `assistant/message` 的 `message.source`（kind = 'model'），无需自行解析请求头。

## 目录结构

```
dsh-token-stats/
├── index.js            # Host 半：TokenStatsService（Remote 服务，采集 + 回填）
├── client.js           # Client 半：设置页「Token 统计」UI bundle
├── typert.host.js      # Typert Host manifest（tokenStats/getStats 描述）
├── scripts/install.mjs # 本地安装脚本
├── .github/workflows/  # GitHub Actions 发布
├── AGENTS.md           # 面向 AI agent 的开发指南（含踩坑）
└── LICENSE             # MIT
```

## 开发

```bash
npm run check           # node --check index.js client.js typert.host.js
node scripts/install.mjs
```

详见 [AGENTS.md](AGENTS.md)——记录了 DSH 正式插件（Host/Client/Typert 三件套）的完整机制和踩坑。

## License

本项目遵循 [MIT License](LICENSE)。

> 本项目是基于 DeepSeek Harness 构建的社区插件，并非 DeepSeek 官方产品。
