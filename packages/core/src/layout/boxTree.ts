/**
 * 页面内容 IR v3（enriched layout）：
 * 采集固定产出的唯一数据结构——块级内容节点（role + 行内 runs + 坐标/字号/颜色）+ 图片节点，
 * DOM 语义优先（h1-h6/p/li/pre/blockquote/th/td），无语义标签的页面用字号聚类启发式兜底
 * （meta.inferred 标记）。重要性评分与核心区间算法沿用 v2，作用对象从叶子文本节点升级为块节点。
 *
 * 该 IR 是后续一切投影（markdown / text 视图 / 视觉预览）的源数据，采集端保证：
 * - 行内结构无损：链接 href、加粗、行内代码都记在 runs 里，段落不再被切碎；
 *   p/para 块内的 <br> 视为段落边界（站点用 <br> 在无 <p> 容器里分段，每段独立成节点）
 * - 语义无损：role 来自真实标签，启发式只做兜底
 * - 空间无损：rect 为页面绝对坐标，暖场滚动保证懒加载图片的盒子已撑开
 */
import type { Page } from "playwright";
import {
  DEFAULT_SCORING_FALLBACKS,
  DEFAULT_SCORING_PARAMS,
  type ScoringFallbacks,
  type ScoringParams,
} from "./scoring.js";

/** 行内片段：块内一段带标记的文本 */
export interface InlineRun {
  t: string;
  /** 链接地址 */
  href?: string;
  /** 行内代码 */
  code?: boolean;
  /** 加粗 */
  bold?: boolean;
  /** 斜体 */
  italic?: boolean;
}

/** 节点语义角色：DOM 事实（h1-h6/p/li/pre/blockquote/th/td/img）或启发式兜底（heading/para/other） */
export type NodeRole =
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "heading"
  | "p"
  | "para"
  | "li"
  | "pre"
  | "blockquote"
  | "th"
  | "td"
  | "img"
  | "other";

/** role 差异字段统一收口（主体字段所有节点一致，差异字段只出现在这里；缺省该字段整体不出现） */
export interface NodeMeta {
  /** li: 有序/无序 */
  ordered?: boolean;
  /** li: 嵌套层级（1 起） */
  depth?: number;
  /** th/td: 表格坐标（rowspan/colspan 未展开） */
  row?: number;
  col?: number;
  /** pre: 语言标注（class 里的 language-xxx） */
  lang?: string;
  /** img: 替代文本 */
  alt?: string;
  /** img: 原始尺寸 [w, h] */
  naturalSize?: [number, number];
  /** 文本块：原始行高（px）——预览按原页行距渲染，避免字体差异导致折行估算偏差 */
  lineH?: number;
  /** role 由启发式推断而非 DOM 事实 */
  inferred?: boolean;
}

export interface LayoutNode {
  /** [x, y, w, h]，页面绝对坐标（含滚动偏移） */
  rect: [number, number, number, number];
  role: NodeRole;
  /** 内容载荷（与 img 二选一）：块内行内片段序列 */
  runs?: InlineRun[];
  /** 内容载荷（与 runs 二选一）：图片绝对 URL */
  img?: string;
  /** 字号 px（文本块） */
  fontSize?: number;
  /** 原始颜色 hex（文本块） */
  color?: string;
  /** 字重（400 正常 / 700 加粗，取自 computed style） */
  fontWeight?: number;
  /** 核心内容标记（主标题/小节标题/正文段落/核心插图） */
  body?: boolean;
  /** 重要性 0~1 */
  importance: number;
  /** 重要性等级 1~5（5 最重要） */
  level: number;
  /** 浮层层级（zIndex>0 的浮层节点才输出；弹窗/悬浮控件等脱离文档流的元素） */
  zIndex?: number;
  meta?: NodeMeta;
}

export interface PageLayout {
  viewport: [number, number];
  docHeight: number;
  /** 是否触达节点上限截断 */
  truncated?: boolean;
  /** 内容节点扁平列表，按阅读顺序（y 升序、x 次序） */
  nodes: LayoutNode[];
}

export interface LayoutOptions {
  /** 内容节点最小边长（px，缺省 10） */
  minSize?: number;
  /** 节点上限（缺省 3000；IR 作为源数据不允许静默截断，超出会带 truncated 标记） */
  maxNodes?: number;
  /** 文本截断长度（0 = 不截断，缺省 0 输出完整文本） */
  textMax?: number;
  /** 采集视口外多远的盒子（px，缺省 Infinity 整页；可传数值缩小范围） */
  viewportMargin?: number;
}

/** 浏览器端抽取参数（profile 的定位/裁剪规则在 walk 前生效） */
export interface ExtractArgs extends LayoutOptions {
  mainContent?: string;
  remove?: string[];
  titleSelector?: string;
  /** 懒加载图片的真实 src 属性候选（按序取第一个非空值；缺省用 emitImg 内置表） */
  lazyImgAttrs?: string[];
}

export interface ExtractResult {
  title: string;
  url: string;
  layout: PageLayout;
}

/** 行内文本 run：块内文本片段 + 折叠的行内样式 flags */
export interface RawRun {
  t: string;
  href?: string;
  code?: boolean;
  bold?: boolean;
  italic?: boolean;
}

/** 浏览器采集的原始节点（未评分） */
export interface RawNode {
  rect: [number, number, number, number];
  role: NodeRole;
  runs?: RawRun[];
  fontSize?: number;
  color?: string;
  fontWeight?: number;
  img?: string;
  alt?: string;
  naturalSize?: [number, number];
  cx: number;
  cy: number;
  area: number;
  zIndex: number;
  meta?: NodeMeta;
}

/** 浏览器采集（含虚拟滚动多趟合并去重）产出，交给 Node 侧 enrichLayout 评分 */
export interface RawPass {
  title: string;
  url: string;
  viewport: [number, number];
  docHeight: number;
  truncated?: boolean;
  /** 实际采集趟数（>1 表示内部滚动容器多趟采集） */
  passes: number;
  raw: RawNode[];
}

/**
 * IR 采集前的页面预热：滚动到底触发懒加载，预算内等图片加载完成，再回顶。
 * 不预热的话，懒加载图片在采集时 src 未就绪/盒子未撑开（缺失、rect 塌陷）。
 * 收敛式多趟：懒加载会把页面撑高/分批渲染，单趟滚不到尾部、单次不等内容稳定——
 * 反复滚动直到（文档高度稳定 且 占位图 src 收敛）或预算/趟数耗尽。
 * 内部滚动容器页面（window 不滚）从 mainContent 起向上找真实滚动容器预热。
 */
