import { useEffect, useRef, useState } from "react";
import type { LayoutNode, PageLayout } from "../types";

/** 重要性等级 → 灰阶（5 最深） */
const LEVEL_COLORS: Record<number, string> = {
  1: "#e0e0e0",
  2: "#b4b4b4",
  3: "#7f7f7f",
  4: "#4f4f4f",
  5: "#1e1e1e",
};

// 行高下限：不能小于字号的 1.3333 倍
const MIN_LH = 1.3333;

// 节点静态样式（rect 坐标/颜色等动态值走 inline style）；'node'/'img' 类名供 fitLineHeights 定位量测
const NODE_CLASS =
  "node absolute box-border overflow-hidden whitespace-normal break-words cursor-default hover:outline-2 hover:outline-solid hover:-outline-offset-1 hover:outline-[#007aff]";

function nodeTip(n: LayoutNode): string {
  return (
    `level ${n.level} · imp ${n.importance}` +
    (n.fontSize
      ? ` · ${n.fontSize}px${(n.fontWeight ?? 400) !== 400 ? ` w${n.fontWeight}` : ""}${n.color ? ` · ${n.color}` : ""}`
      : "") +
    (n.body ? " · 核心" : "") +
    (n.zIndex ? ` · z:${n.zIndex}` : "") +
    ` · [${n.rect.join(",")}]`
  );
}

function ImageNode({ n, tip }: { n: LayoutNode; tip: string }) {
  const [failed, setFailed] = useState(false);
  const [x, y, w, h] = n.rect;
  return (
    <div
      className={`${NODE_CLASS} img border border-dashed border-[#d8d8dc] bg-[#f5f5f7]`}
      style={{ left: x, top: y, width: w, height: h, zIndex: n.zIndex }}
      title={tip}
    >
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-[#86868b]">
          图加载失败
        </div>
      ) : (
        <img
          className="block h-full w-full object-cover"
          src={n.img}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

function NodeView({ n }: { n: LayoutNode }) {
  const [x, y, w, h] = n.rect;
  const zi = n.zIndex ? { zIndex: n.zIndex } : undefined;
  const tip = nodeTip(n);
  if (n.img) return <ImageNode n={n} tip={tip} />;
  const fsz = Math.max(8, Math.min(n.fontSize ?? 14, h - 2));
  // 原始行高（新 IR 的 meta.lineH）：渲染即按原页行距；无则按行高=字号，量测阶段再修正
  const origLh = typeof n.meta?.lineH === "number" ? n.meta.lineH : 0;
  const text = n.runs ? n.runs.map((r) => r.t).join("") : "";
  return (
    <div
      className={NODE_CLASS}
      data-orig-lh={origLh || undefined}
      style={{
        left: x,
        top: y,
        width: w,
        height: h,
        color: LEVEL_COLORS[n.level] ?? "#7f7f7f",
        fontSize: fsz,
        fontWeight: n.fontWeight ?? 400,
        lineHeight: `${origLh || fsz}px`,
        background: n.body ? "#eef4ff" : undefined,
        ...zi,
      }}
      title={tip}
    >
      {text}
    </div>
  );
}

/**
 * 行高两级策略：新 IR 带 meta.lineH（采集端记录的原页行高）时直接按原行距渲染，
 * 仅在预览字体折行偏多导致内容超出盒高时压缩行高装回盒子；无原始行高（旧数据）
 * 按估算兜底：行数 = 内容高/字号（行高=字号时测量），行高 = 盒高/行数 → 文本行
 * 均匀撑满盒子，单行盒子即垂直居中。均在 React 渲染完成后对 DOM 量测修正。
 */
function fitLineHeights(wrap: HTMLElement): void {
  wrap.querySelectorAll<HTMLElement>(".node").forEach((el) => {
    if (el.classList.contains("img") || !el.textContent?.trim()) return;
    const h = el.getBoundingClientRect().height;
    const fsz = parseFloat(el.style.fontSize) || 14;
    // scrollHeight 不会小于盒子自身高度，量行数前临时放开 height
    const height = el.style.height;
    el.style.height = "auto";
    const contentH = el.scrollHeight;
    el.style.height = height;
    // 有原始行高（新 IR 的 meta.lineH）：保持原页行距；预览字体折行偏多导致
    // 内容超高时，按预览实际行数压缩行高装回盒子，避免溢出裁剪
    const origLh = parseFloat(el.dataset.origLh || "") || 0;
    if (origLh > 0) {
      if (contentH <= h + 1) return;
      const lines = Math.max(2, Math.round(contentH / origLh));
      el.style.lineHeight = `${Math.max(fsz, h / lines).toFixed(2)}px`;
      return;
    }
    const lines = Math.max(1, Math.round(contentH / fsz));
    if (lines === 1) {
      // 单行：行高撑满盒子垂直居中；行高被下限抬高时上移半个溢出量保持居中
      const lh = Math.max(h, fsz * MIN_LH);
      el.style.lineHeight = `${lh.toFixed(2)}px`;
      if (lh > h)
        el.style.transform = `translateY(${((h - lh) / 2).toFixed(2)}px)`;
      return;
    }
    // 盒子装不下原始行数时行高按下限截断，超出部分溢出裁剪
    el.style.lineHeight = `${Math.max(fsz * MIN_LH, Math.min(h / lines, h)).toFixed(2)}px`;
  });
}

export default function LayoutCanvas({ layout }: { layout: PageLayout }) {
  const ref = useRef<HTMLDivElement>(null);
  // 绘制顺序：zIndex 升序（浮层最后画，盖在上层）
  const nodes = [...layout.nodes].sort(
    (p, q) => (p.zIndex ?? 0) - (q.zIndex ?? 0),
  );
  useEffect(() => {
    if (ref.current) fitLineHeights(ref.current);
  }, [layout]);
  const [vw] = layout.viewport;
  return (
    <div
      ref={ref}
      className="relative shrink-0 overflow-hidden rounded-xl border border-[#e5e5ea] bg-white"
      style={{ width: vw, height: layout.docHeight }}
    >
      {nodes.map((n, i) => (
        <NodeView key={i} n={n} />
      ))}
    </div>
  );
}
