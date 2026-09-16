/**
 * 智能分镜 应用服务：密度方案 → 分镜生成 → 手动编排（拆/合/删/增/排序）
 *
 * 数据流单向（规则第7条）：分镜 regeneration 只递增 versions.storyboard
 * 并随面板快照 upstreamVersions；下游（台词/描述词/图片）据此自判 stale，
 * 本服务绝不静默改写下游数据。
 *
 * 原文零修改（规则第5条）：一切分镜只用 sourceStartIndex/sourceEndIndex 锚定
 * chapter.sourceContent，空镜（转场镜）允许零长度区间。
 *
 * 生成策略：大模型优先（LLM 对句级片段做分组），失败或结果不完整时
 * 自动回落本地规则分镜（generateStoryboardLocal），保证总有可用结果。
 */
import { z } from "zod";
import {
  deletePanels,
  generateId,
  listPanels,
  saveChapter,
  savePanels,
} from "../../db/comicDb";
import { getDensityLevel, shotDensity } from "../configService";
import { chatJson, describeAiError } from "../ai/llmClient";
import {
  findSplitOffset,
  groupSegmentsIntoPanels,
  segmentSourceText,
  type SourceSegment,
} from "./segmenter";
import type { AiConnectionSettings, ComicChapter, ComicPanel, ShotDensityLevel } from "../../types";

/** 面板生成字段的初始状态 */
function emptyGeneration(now: string): ComicPanel["generation"] {
  return { status: "pending", attempts: 0, updatedAt: now };
}

function buildPanel(params: {
  chapter: ComicChapter;
  order: number;
  sourceStartIndex: number;
  sourceEndIndex: number;
  densityApplied: ShotDensityLevel;
}): ComicPanel {
  const now = new Date().toISOString();
  return {
    id: generateId("panel"),
    projectId: params.chapter.projectId,
    chapterId: params.chapter.id,
    order: params.order,
    sourceStartIndex: params.sourceStartIndex,
    sourceEndIndex: params.sourceEndIndex,
    densityApplied: params.densityApplied,
    dialogues: [],
    generation: emptyGeneration(now),
    upstreamVersions: { ...params.chapter.versions },
    createdAt: now,
    updatedAt: now,
  };
}

/** 重排全部面板的 order 字段并写回 chapter.panelOrder + 章节（结构变更收口） */
async function rewriteOrder(chapter: ComicChapter, panels: ComicPanel[]): Promise<ComicPanel[]> {
  const ordered = [...panels].sort((a, b) => a.order - b.order);
  ordered.forEach((panel, index) => {
    panel.order = index;
  });
  chapter.panelOrder = ordered.map((panel) => panel.id);
  chapter.updatedAt = new Date().toISOString();
  await savePanels(ordered);
  await saveChapter(chapter);
  return ordered;
}

// ---------------------------------------------------------------------------
// 智能生成
// ---------------------------------------------------------------------------

export type StoryboardStrategy = "llm" | "local";

export interface GenerateStoryboardAutoResult {
  panels: ComicPanel[];
  /** llm = 大模型分组成功；local = 本地规则（含回落） */
  strategy: StoryboardStrategy;
  /** 回落本地时的原因说明（用于 UI 提示） */
  note?: string;
}

/** 单次 LLM 调用处理的句级片段数量（控制输出体积） */
const SEGMENTS_PER_BATCH = 30;

/** LLM 分组输出契约：把片段索引分组为分镜 */
const groupSchema = z.object({
  groups: z
    .array(z.object({ segmentIndexes: z.array(z.number().int().min(0)).min(1) }))
    .min(1),
});

const GROUP_SYSTEM_PROMPT = [
  "你是漫画分镜导演助手。把输入的编号片段（原文章节已切成句/对话片段）分组为分镜。",
  "只输出 JSON，结构：{\"groups\":[{\"segmentIndexes\":[0,1]}]}。",
  "规则：每个分镜是一个连续镜头画面，通常由 1-4 个相邻片段组成；对话与其引导叙述尽量同镜；",
  "场景切换或时间跳跃处开新镜；片段必须不重不漏全部归组，组内索引保持升序。",
  "禁止改写、翻译或省略任何片段内容。",
].join("\n");

/**
 * 按章节 densityPlan 重新生成分镜：大模型优先，失败或结果不完整时自动回落本地规则。
 * settings 未配置时直接走本地规则。
 */