export async function warmPageForLayout(
  page: Page,
  budgetMs = 8000,
  mainContent?: string,
): Promise<void> {
  await page.evaluate(
    async ({ budget, mc }) => {
      const g = globalThis as unknown as Record<string, unknown>;
      if (typeof g.__name !== "function") g.__name = (fn: unknown) => fn;
      // 从 mainContent（缺省 body）向上找真实滚动容器；找不到 = window 滚动页面
      let start: Element | null = null;
      if (mc) {
        try {
          start = document.querySelector(mc);
        } catch {
          start = null;
        }
      }
      let container: HTMLElement | null = null;
      for (
        let e: Element | null = start ?? document.body;
        e && e !== document.body && e !== document.documentElement;
        e = e.parentElement
      ) {
        const cs = window.getComputedStyle(e);
        const he = e as HTMLElement;
        if (
          /(auto|scroll)/.test(cs.overflowY) &&
          he.scrollHeight > he.clientHeight + 8
        ) {
          container = he;
          break;
        }
      }
      const step = container ? container.clientHeight : window.innerHeight;
      const docHeight = (): number =>
        container
          ? container.scrollHeight
          : document.documentElement.scrollHeight;
      // 占位 src：未加载（空/data:/blob:）或水合前的 SSR 模板串
      // （模板串被浏览器按相对 URL 解析后仍含引号等非法 URL 字符，如 src="'.concat(l["a],'…"）
      const junkImgs = (): number =>
        Array.from(document.images).filter((im) => {
          const s = im.src;
          return (
            !s ||
            s.startsWith("data:") ||
            s.startsWith("blob:") ||
            s.includes("'") ||
            s.includes('"')
          );
        }).length;
      const sleep = (ms: number) =>
        new Promise((r) => setTimeout(r, ms));

      const t0 = Date.now();
      let prevHeight = -1;
      let prevJunk = -1;
      for (let pass = 0; pass < 4 && Date.now() - t0 < budget; pass++) {
        // 一趟滚动：以实时 scrollHeight 为界（懒加载在滚动途中撑高页面也能滚到）
        for (let y = 0; ; y += step) {
          if (container) container.scrollTop = y;
          else window.scrollTo(0, y);
          await sleep(120);
          if (y >= docHeight() || Date.now() - t0 > budget) break;
        }
        // 等已发起加载的图片完成
        while (Date.now() - t0 < budget) {
          const pending = Array.from(document.images).filter(
            (im) => im.src && !im.complete,
          ).length;
          if (!pending) break;
          await sleep(250);
        }
        // 等占位 src 收敛：数量归零，或连续 2 轮不再减少（站点压根不水合时的边界）
        let junkBefore = -1;
        let stableRounds = 0;
        while (Date.now() - t0 < budget && stableRounds < 2) {
          const junk = junkImgs();
          if (!junk) break;
          if (junk === junkBefore) stableRounds++;
          else stableRounds = 0;
          junkBefore = junk;
          await sleep(300);
        }
        // 收敛判定：高度稳定 且 占位图不再减少 → 再滚也不会有新内容
        const h = docHeight();
        const junk = junkImgs();
        if (h === prevHeight && junk === prevJunk) break;
        prevHeight = h;
        prevJunk = junk;
      }
      if (container) container.scrollTop = 0;
      else window.scrollTo(0, 0);
    },
    { budget: budgetMs, mc: mainContent },
  );
  await page.waitForTimeout(300); // 回顶后让布局稳定
}

/**
 * 在浏览器上下文执行（page.evaluate）。注意约束：
 * - 函数体内不能有命名函数声明（tsx keepNames 注入 __name 导致浏览器报错），一律 const 箭头函数
 * - 模块级常量必须内联进函数体（evaluate 只序列化函数本身）
 * - async：内部滚动容器的虚拟滚动页面按视口高度多趟扫描，滚动位置异步重挂内容后逐趟采集，
 *   seen 去重合并（同一元素多趟重挂只记一次），pageY 用 r.top + window.scrollY + 容器 scrollTop 归一
 */
