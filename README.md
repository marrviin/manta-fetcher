# manta-fetcher

场景化网页采集 MCP：无头浏览器（Playwright）+ 站点 Profile 定制，返回**结构化 Markdown**（标题层级、列表、表格、代码块、图片），而不是裸 HTML 或纯文本。

**服务定位：文章类信息密集页面**（新闻/资讯/技术博客/公众号文章等）。布局采集、核心内容标记、正文抽取等能力均按文章页语义设计与验证；feed/列表页不是布局能力的目标场景——列表数据用 Profile 结构化字段抽取（如携程 `.flight-item`），不往布局启发式里加规则迁就。

不追求通用抓取，而是**通用兜底 + 每个真实场景一份 Profile**：

- URL 命中 Profile → 使用该站点的正文定位、等待策略、交互动作、结构化字段、图片策略
- 未命中 → 内置通用管线兜底（启发式正文定位 + Shadow DOM 展开 + 全功能 DOM→Markdown）

## 结构（pnpm monorepo）

```
packages/
  core/   # 采集引擎，不依赖 MCP：BrowserPool / FetchEngine / Profile / DOM→Markdown / 图片
  mcp/    # MCP server（stdio）+ CLI（manta-fetcher serve|login|test）
profiles/ # 站点 Profile 示例模板（yaml 为主，可挂 JS Adapter）——不自动加载，复制到用户 profiles 目录生效
packages/skills/manta-fetcher/ # 使用技能：接入 MCP → 布置任务 → 验证还原度 → 沉淀新场景
auth/     # 各站点登录态（storageState）
cache/    # images/ 下载的图片、screenshots/ 失败诊断截图
```

目录解析规则：

- **profiles**：不随包内置，由用户自建，放 `<落盘根>/profiles`（在 git 项目内为 `<项目根>/.manta-fetcher/profiles`，否则 `~/.manta-fetcher/profiles`），热加载；仓库根 `profiles/` 仅作示例模板，可用环境变量 `MANTA_FETCHER_PROFILES_DIR` 临时指向它做开发调试。
- **落盘产物 / 登录态**：产物（articles、screenshots）跟随 git 项目（`<项目根>/.manta-fetcher/cache/`），不在任何 git 仓库内时回退 `~/.manta-fetcher/cache/`；登录态始终在 `~/.manta-fetcher/auth/`。

## 快速开始

```bash
pnpm install
pnpm build          # 先 build core（tsx dev 时也依赖 core 的 dist）
pnpm setup          # 安装 Playwright Chromium
```

MCP 客户端配置（如 `.mcp.json`）：

```json
{
  "mcpServers": {
    "manta-fetcher": {
      "command": "node",
      "args": ["/绝对路径/manta-fetcher/packages/mcp/dist/index.js"],
      "cwd": "/你的工作目录"   // 决定落盘根：git 项目内用 <项目根>/.manta-fetcher，否则 ~/.manta-fetcher
    }
  }
}
```

## MCP 工具

| 工具 | 说明 |
|---|---|
| `fetch_page` | 任意 URL，自动按 URL pattern 匹配 Profile，未命中走通用管线 |
| `fetch_<site>` | 每个 Profile 动态注册的语义化工具（如 `fetch_juejin`） |
| `list_profiles` | 列出已配置站点及能力 |

参数：`url`（必填）、`format`（markdown/html）、`structured`（同时返回 Profile 声明的结构化字段）、`images`（keep-url/download/inline，覆盖站点默认）、`saveTo`（落盘目录）、`layout`（同时返回视觉盒子模型）、`layoutFormat`（text/json）。

## 视觉盒子模型（layout）

传 `layout: true` 时返回**页面布局盒子模型 JSON**：只保留内容节点（有文本或图片），文本节点带字号/颜色/字重，并按重要性算法分级、以灰度梯度替换原色；**核心内容节点额外带 `body: true`**（主标题、各级小节标题、正文段落、导语/引用等样式化长文本、核心区间内的内容配图）。

评分算法、参数表与校准工作流见 [packages/core/docs/layout-methodology.md](packages/core/docs/layout-methodology.md)。