export async function generateStoryboardAuto(
  chapter: ComicChapter,
  settings?: AiConnectionSettings | null,
): Promise<GenerateStoryboardAutoResult> {
  if (settings) {
    try {
      const panels = await generateStoryboardLlm(chapter, settings);
      return { panels, strategy: "llm" };
    } catch (error) {
      const panels = await generateStoryboardLocal(chapter);
      return {
        panels,
        strategy: "local",
        note: describeAiError(error),
      };
    }
  }
  const panels = await generateStoryboardLocal(chapter);
  return { panels, strategy: "local", note: "未配置文本模型，已按本地规则分镜" };
}

/** 按章节 densityPlan 用本地规则重新生成分镜（覆盖旧分镜，需 UI 确认） */
export async function generateStoryboardLocal(chapter: ComicChapter): Promise<ComicPanel[]> {
  const rules = shotDensity.splitRules;
  const segments = segmentSourceText(chapter.sourceContent, rules);
  const groups = groupSegmentsIntoPanels(segments, {
    levels: shotDensity.levels,
    globalLevel: chapter.densityPlan.global,
    dynamic: shotDensity.dynamicDensity.enabled
      ? shotDensity.dynamicDensity
      : { enabled: false, climaxKeywords: [], dialogueBoost: false },
    sceneChangeMarkers: rules.sceneChangeMarkers,
  });

  const ranges = groups.map((group) => {
    const first = segments[group.segmentIndexes[0]];
    const last = segments[group.segmentIndexes[group.segmentIndexes.length - 1]];
    if (!first || !last) return null;
    return {
      startIndex: first.startIndex,
      endIndex: last.endIndex,
      densityApplied: group.levelApplied,
    };
  });
  return persistStoryboard(chapter, ranges.filter((range): range is NonNullable<typeof range> => range !== null));
}

/** LLM 分组分镜：句级片段分批交给大模型分组，映射回原文索引后落库 */
export async function generateStoryboardLlm(
  chapter: ComicChapter,
  settings: AiConnectionSettings,
): Promise<ComicPanel[]> {
  const rules = shotDensity.splitRules;
  const segments = segmentSourceText(chapter.sourceContent, rules);
  if (segments.length === 0) {
    return persistStoryboard(chapter, []);
  }

  // 分批请求 LLM 分组；每批要求片段不重不漏全覆盖，否则视为结果无效
  const ranges: Array<{ startIndex: number; endIndex: number; densityApplied: ShotDensityLevel }> = [];
  for (let start = 0; start < segments.length; start += SEGMENTS_PER_BATCH) {
    const batch = segments.slice(start, start + SEGMENTS_PER_BATCH);
    const result = await chatJson({
      settings,
      system: GROUP_SYSTEM_PROMPT,
      user: buildGroupUserPrompt(batch),
      schema: groupSchema,
      temperature: 0.2,
    });
    const covered = validateGroupCoverage(result.groups, batch.length);
    for (const indexes of covered) {
      const first = batch[indexes[0]];
      const last = batch[indexes[indexes.length - 1]];
      if (!first || !last) throw new Error("LLM 分镜分组越界");
      ranges.push({
        startIndex: first.startIndex,
        endIndex: last.endIndex,
        densityApplied: inferDensityLevel(indexes.length, chapter.densityPlan.global),
      });
    }
  }
  return persistStoryboard(chapter, ranges);
}

/** 校验批内分组覆盖：不重不漏且越界即失败（触发本地兜底） */
function validateGroupCoverage(
  groups: Array<{ segmentIndexes: number[] }>,
  batchLength: number,
): number[][] {
  const seen = new Set<number>();
  const ordered: number[][] = [];
  for (const group of groups) {
    const indexes = [...group.segmentIndexes].sort((a, b) => a - b);
    for (const index of indexes) {
      if (index >= batchLength) throw new Error("LLM 分镜分组索引越界");
      if (seen.has(index)) throw new Error("LLM 分镜分组存在重复片段");
      seen.add(index);
    }
    ordered.push(indexes);
  }
  if (seen.size !== batchLength) throw new Error("LLM 分镜分组未覆盖全部片段");
  return ordered;
}

/** 按组内片段句数推断密度档位（找不到匹配档位时回落全局方案） */
function inferDensityLevel(sentenceCount: number, fallback: ShotDensityLevel): ShotDensityLevel {
  const hit = shotDensity.levels.find(
    (level) => sentenceCount >= level.minSentences && sentenceCount <= level.maxSentences,
  );
  return hit?.id ?? fallback;
}

function buildGroupUserPrompt(batch: SourceSegment[]): string {
  const lines = batch.map(
    (segment, index) =>
      `${index}|${segment.kind === "dialogue" ? "对话" : "叙述"}|${segment.text.replace(/\s+/g, " ").slice(0, 120)}`,
  );
  return `共 ${batch.length} 个片段（编号从 0 开始）。请分组为分镜 JSON：\n\n${lines.join("\n")}`;
}

