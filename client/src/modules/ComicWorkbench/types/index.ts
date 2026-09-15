/**
 * 漫画工作台模块 全量类型定义
 *
 * 规则约束（.trae/rules/comic-workbench-rule.md）：
 * - 禁止 any，所有数据结构必须有完整 TS 类型
 * - 原文零修改：分镜只记录 startIndex/endIndex
 * - 数据流单向：原文 → 分镜 → 角色/场景 → 描述词 → 图片
 */

// ---------------------------------------------------------------------------
// 基础枚举
// ---------------------------------------------------------------------------

/** 内容导入来源 */
export type ComicSourceType = "txt" | "paste" | "inspiration";

/** 台词呈现样式（随漫画形态适配） */
export type ComicLetteringMode = "bubble" | "caption" | "chat" | "none";

/** 分镜密度档位（5档） */
export type ShotDensityLevel = "ultraTight" | "tight" | "standard" | "loose" | "ultraLoose";

/** 镜头类型 */
export type ShotType =
  | "wide"
  | "medium"
  | "closeUp"
  | "extremeCloseUp"
  | "overShoulder"
  | "aerial"
  | "pov";

/** 情绪等级 */
export type EmotionLevel =
  | "calm"
  | "tense"
  | "joyful"
  | "sad"
  | "angry"
  | "suspenseful"
  | "romantic"
  | "shocked";

/** 生成模式 */
export type GenerationMode = "draft" | "hd";

/** 生成任务状态 */
export type GenerationStatus = "pending" | "queued" | "running" | "success" | "failed";

/** 图片资产用途 */
export type ComicImageKind = "panel" | "character" | "scene" | "test";

// ---------------------------------------------------------------------------
// 配置类型（config/*.json 的结构契约）
// ---------------------------------------------------------------------------

/** 漫画形态配置 —— config/comicForms.json */
export interface ComicFormConfig {
  id: string;
  name: string;
  /** 画幅比例，如 "3:4" */
  aspectRatio: string;
  ratioWidth: number;
  ratioHeight: number;
  /** 高清生成参考像素 */
  referencePixel: { width: number; height: number };
  /** 草稿模式参考像素（低分辨率快速预览） */
  draftPixel: { width: number; height: number };
  /** 每图格数规则 */
  panelGrid: { minPerImage: number; maxPerImage: number; defaultPerImage: number };
  /** 台词呈现样式 */
  letteringMode: ComicLetteringMode;
  /** 描述词前缀（形态专属画面语言） */
  promptPrefix: string;
  /** 形态说明（UI 展示） */
  description: string;
  /** 缩略预览的 CSS 示意布局 */
  preview: { layout: "vertical" | "grid" | "single" | "chat"; blockCount: number; accentColor: string };
}

/** 画风通用调节参数 */
export interface StyleAdjustments {
  /** 色调倾向描述词 */
  colorTone: string;
  /** 线条粗细 */
  lineWeight: "thin" | "normal" | "bold";
  /** 画质精细度 */
  quality: "standard" | "fine" | "ultra";
  /** 光影强度 */
  lighting: "soft" | "balanced" | "strong";
}

/** 画风预设 —— config/stylePresets.json */
export interface StylePresetConfig {
  id: string;
  name: string;
  /** 正向描述词模板 */
  promptKeywords: string;
  /** 负面词（可省略，缺省回落到全局负面词） */
  negativeKeywords?: string;
  /** 调节参数默认值 */
  adjustments: StyleAdjustments;
}

/** 用户保存的个人画风预设（存 IndexedDB） */
export interface CustomStylePreset extends StylePresetConfig {
  isCustom: true;
  /** 基于哪个内置预设派生 */
  basePresetId: string;
  /** 用户追加的自定义关键词 */
  customKeywords: string;
  createdAt: string;
}

/** 密度档位配置 —— config/shotDensity.json */
export interface ShotDensityLevelConfig {
  id: ShotDensityLevel;
  name: string;
  /** 单个分镜覆盖的最小句数 */
  minSentences: number;
  maxSentences: number;
  description: string;
}

