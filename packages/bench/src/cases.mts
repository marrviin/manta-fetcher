/**
 * bench 用例定义（硬编码常量，eval-fidelity 风格）。
 * --url 可在命令行覆盖某个 case 的 URL。
 * redirect 型：url 是中转源列表页，运行时经 linkSourceProfile 的会话解析出最终页
 * （微信文章 URL 带 signature 短效，无法硬编码），失败则 case 标 skipped。
 *
 * 产品边界（2026-10 定）：manta 的目标是**内容平台的文章页/内容页**（掘金、36kr、雪球、
 * 少数派、澎湃、微信公众号等），不是通用整页抽取工具。用例按此分两组：
 *   - 目标语料：内容平台文章页/内容页（含 profile 主路径 + generic 对照）；
 *   - 非目标参考：文档站/仓库页/极简博客等，仅留作背景参考，不驱动适配决策（已注释）。
 */
export interface BenchCase {
  name: string;
  url: string;
  /** 最终页采集用的 profile；null = generic（effectiveProfile(null)） */
  profileName: string | null;
  kind: 'direct' | 'redirect';
  /** 用例考察点（报告可读性用，不参与运行） */
  note?: string;
  /** redirect 型：用该 profile 的会话打开 url 并跟随跳转（engine.resolveRedirect） */
  linkSourceProfile?: string;
  /** redirect 型：从列表 IR 中挑中转链的匹配片段 */
  linkPattern?: string;
  /** redirect 型：最终 URL 必须命中该正则，否则 case 标 skipped */
  finalUrlPattern?: string;
  /** 覆盖 effectiveProfile 缺省的导航等待策略（被墙字体拖住 load 事件的站点用 domcontentloaded） */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  /** 覆盖 effectiveProfile 缺省的 goto 超时 ms */
  timeoutMs?: number;
}

export const BENCH_CASES: BenchCase[] = [
  // ===== 目标语料：内容平台文章页/内容页 =====
  // 有 profile 的主路径用例：
  { name: 'juejin-article', url: 'https://juejin.cn/post/7637856870833635343', profileName: 'juejin', kind: 'direct', note: '目标：技术社区文章页（profile 主路径）' },
  { name: 'aibase-article', url: 'https://news.aibase.com/zh/news/31702', profileName: 'aibase-article', kind: 'direct', note: '目标：AI 资讯站文章页（profile 主路径）' },
  { name: 'aibase-list', url: 'https://news.aibase.com/zh/news', profileName: 'aibase-news', kind: 'direct', note: '目标：AI 资讯站列表页（profile 主路径）' },
  {
    name: 'weixin-article',
    url: 'https://weixin.sogou.com/weixin?type=2&query=ai',
    profileName: 'weixin-article',
    kind: 'redirect',
    linkSourceProfile: 'sogou-weixin',
    linkPattern: '/link?url=',
    finalUrlPattern: 'mp\\.weixin\\.qq\\.com',
    note: '目标：微信公众号图文（搜狗中转）',
  },
  // generic 对照组（同为目标站点，量化 profile 增益与通用层对目标站型的裸表现）：
  { name: 'juejin-generic', url: 'https://juejin.cn/post/7637856870833635343', profileName: null, kind: 'direct', note: '同 juejin-article 但无 profile：直接量化 profile 增益' },
  { name: 'sspai-post', url: 'https://sspai.com/post/73145', profileName: null, kind: 'direct', note: '目标：中文图文长文（少数派）' },
  { name: 'thepaper-news', url: 'https://www.thepaper.cn/newsDetail_forward_34269605', profileName: null, kind: 'direct', note: '目标：中文新闻文章页（澎湃）' },
  { name: '36kr-article', url: 'https://www.36kr.com/p/4023705686757506', profileName: null, kind: 'direct', note: '目标：36kr 文章页（客户端渲染站的文章页）' },
  { name: 'xueqiu-article', url: 'https://www.xueqiu.com/1767952205/412111795', profileName: null, kind: 'direct', note: '目标：雪球长文帖（投资者社区）' },
  // ===== 非目标参考（不驱动适配决策，仅背景对照；工件仍在缓存可复评）=====
  // { name: 'generic', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript', profileName: null, kind: 'direct', note: '文档站 generic 基准' },
  // { name: 'py-docs-classes', url: 'https://docs.python.org/3/tutorial/classes.html', profileName: null, kind: 'direct', note: '教程文档：长页多级标题+代码块' },
  // { name: 'react-docs-learn', url: 'https://react.dev/learn', profileName: null, kind: 'direct', note: '现代文档站：SPA 导航+侧栏噪音' },
  // { name: 'ts-handbook-basic-types', url: 'https://www.typescriptlang.org/docs/handbook/2/basic-types.html', profileName: null, kind: 'direct', note: '文档站：代码示例密集', waitUntil: 'domcontentloaded', timeoutMs: 60000 },
  // { name: 'pg-greatwork', url: 'https://paulgraham.com/greatwork.html', profileName: null, kind: 'direct', note: '长文随笔：极简样式纯文本页' },
  // { name: 'martinfowler-strangler', url: 'https://martinfowler.com/bliki/StranglerFigApplication.html', profileName: null, kind: 'direct', note: '技术文章：老式 HTML+内链密集' },
  // { name: 'overreacted-conway', url: 'https://overreacted.io/how-i-vibed-a-proof-of-conways-conjecture/', profileName: null, kind: 'direct', note: '技术博客：数学推导+多级 markdown 结构', waitUntil: 'domcontentloaded', timeoutMs: 60000 },
  // { name: 'rust-blog-people-love', url: 'https://blog.rust-lang.org/2025/12/19/what-do-people-love-about-rust/', profileName: null, kind: 'direct', note: '官方博客：调查报告+引用块' },
  // { name: 'github-ts-repo', url: 'https://github.com/microsoft/TypeScript', profileName: null, kind: 'direct', note: '仓库页：README 内嵌于重 UI 容器' },
  // 36kr-news-list 暂缓：三次采集均失败——generic goto 后页面在 collect 阶段发生客户端导航
  // （execution context destroyed），疑似反爬重定向；且残留页面会卡住 pool.close()。
  // 文章页（36kr-article）是否复现待测；列表页暂不进入目标语料。
  // { name: '36kr-news-list', url: 'https://36kr.com/information/web_news/', profileName: null, kind: 'direct', note: '压力用例：客户端渲染信息流列表页' },
];