/** 清空旧分镜并持久化新区间（本地/LLM 两条路径共用的收口） */
async function persistStoryboard(
  chapter: ComicChapter,
  ranges: Array<{ startIndex: number; endIndex: number; densityApplied: ShotDensityLevel }>,
): Promise<ComicPanel[]> {
  const now = new Date().toISOString();
  // 旧分镜连同其上的台词/描述词/生成记录一并清空
  await deletePanels(chapter.panelOrder, chapter.id);

  const panels: ComicPanel[] = ranges.map((range, index) =>
    buildPanel({
      chapter,
      order: index,
      sourceStartIndex: range.startIndex,
      sourceEndIndex: range.endIndex,
      densityApplied: range.densityApplied,
    }),
  );
  if (panels.length === 0 && chapter.sourceContent.trim().length === 0) {
    // 原文为空白：不产生分镜，也不推进版本
    return [];
  }
  // 兜底：分组为空但原文非空 → 整段一镜，避免用户面对 0 结果无解
  if (panels.length === 0) {
    panels.push(
      buildPanel({
        chapter,
        order: 0,
        sourceStartIndex: 0,
        sourceEndIndex: chapter.sourceContent.length,
        densityApplied: chapter.densityPlan.global,
      }),
    );
  }

  await savePanels(panels);
  chapter.panelOrder = panels.map((panel) => panel.id);
  chapter.dialogueExtracted = false;
  chapter.versions.storyboard += 1;
  chapter.versions.dialogue += 1;
  chapter.updatedAt = now;
  await saveChapter(chapter);
  return panels;
}

/** 更新密度方案（不直接改动分镜，由用户决定是否重新生成） */
export async function updateDensityPlan(
  chapter: ComicChapter,
  plan: { global: ShotDensityLevel; dynamic: boolean },
): Promise<ComicChapter> {
  chapter.densityPlan = plan;
  chapter.updatedAt = new Date().toISOString();
  await saveChapter(chapter);
  return chapter;
}

// ---------------------------------------------------------------------------
// 手动编排
// ---------------------------------------------------------------------------

/** 拆分一镜：在中点最近的句末/从句处切成两镜 */
export async function splitPanel(
  chapter: ComicChapter,
  panelId: string,
): Promise<ComicPanel[]> {
  const panels = await loadOrderedPanels(chapter);
  const index = panels.findIndex((panel) => panel.id === panelId);
  const panel = panels[index];
  if (!panel) throw new Error("分镜不存在，请刷新后重试");

  const text = chapter.sourceContent.slice(panel.sourceStartIndex, panel.sourceEndIndex);
  const rules = shotDensity.splitRules;
  const offset = findSplitOffset(text, rules);
  if (offset === null) {
    throw new Error("该分镜内容过短或没有可拆分的标点，无法再拆");
  }

  const cut = panel.sourceStartIndex + offset;
  const right = buildPanel({
    chapter,
    order: panel.order + 0.5,
    sourceStartIndex: cut,
    sourceEndIndex: panel.sourceEndIndex,
    densityApplied: panel.densityOverride ?? panel.densityApplied,
  });
  panel.sourceEndIndex = cut;
  panel.generation = emptyGeneration(new Date().toISOString());
  panel.updatedAt = new Date().toISOString();

  chapter.versions.storyboard += 1;
  const next = [...panels.slice(0, index + 1), right, ...panels.slice(index + 1)];
  return rewriteOrder(chapter, next);
}

/** 合并相邻两镜（范围取并集，生成状态重置） */
export async function mergePanelWithNext(
  chapter: ComicChapter,
  panelId: string,
): Promise<ComicPanel[]> {
  const panels = await loadOrderedPanels(chapter);
  const index = panels.findIndex((panel) => panel.id === panelId);
  if (index < 0 || index >= panels.length - 1) {
    throw new Error("只有与下一镜相邻的分镜才能合并");
  }
  const current = panels[index];
  const next = panels[index + 1];
  if (!current || !next) throw new Error("分镜不存在，请刷新后重试");

  current.sourceEndIndex = next.sourceEndIndex;
  current.dialogues = [];
  current.prompt = undefined;
  current.generation = emptyGeneration(new Date().toISOString());
  current.updatedAt = new Date().toISOString();

  await deletePanels([next.id], chapter.id);
  chapter.versions.storyboard += 1;
  const remaining = panels.filter((panel) => panel.id !== next.id);
  return rewriteOrder(chapter, remaining);
}

