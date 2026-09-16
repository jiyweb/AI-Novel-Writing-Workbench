/**
 * 配置加载服务
 *
 * 规则约束（comic-workbench-rule.md 第6条）：所有形态/画风/密度/描述词模板
 * 全部来自 config/*.json，禁止硬编码。此处用 zod 做运行时校验，
 * 用户改坏 JSON 时给出可定位的友好错误，而不是让页面崩溃。
 */
import { z } from "zod";
import comicFormsJson from "../config/comicForms.json";
import stylePresetsJson from "../config/stylePresets.json";
import shotDensityJson from "../config/shotDensity.json";
import promptFormulaJson from "../config/promptFormula.json";
import aiProvidersJson from "../config/aiProviders.json";
import narrativeTemplatesJson from "../config/narrativeTemplates.json";
import sensitiveWordsJson from "../config/sensitiveWords.json";
import type {
  AiProvidersConfig,
  ComicFormConfig,
  NarrativeTemplatesConfig,
  PromptFormulaConfig,
  ShotDensityConfig,
  StylePresetConfig,
  SensitiveWordsConfig,
} from "../types";

// ---------------------------------------------------------------------------
// zod schema（与 types/index.ts 对齐）
// ---------------------------------------------------------------------------

const comicFormSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aspectRatio: z.string().min(1),
  ratioWidth: z.number().positive(),
  ratioHeight: z.number().positive(),
  referencePixel: z.object({ width: z.number().positive(), height: z.number().positive() }),
  draftPixel: z.object({ width: z.number().positive(), height: z.number().positive() }),
  panelGrid: z.object({
    minPerImage: z.number().int().min(1),
    maxPerImage: z.number().int().min(1),
    defaultPerImage: z.number().int().min(1),
  }),
  letteringMode: z.enum(["bubble", "caption", "chat", "none"]),
  promptPrefix: z.string(),
  description: z.string(),
  preview: z.object({
    layout: z.enum(["vertical", "grid", "single", "chat"]),
    blockCount: z.number().int().min(1),
    accentColor: z.string(),
  }),
});

const stylePresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  promptKeywords: z.string(),
  negativeKeywords: z.string().optional(),
  adjustments: z.object({
    colorTone: z.string(),
    lineWeight: z.enum(["thin", "normal", "bold"]),
    quality: z.enum(["standard", "fine", "ultra"]),
    lighting: z.enum(["soft", "balanced", "strong"]),
  }),
});

const shotDensitySchema = z.object({
  defaultDensity: z.enum(["ultraTight", "tight", "standard", "loose", "ultraLoose"]),
  levels: z
    .array(
      z.object({
        id: z.enum(["ultraTight", "tight", "standard", "loose", "ultraLoose"]),
        name: z.string(),
        minSentences: z.number().int().min(1),
        maxSentences: z.number().int().min(1),
        description: z.string(),
      }),
    )
    .min(5),
  splitRules: z.object({
    sentenceEndChars: z.string().min(1),
    clauseBreakChars: z.string(),
    maxPanelChars: z.number().int().positive(),
    minPanelChars: z.number().int().positive(),
    sceneChangeForceSplit: z.boolean(),
    sceneChangeMarkers: z.array(z.string()),
    dialogueSeparateFromNarration: z.boolean(),
    dialogueOpenChars: z.string().min(1),
    dialogueCloseChars: z.string().min(1),
  }),
  dynamicDensity: z.object({
    enabled: z.boolean(),
    climaxKeywords: z.array(z.string()),
    dialogueBoost: z.boolean(),
  }),
});

