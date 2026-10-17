/**
 * 内容 IR → Markdown 的确定性投影：role→块级语法，runs→行内语法，表格按 row/col 组装。
 * 只映射，不做启发式判断——每个字段都有唯一确定的去处。
 */
import type { InlineRun, LayoutNode, NodeRole, PageLayout } from "./boxTree.js";

const CONTENT_ROLES = new Set<NodeRole>([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "heading",
  "p",
  "para",
  "li",
  "pre",
  "blockquote",
  "th",
  "td",
  "img",
]);

/** 同页锚点链接（#frag 或与 pageUrl 同 path 的 url#frag）→ 只投影文本，不保留链接 */
function isSamePageAnchor(href: string, pageUrl?: string): boolean {
  if (href.startsWith("#")) return true;
  if (!pageUrl) return false;
  try {
    const a = new URL(href, pageUrl);
    const b = new URL(pageUrl);
    return (
      a.origin === b.origin &&
      a.pathname === b.pathname &&
      a.search === b.search &&
      !!a.hash
    );
  } catch {
    return false;
  }
}

/** 行内片段 → markdown 行内语法：code 包反引号，bold/italic 包星号下划线，href 包方括号圆括号 */
function inline(runs: InlineRun[], pageUrl?: string): string {
  return runs
    .map((r) => {
      if (!r.t) return "";
      let inner = r.code ? `\`${r.t}\`` : r.t;
      if (r.bold && !r.code) inner = `**${inner}**`;
      if (r.italic && !r.code) inner = `_${inner}_`;
      return r.href && !isSamePageAnchor(r.href, pageUrl)
        ? `[${inner}](${r.href})`
        : inner;
    })
    .join("");
}

const textOf = (n: LayoutNode, pageUrl?: string): string =>
  n.runs ? inline(n.runs, pageUrl) : "";

/** 单个内容块 → markdown 行（不含表格组装） */
function blockLines(
  n: LayoutNode,
  listCounters: number[],
  pageUrl?: string,
): string[] {
  const text = textOf(n, pageUrl);
  switch (n.role) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return [`${"#".repeat(Number(n.role[1]))} ${text}`];
    case "heading":
      return [`## ${text}`]; // 启发式标题无层级信息，缺省二级
    case "p":
    case "para":
      return text ? [text] : [];
    case "li": {
      const depth = Math.max(1, n.meta?.depth ?? 1);
      listCounters.length = Math.max(listCounters.length, depth);
      let marker: string;
      if (n.meta?.ordered) {
        listCounters[depth - 1] = (listCounters[depth - 1] ?? 0) + 1;
        marker = `${listCounters[depth - 1]}. `;
      } else {
        listCounters[depth - 1] = 0;
        marker = "- ";
      }
      return [`${"  ".repeat(depth - 1)}${marker}${text}`];
    }
    case "blockquote":
      return text ? [`> ${text}`] : [];
    case "pre": {
      const body = (n.runs ?? []).map((r) => r.t).join("");
      const fence = body.includes("```") ? "~~~~" : "```";
      return [`${fence}${n.meta?.lang ?? ""}`, body, fence];
    }
    case "img": {
      const alt = n.meta?.alt ?? "";
      return [`![${alt}](${n.img})`];
    }
    default:
      return [];
  }
}

/** 连续的 th/td 节点组装成 markdown 表格（rowspan/colspan 未展开，按 cellIndex 对位） */
function tableLines(cells: LayoutNode[], pageUrl?: string): string[] {
  if (!cells.length) return [];
  const rows = new Map<number, Map<number, string>>();
  let maxCol = 0;
  for (const c of cells) {
    const row = rows.get(c.meta?.row ?? 0) ?? new Map<number, string>();
    const col = c.meta?.col ?? 0;
    row.set(col, textOf(c, pageUrl).replace(/\|/g, "\\|").replace(/\n/g, " "));
    rows.set(c.meta?.row ?? 0, row);
    maxCol = Math.max(maxCol, col);
  }
  const rowIdx = [...rows.keys()].sort((a, b) => a - b);
  const render = (row: Map<number, string>): string =>
    `| ${Array.from({ length: maxCol + 1 }, (_, i) => row.get(i) ?? "").join(" | ")} |`;
  const lines = [
    render(rows.get(rowIdx[0])!),
    `| ${Array.from({ length: maxCol + 1 }, () => "---").join(" | ")} |`,
  ];
  for (const r of rowIdx.slice(1)) lines.push(render(rows.get(r)!));
  return lines;
}

export interface LayoutToMarkdownOptions {
  /** 只投影核心内容（body 标记）节点；缺省 true，无 body 标记时退回全部内容角色节点 */
  bodyOnly?: boolean;
  /** 页面 URL：用于识别同页锚点链接（如目录 #frag），投影时只保留文本不保留链接 */
  pageUrl?: string;
}

/**
 * IR → Markdown。
 * 输入节点须按阅读顺序（enrichLayout 的产出已排序）；噪音（other/非 body）不出现在产物里。
 */
export function layoutToMarkdown(
  layout: PageLayout,
  opts: LayoutToMarkdownOptions = {},
): string {
  const bodyOnly = opts.bodyOnly ?? true;
  const pageUrl = opts.pageUrl;
  let nodes = layout.nodes.filter((n) => CONTENT_ROLES.has(n.role));
  if (bodyOnly) {
    const core = nodes.filter((n) => n.body);
    if (core.length) nodes = core;
  }

  const out: string[] = [];
  const listCounters: number[] = [];
  let i = 0;
  while (i < nodes.length) {
    const n = nodes[i];
    if (n.role === "th" || n.role === "td") {
      let j = i;
      while (
        j < nodes.length &&
        (nodes[j].role === "th" || nodes[j].role === "td")
      )
        j++;
      out.push(tableLines(nodes.slice(i, j), pageUrl).join("\n"));
      i = j;
      continue;
    }
    const lines = blockLines(n, listCounters, pageUrl);
    if (lines.length) out.push(lines.join("\n"));
    i++;
  }
  return out.join("\n\n") + "\n";
}
