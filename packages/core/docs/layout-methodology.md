# Layout IR 评分方法论

> 本文说明 manta-fetcher 通用层（BoxTree 管线）的设计依据与算法细节。
> 代码入口：`packages/core/src/layout/boxTree.ts`（管线）与 `packages/core/src/layout/scoring.ts`（参数表）。
> 站点差异不在本文范围——只允许通过 `profiles/*.yaml` 的 `layout` 段声明（见 §9）。

## 1. 目标与范围

**目标**：把任意网页还原为「块级内容 IR」——每个节点带角色（role）、行内文本 run、几何 rect、字号/颜色/字重、重要性分（importance 0-1 → level 1-5）、是否核心正文（body）标记。markdown / 纯文本 / 视觉预览都只是 IR 的投影，不在采集阶段做站点定制。

**页面形态**（`profile.layout.pageType`）：
- `article`（缺省）：成文内容页。计算「核心内容区间」，区间内的语义内容标 `body: true`。
- `feed` / `list`：信息流、列表页。无「一篇正文」可圈定，跳过核心区间计算，`body` 由语义角色直接标记（等价于引擎的 `coreBottom < 0` 降级分支，见 §5）。

**明确不做**：不做语义理解、不猜"作者意图"；所有判断都来自可测的渲染信号（字号、字重、颜色频率、几何位置、聚类文本量）。

## 2. 两阶段数据流与序列化约束

```
FetchEngine.fetch
  → warmPageForLayout        # 滚动暖场：触发懒加载、等图片撑开盒子
  → page.evaluate(collectLayoutFn, args)   # 浏览器侧：多趟 RawPass 采集
  → enrichLayout(pass, opts) # Node 侧：聚类统计 + 评分 + body 标记 + 阅读顺序
  → FetchResult.layout       # IR v3
```

**序列化约束**是本管线最重要的工程事实：`collectLayoutFn` 以函数源码形式传进浏览器，
它引用的任何模块级常量在浏览器里都是 `undefined`。因此浏览器侧参数（minSize/maxNodes/textMax/viewportMargin/lazyImgAttrs）一律经 `ExtractArgs` 传入（JSON 可序列化；`Infinity` 无法跨 JSON，`viewportMargin` 缺省/`null` 均表示整页）。Node 侧参数（评分权重等）不参与序列化，收敛在 `scoring.ts`——这就是参数分居两处的原因，不是历史遗留。

多趟采集（RawPass）：页面按视口分趟滚动，每趟收集视口附近的节点，坐标统一换算回文档坐标系（`r.top + window.scrollY + 容器scrollTop`）。同一节点可能被多趟覆盖，`seenImg`/`seenBlock` 去重。

## 3. 信号定义

以下信号在 `enrichLayout` 中对每个文本节点计算（公式与取值域以 `scoring.ts` 命名常量为准）：

| 信号 | 定义 | 直觉 |
|---|---|---|
| fontScore | `(fontSize − bodyFont) / (maxFont − bodyFont)`，整页同字号时取 0.5 | 相对正文的字号层级 |
| weightScore | `(fontWeight − bodyWeight) / 300`，仅更粗时非零 | 加粗是编辑强调信号 |
| clusterScore | 同簇（同 fontSize+color）文本量 / 最大簇文本量 | 正文的群体性：孤立的样式通常是噪音 |
| lengthScore | `chars / 60` | 长文本更可能是内容 |
| centrality | 水平居中项 0.6 + 垂直边缘项 0.4；顶部 8% / 底部 12% 页高为边缘带 | 导航/页脚贴边，正文居中 |
| colorRarity | `1 − (该色节点数−1)/最大色节点数` | 罕见颜色更可能是装饰/标注 |
| areaScore（图片） | `area / (240×240)` | 大图是内容图，小图是图标 |

参考值：`bodyFont` = **字符加权**最高频字号、`bodyWeight` = 最高频字重、`maxFont` = 全页最高字号。
`bodyFont` 按字符量加权（每节点权重 = max(1, 字符数)）而非按节点数：壳噪音（侧栏榜单/
导航项）节点数可以超过正文，字符量不会——实测雪球右栏大量 14px 榜单项把节点数最高频
判到壳字号上，16px 正文整体被误归位成 heading，进而 `paras` 为空、核心区间失效、全页
误标 body（三重级联）。

