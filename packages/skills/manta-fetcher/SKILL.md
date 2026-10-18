---
name: manta-fetcher
description: 使用 manta-fetcher MCP 完成网页内容采集的完整工作流：接入 MCP、布置采集任务、沉淀新场景 Profile。当用户要求抓取/采集某网站网页内容（返回页面内容 IR）、要为新站点扩展采集能力、或问采集结果可信度时使用。
---

# manta-fetcher 采集工作流

manta-fetcher 是场景化网页采集 MCP：无头浏览器 + 站点 Profile 定制，采集产出**正文 Markdown + 结构化字段**（底层是页面内容 IR：块级节点 role + 行内 runs + 坐标/字号/重要性 + 图片节点，markdown 为其投影）。核心原则：**场景定义全部在配置层（profiles/*.yaml），引擎代码零站点耦合；无 profile 时通用管线兜底**。

## 前置检查

首次使用前确认环境就绪（在仓库根目录执行）：

```bash
ls profiles/                  # 已有场景配置
ls packages/mcp/dist/index.js # 已编译；没有则 pnpm build
./node_modules/.bin/tsx packages/mcp/scripts/mcp-smoke.mts   # 冒烟：能列出工具即正常
```

MCP 客户端接入（Claude Code 的 `.mcp.json`）：

```json
{
  "mcpServers": {
    "manta-fetcher": {
      "command": "node",
      "args": ["/绝对路径/manta-fetcher/packages/mcp/dist/index.js"],
      "cwd": "/工作目录"   // profiles/、auth/、cache/ 都按此目录解析
    }
  }
}
```

## 一、布置采集任务

### 工具选择

| 工具 | 用途 |
|---|---|
| `list_profiles` | 先看已有场景；新任务先查这里 |
| `fetch_page` | 任意 URL 兜底（未命中 Profile 走通用管线） |
| `fetch_<site>` | 命中已配置场景的页面 |
| `login_<site>` | 场景要求登录态时使用（会弹浏览器窗口，需用户操作） |

> 组合工具（`fetch_<site>_top3` 类，列表 → 逐篇详情）依赖 composite 投影，暂未接入 MCP（引擎侧能力已备，接入后此条删除）。

### 通用参数（所有 fetch 工具）

```
url          必填
saveTo       "cache/layouts" → 落盘 IR JSON（<dir>/<site>/<日期>/<时间>-<slug>.layout.json）
saveSlug     落盘文件名 slug，缺省用页面标题
preview      true → 启动本地预览 server 渲染布局（视觉校验 profile 用）
```

### 典型调用模式

```jsonc
// 单页采集 + 落盘
{ "name": "fetch_juejin", "arguments": { "url": "https://juejin.cn/post/xxx", "saveTo": "cache/layouts" } }

// 采集 + 视觉预览（校验 profile 的 mainContent/remove 是否框对了正文）
{ "name": "fetch_juejin", "arguments": { "url": "https://juejin.cn/post/xxx", "preview": true } }
```

### 登录场景的处理（agent 自主流程）

1. 调用 fetch 工具 → 返回错误且提示 `请调用工具 login_<site>` 
2. **主动调用** `login_<site>`（不要等用户指示）——浏览器窗口弹出，告知用户在窗口中完成登录，工具会自动检测成功（按 profile 的 `sessionCookie` 或 URL 变化）
3. 登录态保存在 `auth/<site>.storage.json`，跨进程复用；**登录成功后直接重试原抓取**，无需用户再指挥
4. 注意：登录检测按 profile 的 `sessionCookie` 优先，用户登录完成前工具不会提前返回（误判已堵上，但超时 5 分钟需提醒用户）

## 二、验证采集质量（量化，不靠目测）

| 手段 | 命令 | 用途 |
|---|---|---|
| 单点体检 | `./node_modules/.bin/tsx packages/bench/scripts/profile-verify.mts --url <url> [--profile <name>]` | 任意 URL 的量化 PASS/FAIL：句子召回、bigram F1、字符比、标题/图片命中，每项带修法提示。**调 profile 的标准循环** |
| 效果基准 | `./node_modules/.bin/tsx packages/bench/scripts/bench-run.mts [--case <n>]` | manta vs 基线引擎对比（5 用例），改引擎/profile 后跑，防回归 |
| 视觉预览 | fetch 工具 `preview: true` | 盒子落在正文位置、噪音被 remove 即正常 |
| IR 回归 | `./node_modules/.bin/tsx packages/mcp/scripts/ir-regression.mts` | 线上页面快照逐字节对比，确认引擎改动零漂移 |

体检的判定语义：参考系 = profile mainContent 的 DOM 文本（无 profile 用整页文本）；字符比 ≈1 最好，≪1 丢内容、≫1 混噪音。

## 三、沉淀新场景（新站点 → Profile）

**完整生成工作流（探针 → YAML 草稿 → 机器验证闭环 → 回归）见 `profile-authoring` skill**，那里有每步的判据和失败模式速查表。以下为速览：

三种站点形态，先探测再写配置：

### 1. 探测 DOM（一次性，用完即删探针脚本，避免脏数据）

```bash
cat > packages/core/scripts/probe.mts <<'EOF'
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
await p.goto('<URL>', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3000);
const info = await p.evaluate(() => {
  const first = document.querySelector('<结果项选择器猜测>');
  const item = first?.closest('li, div, article');
  return { itemTag: item?.tagName, itemClass: item?.className, itemHtml: item?.outerHTML.slice(0, 1000), n: document.querySelectorAll('<猜测>').length };
});
console.log(JSON.stringify(info, null, 2));
await b.close();
EOF
./node_modules/.bin/tsx packages/core/scripts/probe.mts
```

**注意**：`page.evaluate` 内不能定义命名函数（tsx keepNames 注入 `__name` 导致浏览器报错），复杂逻辑用 IIFE；若报 `__name is not defined`，在 evaluate 函数体首行加 `const g = globalThis as any; if (typeof g.__name !== 'function') g.__name = (fn: any) => fn;`

### 2. 写 Profile（列表页 + 详情页各一个 YAML）

```yaml
# profiles/<site>-list.yaml — 列表页
name: <site>-list
description: <一句话说明，会直接成为 MCP 工具描述>
match: ["https://<站点>/list*"]

navigation:
  waitUntil: "visible:<结果项选择器>"   # 优先用 visible: 选择器，别用 networkidle
  userAgent: "..."                      # 仅当默认 UA 被反爬拦截时才需要

extraction:
  mainContent: "<列表容器>"
  remove: ["<噪音>"]
# structured 字段可用；composite（列表→详情链）暂未接入 MCP，schema 先接受配置
```

```yaml
# profiles/<site>-article.yaml — 详情页
name: <site>-article
match: ["https://<站点>/detail/*"]
extraction:
  mainContent: "<正文容器>"
  title: "h1"
  remove: ["<噪音>"]     # 校准轮次里逐步收紧
```

组合工具、login 工具由引擎**动态注册**，写完 YAML 即生效（ListTools 会热加载），无需重启 MCP、无需改代码。

### 3. 三种站点形态的已知解法

| 形态 | 特征 | 解法（profile 配置） |
|---|---|---|
| 直连型（AIBase） | 无登录无反爬 | 纯 YAML，零特殊配置 |
| 登录型（掘金热榜） | 无登录态被重定向/内容缺失 | `auth.required + loginUrl + sessionCookie`；登录成功**不跳 URL** 的站必须配 sessionCookie |
| 中转链型（搜狗微信） | 详情链接是会话级 token + JS 跳转 | `composite.resolveRedirect: true`（同会话解析最终 URL）；UA 被拦时配 `navigation.userAgent` |

### 4. 校准与验证（防脏数据纪律）

```bash
# 标准循环：profile-verify 量化体检 → 失败项按提示修 YAML → 重跑，PASS 后做回归
./node_modules/.bin/tsx packages/bench/scripts/profile-verify.mts --url <url> --profile <site>
```

```bash
# 采集一轮（saveTo 落盘 IR / preview 视觉校验）
# → 检查 IR：正文块是否混入噪音（面包屑/发布时间条/复制按钮）？
# → 混入则在 profile 的 remove 里加规则（用探针确认噪音的 selector），重新采集
```

**脏数据纪律（必须遵守）**：

- 校准期间落的盘，最终一轮跑完后**删除旧轮次产物**，只留最终样本
- 探针/临时调试脚本**用完即删**
- 删除文章产物时**核对孤儿图片**：`cache/images/<site>/` 中未被任何现存 md 引用的图一并删除
- 测试产生的假 storageState（如 smoke 测试写的）记得删

## 四、常见问题速查

| 现象 | 原因 → 处置 |
|---|---|
| `pnpm --filter exec` 跑验证匹配不到 profile | 它把 cwd 切到了包目录 → 从仓库根目录 `./node_modules/.bin/tsx packages/...` 跑 |
| 改了 core 但 mcp 行为没变 | tsx 跑 mcp 时 import 的是 core 的 dist → 先 `pnpm build` |
| 列表抓到 0 条 | 页面未渲染完/被反爬/选择器失效 → 提高 waitForTimeout 重试一次；仍为 0 则重新探 DOM |
| 组合工具报"未解析出任何条目" | 同上，引擎刻意报错而非静默返回空，防误判 |
| HeadlessChrome 被站点拦截 | profile 配 `navigation.userAgent` 为真实 Chrome UA |
| 图片下载失败 | 站点防盗链 → 引擎用浏览器 context 下载已带 cookie/referer；仍失败时图片保留原始 URL 并在 stderr 提示 |