```jsonc
{
  "viewport": [1280, 800],
  "docHeight": 5437,
  "truncated": false,
  "nodes": [   // 扁平列表，按阅读顺序（y 升序、x 次序）
    {
      "rect": [122, 113, 756, 42],   // [x,y,w,h] 页面绝对坐标
      "text": "前端如何生成10000页PDF文件？",
      "fontSize": 32,
      "color": "#252933",            // 原始颜色
      "fontWeight": 600,             // computed 字重（400 正常 / 600-800 标题）
      "importance": 1.0,             // 0~1
      "level": 5,                    // 1~5，5 最重要
      "body": true,                  // 核心内容标记（文章页）
      "zIndex": 100                  // 浮层层级（仅 zIndex>0 的弹窗/悬浮控件输出）
    },
    {
      "rect": [106, 460, 36, 36],
      "img": "https://.../logo.png", // 图片节点：绝对 URL
      "imgSize": [48, 48],
      "importance": 0.7,
      "level": 4
    }
  ]
}
```

**重要性算法**（采集完成后基于全页统计打分，纯启发式统计，不依赖 DOM 语义标签）：

- **标题信号**：字号相对正文（全页最高频字号）越大越重要，超过正文触发标题专项分；加粗（字重 > 正文）再抬一档
- **字重信号**：相对正文字重越粗越重要（b/strong/加粗标题）
- **正文信号**：同 fontSize+color 的文本聚类量占比越大越可能是正文（全页最大聚类的成员 → 高分）
- **装饰信号**：颜色稀有（几乎无同色节点）且位置靠边（水平偏离中心、落入页首 8%/页脚 12% 带）→ 重要性 ×0.6
- **浮层信号**：zIndex ≥ 10 的节点（弹窗/悬浮控件）必然直接进入用户视野，重要性抬底至 0.55
- 另有文本长度、水平居中度参与加权；图片按面积+居中度评分（浮层同样适用）

实测校准（掘金文章页）：主标题 5 → 大图 5 → 小节标题 4 → 正文段落 3 → 导航/装饰 1-2。

**核心内容标记（`body: true`）**——目标是圈出文章的完整核心内容，链路：

1. **正文聚类**：文本量 ≥ 最大聚类 40% 且**字数加权质心在前半页**的聚类中，取文本量最大的（质心而非 minY——后者会被 hashtag chip 等单个杂点劫持；页尾推荐卡即便文本量更大也会因质心靠后被排除）
2. **核心内容区间** = [主标题顶， 最后一个正文段落底]；主标题 = 正文起点之上字号最大的节点
3. 区间内四合一标记：**段落**（正文聚类+正文字重+≥10 字）/ **小节标题**（字重 ≥600 或字号 > 正文聚类 1.15 倍）/ **导语·引用块**（区间内字号不小于正文、≥30 字、但样式与正文聚类不同）/ **插图**（质心在区间内且显示最短边 ≥80px，排除 logo/头像）

经 aibase（桌面门户+页尾推荐区）、掘金（w500 meta 标签/导语灰框/列表短句）、微信（移动极简版式）三站验证：主标题/小节标题/正文段落/导语/内容配图全部命中，导航、meta 计数、TOC 副本、登录礼包、侧栏推荐、页尾相关卡全部排除。

- 用途：Markdown 丢空间关系，盒子模型补齐"什么在哪、多大、和谁并排、谁重要"；`body: true` 给下游（摘要/抽取/翻译）现成的核心内容范围提示
- **预览**：`preview: true`（配合 `layout: true`）注册会话内预览 server（`127.0.0.1` 随机端口）并自动打开浏览器——节点按 rect 绝对定位、按 level 灰阶着色、核心内容节点浅蓝底、图片加载原图、浮层按 zIndex 叠放、hover 查看原始样式；同会话多次 preview 在左侧栏累积切换，server 随 MCP 进程存续
- **落盘**：`saveTo` 时自动同槽写入 `<HHmmss>-<slug>.layout.json`（与 .md/.meta.json 同目录同名，含 url/site/title/fetchedAt + 完整盒子模型）
- 过滤规则：不可见剔除、`display:contents` 透传、行内碎片剔除、内容节点上限 600（触顶标注截断）
- 在 `preparePage` 的 DOM 修改之前抽取，反映用户实际看到的原始页面；采集前自动预热（滚动到底触发懒加载、等图片加载完成后回顶）
- `layoutFormat: text` 可选紧凑文本渲染（`▓▓▓ [x,y,w,h] 文本 @字号 w字重 核心 z浮层`）；默认 JSON
- 缺省**整页采集**（无视口限制，maxNodes 兜底截断）；`layoutOptions.viewportMargin` 可缩小范围