/** 分镜切分规则参数（全部可配置，禁止硬编码） */
export interface ShotSplitRulesConfig {
  /** 句子终止字符集 */
  sentenceEndChars: string;
  /** 句内从句切分参考字符集 */
  clauseBreakChars: string;
  /** 超长句强制拆分的字符阈值 */
  maxPanelChars: number;
  /** 超短句合并的字符阈值 */
  minPanelChars: number;
  /** 场景切换是否强制切分 */
  sceneChangeForceSplit: boolean;
  /** 场景切换提示词表 */
  sceneChangeMarkers: string[];
  /** 对话与叙述是否分开成镜 */
  dialogueSeparateFromNarration: boolean;
  /** 对话引号开/闭字符集 */
  dialogueOpenChars: string;
  dialogueCloseChars: string;
}

/** 智能动态密度配置 */
export interface DynamicDensityConfig {
  enabled: boolean;
  /** 剧情高强度节点关键词（命中时自动调紧） */
  climaxKeywords: string[];
  /** 对话密集段自动调紧 */
  dialogueBoost: boolean;
}

/** shotDensity.json 顶层结构 */
export interface ShotDensityConfig {
  defaultDensity: ShotDensityLevel;
  levels: ShotDensityLevelConfig[];
  splitRules: ShotSplitRulesConfig;
  dynamicDensity: DynamicDensityConfig;
}

/** 描述词公式段顺序与模板 —— config/promptFormula.json */
export interface PromptFormulaConfig {
  /** 段落拼接顺序，键与 PromptSegments 对齐 */
  segmentOrder: Array<keyof PromptSegments>;
  /** 段落连接符 */
  segmentJoiner: string;
  /** 无元数据时剧情段回落到原文的截断长度 */
  actionFallbackCharLimit: number;
  /** 各段模板，{placeholder} 会被替换 */
  segmentTemplates: Record<keyof PromptSegments, string>;
  /** 镜头指令映射 */
  cameraDirectives: Record<ShotType, string>;
  /** 台词呈现提示（按 letteringMode） */
  letteringHints: Record<ComicLetteringMode, string>;
  /** 画质词（按生成模式） */
  qualityWords: Record<GenerationMode, string>;
  /** 线条粗细的中文展示词（UI 与描述词共用） */
  lineWeightLabels: Record<StyleAdjustments["lineWeight"], string>;
  /** 光影强度的中文展示词 */
  lightingLabels: Record<StyleAdjustments["lighting"], string>;
  /** 全局负面词 */
  negativeWords: string;
}

/** AI 服务商预设 —— config/aiProviders.json */
export interface AiProviderProtocolConfig {
  /** 协议族：openai-chat 兼容 / ark-images 同步生图 / grsai 异步轮询生图 */
  protocol: "openai-chat" | "ark-images" | "grsai";
  defaultBaseUrl: string;
  models: string[];
}

export interface AiProviderConfig {
  id: string;
  name: string;
  /** 提供哪类能力 */
  kind: "llm" | "image" | "both";
  llm?: AiProviderProtocolConfig;
  image?: AiProviderProtocolConfig;
  notes?: string;
}

export interface AiProvidersConfig {
  providers: AiProviderConfig[];
  defaults: {
    llmTimeoutMs: number;
    longTextTimeoutMs: number;
    imageTimeoutMs: number;
    imagePollIntervalMs: number;
    imagePollMaxMs: number;
    maxRetries: number;
    retryBaseDelayMs: number;
    /** 生图队列并发数 */
    imageConcurrency: number;
  };
}

/** 用户 AI 连接配置（存 IndexedDB，API Key 不出本机） */
export interface AiConnectionSettings {
  llm: { providerId: string; baseUrl: string; apiKey: string; model: string };
  image: { providerId: string; baseUrl: string; apiKey: string; model: string };
}

/** 爆款叙事模板 —— config/narrativeTemplates.json */
export interface NarrativeTemplateConfig {
  id: string;
  name: string;
  description: string;
  /** 注入灵感扩写/分镜引导的指令 */
  promptDirective: string;
}

