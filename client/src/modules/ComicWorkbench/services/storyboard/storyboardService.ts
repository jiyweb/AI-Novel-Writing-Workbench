/**
 * 智能分镜 应用服务：密度方案 → 分镜生成 → 手动编排（拆/合/删/增/排序）
 *
 * 数据流单向（规则第7条）：分镜 regeneration 只递增 versions.storyboard
 * 并随面板快照 upstreamVersions；下游（台词/描述词/图片）据此自判 stale，
 * 本服务绝不静默改写下游数据。
 *
 * 原文零修改（规则第5条）：一切分镜只用 sourceStartIndex/sourceEndIndex 锚定
 * chapter.sourceContent，空镜（转场镜）允许零长度区间。
 */
import {
  deletePanels,
  generateId,
  listPanels,
  saveChapter,
  savePanels,
} from "../../db/comicDb";
import { getDensityLevel, shotDensity } from "../configService";
import {
  findSplitOffset,
  groupSegmentsIntoPanels,
  segmentSourceText,
} from "./segmenter";
import type { ComicChapter, ComicPanel, ShotDensityLevel } from "../../types";

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

/**
 * 按章节 densityPlan 重新生成分镜（覆盖旧分镜，需 UI 确认）。
 * 返回新生成的面板列表（已持久化）。
 */
export async function generateStoryboard(chapter: ComicChapter): Promise<ComicPanel[]> {
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

  const now = new Date().toISOString();
  // 旧分镜连同其上的台词/描述词/生成记录一并清空
  await deletePanels(chapter.panelOrder, chapter.id);

  const panels: ComicPanel[] = [];
  for (const group of groups) {
    const first = segments[group.segmentIndexes[0]];
    const last = segments[group.segmentIndexes[group.segmentIndexes.length - 1]];
    if (!first || !last) continue;
    panels.push(
      buildPanel({
        chapter,
        order: panels.length,
        sourceStartIndex: first.startIndex,
        sourceEndIndex: last.endIndex,
        densityApplied: group.levelApplied,
      }),
    );
  }
  if (panels.length === 0 && segments.length === 0) {
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