## Site Profile

在用户 profiles 目录（git 项目内 `<项目根>/.manta-fetcher/profiles/`，否则 `~/.manta-fetcher/profiles/`）下新增 `.yaml`（或 `.js`）文件即可，热加载，无需重启。可参考仓库根 `profiles/` 下的示例模板。

```yaml
name: juejin
description: 抓取掘金技术文章，返回含代码块和图片的 Markdown
match:
  - "https://juejin.cn/post/*"     # * 匹配任意字符

navigation:
  waitUntil: "visible:.markdown-body"   # load|domcontentloaded|networkidle|visible:<sel>|ms:<n>
  timeoutMs: 30000
  # userAgent / viewport / locale 可选

actions:                                # 声明式交互（滚动加载/点击/等待）
  - scroll: { maxScrolls: 20 }
  - click: { selector: "text=查看更多" }

extraction:
  mainContent: ".markdown-body"   # 正文定位；缺省走通用启发式
  title: "h1.article-title"
  remove: [".article-suspended-panel"]

markdown:
  headingOffset: 0                # 标题层级偏移，2 表示正文 h1 输出为 ###

images:
  mode: download                  # keep-url（最快）| download（本地化）| inline（小图 base64 内联）
  saveDir: cache/images/juejin
  inlineMaxBytes: 1500000

auth:
  storageState: auth/juejin.storage.json   # 缺省即此路径；登录后自动生成
  # required: true              # 无登录态时 fetch 直接失败，错误信息指引调用 login_<site>
  # loginUrl: "https://..."     # login_<site> 打开的入口页，缺省用页面 URL 本身
  # successUrl: ""              # 登录成功判定（正则）；缺省"离开起始页后回到同站非登录页"
  # loginRedirect: "/login"     # 运行时检测：抓取后 URL 命中即报"登录态失效"

structured:
  fields:
    author: { selector: ".username" }
    tags:   { selector: ".tag-list li", multiple: true }
    link:   { selector: ".share", attribute: "href" }
    # 嵌套子字段：列表抽成对象数组（如榜单/搜索结果），limit 控制条数
    top:
      selector: "li.item"
      multiple: true
      limit: 3
      fields:
        rank:  { selector: ".rank" }
        title: { selector: "a.title" }
        url:   { selector: "a.title", attribute: "href" }
```

### 需要登录的场景（交互式登录）

Profile 声明 `auth.required` 后，MCP 会同时注册 `fetch_<site>` 和 `login_<site>` 两个工具：

1. LLM 调用 `fetch_<site>` → 无登录态时快速失败，错误信息直接指引调用 `login_<site>`
2. `login_<site>` 打开**有头浏览器窗口**，用户手动登录；每 2s 轮询检测成功（离开入口页后回到非登录页，或命中 `successUrl`），成功即保存登录态到 `auth/<site>.storage.json`
3. 用户直接关闭浏览器窗口或超时：已有 cookie 也会保留，可重试抓取验证
4. 登录态沉淀在该场景的 storageState 中跨进程复用；失效时（抓取后 URL 命中 `loginRedirect`）报错提示重新登录

复杂交互（登录流程、多步操作）用 JS Adapter：yaml 里 `adapter: ./juejin-adapter.js`，模块 default export `{ overrides?, prepare?(page, {url}) }`。

## 落盘（saveTo）

所有 fetch 工具（含组合工具）支持 `saveTo`（保存根目录，如 `cache/articles`）与可选 `saveSlug`。统一布局：

```
<saveTo>/<站点名>/<本地日期 YYYY-MM-DD>/<本地时间 HHmmss>-<slug>.md
<saveTo>/<站点名>/<本地日期 YYYY-MM-DD>/<本地时间 HHmmss>-<slug>.meta.json   # 有结构化字段时
```