export const collectLayoutFn = async (args: ExtractArgs): Promise<RawPass> => {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.__name !== "function") g.__name = (fn: unknown) => fn;

  const minSize = args.minSize ?? 10;
  const maxNodes = args.maxNodes ?? 3000;
  const textMax = args.textMax ?? 0; // 0 = 不截断
  const margin = args.viewportMargin ?? Infinity;

  // 块级标签：walk 遇到即按语义/独立块处理，行内序列化时会跳过这些子树（由 walk 单独负责）
  const BLOCKISH = new Set(
    (
      "P DIV UL OL LI TABLE PRE BLOCKQUOTE H1 H2 H3 H4 H5 H6 SECTION ARTICLE " +
      "TD TH TR THEAD TBODY FIGURE FIGCAPTION"
    ).split(" "),
  );
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "SVG",
    "LINK",
    "META",
  ]);
  const H_ROLE: Record<string, NodeRole> = {
    H1: "h1",
    H2: "h2",
    H3: "h3",
    H4: "h4",
    H5: "h5",
    H6: "h6",
    P: "p",
    LI: "li",
    PRE: "pre",
    BLOCKQUOTE: "blockquote",
    TH: "th",
    TD: "td",
    // 图注是语义标签而非启发式段落：按 inferred para 归位时不在正文聚类里会被
    // 整段硬丢（实测微信文章图注全漏）；语义角色在核心区间内直接标 body
    FIGCAPTION: "p",
  };

  const cleanText = (s: string): string => s.replace(/[\t\n\r ]+/g, " ");

  // 语义块内出现这些后代（图片/嵌套块）时，块 rect 改用纯文本盒：元素 rect 会罩住
  // 后代内容（<p>文本+img、<li>内嵌 ul 很常见），与 walk 单独发射的 img/子块节点重叠
  const MIXED_SEL = "img, " + [...BLOCKISH].map((t) => t.toLowerCase()).join(", ");

  // 纯文本盒：与 inlineRuns 同规则跳过图片/块级子树，文本节点 Range rects 取并集
  const textRectOf = (el: Element): DOMRect | null => {
    const rg = document.createRange();
    const boxes: DOMRect[] = [];
    const collect = (node: Node): void => {
      if (node.nodeType === 3) {
        rg.selectNodeContents(node);
        for (const q of Array.from(rg.getClientRects())) {
          if (q.width > 0 || q.height > 0) boxes.push(q);
        }
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = (node as Element).tagName;
      if (SKIP_TAGS.has(tag) || tag === "IMG" || BLOCKISH.has(tag)) return;
      for (const c of Array.from(node.childNodes)) collect(c);
    };
    for (const c of Array.from(el.childNodes)) collect(c);
    if (!boxes.length) return null;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const q of boxes) {
      l = Math.min(l, q.left);
      t = Math.min(t, q.top);
      r = Math.max(r, q.right);
      b = Math.max(b, q.bottom);
    }
    if (l === Infinity) return null;
    return {
      left: l,
      top: t,
      width: r - l,
      height: b - t,
    } as DOMRect;
  };

  const absUrl = (href: string): string => {
    try {
      return new URL(href, document.baseURI).href;
    } catch {
      return href;
    }
  };

  // 段级文本盒：BR 分段的段落没有自己的元素盒，用段内文本节点 Range rects 取并集；
  // 同时返回去重后的行 top 序列（行高兜底估算用）。无可见盒返回 null。
  const segRectOf = (
    textNodes: Node[],
  ): { rect: DOMRect; tops: number[] } | null => {
    const rg = document.createRange();
    let l = Infinity,
      t = Infinity,
      r = -Infinity,
      b = -Infinity;
    const tops: number[] = [];
    for (const node of textNodes) {
      rg.selectNodeContents(node);
      for (const q of Array.from(rg.getClientRects())) {
        if (q.width <= 0 && q.height <= 0) continue;
        l = Math.min(l, q.left);
        t = Math.min(t, q.top);
        r = Math.max(r, q.right);
        b = Math.max(b, q.bottom);
        const qt = Math.round(q.top);
        if (!tops.some((x) => Math.abs(x - qt) <= 3)) tops.push(qt);
      }
    }
    if (l === Infinity) return null;
    tops.sort((a, b2) => a - b2);
    return {
      rect: { left: l, top: t, width: r - l, height: b - t } as DOMRect,
      tops,
    };
  };

  // ================= 行内序列化：块内文本 → 分段 runs =================
  // 块级子树跳过（walk 会单独处理），IMG 跳过（单独成节点），A/CODE/B/EM 折叠成 flags。
  // BR 是段落边界：站点常用 <br> 在无 <p> 的容器里分段（实测雪球正文是"裸文本+<br>"），
  // 按段返回（runs + 段内文本节点，供段级文本盒取坐标）；无 BR 的块只有一段，行为不变。
  type InlineSeg = { runs: RawRun[]; textNodes: Node[] };

  const inlineSegments = (root: Element, throughBlocks = false): InlineSeg[] => {
    const segs: InlineSeg[] = [];
    let cur: InlineSeg = { runs: [], textNodes: [] };
    const flush = (): void => {
      if (cur.runs.length) segs.push(cur);
      cur = { runs: [], textNodes: [] };
    };
    const push = (t: string, f: RawRun, node: Node): void => {
      if (!t) return;
      if (!cur.textNodes.includes(node)) cur.textNodes.push(node);
      const last = cur.runs[cur.runs.length - 1];
      if (
        last &&
        last.href === f.href &&
        last.code === f.code &&
        last.bold === f.bold &&
        last.italic === f.italic
      ) {
        last.t += t;
      } else {
        cur.runs.push({
          t,
          href: f.href,
          code: f.code,
          bold: f.bold,
          italic: f.italic,
        });
      }
    };
    const visit = (node: Node, f: RawRun): void => {
      if (node.nodeType === 3) {
        push(cleanText(node.textContent || ""), f, node);
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node as Element;
      const tag = el.tagName;
      // 块级/图片由外层处理；throughBlocks 模式（td/th：富文本单元格文本常包在 div 里）仍深入，
      // 但嵌套 TABLE 交给 walk 单独接管，避免外层 td 吸入嵌套表格文本造成重复
      if (SKIP_TAGS.has(tag) || tag === "IMG") return;
      if (BLOCKISH.has(tag) && (!throughBlocks || tag === "TABLE")) return;
      if (tag === "BR") {
        flush();
        return;
      }
      const nf: RawRun =
        tag === "A"
          ? { ...f, href: absUrl(el.getAttribute("href") || f.href || "") }
          : tag === "CODE" || tag === "KBD" || tag === "SAMP"
            ? { ...f, code: true }
            : tag === "B" || tag === "STRONG"
              ? { ...f, bold: true }
              : tag === "EM" || tag === "I"
                ? { ...f, italic: true }
                : f;
      for (const child of Array.from(el.childNodes)) visit(child, nf);
    };
    for (const child of Array.from(root.childNodes)) visit(child, { t: "" });
    flush();
    // 每段独立归一：去掉首尾空白、同 flags 相邻 run 接缝处补空格，空段丢弃
    const out: InlineSeg[] = [];
    for (const seg of segs) {
      const runs: RawRun[] = [];
      for (const r of seg.runs) {
        r.t = r.t.replace(/^ +| +$/g, "");
        if (!r.t) continue;
        const last = runs[runs.length - 1];
        if (
          last &&
          last.href === r.href &&
          last.code === r.code &&
          last.bold === r.bold &&
          last.italic === r.italic
        ) {
          last.t +=
            (last.t.endsWith(" ") || r.t.startsWith(" ") ? "" : " ") + r.t;
        } else {
          runs.push(r);
        }
      }
      if (runs.length) out.push({ runs, textNodes: seg.textNodes });
    }
    if (out.length && textMax > 0) {
      // 截断预算跨段连续消耗（与旧单块语义一致）
      let budget = textMax;
      for (const seg of out) {
        for (const r of seg.runs) {
          if (budget <= 0) {
            r.t = "";
            continue;
          }
          if (r.t.length > budget) r.t = r.t.slice(0, budget);
          budget -= r.t.length;
        }
      }
    }
    return out;
  };

  const inlineRuns = (root: Element, throughBlocks = false): RawRun[] =>
    inlineSegments(root, throughBlocks).flatMap((s) => s.runs);

  // ================= 采集 =================
  // 多趟滚动归一坐标：r.top 已含容器滚动量，补 window.scrollY + 容器当前 scrollTop，
  // 使各趟采集的同一元素得到一致的"文档坐标"（趟内容器滚到哪都归一到顶部基准）
  let scrollContainer: HTMLElement | null = null;
  const scrollAdj = (): number =>
    window.scrollY + (scrollContainer ? scrollContainer.scrollTop : 0);

  const raw: RawNode[] = [];
  const seenImg = new Set<string>();
  const seenBlock = new Set<string>();
  let count = 0;
  let truncated = false;

  const toHex = (c: string): string => {
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return "#000000";
    return (
      "#" +
      [m[1], m[2], m[3]]
        .map((v) => Number(v).toString(16).padStart(2, "0"))
        .join("")
    );
  };

  // 图片节点：src 懒加载修正 + 绝对化，尺寸/alt 记入 meta
  const lazyImgAttrs = args.lazyImgAttrs ?? [
    "data-src",
    "data-original",
    "data-lazy-src",
    "data-actualsrc",
    "data-lazy",
  ];
  const emitImg = (el: Element): void => {
    const img = el as HTMLImageElement;
    let src = img.getAttribute("src") || "";
    if (!src || src.startsWith("data:")) {
      for (const a of lazyImgAttrs) {
        const v = el.getAttribute(a);
        if (v) {
          src = v;
          break;
        }
      }
    }
    if (!src || src.startsWith("data:")) return;
    try {
      src = new URL(src, document.baseURI).href;
    } catch {
      return;
    }
    if (seenImg.has(src)) return;
    seenImg.add(src);
    const r = el.getBoundingClientRect();
    const pageY = r.top + scrollAdj();
    const cs = window.getComputedStyle(el);
    raw.push({
      rect: [
        Math.round(r.left),
        Math.round(pageY),
        Math.round(r.width),
        Math.round(r.height),
      ],
      role: "img",
      img: src,
      alt: (img.getAttribute("alt") || "").trim() || undefined,
      naturalSize: [
        Math.round(img.naturalWidth || r.width),
        Math.round(img.naturalHeight || r.height),
      ],
      cx: r.left + r.width / 2,
      cy: pageY + r.height / 2,
      area: r.width * r.height,
      zIndex: parseInt(cs.zIndex, 10) || 0,
    });
    count++;
  };

  // 发射单个文本块节点（坐标换算/去重/链接下传/元数据/行高/评分载荷），返回是否发射。
  // emitBlock 的共用底层：单块路径与 BR 分段路径都走这里。
  const emitBlockNode = (
    el: Element,
    role: NodeRole,
    inferred: boolean,
    cs: CSSStyleDeclaration,
    runs: RawRun[],
    // 页面绝对坐标盒（调用方已换算 scrollAdj 或用元素盒）
    rect: { left: number; top: number; width: number; height: number },
    // 行高兜底估算的行 top 序列（BR 分段路径由 segRectOf 产出；缺省用元素 Range）
    lineHTops?: number[],
  ): boolean => {
    const r = rect;
    const pageY = r.top + scrollAdj();
    if (r.width < minSize || r.height < minSize) return false;
    const text = runs.map((x) => x.t).join("");
    if (!text.trim()) return false;
    // 多趟采集去重：归一坐标 + 全文一致的块只记一次（虚拟行卸载重挂后重采）
    const seenKey = `${role}|${text.slice(0, 120)}|${Math.round(r.left)},${Math.round(pageY)},${Math.round(r.width)},${Math.round(r.height)}`;
    if (seenBlock.has(seenKey)) return false;
    seenBlock.add(seenKey);
    // 块整体包在链接里（如卡片式列表项 <a><div>标题</div></a>）：祖先 href 下传给无自有 href 的 runs
    if (role !== "pre") {
      const anc = el.closest("a[href]");
      if (anc) {
        const ancHref = absUrl(anc.getAttribute("href") || "");
        for (const r of runs) if (!r.href) r.href = ancHref;
      }
    }
    const meta: NodeMeta = {};
    if (inferred) meta.inferred = true;
    if (role === "li") {
      meta.ordered = el.parentElement?.tagName === "OL";
      let depth = 0;
      let p: HTMLElement | null = el.parentElement;
      while (p) {
        if (p.tagName === "UL" || p.tagName === "OL") depth++;
        p = p.parentElement;
      }
      meta.depth = depth;
    }
    if (role === "th" || role === "td") {
      // tr.rowIndex / cell.cellIndex 为原生表格坐标（rowspan/colspan 未展开）
      meta.row = (el as HTMLTableCellElement).closest("tr")?.rowIndex ?? 0;
      meta.col = (el as HTMLTableCellElement).cellIndex ?? 0;
    }
    if (role === "pre") {
      // 语言标注优先取内部 <code> 的 class（不少站点把 language-xxx 标在 code 上）
      const codeCls = `${el.className || ""} ${el.querySelector("code")?.className || ""}`;
      const m = codeCls.match(/language-([\w-]+)/);
      if (m) meta.lang = m[1];
    }
    // 原始行高：优先 computed lineHeight（多数站点显式设置）；"normal" 时按行内 Range
    // 的逐行 rects 推（相邻 top 差即行高，过滤上下标等矮碎片），量不出则不记、预览走估算兜底
    let lineH = 0;
    const lhRaw = cs.lineHeight;
    if (lhRaw && lhRaw !== "normal") {
      lineH = Math.round(parseFloat(lhRaw)) || 0;
    } else if (lineHTops && lineHTops.length >= 2) {
      lineH = Math.round(
        (lineHTops[lineHTops.length - 1] - lineHTops[0]) /
          (lineHTops.length - 1),
      );
    } else {
      try {
        const rg = document.createRange();
        rg.selectNodeContents(el);
        const fs = parseFloat(cs.fontSize) || 14;
        const rects = Array.from(rg.getClientRects()).filter(
          (rr) => rr.width > 1 && rr.height > Math.max(6, fs * 0.75),
        );
        const tops: number[] = [];
        for (const rr of rects) {
          const t = Math.round(rr.top);
          if (!tops.some((x) => Math.abs(x - t) <= 3)) tops.push(t);
        }
        if (tops.length >= 2) {
          tops.sort((a, b) => a - b);
          lineH = Math.round(
            (tops[tops.length - 1] - tops[0]) / (tops.length - 1),
          );
        } else if (tops.length === 1) {
          lineH = Math.round(r.height);
        }
      } catch {
        // 非标准内容量不出行高：跳过
      }
    }
    if (lineH >= 4 && lineH <= r.height + 4) meta.lineH = lineH;
    raw.push({
      rect: [
        Math.round(r.left),
        Math.round(pageY),
        Math.round(r.width),
        Math.round(r.height),
      ],
      role,
      runs,
      fontSize: Math.round(parseFloat(cs.fontSize) || 14),
      color: toHex(cs.color),
      fontWeight: parseInt(cs.fontWeight, 10) || 400,
      cx: r.left + r.width / 2,
      cy: pageY + r.height / 2,
      area: r.width * r.height,
      zIndex: parseInt(cs.zIndex, 10) || 0,
      meta: Object.keys(meta).length ? meta : undefined,
    });
    count++;
    return true;
  };

  // 文本块节点：role 语义优先；无语义标签但有直接文本的容器按启发式（inferred）出 para。
  // p/para 是纯文本段落角色，按 BR 分段（站点用 <br> 在无 <p> 容器里分段，实测雪球正文）：
  // 每段用自己的文本盒独立发射；li/td/th/pre/blockquote 等结构角色保持整块。
  const emitBlock = (
    el: Element,
    role: NodeRole,
    inferred: boolean,
    // 混排块的纯文本盒覆盖（textRectOf 产出）；缺省用元素 rect
    rectOverride?: { left: number; top: number; width: number; height: number },
  ): boolean => {
    const cs = window.getComputedStyle(el);
    const splittable = role === "p" || role === "para";
    if (splittable) {
      const segs = inlineSegments(el, false);
      if (segs.length > 1) {
        let emitted = false;
        for (const seg of segs) {
          const sr = segRectOf(seg.textNodes);
          if (!sr) continue;
          if (
            emitBlockNode(el, role, inferred, cs, seg.runs, {
              left: sr.rect.left,
              top: sr.rect.top,
              width: sr.rect.width,
              height: sr.rect.height,
            }, sr.tops)
          )
            emitted = true;
        }
        return emitted;
      }
    }
    // pre 优先取内部 <code> 的文本：站点常把语言标签/复制按钮等工具条放在 pre 里
    const preCode = role === "pre" ? el.querySelector("code") : null;
    // td/th 用 throughBlocks：富文本单元格文本常包在 div 里，普通行内序列化会漏成空
    const runs =
      role === "pre"
        ? [{ t: (preCode ?? el).textContent || "" }]
        : inlineRuns(el, role === "td" || role === "th");
    const r = rectOverride
      ? ({
          left: rectOverride.left,
          top: rectOverride.top,
          width: rectOverride.width,
          height: rectOverride.height,
        } as DOMRect)
      : el.getBoundingClientRect();
    return emitBlockNode(el, role, inferred, cs, runs, {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
    });
  };

  // 块内的块级/图片后代由 walk 单独接管，避免内容丢失或重复
  const walkChildren = (el: Element): void => {
    for (const child of Array.from(el.children)) walk(child);
  };

  // 行内容器（span/em/a…）里嵌的图片：<p><span><img></span></p> 之类，
  // 行内序列化跳过 img，这里深入行内子树把图片收出来（emitImg 按 src 去重，重复调用安全）
  const collectImgs = (el: Element): void => {
    for (const sub of Array.from(el.children)) {
      if (sub.tagName === "IMG") {
        const ir = sub.getBoundingClientRect();
        if (ir.width >= minSize && ir.height >= minSize) emitImg(sub);
      } else if (!BLOCKISH.has(sub.tagName)) {
        collectImgs(sub);
      }
    }
  };

  const walk = (el: Element): void => {
    if (count >= maxNodes) {
      truncated = true;
      return;
    }
    for (const child of Array.from(el.children)) {
      if (count >= maxNodes) {
        truncated = true;
        break;
      }
      const tag = child.tagName;
      if (SKIP_TAGS.has(tag)) continue;
      const cs = window.getComputedStyle(child);
      if (
        cs.display === "none" ||
        cs.visibility === "hidden" ||
        parseFloat(cs.opacity || "1") === 0
      )
        continue;
      // display:contents 自身不生成盒——透传子元素
      if (cs.display === "contents") {
        walk(child);
        continue;
      }
      if (tag === "IMG") {
        const r = child.getBoundingClientRect();
        if (r.width >= minSize && r.height >= minSize) emitImg(child);
        continue;
      }

      const isSemantic = H_ROLE[tag] !== undefined;
      if (isSemantic) {
        const r = child.getBoundingClientRect();
        if (r.width >= minSize && r.height >= minSize) {
          // 混排块（内含图片/嵌套块）：rect 用纯文本盒，避免罩住 walk 单独发射的后代节点
          const tr = child.querySelector(MIXED_SEL)
            ? (textRectOf(child) ?? undefined)
            : undefined;
          emitBlock(child, H_ROLE[tag], false, tr);
          // TD/TH 已用 throughBlocks 吸入全部子树文本，无论本趟是否发射成功
          // （多趟重挂时命中去重返回 false）都不能再走兜底递归——否则内部
          // div/span 会被再发射成碎片 para 造成文本重复——只接管嵌套表格与图片
          if (tag === "TD" || tag === "TH") {
            const collectCellImgs = (el: Element): void => {
              for (const sub of Array.from(el.children)) {
                if (sub.tagName === "IMG") {
                  const ir = sub.getBoundingClientRect();
                  if (ir.width >= minSize && ir.height >= minSize) emitImg(sub);
                } else if (sub.tagName !== "TABLE") {
                  collectCellImgs(sub);
                }
              }
            };
            for (const sub of Array.from(child.children)) {
              if (sub.tagName === "TABLE") walk(sub);
              else collectCellImgs(sub);
            }
            continue;
          }
          // LI 的嵌套列表 / P 内嵌块级元素：行内序列化已跳过这些子树，这里递归接管；
          // IMG 不是块级但同样被行内序列化跳过（<p><img></p>、<p><span><img></span></p> 很常见）
          for (const sub of Array.from(child.children)) {
            if (sub.tagName === "IMG") {
              const ir = sub.getBoundingClientRect();
              if (ir.width >= minSize && ir.height >= minSize) emitImg(sub);
            } else if (BLOCKISH.has(sub.tagName)) {
              walk(sub);
            } else {
              collectImgs(sub);
            }
          }
          continue;
        }
        // 尺寸过小的语义块：仍递归（可能内含图片/文本），不当块输出
        for (const sub of Array.from(child.children)) {
          if (sub.tagName === "IMG") {
            const ir = sub.getBoundingClientRect();
            if (ir.width >= minSize && ir.height >= minSize) emitImg(sub);
          } else if (BLOCKISH.has(sub.tagName)) {
            walk(sub);
          } else {
            collectImgs(sub);
          }
        }
        continue;
      }

      // 非语义元素：有直接文本 → 启发式 para（标题/噪音在评分阶段按字号/聚类归类）
      const ownText = cleanText(
        Array.from(child.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent || "")
          .join(" "),
      ).replace(/^ +| +$/g, "");
      if (ownText.length >= 2) {
        const r = child.getBoundingClientRect();
        // ownText.length ≥ 2 是本分支前提，threshold 恒等于 minSize（历史遗留的三元式已删）
        const threshold = minSize;
        if (r.width >= threshold && r.height >= threshold) {
          const pageY = r.top + scrollAdj();
          if (
            !(pageY + r.height < -margin || pageY > window.innerHeight + margin)
          ) {
            emitBlock(child, "para", true);
          }
        }
      }
      walk(child);
    }
  };

  // ---- 0. 展开 Shadow DOM（正文级内容藏在 shadow root 里的站点） ----
  const CONTENT_TAGS_RE =
    /<(pre|code|table|img|p|h[1-6]|ul|ol|dl|blockquote)\b/i;
  const expandShadow = (root: Document | ShadowRoot | Element): void => {
    for (const el of Array.from(root.querySelectorAll("*"))) {
      const sr = (el as HTMLElement).shadowRoot;
      if (!sr) continue;
      expandShadow(sr);
      if (CONTENT_TAGS_RE.test(sr.innerHTML)) {
        const container = document.createElement("div");
        container.innerHTML = sr.innerHTML;
        el.replaceWith(container);
      }
    }
  };
  expandShadow(document);

  // ---- 1. 采集范围：profile mainContent → 通用正文容器候选 → body；remove 在 walk 前裁剪 ----
  let scope: Element = document.body;
  if (args.mainContent) {
    try {
      const els = Array.from(
        document.querySelectorAll(args.mainContent),
      ).filter((e) => (e.textContent || "").trim().length > 80);
      if (els.length) {
        scope = els.reduce((a, b) =>
          (b.textContent || "").length > (a.textContent || "").length ? b : a,
        );
      }
    } catch {
      /* 非法选择器 → body */
    }
  }
  for (const sel of args.remove || []) {
    try {
      scope.querySelectorAll(sel).forEach((e) => e.remove());
    } catch {
      /* 非法选择器跳过 */
    }
  }

  // ---- 2. 采集：普通页面单趟；内部滚动容器（虚拟滚动会卸载离屏内容）按视口高度多趟扫描 ----
  // 从 scope 向上找真实滚动容器（body/documentElement 视为 window 滚动，不参与多趟）
  for (
    let e: Element | null = scope;
    e && e !== document.body && e !== document.documentElement;
    e = e.parentElement
  ) {
    const cs = window.getComputedStyle(e);
    const he = e as HTMLElement;
    if (
      /(auto|scroll)/.test(cs.overflowY) &&
      he.scrollHeight > he.clientHeight + 8
    ) {
      scrollContainer = he;
      break;
    }
  }
  let passes = 1;
  if (
    scrollContainer &&
    scrollContainer.scrollHeight > scrollContainer.clientHeight * 1.2
  ) {
    const step = scrollContainer.clientHeight;
    const maxScroll =
      scrollContainer.scrollHeight - scrollContainer.clientHeight;
    passes = 0;
    for (let y = 0; y <= maxScroll; y += step) {
      scrollContainer.scrollTop = y;
      // 虚拟渲染器按滚动位置异步重挂内容，等一拍再采
      await new Promise((r) => setTimeout(r, y === 0 ? 120 : 320));
      walk(scope);
      passes++;
      if (truncated) break;
    }
    scrollContainer.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 120));
  } else {
    walk(scope);
  }

  // ---- 主标题补采：标题常在 mainContent 之外（站点常把 h1 标题放成正文容器的兄弟节点） ----
  if (count < maxNodes) {
    let titleEl: Element | null = null;
    if (args.titleSelector) {
      try {
        titleEl = document.querySelector(args.titleSelector);
      } catch {
        /* 非法选择器 */
      }
    }
    if (!titleEl) titleEl = document.querySelector("h1");
    if (titleEl && !scope.contains(titleEl) && titleEl !== scope) {
      emitBlock(titleEl, titleEl.tagName === "H1" ? "h1" : "heading", false);
    }
  }

  // ---- 文档高度：内部滚动容器页面（window 不滚，scrollHeight=视口高）用节点最大底边兜底 ----
  const rawBottom = raw.length
    ? Math.max(...raw.map((n) => n.rect[1] + n.rect[3]))
    : 0;
  const docHeight = Math.max(
    document.documentElement.scrollHeight,
    rawBottom,
    1,
  );

  // ---- 标题：titleSelector → h1 → document.title ----
  let title = "";
  if (args.titleSelector) {
    try {
      title =
        document.querySelector(args.titleSelector)?.textContent?.trim() || "";
    } catch {
      /* ignore */
    }
  }
  if (!title) {
    const h1 = document.querySelector("h1");
    title = (h1?.textContent?.trim() || document.title || "").trim();
  }

  return {
    title,
    url: location.href,
    viewport: [window.innerWidth, window.innerHeight],
    docHeight,
    truncated: truncated || undefined,
    passes,
    raw,
  };
};

