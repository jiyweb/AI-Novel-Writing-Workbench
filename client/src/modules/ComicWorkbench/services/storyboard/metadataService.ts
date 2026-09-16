/**
 * 分镜元数据 LLM 增强（可跳过）
 *
 * 元数据 = 镜头类型 / 情绪 / 动作概述，仅作为描述词素材，
 * 不回写、不改写原文（规则第5条）。未配置大模型时可整体跳过，
 * 元数据缺失时描述词引擎按缺省值工作。
 */
import { z } from "zod";
import type { ComicChapter, ComicPanel } from "../../types";
import { saveChapter, savePanels } from "../../db/comicDb";
import { chatJson, describeAiError, type AiError } from "../ai/llmClient";
import { narrativeTemplates } from "../configService";
import type { AiConnectionSettings } from "../../types";

/** 单次 LLM 调用处理的分镜数量（控制输出体积） */
const BATCH_SIZE = 8;
/** 单镜原文截断长度（元数据只需动作主干） */
const PANEL_TEXT_LIMIT = 240;

const shotTypeSchema = z.enum([
  "wide",
  "medium",
  "closeUp",
  "extremeCloseUp",
  "overShoulder",
  "aerial",
  "pov",
]);
const emotionSchema = z.enum([
  "calm",
  "tense",
  "joyful",
  "sad",
  "angry",
  "suspenseful",
  "romantic",
  "shocked",
]);

const batchSchema = z.object({
  panels: z.array(
    z.object({
      index: z.number().int().min(0),
      shotType: shotTypeSchema.optional(),
      emotion: emotionSchema.optional(),
      actionSummary: z.string().max(60).optional(),
    }),
  ),
});

const SYSTEM_PROMPT = [
  "你是漫画分镜导演助手。根据每个分镜的原文片段，判断画面语言元数据。",
  "只输出 JSON，结构：{\"panels\":[{\"index\":0,\"shotType\":\"medium\",\"emotion\":\"tense\",\"actionSummary\":\"…\"}]}。",
  "shotType 取值：wide（远景/全景）、medium（中景）、closeUp（特写）、extremeCloseUp（大特写）、overShoulder（过肩）、aerial（俯瞰）、pov（主观视角）。",
  "emotion 取值：calm、tense、joyful、sad、angry、suspenseful、romantic、shocked。",
  "actionSummary 用不超过30字概括画面正在发生的动作，供文生图使用，禁止照抄大段原文。",
  "必须覆盖输入的每一个 index，不得遗漏。",
].join("\n");

export interface EnrichMetadataParams {
  chapter: ComicChapter;
  panels: ComicPanel[];
  settings: AiConnectionSettings;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * 为分镜批量生成元数据并落库。
 * 返回成功更新的分镜数；单批失败抛出 AiError，由调用方决定是否继续。
 */
export async function enrichPanelMetadata(params: EnrichMetadataParams): Promise<number> {
  const { chapter, panels, settings, signal, onProgress } = params;
  const eligible = panels.filter(
    (panel) => panel.sourceEndIndex > panel.sourceStartIndex,
  );
  let updated = 0;
  let done = 0;

  for (let start = 0; start < eligible.length; start += BATCH_SIZE) {
    const batch = eligible.slice(start, start + BATCH_SIZE);
    const userPrompt = buildUserPrompt(chapter, batch);
    const result = await chatJson({
      settings,
      system: SYSTEM_PROMPT,
      user: userPrompt,
      schema: batchSchema,
      signal,
      temperature: 0.3,
    });

    const byIndex = new Map(result.panels.map((item) => [item.index, item]));
    for (const panel of batch) {
      const hit = byIndex.get(panel.order);
      if (!hit) continue;
      panel.metadata = {
        characterIds: panel.metadata?.characterIds ?? [],
        sceneId: panel.metadata?.sceneId,
        shotType: hit.shotType ?? panel.metadata?.shotType,
        emotion: hit.emotion ?? panel.metadata?.emotion,
        actionSummary: hit.actionSummary ?? panel.metadata?.actionSummary ?? "",
      };
      panel.updatedAt = new Date().toISOString();
      updated += 1;
    }
    done += batch.length;
    onProgress?.(done, eligible.length);
  }

  await savePanels(eligible);
  // 元数据是描述词素材：增强后递增元数据版本，提示描述词待更新（规则第7条，不静默改写）
  if (updated > 0) {
    chapter.versions.metadata = (chapter.versions.metadata ?? 0) + 1;
    chapter.updatedAt = new Date().toISOString();
    await saveChapter(chapter);
  }
  return updated;
}

function buildUserPrompt(chapter: ComicChapter, batch: ComicPanel[]): string {
  const lines = batch.map((panel) => {
    const text = chapter.sourceContent
      .slice(panel.sourceStartIndex, panel.sourceEndIndex)
      .replace(/\s+/g, " ")
      .slice(0, PANEL_TEXT_LIMIT);
    return `index=${panel.order}\n原文：${text}`;
  });
  // 爆款增强：章节带叙事模板时注入节奏要求，让镜头/情绪判断贴合该节奏
  const template = narrativeTemplates.templates.find(
    (item) => item.id === chapter.inspiration?.brief.narrativeTemplateId,
  );
  const narrativeLine = template ? `\n叙事节奏要求：${template.promptDirective}` : "";
  return `章节标题：${chapter.title}${narrativeLine}\n\n请为以下 ${batch.length} 个分镜输出元数据 JSON：\n\n${lines.join("\n\n")}`;
}

/** 元数据增强失败的统一文案（规则第12条错误兜底） */
export function describeMetadataError(error: unknown): string {
  const aiError = error as AiError | undefined;
  if (aiError && typeof aiError === "object" && "kind" in aiError) {
    return describeAiError(error);
  }
  return error instanceof Error ? error.message : "元数据生成失败";
}
