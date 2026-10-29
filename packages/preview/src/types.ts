/** 与 core 的 boxTree.ts / previewServer.ts 输出对齐的前端类型（只读投影） */

export type ViewMode = 'layout' | 'md';
export type EntrySource = 'saved' | 'session';

/** 行内片段：块内一段带标记的文本 */
export interface InlineRun {
  t: string;
  href?: string;
  code?: boolean;
  bold?: boolean;
  italic?: boolean;
}

export interface LayoutNode {
  /** [x, y, w, h]，页面绝对坐标 */
  rect: [number, number, number, number];
  role: string;
  runs?: InlineRun[];
  img?: string;
  fontSize?: number;
  color?: string;
  fontWeight?: number;
  /** 核心内容标记（主标题/小节标题/正文段落/核心插图） */
  body?: boolean;
  importance: number;
  /** 重要性等级 1~5（5 最重要） */
  level: number;
  zIndex?: number;
  meta?: Record<string, unknown>;
}

export interface PageLayout {
  viewport: [number, number];
  docHeight: number;
  truncated?: boolean;
  nodes: LayoutNode[];
}

/** /api/layouts 列表项 */
export interface LayoutSummary {
  id: string;
  title: string;
  url: string;
  site: string;
  fetchedAt: string;
  nodes: number;
  viewport: [number, number];
  docHeight: number;
  source: EntrySource;
  /** 落盘条目：相对 SAVE_ROOT 的文件路径 */
  file?: string;
}

/** /api/layout/:id 详情 */
export interface LayoutDetail {
  id: string;
  title: string;
  url: string;
  fetchedAt: string;
  layout: PageLayout;
  markdown: string;
}