/** enrichLayout 选项：参数表缺省用默认值；pageType 控制 core range 阶段 */
export interface EnrichOptions {
  params?: ScoringParams;
  fallbacks?: ScoringFallbacks;
  /** article=计算核心内容区间；feed/list=跳过（等价 coreBottom<0 分支，body 由语义角色直接标记）。缺省 article */
  pageType?: "article" | "feed" | "list";
}

/**
 * Node 侧 IR 评分：collectLayoutFn 只产出 RawPass（多趟原始节点），本函数完成
 * 字号/字重/样式聚类统计、正文聚类与核心内容区间标记、启发式 role 归位、
 * 重要性评分、阅读顺序排序，产出最终 ExtractResult。
 */
export function enrichLayout(
  pass: RawPass,
  opts: EnrichOptions = {},
): ExtractResult {
  const params = opts.params ?? DEFAULT_SCORING_PARAMS;
  const fallbacks = opts.fallbacks ?? DEFAULT_SCORING_FALLBACKS;
  const pageType = opts.pageType ?? "article";
  const raw = pass.raw;
  const textNodes = raw.filter((n) => n.runs) as (RawNode & {
    fontSize: number;
    color: string;
    fontWeight: number;
  })[];
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  const textOf = (n: RawNode): string =>
    (n.runs || []).map((x) => x.t).join("");

  // 字号分布：最高字号为标题参考，正文字号按"字符加权最高频"取——壳噪音（侧栏榜单/
  // 导航项）节点数可以超过正文（实测雪球右栏大量 14px 榜单项），但字符量不会；
  // 按节点数取会把 bodyFont 判到壳字号上，正文（16px > 14px）被整体误归位成 heading
  const fontFreq = new Map<number, number>();
  let maxFont = fallbacks.maxFontFloor;
  for (const n of textNodes) {
    const w = Math.max(1, textOf(n).length);
    fontFreq.set(n.fontSize, (fontFreq.get(n.fontSize) || 0) + w);
    maxFont = Math.max(maxFont, n.fontSize);
  }
  const bodyFont =
    [...fontFreq.entries()].sort(
      (a, b) => b[1] - a[1] || a[0] - b[0],
    )[0]?.[0] ?? fallbacks.bodyFontFallback;

  // 字重分布：最高频字重为正文字重参考
  const weightFreq = new Map<number, number>();
  for (const n of textNodes)
    weightFreq.set(n.fontWeight, (weightFreq.get(n.fontWeight) || 0) + 1);
  const bodyWeight =
    [...weightFreq.entries()].sort(
      (a, b) => b[1] - a[1] || a[0] - b[0],
    )[0]?.[0] ?? fallbacks.bodyWeightFallback;

  // 样式聚类：同 fontSize+color 的文本量（正文的群体信号）；颜色频率（装饰的孤色信号）
  const clusterMeta = new Map<string, { chars: number; wy: number }>();
  const colorCount = new Map<string, number>();
  for (const n of textNodes) {
    const k = n.fontSize + "|" + n.color;
    const m = clusterMeta.get(k) ?? { chars: 0, wy: 0 };
    m.chars += textOf(n).length;
    m.wy += textOf(n).length * n.rect[1];
    clusterMeta.set(k, m);
    colorCount.set(n.color, (colorCount.get(n.color) || 0) + 1);
  }
  const maxClusterChars = Math.max(
    ...[...clusterMeta.values()].map((m) => m.chars),
    1,
  );
  const maxColorCount = Math.max(...colorCount.values(), 1);

  // 文档高度：浏览器侧已用 documentElement.scrollHeight 与节点最大底边兜底
  const docH = Math.max(pass.docHeight, 1);
  const pageW = Math.max(pass.viewport[0], 1);

  // 正文聚类：文本量 ≥ 40% 最大值且字数加权质心在前半页的聚类中，取文本量最大的
  const maxCharsKey =
    [...clusterMeta.entries()].sort(
      (a, b) => b[1].chars - a[1].chars,
    )[0]?.[0] ?? "";
  let bodyClusterKey = "";
  let bodyClusterChars = 0;
  for (const [k, m] of clusterMeta) {
    const cy = m.wy / m.chars;
    if (
      m.chars < maxClusterChars * params.cluster.bodyClusterCharsRatio ||
      cy > docH * params.cluster.bodyClusterCentroidMaxY
    )
      continue;
    if (m.chars > bodyClusterChars) {
      bodyClusterChars = m.chars;
      bodyClusterKey = k;
    }
  }
  if (!bodyClusterKey) bodyClusterKey = maxCharsKey;
  const bodyClusterFont = parseInt(bodyClusterKey, 10);

  // 核心内容区间：主标题顶 → 最后一个正文段落底（块级语义角色直接参与）
  // 注意同时纳入 "para"（通用管线推断的段落，无 <P> 标签的页面全靠它）与 "th"
  // feed/list 页面跳过核心区间计算（等价 coreBottom<0 分支）
  const CONTENT_ROLE = new Set<NodeRole>(["p", "para", "li", "td", "th"]);
  // 字重不参与段落资格：加粗段（公众号重点句等）是强调不是换角色——
  // 启发式归位也只按字号+聚类判 para（见下方归位循环），两处必须一致
  const paras = textNodes.filter(
    (n) =>
      CONTENT_ROLE.has(n.role) &&
      n.fontSize + "|" + n.color === bodyClusterKey &&
      textOf(n).length >= params.cluster.paraMinChars,
  );
  let coreTop = 0;
  let coreBottom = -1;
  let titleNode: (typeof textNodes)[number] | null = null;
  // 正文列：核心段落的 x 覆盖带（左缘中位数 + 带宽容差）。双栏站的侧栏榜单与正文
  // 同字号同色（实测雪球热门话题/热股榜），y 区间管不住它们，靠列左缘区分；
  // 容差放得宽（带宽 × 0.3）：居中图注/引用缩进不得被误杀，侧栏整列漂移必须被排除
  let inColumn: (n: RawNode) => boolean = () => true;
  if (pageType === "article" && paras.length) {
    const sorted = [...paras].sort((a, b) => a.rect[1] - b.rect[1]);
    // 尾部收紧：最后一个长段落（≥ longParaChars）为锚，锚后贴着（间距 ≤ 120px）的
    // 短段并入（"（完）"类收尾），断档即止——讨论框/相关推荐等尾部噪音与正文之间
    // 总有断档或本身就短。整页无长段落时不剥（诗歌/短句正文退回旧行为）
    let li = -1;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (textOf(sorted[i]).length >= params.cluster.longParaChars) {
        li = i;
        break;
      }
    }
    if (li < 0) {
      coreBottom = Math.max(...paras.map((n) => n.rect[1] + n.rect[3]));
    } else {
      let end = li;
      while (end + 1 < sorted.length) {
        const gap =
          sorted[end + 1].rect[1] -
          (sorted[end].rect[1] + sorted[end].rect[3]);
        if (gap > 120) break;
        end++;
      }
      coreBottom = sorted[end].rect[1] + sorted[end].rect[3];
    }
    const top0 = sorted[0].rect[1];
    for (const n of textNodes) {
      if (
        n.rect[1] < top0 &&
        n.rect[1] >= 0 && // 固定定位元素在滚动后坐标可为负（实测雪球悬浮登录栏 y=-5978），不是标题
        n.fontSize > bodyClusterFont &&
        (!titleNode || n.fontSize > titleNode.fontSize)
      )
        titleNode = n;
    }
    coreTop = titleNode ? titleNode.rect[1] : top0;
    // 正文列判定以左缘为准：正文段落全部从列左缘起排（左缘中位数高度一致），
    // 侧栏/悬浮栏从自己的列左缘起排。列内更宽的块（代码块/表格）左缘仍贴列，
    // 所以右缘只留极小容差（渲染抖动），否则侧栏（实测距正文列仅 23px）会混入
    const colL = Math.min(...paras.map((n) => n.rect[0]));
    const colR = Math.max(...paras.map((n) => n.rect[0] + n.rect[2]));
    const colW = colR - colL;
    const tolL = Math.max(32, colW * 0.1);
    const tolR = 8;
    inColumn = (n: RawNode): boolean =>
      n.rect[0] >= colL - tolL &&
      n.rect[0] <= colR + tolR;
  }

  // 启发式 role 归位：字号大于正文 → heading；链接列表簇 → li；正文聚类 → para；其余 → other
  // 链接列表簇（仅 feed/list 页）：热榜/推荐位等次级模块整簇是站内跳转锚点（卡片
  // <a> 包裹），文本量不足以竞选正文聚类、语义角色通道又只认 li——inferred para
  // 归位会整段硬丢（实测 AIBase 热榜 10 条标题全漏）。同簇满足节点数与去重锚点数
  // 门槛时按 li 归位，走语义角色通道（feed/list 下语义角色直接标 body）。
  const linkListKeys = new Set<string>();
  const linkListItem = new Set<RawNode>();
  if (pageType !== "article") {
    const isSamePage = (href: string): boolean => {
      try {
        const a = new URL(href, pass.url);
        const b = new URL(pass.url);
        return (
          a.origin === b.origin &&
          a.pathname === b.pathname &&
          a.search === b.search &&
          !!a.hash
        );
      } catch {
        return false;
      }
    };
    // 准入按节点逐个判（短文本的导航/页脚项即使与热榜同簇也不抬），
    // 门槛按簇统计（同簇互证是列表模块而非孤链接），抬分只落在候选节点上
    const linkCand = new Map<string, { n: number; hrefs: Set<string> }>();
    for (const n of textNodes) {
      if (n.role !== "para" || !n.meta?.inferred) continue;
      if (n.fontSize > bodyFont) continue; // 已按标题归位，不走本通道
      const runs = n.runs ?? [];
      if (!runs.length) continue;
      if (!runs.every((r) => r.href && !isSamePage(r.href))) continue;
      if (textOf(n).length < params.cluster.paraMinChars) continue;
      const k = n.fontSize + "|" + n.color;
      const m = linkCand.get(k) ?? { n: 0, hrefs: new Set<string>() };
      m.n++;
      for (const r of runs) m.hrefs.add(r.href!);
      linkCand.set(k, m);
      linkListItem.add(n);
    }
    for (const [k, m] of linkCand) {
      if (
        m.n >= params.linkList.minNodes &&
        m.hrefs.size >= params.linkList.minDistinctHrefs
      )
        linkListKeys.add(k);
    }
  }
  // 图注归位：站点自绘图注（非语义 figcaption）是紧贴图片下缘的孤立短文本——
  // 小字号、不在正文聚类、文本短、水平落在图片跨度内（实测微信文章图注全漏）。
  // 按语义角色 p 输出：article 页仍受核心区间约束，feed/list 页语义角色直接标 body。
  // 图片短边 ≥ coreImgMinSide：小图标下方的标签文字不是图注。
  const imgRects = raw.filter((n) => n.img).map((n) => n.rect);
  const isCaption = (n: RawNode): boolean => {
    const text = textOf(n);
    if (!text || text.length > params.caption.maxChars) return false;
    if (n.fontSize! > bodyFont) return false;
    const [x, y, w] = n.rect;
    const cx = x + w / 2;
    return imgRects.some(([ix, iy, iw, ih]) => {
      const bottom = iy + ih;
      return (
        Math.min(iw, ih) >= params.image.coreImgMinSide &&
        y >= bottom &&
        y - bottom <= params.caption.maxGapPx &&
        cx >= ix &&
        cx <= ix + iw
      );
    });
  };
  for (const n of textNodes) {
    if (n.role !== "para" || !n.meta?.inferred) continue;
    if (n.fontSize > bodyFont) n.role = "heading";
    else if (
      linkListKeys.has(n.fontSize + "|" + n.color) &&
      linkListItem.has(n)
    )
      n.role = "li";
    else if (n.fontSize + "|" + n.color === bodyClusterKey) n.role = "para";
    else if (isCaption(n)) n.role = "p";
    else n.role = "other";
  }

  const nodes: LayoutNode[] = raw.map((n) => {
    if (n.img) {
      // 图片：面积 + 水平居中度；浮层图片（弹窗图）抬底
      const areaScore = clamp01(
        n.area / (params.image.areaRefSide * params.image.areaRefSide),
      );
      const dx = Math.abs(n.cx - pageW / 2) / (pageW / 2);
      let importance = clamp01(
        params.image.areaWeight * areaScore +
          params.image.centralityWeight *
            (1 - dx * params.image.centralityPenalty),
      );
      if (n.zIndex >= params.overlay.zIndexThreshold)
        importance = Math.max(importance, params.overlay.importanceFloor);
      const out: LayoutNode = {
        rect: n.rect,
        role: "img",
        img: n.img,
        importance: Math.round(importance * 100) / 100,
        level: Math.min(
          5,
          Math.max(1, 1 + Math.round(importance * params.levelScale)),
        ),
      };
      if (n.zIndex > 0) out.zIndex = n.zIndex;
      // 核心内容插图：质心落在核心内容区间内且显示尺寸够大
      if (
        coreBottom >= 0 &&
        Math.min(n.rect[2], n.rect[3]) >= params.image.coreImgMinSide &&
        n.rect[1] + n.rect[3] / 2 >= coreTop &&
        n.rect[1] + n.rect[3] / 2 <= coreBottom
      )
        out.body = true;
      const meta: NodeMeta = {};
      if (n.alt) meta.alt = n.alt;
      if (n.naturalSize) meta.naturalSize = n.naturalSize;
      if (Object.keys(meta).length) out.meta = meta;
      return out;
    }

    const fontSize = n.fontSize!;
    const color = n.color!;
    const fontWeight = n.fontWeight!;
    const text = textOf(n);
    const clusterKey = fontSize + "|" + color;
    const fontScore =
      maxFont <= bodyFont
        ? fallbacks.fontScoreFallback
        : clamp01((fontSize - bodyFont) / (maxFont - bodyFont));
    const weightScore =
      fontWeight > bodyWeight
        ? clamp01((fontWeight - bodyWeight) / params.normalization.weightRefDelta)
        : 0;
    const clusterScore =
      (clusterMeta.get(clusterKey)?.chars || 0) / maxClusterChars;
    const lengthScore = clamp01(text.length / params.normalization.lengthRefChars);
    const dx = Math.abs(n.cx - pageW / 2) / (pageW / 2);
    const vy = n.cy / docH;
    const vertEdge =
      Math.min(1, vy / params.edge.topBandRatio) *
      Math.min(1, (1 - vy) / params.edge.bottomBandRatio);
    const centrality = clamp01(
      (1 - dx) * params.edge.centerWeight + vertEdge * params.edge.edgeWeight,
    );
    const colorRarity = 1 - ((colorCount.get(color) || 1) - 1) / maxColorCount;

    let importance =
      params.textWeights.font * fontScore +
      params.textWeights.weight * weightScore +
      params.textWeights.cluster * clusterScore +
      params.textWeights.length * lengthScore +
      params.textWeights.centrality * centrality;
    if (fontSize > bodyFont) {
      const headingScore = clamp01(
        params.heading.base +
          (fontSize / bodyFont - 1) * params.heading.sizeGain +
          weightScore * params.heading.weightGain,
      );
      importance = Math.max(importance, headingScore);
    }
    if (
      colorRarity > params.decorative.colorRarityMin &&
      centrality < params.decorative.centralityMax
    )
      importance *= params.decorative.decay;
    if (n.zIndex >= params.overlay.zIndexThreshold)
      importance = Math.max(importance, params.overlay.importanceFloor);
    importance = clamp01(importance);
    const level = Math.min(
      5,
      Math.max(1, 1 + Math.round(importance * params.levelScale)),
    );

    const out: LayoutNode = {
      rect: n.rect,
      role: n.role,
      runs: n.runs,
      fontSize,
      color,
      fontWeight,
      importance: Math.round(importance * 100) / 100,
      level,
    };
    if (n.zIndex > 0) out.zIndex = n.zIndex;
    if (n.meta) out.meta = n.meta;

    // 核心内容标记：语义内容角色在核心区间内直接可信；启发式沿用字号/聚类条件。
    // 双重约束：y 在核心区间内 + x 在正文列内（侧栏榜单与正文同字号同色时只有列能区分）。
    // p（语义段落，含 figcaption/自绘图注归位）不做列校验——图注常比正文列窄/偏移，
    // 侧栏的 p 噪音由 y 区间挡住；列校验针对的是榜单/导航常见的 li/td/heading/para。
    const inCore =
      coreBottom >= 0 && n.rect[1] >= coreTop && n.rect[1] <= coreBottom;
    const isSemanticP = n.role === "p";
    const semanticContent =
      n.role === "heading" ||
      /^h[1-6]$/.test(n.role) ||
      n.role === "pre" ||
      n.role === "li" ||
      n.role === "blockquote" ||
      isSemanticP ||
      n.role === "td" ||
      n.role === "th";
    if (semanticContent) {
      out.body = coreBottom < 0 ? true : inCore && (isSemanticP || inColumn(n));
    } else if (n.role === "para") {
      // 正文聚类内（同字号+颜色）即核心正文（加粗段是强调，见 paras 过滤处的说明）；
      // 短文本（表格数字等）仅核心区间内标记
      const isPara = clusterKey === bodyClusterKey;
      if (isPara) out.body = coreBottom < 0 ? true : inCore && inColumn(n);
    }
    // 无核心区间（无正文段落）时保持不标，交给 level 表达
    return out;
  });

  // 阅读顺序
  nodes.sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);

  // feed/list 页无核心区间，图片节点拿不到 body 标记，feed 卡片缩略图永远进不了投影。
  // 与 body 文本节点同行（垂直重叠过半 + 水平间距 ≤150px）的图片随条目标 body；
  // article 页不受影响（coreBottom ≥ 0 时图片走核心区间判定）。
  if (coreBottom < 0) {
    const bodyRects = nodes
      .filter((n) => n.body && n.role !== "img")
      .map((n) => n.rect);
    for (const n of nodes) {
      if (n.role !== "img" || n.body) continue;
      const [ix, iy, iw, ih] = n.rect;
      const inBodyRow = bodyRects.some(([tx, ty, tw, th]) => {
        const vOverlap = Math.min(iy + ih, ty + th) - Math.max(iy, ty);
        if (vOverlap < Math.min(ih, th) * 0.5) return false;
        const hGap = Math.max(ix - (tx + tw), tx - (ix + iw));
        return hGap <= 150;
      });
      if (inBodyRow) n.body = true;
    }
  }

  // 标题：浏览器侧已按 titleSelector → h1 → document.title 提取（RawPass.title）
  return {
    title: pass.title,
    url: pass.url,
    layout: {
      viewport: pass.viewport,
      docHeight: docH,
      truncated: pass.truncated || undefined,
      nodes,
    },
  };
}