## 4. 正文聚类（body cluster）

聚类键 = `fontSize + "|" + color`（同字号同色才算一族；字重不进键，避免 em/strong 切碎正文簇）。

**准入**（`cluster.*`）同时满足：
1. 簇文本量 ≥ 最大簇 × `bodyClusterCharsRatio`（0.4）——防小簇噪声明抢；
2. 簇字符加权质心 y ≤ 页高 × `bodyClusterCentroidMaxY`（0.5）——正文不会沉在页尾。

**选定**：准入簇中文本量最大者。**回退**：无一准入时取文本量最大簇（保证 tagless 页总有参考）。

正文聚类是后续一切的锚：它是 fontScore 的原点、para 归类的依据、核心区间的段落来源。

## 5. 核心内容区间（core range）与降级

区间 = [主标题顶, 尾部锚定段落底]：
- 段落来源：语义角色 `p/para/li/td/th` 且落在正文簇、字重为正文字重、字符数 ≥ `paraMinChars`（10）；
- 主标题：段落起点之上（y ≥ 0，排除 fixed 定位飞出视口的登录条等壳元素）、字号大于
  正文字号的最大者——不设 y ≥ 0 下限时 `position: fixed` 的壳元素（实测雪球
  「立即登录/注册」在 y=-5978）会被选为主标题，核心区间被拉到覆盖全页；
- 尾部锚定：取最后一个长段落（≥ `longParaChars`（40））为锚，锚后**贴身**短段
  （与上一段间距 ≤ 120px）并入，断档即止——文章尾部的讨论框/互动条/相关推荐与
  正文之间总有断档或本身就短；整页无长段落时不剥（诗歌/短句正文退回旧行为）；
- **列校验（inColumn）**：正文区间是 y 维的，双栏页右栏（侧栏榜单）与正文同 y 也会
  落进区间。以聚类段落的水平跨度界定正文列（左缘容差 `max(32, 列宽×0.1)`、右缘
  8px），区间内的节点还须落在列内才算 body——实测雪球右栏榜单 x=845 距正文列右缘
  仅 23px、同字号同色，只有列能区分；
- `pageType: feed/list` 跳过本阶段（强制 `coreBottom = -1`）。

**降级链**（`coreBottom < 0`，即无合格段落或非 article 页）：
- 语义内容角色（h1-6/pre/li/blockquote/p/td/th、聚类 para）一律 `body: true`；
- 其余节点不标 body，交给 level 表达重要性。

这个降级分支是刻意保留的统一出口：feed 页、极端异常页、空页都走它，不需要特判。

**链接列表簇归位（仅 feed/list 页）**：热榜/推荐位等次级模块整簇是站内跳转锚点
（卡片 `<a>` 包裹），文本量不足以竞选正文聚类、语义角色通道又只认 li——inferred
para 归位会整段硬丢（实测 AIBase 热榜 10 条标题全漏）。归位规则：

- 准入按节点逐个判：inferred para、字号 ≤ 正文字号、全部 run 携带站外跳转 href
  （同页锚点不算）、单节点文本 ≥ `paraMinChars`——短文本的导航/页脚项即使与热榜
  同簇也不抬；
- 门槛按簇（同 fontSize+color）统计：簇内候选节点数 ≥ `linkList.minNodes`（3）
  且去重 href 数 ≥ `linkList.minDistinctHrefs`（3），互证这是列表模块而非孤链接；
- 抬分只落在候选节点上：命中簇的候选 inferred para 改标 `li`，走语义角色通道。

**figcaption 按语义角色采集**：`FIGCAPTION` 直接映射语义角色 `p`（`H_ROLE` 表），
不走 inferred para 启发式——图注字号小、颜色孤立（灰阶），不参与正文聚类，
按启发式归位会被整段丢（实测微信文章图注全漏）。语义角色在核心区间内直接标 body。

