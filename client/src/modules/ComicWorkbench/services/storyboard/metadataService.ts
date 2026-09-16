/**
 * 分镜元数据 LLM 增强（可跳过）
 *
 * 元数据 = 镜头类型 / 情绪 / 动作概述 / 出场角色 / 场景 / 拟声词 / 空镜标记，
 * 仅作为描述词素材，不回写、不改写原文（规则第5条）。
 * 未配置大模型时可整体跳过，元数据缺失时描述词引擎按缺省值工作。
 *
 * 角色/场景绑定：LLM 从项目角色库/场景库名单中按名字选择，服务层把名字
 * 映射回 id 写入 metadata.characterIds / metadata.sceneId；映射不上的名字
 * 会被丢弃，保证描述词引擎只引用真实存在的卡片。
 */
import { z } from "zod";
import type { ComicChapter, ComicCharacter, ComicPanel, ComicScene } from "../../types";
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
      /** 出场角色名（必须来自提供的角色名单，最多 4 个） */
      characterNames: z.array(z.string().min(1)).max(4).optional(),
      /** 所处场景名（必须来自提供的场景名单） */
      sceneName: z.string().min(1).max(30).optional(),
      /** 画面拟声词（不超过 6 字，可省略） */
      sfx: z.string().min(1).max(12).optional(),
      /** 该镜无人物、仅环境/情绪留白时为 true */
      emptyShot: z.boolean().optional(),
    }),
  ),
});

const SYSTEM_PROMPT = [
  "你是漫画分镜导演助手。根据每个分镜的原文片段，判断画面语言元数据。",
  "只输出 JSON，结构：{\"panels\":[{\"index\":0,\"shotType\":\"medium\",\"emotion\":\"tense\",\"actionSummary\":\"…\",\"characterNames\":[\"…\"],\"sceneName\":\"…\",\"sfx\":\"…\",\"emptyShot\":false}]}。",
  "shotType 取值：wide（远景/全景）、medium（中景）、closeUp（特写）、extremeCloseUp（大特写）、overShoulder（过肩）、aerial（俯瞰）、pov（主观视角）。",
  "emotion 取值：calm、tense、joyful、sad、angry、suspenseful、romantic、shocked。",
  "actionSummary 用不超过30字概括画面正在发生的动作，供文生图使用，禁止照抄大段原文。",
  "characterNames：从提供的角色名单中选出本镜出场角色（原文中出现名字优先），名单里没有的角色禁止输出；确无出场可省略。",
  "sceneName：从提供的场景名单中选出本镜所处场景，名单里没有的场景禁止输出；确无法判断可省略。",
  "sfx：画面适合配拟声/音效词时给一个不超过6字的中文拟声词（如「轰」「哗啦」），可省略。",
  "emptyShot：本镜没有人物、仅环境或情绪留白时输出 true，可省略。",
  "必须覆盖输入的每一个 index，不得遗漏。",
].join("\n");

