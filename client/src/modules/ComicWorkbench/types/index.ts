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

/** 导入预处理规则 —— config/chapterPatterns.json */
export interface ChapterPatternsConfig {
  /** 章节号标题（第X章 / 第十二回 / Chapter 1） */
  chapterHeadingPatterns: string[];
  /** 剧情性特殊章名（序章/楔子/番外等，视为正文章节） */
  storyHeadingPatterns: string[];
  /** 非正文块标题（前言/导语/简介等，默认跳过分镜） */
  frontMatterHeadingPatterns: string[];
  /** 作者话标题（作者的话/感言/公告等，默认跳过分镜） */
  authorNoteHeadingPatterns: string[];
  /** 标题行最大长度（超过则视为正文） */
  headingMaxChars: number;
  /** 章号后标题部分的最大长度 */
  headingTitleMaxChars: number;
  /** 章号后无分隔符直接接文字时，允许的标题最大长度 */
  headingTightTitleMaxChars: number;
  /** 无分隔符标题不允许以这些虚词开头（正文续写的典型特征） */
  headingTightTitleForbiddenStarts: string;
  /** 标题行不允许出现的句读字符 */
  headingPunctuationForbidden: string;
  /** 纯数字章节号（如单独一行「12」） */
  pureNumberHeadingPattern: string;
  pureNumberMaxChars: number;
  /** 非正文块标题行最大长度 */
  frontMatterHeadingMaxChars: number;
  /** 非正文块最大字符数（超过则视为正文，防误判整章） */
  frontMatterMaxChars: number;
  /** 广告/推广行（命中且行长 ≤ junkLineMaxChars 时删除） */
  junkLinePatterns: string[];
  junkLineMaxChars: number;
  /** 纯装饰分隔线行（删除） */
  separatorLinePattern: string;
  /** 不可见字符（正文中的零宽字符等，静默清除） */
  invisibleCharPattern: string;
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
  /** 台词逐字绘制进画面的提示（按 letteringMode，含 {dialoguesText}/{sfxText} 占位符） */
  letteringEmbedHints: Record<ComicLetteringMode, string>;
  /** 空镜（无人物）时角色段的替代提示 */
  emptyShotHint: string;
  /** 画质词（按生成模式） */
  qualityWords: Record<GenerationMode, string>;
  /** 线条粗细的中文展示词（UI 与描述词共用） */
  lineWeightLabels: Record<StyleAdjustments["lineWeight"], string>;
  /** 光影强度的中文展示词 */
  lightingLabels: Record<StyleAdjustments["lighting"], string>;
  /** 全局负面词 */
  negativeWords: string;
}

/** 漫画模块 AI 运行参数 —— config/aiProviders.json（只含默认参数与尺寸档位，服务商/模型配置全部来自主程序） */
export interface AiProvidersConfig {
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
    /** 主程序支持的分镜图尺寸档位（宽x高） */
    imageSizes: string[];
  };
}

/**
 * 生图模型选择：显式指定主程序的服务商/模型；缺省时使用主程序当前选中的生图模型。
 * 文本模型不再单独配置，直接使用主程序当前文本模型。
 */
export interface ComicImageModelChoice {
  /** 主程序生图服务商 id（如 openai / ark / grsai），缺省 = 跟随主程序 */
  providerId?: string;
  /** 模型名，缺省 = 跟随主程序该服务商的默认生图模型 */
  model?: string;
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

/** 导入时识别的非正文块（前言/导语/作者的话等）：内容完整保留，但不参与分镜 */
export interface ChapterAnnotation {
  id: string;
  kind: "frontMatter" | "authorNote";
  /** 块标题（如「前言」「作者的话」） */
  title: string;
  content: string;
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
  /** 非正文块（前言/作者的话等），导入时识别并单独存放，不参与分镜 */
  annotations?: ChapterAnnotation[];
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
  /** 台词/旁白/声效是否绘制进画面（true 时描述词含逐字绘制指令；缺省视为开启） */
  letteringEmbed?: boolean;
  /** 运营文案（按 平台id 存储） */
  marketing: Record<string, MarketingCopy>;
}

/** 场景动态参数（时间/天气/光影） */
export interface SceneDynamicParams {
  time: string;
  weather: string;
  lighting: string;
}

/**
 * 人物设计图视图：4 全身转向 + 3 面部特写。
 * 同一角色固定 7 张设定图，供分镜生图时保持人物一致性参考。
 */
export type CharacterDesignView =
  | "full_front"
  | "full_three_quarter"
  | "full_side"
  | "full_back"
  | "face_front"
  | "face_three_quarter"
  | "face_side";

/** 人物设计图集合（值为图片 blob 记录 id，缺省表示该视图尚未生成） */
export interface CharacterDesignImages {
  full_front?: string;
  full_three_quarter?: string;
  full_side?: string;
  full_back?: string;
  face_front?: string;
  face_three_quarter?: string;
  face_side?: string;
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
  /** 主色调/色板（锁定角色用色，设计图与分镜描述词引用） */
  palette?: string;
  /** 描述词片段（由设定组装，可手动编辑） */
  promptFragment: string;
  /** 正面参考图 blob id */
  frontImageId?: string;
  /** 侧面参考图 blob id */
  sideImageId?: string;
  /** 人物设计图（7 视图） */
  designImages?: CharacterDesignImages;
  /** 生成设计图时的设定快照（promptFragment），设定变更后提示重新生成 */
  designBasisStamp?: string;
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
  /** 场景概念图 blob 记录 id */
  imageId?: string;
  /** 生成场景图时的设定快照（promptFragment），设定变更后提示重新生成 */
  imageBasisStamp?: string;
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
/** 台词类型：对白（角色说的话）/ 旁白（画外音叙事）/ 内心独白 */
export type DialogueKind = "dialogue" | "narration" | "inner";

export interface PanelDialogue {
  id: string;
  /** 台词类型；旧数据缺省视为对白 */
  kind?: DialogueKind;
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
  /** 画面拟声/音效词（如「轰——」，随台词嵌入图片，可选） */
  sfx?: string;
  /** 该镜是否为空镜（无人物台词、仅环境或情绪留白） */
  emptyShot?: boolean;
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
  /** 主程序生图任务 id（comic_panel 场景，任务级归属） */
  taskId?: string;
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
  /** 生图模型覆盖选择（文本模型与 API Key 一律使用主程序配置）；null = 全部跟随主程序 */
  ai: { image: ComicImageModelChoice } | null;
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