**自绘图注归位（全体 pageType）**：很多站点的图注不用 `figure/figcaption`
（微信图文用自绘 caption 块）。签名：小字号（≤ 正文字号）、不在正文聚类、
文本 ≤ `caption.maxChars`（60）、顶边紧贴某图片下缘（间距 ≤ `caption.maxGapPx`
即 40px——实测图注 3-30px、正文段落 > 50px，取中）、水平中心落在图片跨度内、
且该图片短边 ≥ `coreImgMinSide`（80px，小图标下方的标签不是图注）。命中后按
语义角色 `p` 归位，仍受核心区间/语义角色通道约束。

**段落资格不含字重**：加粗段（公众号重点句等）是强调不是换角色。`paras`
过滤（核心区间下界来源）与 para 的 body 标记均只按「字号+颜色 ∈ 正文簇 +
字符数 ≥ paraMinChars」判定；启发式归位原本就只按簇判 para，三处保持一致。
此前 body 标记多一个 `fontWeight === bodyWeight` 条件，导致加粗段整段丢失
（实测微信文章 3 段加粗重点句全漏）。

## 6. 重要性合成

**文本节点**（`textWeights.*`，权重和为 1）：

```
importance = 0.34·fontScore + 0.06·weightScore + 0.26·clusterScore
           + 0.16·lengthScore + 0.18·centrality
```

叠加规则（按序）：
1. **标题抬分**：`fontSize > bodyFont` 时取 `max(importance, base + (fontSize/bodyFont − 1)·sizeGain + weightScore·weightGain)`（0.4 / 0.8 / 0.15）；
2. **装饰衰减**：`colorRarity > 0.75 且 centrality < 0.3` 时 `importance × 0.6`（罕见色 + 贴边 ≈ 广告/装饰角标）；
3. **浮层地板**：`zIndex ≥ 10` 抬到 ≥ 0.55（弹窗内容用户必然可见，不因样式孤立被打低）；
4. 钳到 [0,1]。

**图片节点**：`0.55·areaScore + 0.45·(1 − dx·0.6)`（dx = 水平偏离中心比例）；同样适用浮层地板。

**level 映射**：`level = 1 + round(importance × levelScale)`（levelScale=4），钳到 [1,5]。校准基线（三站实测）：主标题 5、大图 5、小节标题 4、正文段落 3、导航/装饰 1-2。

**body 标记**（article 且有核心区间）：语义内容角色与聚类 para 在区间内 → body；
核心插图（质心在区间内且显示边长 ≥ 80px）→ body。列校验的豁免面：语义 `p`
（含 figcaption/自绘图注归位）不做列校验——图注常比正文列窄/偏移，实测微信图注
与 fixture 图注均会误杀；侧栏的 `p` 噪音由 y 区间挡住。列校验针对的是榜单/导航
常见的 li/td/heading/para。

## 7. 参数总表

全部默认值见 `packages/core/src/layout/scoring.ts`（`DEFAULT_SCORING_PARAMS` / `DEFAULT_SCORING_FALLBACKS`），每个字段带注释。分组概览：

| 组 | 字段 | 默认 | 校准依据 |
|---|---|---|---|
| cluster | bodyClusterCharsRatio / bodyClusterCentroidMaxY / paraMinChars / longParaChars | 0.4 / 0.5 / 10 / 40 | 三站文章页调出，兜住 feed 式短句簇；40 ≈ 尾部讨论框短句与正文长段的分界 |
| textWeights | font / weight / cluster / length / centrality | .34/.06/.26/.16/.18 | 标题 5 / 正文 3 / 噪音 ≤2 的实测分布 |
| heading | base / sizeGain / weightGain | 0.4 / 0.8 / 0.15 | h2(1.5×) ≈ 0.75 → level 4 |
| image | areaRefSide / areaWeight / centralityWeight / centralityPenalty / coreImgMinSide | 240 / .55 / .45 / .6 / 80 | 640×360 配图 ≈ 5 分 |
| overlay | zIndexThreshold / importanceFloor | 10 / 0.55 | 掘金/知乎弹窗实测 zIndex ≥ 10 |
| normalization | lengthRefChars / weightRefDelta | 60 / 300 | 一句话摘要≈0.4 分、bold≈+0.2 |
| edge | topBandRatio / bottomBandRatio / centerWeight / edgeWeight | .08 / .12 / .6 / .4 | 常规导航条高度占比 |
| decorative | colorRarityMin / centralityMax / decay | 0.75 / 0.3 / 0.6 | 广告角标实测掉半档 |
| linkList | minNodes / minDistinctHrefs | 3 / 3 | 热榜/推荐位模块 ≥3 条互证；导航/页脚不达门槛 |
| caption | maxGapPx / maxChars | 40 / 60 | 图注距图 3-30px、正文段 > 50px，取中；短文本才算图注 |
| levelScale | — | 4 | importance 0.75 → level 4 |

