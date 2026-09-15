/**
 * 描述词引擎：公式组装（不走大模型）
 *
 * 按 config/promptFormula.json 的 segmentOrder 依次渲染 8 个段落
 * （形态/画风/场景/角色/剧情/镜头/台词呈现/画质），占位符运行时替换，
 * 空段自动跳过。数据来源：项目形态画风 + 分镜元数据 + 角色/场景卡 + 台词。
 *
 * 手动编辑后 panel.prompt.manualOverride 置位，批量重建默认跳过该镜。
 * 个人模板（customPromptFormula）只覆盖 segmentTemplates，存全局设置。
 */
import { getFormById, getStylePresetById, promptFormula } from "./configService";
import { getSettings, savePanel, saveChapter, saveSettings } from "../db/comicDb";
import type {
  ComicChapter,
  ComicCharacter,
  ComicPanel,
  ComicProject,
  ComicScene,
  CustomPromptFormula,
  PanelPrompt,
  PromptSegments,
} from "../types";

// ---------------------------------------------------------------------------
// 公式组装
// ---------------------------------------------------------------------------

export interface PromptBuildInput {
  chapter: ComicChapter;
  panel: ComicPanel;
  project: ComicProject;
  characters: ComicCharacter[];
  scenes: ComicScene[];
  /** 用户保存的个人模板（覆盖默认 segmentTemplates） */
  customFormula?: CustomPromptFormula | null;
}

/** 生效的段模板（个人模板覆盖默认） */
export function resolveTemplates(customFormula?: CustomPromptFormula | null) {
  return { ...promptFormula.segmentTemplates, ...(customFormula?.segmentTemplates ?? {}) };
}

/** 按公式组装单个分镜描述词（manualOverride=false） */
export function buildPanelPrompt(input: PromptBuildInput): PanelPrompt {
  const { chapter, panel, project } = input;
  const form = getFormById(project.formId);
  const style = getStylePresetById(project.stylePresetId);
  const metadata = panel.metadata;
  const scene = metadata?.sceneId
    ? input.scenes.find((item) => item.id === metadata.sceneId)
    : undefined;

  // 出场角色：优先元数据，其次本镜台词的说话人
  const characterIds = new Set(metadata?.characterIds ?? []);
  for (const dialogue of panel.dialogues) {
    if (dialogue.characterId) characterIds.add(dialogue.characterId);
  }
  const charactersText = [...characterIds]
    .map((id) => input.characters.find((character) => character.id === id))
    .filter((character): character is ComicCharacter => Boolean(character))
    .map((character) => character.promptFragment || character.name)
    .join("；");

  // 剧情段：元数据动作概述优先，缺失时回落到本镜原文（只读引用，不回写）
  const sourceText = chapter.sourceContent
    .slice(panel.sourceStartIndex, panel.sourceEndIndex)
    .trim();
  const actionText =
    metadata?.actionSummary && metadata.actionSummary.trim().length > 0
      ? metadata.actionSummary
      : truncateForPrompt(sourceText, promptFormula.actionFallbackCharLimit);

  const letteringMode = form?.letteringMode ?? "bubble";
  const letteringHint = (promptFormula.letteringHints[letteringMode] ?? "").replaceAll(
    "{dialogueCount}",
    String(panel.dialogues.length),
  );

  const adjustments = project.styleAdjustments;
  const trimmedCustom = project.customStyleKeywords.trim();
  const values: Record<string, string> = {
    formPromptPrefix: form?.promptPrefix ?? "",
    styleKeywords: style?.promptKeywords ?? "",
    colorTone: adjustments.colorTone,
    lineWeight: promptFormula.lineWeightLabels[adjustments.lineWeight] ?? adjustments.lineWeight,
    lighting: promptFormula.lightingLabels[adjustments.lighting] ?? adjustments.lighting,
    customKeywords: trimmedCustom ? `，${trimmedCustom}` : "",
    sceneName: scene?.name ?? "",
    sceneSpace: scene?.spaceStructure ?? "",
    sceneEnvironment: scene?.environment ?? "",
    sceneTime: scene?.dynamic.time ?? "",
    sceneWeather: scene?.dynamic.weather ?? "",
    sceneLighting: scene?.dynamic.lighting ?? "",
    charactersText,
    actionSummary: actionText,
    cameraDirective: metadata?.shotType
      ? (promptFormula.cameraDirectives[metadata.shotType] ?? "")
      : "",
    letteringHint,
    qualityWords: promptFormula.qualityWords.hd,
  };

  const templates = resolveTemplates(input.customFormula);
  const segments: PromptSegments = {
    form: "",
    style: "",
    scene: "",
    characters: "",
    action: "",
    camera: "",
    lettering: "",
    quality: "",
  };
  for (const key of promptFormula.segmentOrder) {
    segments[key] = cleanupSegment(fillTemplate(templates[key] ?? "", values));
  }

  return { final: joinSegments(segments), segments, manualOverride: false };
}

