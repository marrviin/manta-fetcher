# @manta-fetcher/bench

抽取效果双向对比基准。在线入口 `bench`（采集 + 离线引擎 + 金样指标），离线重算入口 `report`，金样入口 `gold`。

## 产品边界与用例分组（2026-10 定）

**manta 的目标是内容平台的文章页/内容页**（掘金、36kr、雪球、少数派、澎湃、微信公众号等），
不是通用整页抽取工具。用例据此分两组（`src/cases.mts`）：

- **目标语料**：内容平台文章页/内容页。profile 主路径用例 + generic 对照组
  （同站去 profile 量化 profile 增益）。
- **非目标参考**：文档站/仓库页/极简博客等——仅背景对照，不驱动适配决策
  （在 cases.mts 中注释保留，历史工件仍在 `~/.manta-fetcher/cache/bench/` 可复评）。

首批结论（2026-10-17，16 用例）：profiled 套件 manta 句子召回 0.943 / gold F1 0.945
（readability/trafilatura 召回 0.85–0.87、F1 0.95–0.96）；generic 全景下 trafilatura
gold F1 0.814 > manta 0.658，但差距集中在非目标的文档站/仓库页；目标站型内
（sspai/thepaper/juejin-generic）差距为 0.04–0.4 不等，juejin profile 增益 0.595→0.978。

## 引擎

| 引擎 | 类型 | 说明 |
|---|---|---|
| manta | 在线（全管线） | warm + collect + IR 投影 md |
| raw-turndown | 离线 | 整页直转（无降噪），下界参考 |
| readability-turndown | 离线 | @mozilla/readability 主内容 → md |
| trafilatura | 离线（Python） | 生态标杆基线；`packages/bench/.venv`，安装：`uv venv .venv && uv pip install trafilatura`，入口 `scripts/trafilatura` |
| jina-reader | 在线 | r.jina.ai 代理抓取；**本开发网络不可达**（fetch failed），留作可选引擎，支持 `JINA_API_KEY` |

## 语料原则

- 目标语料选站：中文内容平台优先，形态覆盖（技术社区/资讯站文章+列表/公众号图文/
  图文长文/新闻/社区长帖）；本网络环境可达（被墙域名不收录；被墙字体拖住 `load`
  的站点声明 `waitUntil: 'domcontentloaded'`，见 BenchCase 覆盖字段）。
- 每个用例带 `note` 说明考察点；扩容保持原则并逐条记录。

## 金样生成

`gold` 入口走 ANTHROPIC_API_KEY（已失效）或 bundle 模式（`gold-prompt.txt` → LLM 标注 →
`--import` 回填，zod 校验）。当前实践：bundle prompt 交由并行子代理标注，效果等同。

## 已知环境限制

- 36kr 列表页客户端导航反爬使 generic 采集三次失败（collect 阶段 execution context
  destroyed），且残留页面会卡住 `pool.close()`（BrowserPool 健壮性待办）；文章页待验证。
- 雪球反爬依赖 cookie，curl 需先访问首页种 cookie；headless 表现待验证。
