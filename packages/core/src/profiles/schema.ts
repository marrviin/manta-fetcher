import { z } from 'zod';

/** 声明式动作：滚动加载 / 点击 / 等待 */
export const ActionSchema = z.union([
  z.object({
    scroll: z
      .object({
        maxScrolls: z.number().int().min(1).optional(),
        delayMs: z.number().int().min(50).optional(),
      })
      .optional(),
  }),
  z.object({
    click: z.object({ selector: z.string() }).optional(),
  }),
  z.object({
    wait: z
      .union([z.object({ ms: z.number().int().min(0) }), z.object({ selector: z.string() })])
      .optional(),
  }),
]);
export type ProfileAction = z.infer<typeof ActionSchema>;

const NavigationSchema = z.object({
  /**
   * "load" | "domcontentloaded" | "networkidle" | "commit"
   * 或 "visible:<css选择器>" / "ms:<毫秒>"（goto 后追加等待）
   */
  waitUntil: z.string().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  userAgent: z.string().optional(),
  viewport: z.object({ width: z.number().int(), height: z.number().int() }).optional(),
  locale: z.string().optional(),
  /**
   * 浏览器后端：cdp:<endpoint> —— 连接用户真实 Chrome（需以 --remote-debugging-port 启动），
   * 用于传输指纹级反爬站点。连接对端无法指定 UA/viewport（以真实浏览器为准）。
   */
  browser: z.string().optional(),
});

/** 单个字段：标量选择器，或带 fields 子字段的对象列表 */
export interface StructuredField {
  selector: string;
  multiple?: boolean;
  /** 取属性而非 textContent，如 "href" */
  attribute?: string;
  /** 最多取前 N 个（配合 multiple，如热榜前 3） */
  limit?: number;
  /** 嵌套子字段：以当前元素为作用域解析，输出对象 */
  fields?: Record<string, StructuredField>;
}

export const StructuredFieldSchema: z.ZodType<StructuredField> = z.lazy(() =>
  z.object({
    selector: z.string(),
    multiple: z.boolean().optional(),
    attribute: z.string().optional(),
    limit: z.number().int().positive().optional(),
    fields: z.record(z.string(), StructuredFieldSchema).optional(),
  }),
);

/** 组合编排声明：列表页 → N 个详情页。由引擎通用实现，生成 fetch_<site>_items 组合工具 */
export const CompositeSpecSchema = z.object({
  detailProfile: z.string().min(1),
  urlField: z.string().optional(),
  detailLimit: z.number().int().positive().optional(),
  tool: z.string().optional(),
  /**
   * 列表字段属性：相对 URL 时以列表页 URL 为 base 绝对化（缺省 true）
   */
  absolutizeUrl: z.boolean().optional(),
  /**
   * 详情 URL 是会话级中转链（需同会话 JS 跳转到真实地址）时，
   * 在列表页同一 context 中打开跟随跳转，取最终 URL 交给 detailProfile 抓正文
   */
  resolveRedirect: z.boolean().optional(),
});
export type CompositeSpec = z.infer<typeof CompositeSpecSchema>;

