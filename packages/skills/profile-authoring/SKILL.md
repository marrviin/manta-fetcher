---
name: profile-authoring
description: 为 manta-fetcher 生成新站点 Profile 的 agent 工作流：能力分层判断 → DOM 探针 → YAML 草稿 → profile-verify 量化自验闭环 → 回归确认。当用户要求为新站点扩展采集能力、生成 profile、或采集某站效果不佳需要定制时使用。目标：一次会话内产出经过量化验证的稳定 profile，而不是反复试错。
---

# Profile 生成工作流（一次会话产出稳定 Profile）

核心原则：**每一步都有量化判据，迭代发生在生成时的机器验证里，不靠人反复试**。
验证器是 `profile-verify.mts`——一条命令出 PASS/FAIL 体检表，失败行自带修法提示；你的职责是读懂提示、改对 YAML、重跑确认。

## 前置

```bash
cd /path/to/manta-fetcher          # 仓库根工作（落盘根 = <仓库根>/.manta-fetcher）
pnpm --filter @manta-fetcher/core build   # 改过 core 源码后必须；mcp 脚本 import 的是 dist
MANTA_FETCHER_PROFILES_DIR=$PWD/profiles ./node_modules/.bin/tsx packages/mcp/scripts/mcp-smoke.mts   # 冒烟（env 指向模板 profiles）
```

## 第 0 步：能力分层判断（能不写 profile 就不写）

```bash
./node_modules/.bin/tsx packages/bench/scripts/profile-verify.mts --url <url>
```

先跑一次 **generic**（不带 --profile）：

- **PASS** → 通用管线已够用，不需要 profile，收工。
- **FAIL** → 看失败项属于哪类：
  - **内容缺失类**（低召回 / 字符比 ≪1）→ 先确认不是渲染时机问题：查 `~/.manta-fetcher/cache/bench/verify-*/coreText.txt`（主内容参考文本）与 `engines/manta.md` 的差异。若 coreText 本身就缺正文 → 站点需要登录/反爬处理；若 coreText 有而 manta.md 没有 → 引擎问题，不要用 profile 硬补，报告给用户
  - **噪音类**（字符比 ≫1 / 低 F1）→ 需要 profile（mainContent/remove），走第 1 步

## 第 1 步：探测 DOM（一次性，用完即删探针脚本）

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

**注意**：`page.evaluate` 内不能定义命名函数（tsx keepNames 注入 `__name` 导致浏览器报错），一律 const 箭头函数；若报 `__name is not defined`，在 evaluate 函数体首行加：
`const g = globalThis as any; if (typeof g.__name !== 'function') g.__name = (fn: any) => fn;`

要探清的最小信息集：① 正文/列表的唯一容器选择器（语义标签 `article`/`main` 优先于 class）；② 标题选择器；③ 噪音块的 selector（面包屑、元信息条、悬浮栏、相关推荐）；④ 列表页的结果项结构（条目选择器 + 标题/链接/摘要的相对路径）。

## 第 2 步：起草 YAML（每个字段都有明确的"什么时候写"）

```yaml
# 用户 profiles 目录（仓库根工作即 <仓库根>/.manta-fetcher/profiles/<site>.yaml；参考仓库根 profiles/ 下的示例模板）
name: <site>                        # = MCP 工具名 fetch_<site>
description: <一句话，会成为工具描述>
match: ["https://<站点>/pattern*"]  # 尽量窄，避免误吞

navigation:
  waitUntil: "visible:<正文或结果项选择器>"  # 优先 visible:，禁用 networkidle（常连接站会超时）
  timeoutMs: 30000
  userAgent: "..."                  # 仅默认 UA 被反爬拦截时才加
  viewport/locale:                  # 仅站点有响应式/地区门控时才加

extraction:
  mainContent: "<语义最小容器>"      # 框"正文所在的最近公共容器"，不是更大也不是更小
  title: "h1"                       # 站内标题有专用 class 时用之
  remove:                           # 从最具体的开始，一条一个噪音块
    - "<噪音 selector>"

# 列表页才加（文章页千万别加）：
layout:
  pageType: feed                    # 列表/信息流页：跳过"主标题+成段正文"的核心区判定

# 有字段要结构化返回时才加：
structured:
  fields:
    author: { selector: ".username" }
    publishTime: { selector: ".meta-box .time", attribute: "title" }
    tags: { selector: ".tag-list li .tag-title", multiple: true }
```