export interface PlatformAdapterConfig {
  id: string;
  name: string;
  /** 该平台推荐形态 */
  recommendedFormId: string;
  /** 节奏建议（注入文案生成） */
  pacingHint: string;
}

export interface NarrativeTemplatesConfig {
  templates: NarrativeTemplateConfig[];
  platforms: PlatformAdapterConfig[];
}

/** 敏感词表 —— config/sensitiveWords.json */
export interface SensitiveWordsConfig {
  /** 检测到后的行为：目前仅 warn（提示后由用户决定） */
  action: "warn";
  words: string[];
}

// ---------------------------------------------------------------------------
// 业务实体（IndexedDB 持久化）
// ---------------------------------------------------------------------------

/** 章节版本链计数器：任一上游阶段完成后递增，用于下游 stale 判定 */
export interface ChapterVersions {
  /** 原文导入版本 */
  content: number;
  /** 分镜版本 */
  storyboard: number;
  /** 分镜元数据版本（镜头/情绪/动作概述，仅作为描述词素材） */
  metadata?: number;
  /** 角色/场景版本 */
  cast: number;
  /** 台词版本 */
  dialogue: number;
  /** 描述词版本 */
  prompt: number;
  /** 画风/形态等表现层版本 */
  presentation: number;
}

export function emptyChapterVersions(): ChapterVersions {
  return { content: 0, storyboard: 0, cast: 0, dialogue: 0, prompt: 0, presentation: 0 };
}

/** 阶段产出所基于的上游版本快照（待更新判定依据，规则第7条数据流单向） */
export interface PanelStageBasis {
  storyboard: number;
  metadata: number;
  cast: number;
  dialogue: number;
  presentation: number;
}

/** 成品图产出所基于的版本（描述词 + 表现层） */
export interface PanelImageBasis {
  prompt: number;
  presentation: number;
}

/** 下游阶段落库时盖章：记录当时章节版本，供 syncService 比对 */
export function stageBasisSnapshot(chapter: ComicChapter): PanelStageBasis {
  const versions = chapter.versions;
  return {
    storyboard: versions.storyboard,
    metadata: versions.metadata ?? 0,
    cast: versions.cast,
    dialogue: versions.dialogue,
    presentation: versions.presentation,
  };
}

/** 灵感扩写参数（唯一走大模型的导入方式） */
export interface InspirationBrief {
  keywords: string;
  length: "short" | "medium" | "long";
  genre: string;
  styleHint: string;
  narrativeTemplateId?: string;
}

/** 灵感扩写结构化产出 */
export interface InspirationDraft {
  characters: Array<{
    name: string;
    gender: string;
    appearance: string;
    clothing: string;
    features: string;
  }>;
  scenes: Array<{ name: string; spaceStructure: string; environment: string }>;
  plotNodes: string[];
  content: string;
}

/** 漫画项目 */
export interface ComicProject {
  id: string;
  name: string;
  /** 选定形态（config/comicForms.json 的 id） */
  formId: string;
  /** 选定画风预设 */
  stylePresetId: string;
  /** 形态画风微调参数 */
  styleAdjustments: StyleAdjustments;
  /** 自定义追加关键词 */
  customStyleKeywords: string;
  /** 平台适配（可选，爆款增强） */
  platformId?: string;
  createdAt: string;
  updatedAt: string;
}

/** 章节（一个项目多章节，共享角色库/场景库） */
export interface ComicChapter {
  id: string;
  projectId: string;
  title: string;
  /** 章节在项目内的序号（从 1 开始） */
  index: number;
  sourceType: ComicSourceType;
  /**
   * 原文正文。导入时一次性写入，此后只读——
   * 分镜/台词仅通过 startIndex/endIndex 引用，绝不改写此字段。
   */
  sourceContent: string;
  /** 原文字符数（冗余存储便于列表展示与校验） */
  sourceCharCount: number;
  /** 灵感导入时的参数与产出记录 */
  inspiration?: { brief: InspirationBrief; draft: InspirationDraft };
  createdAt: string;
  updatedAt: string;
  versions: ChapterVersions;
  /** 全局分镜密度方案 */
  densityPlan: { global: ShotDensityLevel; dynamic: boolean };
  /** 分镜顺序 */
  panelOrder: string[];
  /** 台词提取是否已执行过 */
  dialogueExtracted: boolean;
  /** 运营文案（按 平台id 存储） */
  marketing: Record<string, MarketingCopy>;
}