- 时间用**本地时区**（年月日时分秒），非 UTC
- 单篇：`cache/articles/weixin-article/2026-10-15/110233-文章标题.md`
- 组合采集（列表→详情）：slug 带 `NN-` 抓取顺序前缀，如 `cache/articles/juejin/2026-10-15/122445-01-前端如何生成10000页PDF文件.md`
- 文件头注释含元信息（title/url/site/fetchedAt），图片已在 Markdown 中重写为本地路径
- `structuredContent.saved` 返回保存路径清单

## CLI

```bash
node packages/mcp/dist/index.js test <URL> [站点名]   # 抓一次输出 Markdown 预览（调 Profile 用）
node packages/mcp/dist/index.js login <站点名> <URL>  # 有头浏览器手动登录，回车保存登录态
node packages/mcp/dist/index.js serve                 # 启动 MCP server（默认）
pnpm --filter @manta-fetcher/core exec tsx scripts/core-smoke.mts   # 引擎冒烟：嵌套字段 + 登录等待
pnpm --filter @manta-fetcher/mcp exec tsx scripts/mcp-smoke.mts     # MCP 协议冒烟
```

### 抽取效果对比基准（bench）

manta 全管线 vs 基线引擎（浏览器直转 raw-turndown / Readability+Turndown）的双向对比，含可选大模型金样层。工件落 `~/.manta-fetcher/cache/bench/`：

```bash
pnpm --filter @manta-fetcher/bench exec tsx scripts/bench-run.mts              # 全量采集+对比（5 用例 × 3 引擎）
pnpm --filter @manta-fetcher/bench exec tsx scripts/bench-run.mts --case juejin-article   # 单用例
pnpm --filter @manta-fetcher/bench exec tsx scripts/bench-gold.mts --all       # 大模型金样（API 或 bundle 模式）
pnpm --filter @manta-fetcher/bench exec tsx scripts/bench-gold.mts --case <n> --import <file>  # bundle 标注回填
pnpm --filter @manta-fetcher/bench exec tsx scripts/bench-report.mts           # 离线重算（不出网）
```

每次运行（bench-run / bench-report）都会生成 `~/.manta-fetcher/cache/bench/report.html`——单文件报告页（聚合表、分 case 对比、一致性矩阵、跨次运行趋势图），浏览器直接打开；真实采集的历史按 jsonl 累积（`bench-history.jsonl`），离线重算不追加。

单点 profile 体检：`pnpm --filter @manta-fetcher/bench exec tsx scripts/profile-verify.mts --url <url> [--profile <name>]`——任意 URL 的量化 PASS/FAIL（句子召回/bigram F1/字符比/标题图片命中，失败项带修法提示），是生成与调整 profile 的标准验证循环。

指标：句子召回%、字符 bigram P/R/F1、引擎间一致性矩阵、结构计数 vs DOM 实数、字符比、金样内容 P/R/F1、标题/图片召回、噪音率。公平性：所有引擎解析同一份暖场后的页面快照（懒加载已回填）。金样与页面文本 hash 绑定，计数/推荐位抖动（正文 ≥90% 仍命中）自动自愈，正文真漂移判 stale。

## 通用管线的处理能力

- Shadow DOM 展开（Web Components 站点的正文，如 MDN 代码示例）
- 图片懒加载修正（data-src/srcset/picture）与 URL 绝对化
- 不可见元素、script/style/svg 噪音移除
- GFM 表格、嵌套列表、代码块语言恢复（language-/hljs- class）
- 页内锚点链接转纯文本（避免标题全是 `[x](#x)` 形式）
- 失败时自动截图，路径随错误信息返回

## 已知边界 / 后续

- **feed/列表页不是布局核心内容的目标场景**：这类页面没有"主标题/成段正文"结构，`body` 标记会退化为"列表数据+操作入口"（且无法区分同款样式的短内容与短标签）。列表数据请用 Profile 结构化字段抽取
- 长 token 预算截断分页、并发限速队列、反指纹插件、Profile 单测命令（原 M3/M4 规划）
- `waitUntil: networkidle` 对常连接站点可能超时，优先用 `visible:<selector>`
- Markdown 中转义策略较宽松，极端字符的站点可在 Profile 中验证调整