export interface EnrichMetadataParams {
  chapter: ComicChapter;
  panels: ComicPanel[];
  /** 项目角色库：LLM 输出的角色名按此映射回 id */
  characters: ComicCharacter[];
  /** 项目场景库：LLM 输出的场景名按此映射回 id */
  scenes: ComicScene[];
  settings: AiConnectionSettings;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * 为分镜批量生成元数据并落库。
 * 返回成功更新的分镜数；单批失败抛出 AiError，由调用方决定是否继续。
 */
export async function enrichPanelMetadata(params: EnrichMetadataParams): Promise<number> {
  const { chapter, panels, characters, scenes, settings, signal, onProgress } = params;
  const eligible = panels.filter(
    (panel) => panel.sourceEndIndex > panel.sourceStartIndex,
  );
  const charactersByName = new Map(characters.map((character) => [character.name, character]));
  const scenesByName = new Map(scenes.map((scene) => [scene.name, scene]));
  let updated = 0;
  let done = 0;

  for (let start = 0; start < eligible.length; start += BATCH_SIZE) {
    const batch = eligible.slice(start, start + BATCH_SIZE);
    const userPrompt = buildUserPrompt(chapter, batch, characters, scenes);
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
        characterIds: resolveCharacterIds(hit.characterNames, charactersByName) ??
          panel.metadata?.characterIds ?? [],
        sceneId: resolveSceneId(hit.sceneName, scenesByName) ?? panel.metadata?.sceneId,
        shotType: hit.shotType ?? panel.metadata?.shotType,
        emotion: hit.emotion ?? panel.metadata?.emotion,
        actionSummary: hit.actionSummary ?? panel.metadata?.actionSummary ?? "",
        sfx: hit.sfx ?? panel.metadata?.sfx,
        emptyShot: hit.emptyShot ?? panel.metadata?.emptyShot,
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

/** 角色名 → 角色卡 id（精确匹配优先，其次前/后缀包含；映射不上的名字丢弃） */
function resolveCharacterIds(
  names: string[] | undefined,
  charactersByName: Map<string, ComicCharacter>,
): string[] | null {
  if (!names || names.length === 0) return null;
  const ids: string[] = [];
  for (const name of names) {
    const exact = charactersByName.get(name);
    if (exact) {
      if (!ids.includes(exact.id)) ids.push(exact.id);
      continue;
    }
    for (const character of charactersByName.values()) {
      if (
        (character.name.includes(name) || name.includes(character.name)) &&
        !ids.includes(character.id)
      ) {
        ids.push(character.id);
        break;
      }
    }
  }
  return ids.length > 0 ? ids : null;
}

/** 场景名 → 场景卡 id（精确匹配优先，其次前/后缀包含） */
function resolveSceneId(
  name: string | undefined,
  scenesByName: Map<string, ComicScene>,
): string | null {
  if (!name) return null;
  const exact = scenesByName.get(name);
  if (exact) return exact.id;
  for (const scene of scenesByName.values()) {
    if (scene.name.includes(name) || name.includes(scene.name)) return scene.id;
  }
  return null;
}

function buildUserPrompt(
  chapter: ComicChapter,
  batch: ComicPanel[],
  characters: ComicCharacter[],
  scenes: ComicScene[],
): string {
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
  const castLine =
    characters.length > 0
      ? `\n角色名单（characterNames 只能从这里选）：${characters.map((character) => character.name).join("、")}`
      : "\n（本项目暂无角色卡，characterNames 省略）";
  const sceneLine =
    scenes.length > 0
      ? `\n场景名单（sceneName 只能从这里选）：${scenes.map((scene) => scene.name).join("、")}`
      : "\n（本项目暂无场景卡，sceneName 省略）";
  return `章节标题：${chapter.title}${narrativeLine}${castLine}${sceneLine}\n\n请为以下 ${batch.length} 个分镜输出元数据 JSON：\n\n${lines.join("\n\n")}`;
}

/** 元数据增强失败的统一文案（规则第12条错误兜底） */
export function describeMetadataError(error: unknown): string {
  const aiError = error as AiError | undefined;
  if (aiError && typeof aiError === "object" && "kind" in aiError) {
    return describeAiError(error);
  }
  return error instanceof Error ? error.message : "元数据生成失败";
}

// ---------------------------------------------------------------------------
// 角色/场景绑定：手动保存与一键修复
// ---------------------------------------------------------------------------

export interface SavePanelBindingParams {
  chapter: ComicChapter;
  panel: ComicPanel;
  characterIds: string[];
  sceneId?: string;
}

/**
 * 保存单镜的角色/场景绑定并递增元数据版本，
 * 提示描述词待更新（规则第7条：上游变化不静默改写下游）。
 */
export async function savePanelBinding(params: SavePanelBindingParams): Promise<ComicPanel> {
  const next: ComicPanel = {
    ...params.panel,
    metadata: {
      ...(params.panel.metadata ?? { characterIds: [], actionSummary: "" }),
      characterIds: params.characterIds,
      sceneId: params.sceneId,
      // 手动重新绑定后清掉「无人空镜」标记，绑定状态以用户操作为准
      emptyShot: params.characterIds.length > 0 ? false : params.panel.metadata?.emptyShot,
    },
    updatedAt: new Date().toISOString(),
  };
  await savePanels([next]);
  params.chapter.versions.metadata = (params.chapter.versions.metadata ?? 0) + 1;
  params.chapter.updatedAt = new Date().toISOString();
  await saveChapter(params.chapter);
  return next;
}

export interface RepairBindingsResult {
  repaired: number;
  /** 无法自动修复、需要在右栏手动绑定的分镜数 */
  manual: number;
}

/**
 * 一键修复绑定缺失（确定性规则，不走大模型）：
 * 1. 台词说话人 → 角色绑定；
 * 2. 全项目仅一个场景时 → 所有分镜绑定该场景；
 * 3. 无台词且推断不出角色的叙述镜 → 标记空镜（描述词按无人氛围镜渲染）。
 */
export async function repairPanelBindings(params: {
  chapter: ComicChapter;
  panels: ComicPanel[];
  scenes: ComicScene[];
}): Promise<RepairBindingsResult> {
  const { chapter, panels, scenes } = params;
  const singleSceneId = scenes.length === 1 ? (scenes[0]?.id ?? undefined) : undefined;
  const changed: ComicPanel[] = [];
  let manual = 0;

  for (const panel of panels) {
    if (panel.sourceEndIndex <= panel.sourceStartIndex) continue; // 转场空镜不处理
    const metadata = panel.metadata ?? { characterIds: [], actionSummary: "" };
    const ids = new Set(metadata.characterIds);
    for (const dialogue of panel.dialogues) {
      if (dialogue.characterId) ids.add(dialogue.characterId);
    }
    const nextSceneId = metadata.sceneId ?? singleSceneId;
    const hasCharacter = ids.size > 0;
    const nextEmptyShot =
      hasCharacter || panel.dialogues.length > 0 ? false : (metadata.emptyShot ?? true);
    if (!hasCharacter) manual += 1;

    const changedMeta =
      ids.size !== metadata.characterIds.length ||
      nextSceneId !== metadata.sceneId ||
      nextEmptyShot !== metadata.emptyShot;
    if (!changedMeta) continue;
    panel.metadata = {
      ...metadata,
      characterIds: [...ids],
      sceneId: nextSceneId,
      emptyShot: nextEmptyShot,
    };
    panel.updatedAt = new Date().toISOString();
    changed.push(panel);
  }

  if (changed.length > 0) {
    await savePanels(changed);
    chapter.versions.metadata = (chapter.versions.metadata ?? 0) + 1;
    chapter.updatedAt = new Date().toISOString();
    await saveChapter(chapter);
  }
  return { repaired: changed.length, manual };
}