**决策守则**：
- `mainContent` 宁窄勿宽——宽了噪音进来靠 remove 补，每条 remove 都是脆弱点
- `remove` 里的 selector 必须用探针确认存在后再写，不要凭猜测
- 登录型站点：`auth: { required: true, loginUrl: ..., sessionCookie: [...] }`；登录成功**不跳 URL** 的站必须配 sessionCookie
- 中转链型（详情链接是会话级 token + JS 跳转）：`composite.resolveRedirect: true`
- 不要加引擎已有通用能力的补丁（懒加载、图片等待、滚动预热都是引擎默认行为，profile 里没有也不需要对应配置）

## 第 3 步：机器验证闭环（最多 3 轮，每轮一条命令）

```bash
./node_modules/.bin/tsx packages/bench/scripts/profile-verify.mts --url <url> --profile <site>
```

- **PASS** → 第 4 步
- **FAIL** → 逐行读 `✗` 项的 `→` 提示修 YAML，重跑。典型对应关系：

| 失败项 | 根因 → 修法 |
|---|---|
| 句子召回低 | mainContent 框小了 → 扩到正文最近公共容器；或正文未渲染 → 查 coreText.txt |
| bigram F1 低 + 字符比高 | 噪音混入 → 探针确认噪音 selector，加 remove |
| bigram F1 低 + 字符比 ≪1 | 内容缺失 → mainContent 范围/登录态/渲染时机，回到第 0 步分类 |
| 标题 0 命中 | title 选择器未命中 → 探针确认 |
| 图片 0/有图站 | 懒加载属性超出内置表 → ExtractArgs.lazyImgAttrs 场景，报告而非硬补 |

- **3 轮仍 FAIL** → 停。向用户报告失败项与探针证据，不要硬凑 selector 凑到 PASS——凑出来的 profile 站点一改版就碎。

## 第 4 步：回归与收尾

```bash
# 若站点已属于 bench 某个 case：跑单 case 确认数字不回退
./node_modules/.bin/tsx packages/bench/scripts/bench-run.mts --case <case>
# 改过引擎代码时：全量基准 + IR 回归
./node_modules/.bin/tsx packages/bench/scripts/bench-run.mts
./node_modules/.bin/tsx packages/mcp/scripts/ir-regression.mts
```

**脏数据纪律（必须遵守）**：
- 探针/临时脚本**用完即删**；profile-verify 的 `verify-*` 缓存目录可留（自描述、不影响基准）
- 校准期间落的盘只留最终轮次产物；删文章产物时核对孤儿图片（`cache/images/<site>/`）
- 测试产生的假 storageState 记得删

**交付物**：`<落盘根>/profiles/<site>.yaml` + profile-verify 的 PASS 输出（贴给用户，量化可信）。

## 常见问题速查

| 现象 | 原因 → 处置 |
|---|---|
| profile 写了但 fetch 没命中 | URL 不匹配 match 模式 / YAML 语法错误（ProfileRegistry 会静默跳过坏文件）→ `ls <落盘根>/profiles/` + 重新 reload |
| 改 YAML 不生效 | MCP 进程缓存了 profile → ListTools 热加载，但 YAML 语法错会保持旧版；重新 `pnpm build` + 重启 |
| fetch 报"登录态已失效" | 被 loginRedirect 正则命中 → 调 login_<site> 后重试 |
| 列表抓 0 条 | 未渲染完/反爬/选择器失效 → 提高 timeout 重试一次；仍 0 重新探 DOM |
| HeadlessChrome 被拦 | `navigation.userAgent` 配真实 Chrome UA；传输指纹级反爬用 `navigation.browser: "cdp:<endpoint>"` 接管用户真实 Chrome |
| weixin 类站点每次落点不同 | 中转源（搜狗等）返回顺序随机 → 该 case 的 bench 数字天然波动，用金样层/一致性矩阵判断而非单次召回 |