## 8. 校准方法（改权重的工作流）

**禁止盲调**。任何参数变更必须走：

1. `pnpm exec tsx packages/core/scripts/ir-golden.mts` —— fixture 金样回归（确定性 data: URL，逐字节 diff）。七个用例覆盖：语义标签页、混排/浮层/装饰页、无语义启发式页、feed 页、figcaption 图注页、自绘图注页、feed+热榜链接列表页。**article 用例零 diff 是硬门槛**。
2. `pnpm exec tsx packages/mcp/scripts/ir-regression.mts` —— 线上快照对照（role/body/level 偏移 + importance 容差）。先 `capture` 建基线，改动后 diff。
3. 有意的行为变更：先跑 `--update` 重录金样并说明理由（写入 PR），再重采线上基线。

**新增 fixture 的原则**：每个新启发式分支至少一个 fixture；fixture 用 data: URL（不依赖网络）；样式写在页面内（确定性）。例外：需要图片几何参与判定的 fixture（如图注）不能用 data: URI——`emitImg` 有意跳过 data: 源，用 `*.invalid` 域名的 fail-fast 占位 URL 代替（元素盒仍由 CSS 决定，网络请求秒失败）。

## 9. Profile 可调面（`profile.layout`）及取舍

只开放 **一个模式开关 + 少量场景阈值**：

| 字段 | 作用 | 何时需要调 |
|---|---|---|
| `pageType` | article / feed / list 模式开关 | 列表页、信息流页声明 feed/list |
| `minSize` / `maxNodes` / `textMax` / `viewportMargin` | 浏览器采集侧直通 | 超长页缩小范围、虚拟滚动容器 |
| `bodyClusterMinRatio` | 覆盖 cluster.bodyClusterCharsRatio | 正文簇文本量被推荐位稀释的站点 |
| `coreImgMinSide` | 覆盖 image.coreImgMinSide | 缩略图为主的内容站 |

**不开放**：textWeights / heading / edge / decorative 等合成权重。理由：这些权重彼此耦合（level 分布是全体权重的函数），单点暴露会造成"每个站点一套权重、无从校准"的失控面；场景差异实测集中在上述两个阈值，其余靠 pageType 模式吸收。确实需要新旋钮时，先加 fixture + 线上基线证明现状不可覆盖，再进 schema。

## 10. 已知边界与待定语义

- **tagless 页的 role 归位是启发式**：无语义标签时 heading/para/other 由字号/聚类推断（`meta.inferred`），错误归类只影响投影展示，不破坏 IR 结构。
- **主标题选择**：取"正文起点之上字号最大者"——多 h1 模板页可能选到横幅字，暂无消歧信号。
- **被删的死分支语义待定**：旧启发式 para 的尺寸门槛曾有 `ownText.length >= 2 ? minSize : 24` 的三元式，`else` 分支不可达，原意（更小的门槛？）无记录，已删除；若未来发现需要更细门槛，需重新校准。
- **多趟采集中间态去重按内容键**（src/rect），同图不同裁剪会各出一个节点。
- **zIndex 地板对 fixed 悬浮工具条同样生效**：内容误判为"浮层"抬分——目前以 zIndex ≥ 10 区分（工具条常见 1-9），极端样式站点需 profile remove 兜底。
- **序列化边界**：往 `ExtractArgs` 加字段必须 JSON 可序列化（禁函数/Infinity/模块常量）；`viewportMargin` 用 `null` 表整页。