/** IR → 紧凑文本（每行：level条 + [rect] + role[/meta] + 内容 + @字号/字重）；视觉预览用 JSON，此为可选阅读格式 */
export function layoutToText(layout: PageLayout): string {
  const lv = ["█", "▓", "▒", "░", "·"];
  const lines: string[] = [
    `viewport=${layout.viewport[0]}x${layout.viewport[1]} docHeight=${layout.docHeight}${layout.truncated ? " (截断)" : ""}`,
  ];
  const bar = (l: number): string => lv[l - 1].repeat(3);
  const runText = (runs: NonNullable<LayoutNode["runs"]>): string =>
    runs
      .map((r) =>
        r.href
          ? `[${r.t}](${r.href})`
          : r.code
            ? `\`${r.t}\``
            : r.bold
              ? `**${r.t}**`
              : r.italic
                ? `_${r.t}_`
                : r.t,
      )
      .join("");
  const metaStr = (n: LayoutNode): string => {
    const m = n.meta;
    if (!m) return "";
    if (n.role === "li") return ` ${m.ordered ? "ol" : "ul"} d${m.depth}`;
    if (n.role === "th" || n.role === "td") return ` r${m.row}c${m.col}`;
    if (n.role === "pre" && m.lang) return ` ${m.lang}`;
    if (n.role === "img") return m.alt ? ` [${m.alt}]` : "";
    return m.inferred ? " ~" : "";
  };
  for (const n of layout.nodes) {
    const head = `${bar(n.level)} [${n.rect.join(",")}] ${n.role}${metaStr(n)}`;
    if (n.img) lines.push(`${head} ${n.img}`);
    else
      lines.push(
        `${head} ${runText(n.runs ?? [])} @${n.fontSize}px${(n.fontWeight ?? 400) !== 400 ? ` w${n.fontWeight}` : ""}${n.body ? " 核心" : ""}${n.zIndex ? ` z${n.zIndex}` : ""}`,
      );
  }
  return lines.join("\n");
}