/** 场景动态参数（时间/天气/光影） */
export interface SceneDynamicParams {
  time: string;
  weather: string;
  lighting: string;
}

/** 角色卡 */
export interface ComicCharacter {
  id: string;
  projectId: string;
  name: string;
  gender: string;
  appearance: string;
  clothing: string;
  features: string;
  /** 描述词片段（由设定组装，可手动编辑） */
  promptFragment: string;
  /** 正面参考图 blob id */
  frontImageId?: string;
  /** 侧面参考图 blob id */
  sideImageId?: string;
  /** 合并前的同名角色 id 记录 */
  mergedFrom?: string[];
  updatedAt: string;
}

/** 场景卡：固定空间结构 + 动态参数 */
export interface ComicScene {
  id: string;
  projectId: string;
  name: string;
  /** 基础空间结构（固定复用） */
  spaceStructure: string;
  /** 环境描述（固定复用） */
  environment: string;
  /** 动态参数默认值，分镜可覆盖 */
  dynamic: SceneDynamicParams;
  promptFragment: string;
  /** 合并前的同名场景 id 记录 */
  mergedFrom?: string[];
  updatedAt: string;
}

/** 台词气泡布局（百分比定位） */
export interface DialogueLayout {
  /** 距左百分比 0-100 */
  x: number;
  /** 距上百分比 0-100 */
  y: number;
  /** 宽度百分比 0-100 */
  width: number;
  /** 字号缩放，1 为基准 */
  fontScale: number;
}

/** 分镜台词（原文只读，引用索引） */
export interface PanelDialogue {
  id: string;
  /** 匹配到的角色 id（可能为空=未识别） */
  characterId?: string;
  characterName: string;
  text: string;
  sourceStartIndex: number;
  sourceEndIndex: number;
  /** 手动拖拽后的位置 */
  layout?: DialogueLayout;
  /** 字体样式微调 */
  fontStyle?: { bold?: boolean; color?: string };
}

/** 分镜元数据（LLM 增强，可跳过） */
export interface PanelMetadata {
  shotType?: ShotType;
  /** 出场角色 id 列表 */
  characterIds: string[];
  sceneId?: string;
  emotion?: EmotionLevel;
  /** 动作概述（用于描述词，非原文改写） */
  actionSummary: string;
}

/** 描述词分段 */
export interface PromptSegments {
  form: string;
  style: string;
  scene: string;
  characters: string;
  action: string;
  camera: string;
  /** 台词呈现提示（气泡/字幕/聊天框布局指引） */
  lettering: string;
  quality: string;
}

/** 分镜描述词 */
export interface PanelPrompt {
  /** 最终描述词 */
  final: string;
  /** 分段内容（便于单段编辑/批量替换） */
  segments: PromptSegments;
  /** 用户手动编辑过后不再自动覆盖 */
  manualOverride: boolean;
}

/** 分镜生成状态 */
export interface PanelGeneration {
  status: GenerationStatus;
  mode?: GenerationMode;
  /** 成功后的图片 blob id（comic:image:{id}） */
  imageId?: string;
  /** 已尝试次数（失败自动重试上限 3） */
  attempts: number;
  error?: string;
  updatedAt: string;
}

