export * from "./paths.js";

export { BrowserPool } from "./engine/BrowserPool.js";
export type { ContextOptions } from "./engine/BrowserPool.js";
export { FetchEngine, effectiveProfile } from "./engine/FetchEngine.js";
export type { EffectiveProfile, FetchResult } from "./engine/FetchEngine.js";
export {
  autoScroll,
  runActions,
  runExtraWait,
  GOTO_WAIT_UNTILS,
} from "./engine/actions.js";
export { runComposite } from "./engine/composite.js";
export type {
  CompositeItem,
  CompositeResult,
  CompositeDeps,
} from "./engine/composite.js";
export {
  LAYOUT_SCHEMA_VERSION,
  saveLayout,
  sanitizeSlug,
} from "./engine/save.js";
export type { SaveLayoutOptions, SavedLayout } from "./engine/save.js";

export {
  collectLayoutFn,
  enrichLayout,
  layoutToText,
  warmPageForLayout,
} from "./layout/boxTree.js";
export { layoutToMarkdown } from "./layout/toMarkdown.js";
export type {
  LayoutNode,
  InlineRun,
  NodeRole,
  NodeMeta,
  LayoutOptions,
  ExtractArgs,
  ExtractResult,
  RawRun,
  RawNode,
  RawPass,
  PageLayout,
} from "./layout/boxTree.js";
export { openPreviewPage, registerPreview } from "./layout/previewServer.js";
export type { PreviewMeta } from "./layout/previewServer.js";
export {
  DEFAULT_SCORING_PARAMS,
  DEFAULT_SCORING_FALLBACKS,
  partialScoringParams,
} from "./layout/scoring.js";
export type { ScoringParams, ScoringFallbacks } from "./layout/scoring.js";
export type { EnrichOptions } from "./layout/boxTree.js";

export {
  ProfileRegistry,
  patternToRegex,
  sanitizeToolName,
} from "./profiles/loader.js";
export { SiteProfileSchema, ActionSchema } from "./profiles/schema.js";
export type {
  SiteProfile,
  ProfileAdapter,
  LoadedProfile,
  ProfileAction,
} from "./profiles/schema.js";

export { ImageManager } from "./images/manager.js";
export type {
  ImageMode,
  InlineImage,
  ImageProcessResult,
} from "./images/manager.js";

export { interactiveLogin, loginAndWait } from "./auth/login.js";
export type { LoginWaitOptions, LoginWaitResult } from "./auth/login.js";