/** 按公式顺序拼接非空段 */
export function joinSegments(segments: PromptSegments): string {
  return promptFormula.segmentOrder
    .map((key) => segments[key])
    .filter((text) => text.length > 0)
    .join(promptFormula.segmentJoiner);
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => values[key] ?? "");
}

/** 段内清理：占位符为空时模板会留下洞（连续连接符/空值标签） */
function cleanupSegment(text: string): string {
  return text
    .replace(/，\s*，+/g, "，")
    .replace(/[一-龥]{1,4}：(?=，|$)/g, "")
    .replace(/，\s*，+/g, "，")
    .replace(/^[，\s]+|[，\s]+$/g, "")
    .trim();
}

function truncateForPrompt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

// ---------------------------------------------------------------------------
// 批量生成与单镜编辑
// ---------------------------------------------------------------------------

export interface GeneratePromptsParams {
  chapter: ComicChapter;
  panels: ComicPanel[];
  project: ComicProject;
  characters: ComicCharacter[];
  scenes: ComicScene[];
  customFormula?: CustomPromptFormula | null;
  /** true 时连同手动编辑过的分镜一起重建 */
  includeManual: boolean;
  onProgress?: (done: number, total: number) => void;
}

/** 按公式批量生成本章全部分镜描述词，完成后递增章节描述词版本 */
export async function generateChapterPrompts(params: GeneratePromptsParams): Promise<number> {
  let updated = 0;
  let done = 0;
  for (const panel of params.panels) {
    if (panel.prompt?.manualOverride && !params.includeManual) {
      done += 1;
      params.onProgress?.(done, params.panels.length);
      continue;
    }
    panel.prompt = buildPanelPrompt({ ...params, panel });
    panel.updatedAt = new Date().toISOString();
    await savePanel(panel);
    updated += 1;
    done += 1;
    params.onProgress?.(done, params.panels.length);
  }
  params.chapter.versions.prompt += 1;
  params.chapter.updatedAt = new Date().toISOString();
  await saveChapter(params.chapter);
  return updated;
}

/** 保存单镜手动编辑（段落可改，最终词由公式顺序重新拼接） */
export async function applyPromptEdit(panel: ComicPanel, segments: PromptSegments): Promise<ComicPanel> {
  const next: ComicPanel = {
    ...panel,
    prompt: {
      final: joinSegments(segments),
      segments,
      manualOverride: true,
    },
    updatedAt: new Date().toISOString(),
  };
  await savePanel(next);
  return next;
}

/** 将单镜重置为公式自动组装（清除手动标记） */
export async function resetPanelPrompt(params: {
  chapter: ComicChapter;
  panel: ComicPanel;
  project: ComicProject;
  characters: ComicCharacter[];
  scenes: ComicScene[];
  customFormula?: CustomPromptFormula | null;
}): Promise<ComicPanel> {
  const next: ComicPanel = {
    ...params.panel,
    prompt: buildPanelPrompt(params),
    updatedAt: new Date().toISOString(),
  };
  await savePanel(next);
  return next;
}

// ---------------------------------------------------------------------------
// 个人模板（存全局设置）
// ---------------------------------------------------------------------------

export async function getCustomPromptFormula(): Promise<CustomPromptFormula | null> {
  const settings = await getSettings();
  return settings.customPromptFormula ?? null;
}

export async function saveCustomPromptFormula(
  formula: CustomPromptFormula | null,
): Promise<void> {
  const settings = await getSettings();
  await saveSettings({ ...settings, customPromptFormula: formula ?? undefined });
}