/** 漫画分镜：原文只读，用字符索引锚定 */
export interface ComicPanel {
  id: string;
  projectId: string;
  chapterId: string;
  /** 在章节内的顺序（0 起） */
  order: number;
  /** 原文片段起始索引（含） */
  sourceStartIndex: number;
  /** 原文片段结束索引（不含） */
  sourceEndIndex: number;
  /** 本镜实际应用的密度 */
  densityApplied: ShotDensityLevel;
  /** 用户分段设置的密度覆盖（重切时优先） */
  densityOverride?: ShotDensityLevel;
  metadata?: PanelMetadata;
  dialogues: PanelDialogue[];
  prompt?: PanelPrompt;
  generation: PanelGeneration;
  /** 生成分镜内容时的上游版本快照（stale 计算依据） */
  upstreamVersions: ChapterVersions;
  /** 台词提取时所基于的上游版本（缺失＝尚未提取过） */
  dialogueBasis?: PanelStageBasis;
  /** 描述词生成时所基于的上游版本（缺失＝尚未生成） */
  promptBasis?: PanelStageBasis;
  /** 当前成品图所基于的描述词/表现层版本（缺失＝尚未成功生成） */
  imageBasis?: PanelImageBasis;
  createdAt: string;
  updatedAt: string;
}

/** 生成/重绘任务（持久化以支持断点续传） */
export interface GenerationTask {
  id: string;
  projectId: string;
  chapterId: string;
  panelId: string;
  mode: GenerationMode;
  status: GenerationStatus;
  attempts: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** 图片 blob 的元数据记录（blob 本体存 comic:image:{id}） */
export interface ComicImageRecord {
  id: string;
  projectId: string;
  kind: ComicImageKind;
  mime: string;
  byteSize: number;
  /** 远程图片地址：生成服务返回 URL 且跨域读取失败时记录，用于直接展示（可能随平台过期） */
  remoteUrl?: string;
  createdAt: string;
}

/** 运营文案（爆款增强） */
export interface MarketingCopy {
  platformId: string;
  title: string;
  summary: string;
  post: string;
  tags: string[];
  generatedAt: string;
}

/** 用户保存的个人描述词模板（覆盖默认公式模板，存全局设置） */
export interface CustomPromptFormula {
  segmentTemplates: Partial<Record<keyof PromptSegments, string>>;
  updatedAt: string;
}

/** 个人风格预设库 / AI 配置等全局设置 */
export interface WorkbenchSettings {
  ai: AiConnectionSettings | null;
  customStylePresets: CustomStylePreset[];
  /** 自定义描述词公式模板（未设置时使用 config/promptFormula.json 默认值） */
  customPromptFormula?: CustomPromptFormula;
  /** 最近打开的项目（用于恢复现场） */
  lastProjectId?: string;
  lastChapterByProject: Record<string, string>;
}

// ---------------------------------------------------------------------------
// IndexedDB 键空间约定
// ---------------------------------------------------------------------------

/** idb-keyval 键名生成器（集中管理避免散落字符串） */
export const ComicDbKeys = {
  projectIndex: () => "comic:index:projects",
  project: (id: string) => `comic:project:${id}`,
  chapterIndexOfProject: (projectId: string) => `comic:index:chapters:${projectId}`,
  chapter: (id: string) => `comic:chapter:${id}`,
  panelIndexOfChapter: (chapterId: string) => `comic:index:panels:${chapterId}`,
  panel: (id: string) => `comic:panel:${id}`,
  characterIndexOfProject: (projectId: string) => `comic:index:characters:${projectId}`,
  character: (id: string) => `comic:character:${id}`,
  sceneIndexOfProject: (projectId: string) => `comic:index:scenes:${projectId}`,
  scene: (id: string) => `comic:scene:${id}`,
  image: (id: string) => `comic:image:${id}`,
  imageRecord: (id: string) => `comic:imageRecord:${id}`,
  imageRecordIndexOfProject: (projectId: string) => `comic:index:imageRecords:${projectId}`,
  generationTaskIndexOfChapter: (chapterId: string) => `comic:index:genTasks:${chapterId}`,
  generationTask: (id: string) => `comic:genTask:${id}`,
  settings: () => "comic:settings",
  marketing: (chapterId: string, platformId: string) => `comic:marketing:${chapterId}:${platformId}`,
} as const;

/** 项目列表条目（列表页轻量展示） */
export interface ComicProjectSummary {
  id: string;
  name: string;
  formId: string;
  stylePresetId: string;
  chapterCount: number;
  updatedAt: string;
}