const promptFormulaSchema = z.object({
  segmentOrder: z.array(
    z.enum(["form", "style", "scene", "characters", "action", "camera", "lettering", "quality"]),
  ).min(1),
  segmentJoiner: z.string(),
  actionFallbackCharLimit: z.number().int().positive(),
  segmentTemplates: z.record(z.string(), z.string()),
  cameraDirectives: z.record(z.string(), z.string()),
  letteringHints: z.record(z.string(), z.string()),
  letteringEmbedHints: z.record(z.string(), z.string()),
  emptyShotHint: z.string().min(1),
  qualityWords: z.record(z.string(), z.string()),
  lineWeightLabels: z.record(z.string(), z.string()),
  lightingLabels: z.record(z.string(), z.string()),
  negativeWords: z.string(),
});

const aiProvidersSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      kind: z.enum(["llm", "image", "both"]),
      llm: z
        .object({
          protocol: z.enum(["openai-chat", "ark-images", "grsai"]),
          defaultBaseUrl: z.string(),
          models: z.array(z.string()),
        })
        .optional(),
      image: z
        .object({
          protocol: z.enum(["openai-chat", "ark-images", "grsai"]),
          defaultBaseUrl: z.string(),
          models: z.array(z.string()),
        })
        .optional(),
      notes: z.string().optional(),
    }),
  ),
  appProviderAliases: z.record(z.string(), z.string()).optional(),
  defaults: z.object({
    llmTimeoutMs: z.number().positive(),
    longTextTimeoutMs: z.number().positive(),
    imageTimeoutMs: z.number().positive(),
    imagePollIntervalMs: z.number().positive(),
    imagePollMaxMs: z.number().positive(),
    maxRetries: z.number().int().min(1),
    retryBaseDelayMs: z.number().positive(),
    imageConcurrency: z.number().int().min(1),
  }),
});

const narrativeTemplatesSchema = z.object({
  templates: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string(),
      promptDirective: z.string(),
    }),
  ),
  platforms: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      recommendedFormId: z.string().min(1),
      pacingHint: z.string(),
    }),
  ),
});

const sensitiveWordsSchema = z.object({
  action: z.literal("warn"),
  words: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// 解析与导出（模块加载时执行一次；JSON 校验失败会抛出带文件名的错误）
// ---------------------------------------------------------------------------

function parseConfig<T>(fileName: string, schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.join(".") ?? "";
    throw new Error(
      `配置文件 ${fileName} 格式有误${path ? `（位置：${path}）` : ""}：${issue?.message ?? "未知错误"}。请修正后刷新页面。`,
    );
  }
  return result.data;
}

export const comicForms: ComicFormConfig[] = parseConfig(
  "comicForms.json",
  z.object({ forms: z.array(comicFormSchema).min(1) }),
  comicFormsJson,
).forms;

export const stylePresets: StylePresetConfig[] = parseConfig(
  "stylePresets.json",
  z.object({ presets: z.array(stylePresetSchema).min(1) }),
  stylePresetsJson,
).presets;

export const shotDensity: ShotDensityConfig = parseConfig(
  "shotDensity.json",
  shotDensitySchema,
  shotDensityJson,
);

export const promptFormula: PromptFormulaConfig = parseConfig(
  "promptFormula.json",
  promptFormulaSchema,
  promptFormulaJson,
);

export const aiProvidersConfig: AiProvidersConfig = parseConfig(
  "aiProviders.json",
  aiProvidersSchema,
  aiProvidersJson,
);

export const narrativeTemplates: NarrativeTemplatesConfig = parseConfig(
  "narrativeTemplates.json",
  narrativeTemplatesSchema,
  narrativeTemplatesJson,
);

export const sensitiveWords: SensitiveWordsConfig = parseConfig(
  "sensitiveWords.json",
  sensitiveWordsSchema,
  sensitiveWordsJson,
);

// ---------------------------------------------------------------------------
// 便捷查询
// ---------------------------------------------------------------------------

export function getFormById(id: string): ComicFormConfig | undefined {
  return comicForms.find((form) => form.id === id);
}

export function getStylePresetById(id: string): StylePresetConfig | undefined {
  return stylePresets.find((preset) => preset.id === id);
}

export function getDensityLevel(id: string) {
  return shotDensity.levels.find((level) => level.id === id);
}