/** 删除一镜（其原文区间回退为未分镜，不做任何改写） */
export async function deletePanel(chapter: ComicChapter, panelId: string): Promise<ComicPanel[]> {
  const panels = await loadOrderedPanels(chapter);
  if (!panels.some((panel) => panel.id === panelId)) {
    throw new Error("分镜不存在，请刷新后重试");
  }
  await deletePanels([panelId], chapter.id);
  chapter.versions.storyboard += 1;
  const remaining = panels.filter((panel) => panel.id !== panelId);
  return rewriteOrder(chapter, remaining);
}

/** 在某镜之后插入空镜（转场镜，不引用原文；afterPanelId 为空时插到最前） */
export async function insertEmptyPanel(
  chapter: ComicChapter,
  afterPanelId: string | null,
): Promise<ComicPanel[]> {
  const panels = await loadOrderedPanels(chapter);
  const index = afterPanelId ? panels.findIndex((panel) => panel.id === afterPanelId) : -1;
  const anchor =
    index >= 0
      ? (panels[index]?.sourceEndIndex ?? 0)
      : (panels[0]?.sourceStartIndex ?? 0);
  const panel = buildPanel({
    chapter,
    order: index >= 0 ? panels[index]!.order + 0.5 : -0.5,
    sourceStartIndex: anchor,
    sourceEndIndex: anchor,
    densityApplied: chapter.densityPlan.global,
  });
  chapter.versions.storyboard += 1;
  const next = [...panels.slice(0, index + 1), panel, ...panels.slice(index + 1)];
  return rewriteOrder(chapter, next);
}

/** 按给定顺序重排（拖拽/上下移共用） */
export async function reorderPanels(
  chapter: ComicChapter,
  orderedIds: string[],
): Promise<ComicPanel[]> {
  const panels = await loadOrderedPanels(chapter);
  const byId = new Map(panels.map((panel) => [panel.id, panel]));
  const ordered = orderedIds
    .map((id) => byId.get(id))
    .filter((panel): panel is ComicPanel => Boolean(panel));
  if (ordered.length !== panels.length) {
    throw new Error("分镜顺序数据不一致，请刷新后重试");
  }
  chapter.versions.storyboard += 1;
  return rewriteOrder(chapter, ordered);
}

/** 设置单镜密度覆盖并按该密度重切此镜 */
export async function applyDensityOverride(
  chapter: ComicChapter,
  panelId: string,
  level: ShotDensityLevel,
): Promise<ComicPanel[]> {
  const panels = await loadOrderedPanels(chapter);
  const index = panels.findIndex((panel) => panel.id === panelId);
  const panel = panels[index];
  if (!panel) throw new Error("分镜不存在，请刷新后重试");
  const levelConfig = getDensityLevel(level);
  if (!levelConfig) throw new Error("密度档位不存在，请检查 shotDensity.json");

  const rules = shotDensity.splitRules;
  const segments = segmentSourceText(
    chapter.sourceContent.slice(panel.sourceStartIndex, panel.sourceEndIndex),
    rules,
  ).map((segment) => ({
    ...segment,
    startIndex: segment.startIndex + panel.sourceStartIndex,
    endIndex: segment.endIndex + panel.sourceStartIndex,
  }));
  const groups = groupSegmentsIntoPanels(segments, {
    levels: shotDensity.levels,
    globalLevel: level,
    dynamic: { enabled: false, climaxKeywords: [], dialogueBoost: false },
    sceneChangeMarkers: rules.sceneChangeMarkers,
  });

  const replacement = groups.map((group, groupIndex) => {
    const first = segments[group.segmentIndexes[0]];
    const last = segments[group.segmentIndexes[group.segmentIndexes.length - 1]];
    const created = buildPanel({
      chapter,
      order: panel.order + groupIndex * 0.5,
      sourceStartIndex: first?.startIndex ?? panel.sourceStartIndex,
      sourceEndIndex: last?.endIndex ?? panel.sourceEndIndex,
      densityApplied: level,
    });
    created.densityOverride = level;
    return created;
  });

  await deletePanels([panelId], chapter.id);
  chapter.versions.storyboard += 1;
  const next = [
    ...panels.slice(0, index),
    ...replacement,
    ...panels.slice(index + 1),
  ];
  return rewriteOrder(chapter, next);
}

// ---------------------------------------------------------------------------

async function loadOrderedPanels(chapter: ComicChapter): Promise<ComicPanel[]> {
  return listPanels(chapter.id);
}
