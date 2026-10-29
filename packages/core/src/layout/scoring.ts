/**
 * IR 评分参数表（Node 侧，enrichLayout 专用）。
 *
 * 所有魔数收敛于此：每个字段 = 名称 + 默认值 + 含义/依据，校准来源与方法论
 * 见 packages/core/docs/layout-methodology.md。改动任何默认值都必须通过
 * ir-golden（fixture 金样）与 ir-regression（线上快照）回归验证。
 *
 * 注意：本模块不参与 page.evaluate 序列化——浏览器侧（collectLayoutFn 内部）
 * 的常量走 ExtractArgs 传入，与这里的参数互不重叠。
 */

/** 校准基线（三站实测）：主标题 5 → 大图 5 → 小节标题 4 → 正文 3 → 导航/装饰 1-2 */
export interface ScoringParams {
  /** 正文聚类：准入与参考段落 */
  cluster: {
    /** 聚类文本量 ≥ 最大聚类 × 0.4 才有资格成为正文聚类（防小簇噪声明抢） */
    bodyClusterCharsRatio: number; // 0.4
    /** 聚类字符加权质心须在前半页（docH × 0.5）内——正文不会沉在页尾 */
    bodyClusterCentroidMaxY: number; // 0.5
    /** 参与核心区间的段落最小字符数（滤掉时间戳/标签类短句） */
    paraMinChars: number; // 10
    /** 长段落阈值：核心区间尾部以此为锚剥掉短段链（讨论框/互动条/占位符） */
    longParaChars: number; // 40
  };
  /** 文本重要性合成权重（和为 1） */
  textWeights: {
    font: number; // 0.34
    weight: number; // 0.06
    cluster: number; // 0.26
    length: number; // 0.16
    centrality: number; // 0.18
  };
  /** 标题抬分：importance = base + (fontSize/bodyFont - 1) × sizeGain + weightScore × weightGain */
  heading: {
    base: number; // 0.4
    sizeGain: number; // 0.8
    weightGain: number; // 0.15
  };
  /** 图片评分：面积为主、水平居中度为辅 */
  image: {
    /** 面积满分的参考边长（240×240 px ≈ 一屏配图量级） */
    areaRefSide: number; // 240
    areaWeight: number; // 0.55
    centralityWeight: number; // 0.45
    /** 居中度对图片分的折减系数：dx × 0.6 */
    centralityPenalty: number; // 0.6
    /** 核心内容插图的最小显示边长（px），滤图标/头像 */
    coreImgMinSide: number; // 80
  };
  /** 浮层（弹窗/遮罩）地板：zIndex 达到阈值即抬到 importanceFloor */
  overlay: {
    zIndexThreshold: number; // 10
    importanceFloor: number; // 0.55
  };
  /** 归一化参考量 */
  normalization: {
    /** 文本长度满分参考字符数 */
    lengthRefChars: number; // 60
    /** 字重满分的增量参考（fontWeight - bodyWeight 达 300 得满分） */
    weightRefDelta: number; // 300
  };
  /** 垂直边缘带（页面顶部/底部导航条）的中心度衰减 */
  edge: {
    /** 顶部边缘带占页高比例 */
    topBandRatio: number; // 0.08
    /** 底部边缘带占页高比例 */
    bottomBandRatio: number; // 0.12
    /** 中心度合成：水平居中项权重 */
    centerWeight: number; // 0.6
    /** 中心度合成：垂直边缘项权重 */
    edgeWeight: number; // 0.4
  };
  /** 装饰性文本衰减：页面里罕见颜色 + 不居中 → 视为装饰 */
  decorative: {
    colorRarityMin: number; // 0.75
    centralityMax: number; // 0.3
    decay: number; // 0.6
  };
  /** 链接列表簇（feed/list 页热榜/推荐位等次级模块）按 li 归位的准入 */
  linkList: {
    /** 同簇（字号+颜色）至少节点数——孤立的站外跳转文本不抬 */
    minNodes: number; // 3
    /** 同簇至少去重锚点数——导航/页脚复用同一链接时整簇保持 other */
    minDistinctHrefs: number; // 3
  };
  /** 图注归位：紧贴图片下缘的孤立短文本（站点自绘图注，非语义 figcaption） */
  caption: {
    /** 节点顶边与图片底边的最大间距 px——实测图注 3-30px、正文段落 > 50px，取中 */
    maxGapPx: number; // 40
    /** 图注最大字符数——长文本紧贴图片多半是被样式孤立的正文段 */
    maxChars: number; // 60
  };
  /** level = 1 + round(importance × levelScale)，钳到 [1,5] */
  levelScale: number; // 4
}

/** 字体分布的兜底值（无文本节点等极端输入下保持可用） */
export interface ScoringFallbacks {
  maxFontFloor: number; // 12
  bodyFontFallback: number; // 14
  bodyWeightFallback: number; // 400
  /** maxFont ≤ bodyFont（整页同字号）时 fontScore 的固定值 */
  fontScoreFallback: number; // 0.5
}

export const DEFAULT_SCORING_FALLBACKS: ScoringFallbacks = {
  maxFontFloor: 12,
  bodyFontFallback: 14,
  bodyWeightFallback: 400,
  fontScoreFallback: 0.5,
};

export const DEFAULT_SCORING_PARAMS: ScoringParams = {
  cluster: {
    bodyClusterCharsRatio: 0.4,
    bodyClusterCentroidMaxY: 0.5,
    paraMinChars: 10,
    longParaChars: 40,
  },
  textWeights: {
    font: 0.34,
    weight: 0.06,
    cluster: 0.26,
    length: 0.16,
    centrality: 0.18,
  },
  heading: { base: 0.4, sizeGain: 0.8, weightGain: 0.15 },
  image: {
    areaRefSide: 240,
    areaWeight: 0.55,
    centralityWeight: 0.45,
    centralityPenalty: 0.6,
    coreImgMinSide: 80,
  },
  overlay: { zIndexThreshold: 10, importanceFloor: 0.55 },
  normalization: { lengthRefChars: 60, weightRefDelta: 300 },
  edge: {
    topBandRatio: 0.08,
    bottomBandRatio: 0.12,
    centerWeight: 0.6,
    edgeWeight: 0.4,
  },
  decorative: { colorRarityMin: 0.75, centralityMax: 0.3, decay: 0.6 },
  linkList: { minNodes: 3, minDistinctHrefs: 3 },
  caption: { maxGapPx: 40, maxChars: 60 },
  levelScale: 4,
};

/**
 * Profile layout 段 → 完整 ScoringParams：默认值上仅覆盖 profile 开放的两个场景阈值。
 * 其余参数不进 Profile 调参面（保持引擎层的可校准性与行为一致性）。
 */
export function partialScoringParams(
  layout?: { bodyClusterMinRatio?: number; coreImgMinSide?: number } | null,
): ScoringParams {
  const params: ScoringParams = structuredClone(DEFAULT_SCORING_PARAMS);
  if (layout?.bodyClusterMinRatio !== undefined)
    params.cluster.bodyClusterCharsRatio = layout.bodyClusterMinRatio;
  if (layout?.coreImgMinSide !== undefined)
    params.image.coreImgMinSide = layout.coreImgMinSide;
  return params;
}