export const SiteProfileSchema = z.object({
  /** 站点标识，同时决定 auth/<name>.storage.json 与工具名 fetch_<name> */
  name: z.string().min(1),
  description: z.string().optional(),
  /** URL 匹配模式，* 匹配任意字符，如 "https://example.com/post/*" */
  match: z.array(z.string()).default([]),
  /** 可选的 JS Adapter 模块路径（相对 profile 文件），提供 prepare()/overrides */
  adapter: z.string().optional(),

  navigation: NavigationSchema.optional(),
  actions: z.array(ActionSchema).optional(),

  extraction: z
    .object({
      /** 正文定位选择器；缺省时走内置通用启发式 */
      mainContent: z.string().optional(),
      /** 在正文范围内移除的元素 */
      remove: z.array(z.string()).optional(),
      /** 标题选择器，缺省用第一个 h1 或 document.title */
      title: z.string().optional(),
    })
    .optional(),

  /**
   * IR 布局管线的场景差异（缺省全部走引擎默认值，见 docs/layout-methodology.md）。
   * 只开放模式开关 + 差异最大的两个阈值；其余评分参数留在引擎层不开放调参面
   */
  layout: z
    .object({
      /** 页面形态：article=文章正文（计算核心内容区间）；feed/list=信息流/列表页（跳过核心区间，body 由语义角色直接标记） */
      pageType: z.enum(['article', 'feed', 'list']).default('article'),
      /** 内容节点最小边长 px（引擎缺省 10） */
      minSize: z.number().int().min(1).optional(),
      /** 节点上限（引擎缺省 3000） */
      maxNodes: z.number().int().min(1).optional(),
      /** 文本截断长度，0 = 不截断（引擎缺省 0） */
      textMax: z.number().int().min(0).optional(),
      /** 视口外采集边距 px；null = 整页（引擎缺省整页，YAML 无法表达 Infinity） */
      viewportMargin: z.number().int().min(0).nullable().optional(),
      /** 正文聚类准入比例（覆盖 cluster.bodyClusterCharsRatio，引擎缺省 0.4） */
      bodyClusterMinRatio: z.number().min(0).max(1).optional(),
      /** 核心插图最小边长 px（覆盖 image.coreImgMinSide，引擎缺省 80） */
      coreImgMinSide: z.number().int().min(1).optional(),
    })
    .optional(),

  markdown: z
    .object({
      /** 标题层级偏移：2 表示正文里的 h1 输出为 ### */
      headingOffset: z.number().int().min(0).max(5).optional(),
    })
    .optional(),

  images: z
    .object({
      /** keep-url: 保留原始 URL；download: 下载到本地并重写；inline: 小图内联 base64 */
      mode: z.enum(['keep-url', 'download', 'inline']).optional(),
      saveDir: z.string().optional(),
      inlineMaxBytes: z.number().int().positive().optional(),
    })
    .optional(),

  auth: z
    .object({
      /** 登录态文件；缺省 auth/<name>.storage.json */
      storageState: z.string().optional(),
      /** 该场景必须登录：无登录态时 fetch 直接失败并提示调用 login_<site> */
      required: z.boolean().optional(),
      /** 登录入口 URL（login_<site> 打开有头浏览器访问的地址，缺省用页面 URL 本身） */
      loginUrl: z.string().optional(),
      /** 登录成功判定：URL 匹配该正则/子串；缺省为"离开起始页后回到同站非登录页" */
      successUrl: z.string().optional(),
      /** 运行时登录检测：抓取后 URL 命中该正则视为登录态失效（如被重定向到登录页） */
      loginRedirect: z.string().optional(),
      /** 会话 cookie 名（逗号分隔）：存在任一即判定登录成功，比 URL 启发式可靠（如 "sessionid,sessionid_ss"） */
      sessionCookie: z.string().optional(),
    })
    .optional(),

  /** 结构化字段抽取，随 structuredContent 返回；支持嵌套子字段（列表抽成对象数组） */
  structured: z
    .object({
      fields: z.record(z.string(), StructuredFieldSchema),
    })
    .optional(),

  /** 组合编排：列表页 → N 个详情页，生成 fetch_<site>_items 组合工具 */
  composite: CompositeSpecSchema.optional(),
});

export type SiteProfile = z.infer<typeof SiteProfileSchema>;

/** JS Adapter 约定（.js/.mjs 文件 default export） */
export interface ProfileAdapter {
  /** 覆盖/补充 yaml 中的声明式配置 */
  overrides?: Partial<SiteProfile>;
  /** 复杂交互钩子：在等待与声明式 actions 之后、抽取之前执行 */
  prepare?: (page: import('playwright').Page, ctx: { url: string }) => Promise<void>;
}

export interface LoadedProfile {
  def: SiteProfile;
  /** MCP 工具名，如 fetch_<site> */
  toolName: string;
  /** 登录工具名，如 login_<site> */
  loginToolName: string;
  filePath: string;
  mtime: number;
  prepare?: ProfileAdapter['prepare'];
}
