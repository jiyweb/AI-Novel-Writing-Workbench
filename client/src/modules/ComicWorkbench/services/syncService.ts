/**
 * 版本链同步服务（规则第7条：数据流单向，禁止静默级联修改）
 *
 * 每个分镜的台词/描述词/画面在产出时记录当时的章节版本快照（basis 盖章），
 * 上游（分镜/角色场景/台词/形态画风/分镜元数据）变化后据此标记「待更新」，
 * 绝不静默改写下游内容。
 *
 * 一键同步按依赖序重跑文本链：台词重提（确定性算法）→ 描述词重建；
 * 画面重生成消耗生图额度，保留在「生成」步骤由用户显式触发。
 * 手动编辑过的描述词默认保护（与描述词步骤的批量行为一致）。
 */
import { extractDialogues } from "./dialogueService";
import { generateChapterPrompts } from "./promptEngine";
import { getFormById } from "./configService";
import type {
  ComicChapter,
  ComicCharacter,
  ComicPanel,
  ComicProject,
  ComicScene,
  CustomPromptFormula,
} from "../types";

export interface PanelStaleFlags {
  /** 台词基于旧分镜/旧角色库（说话人归属或原文区间可能已变化） */
  dialogue: boolean;
  /** 描述词基于旧上游（分镜/元数据/角色/台词/画风） */
  prompt: boolean;
  /** 成品图基于旧描述词或旧画风 */
  image: boolean;
}

/** 单镜待更新判定：basis 快照与章节当前版本逐项比对 */
export function computePanelStale(
  panel: ComicPanel,
  chapter: ComicChapter,
): PanelStaleFlags {
  const versions = chapter.versions;
  let dialogue = false;
  if (panel.dialogueBasis) {
    dialogue =
      panel.dialogueBasis.storyboard !== versions.storyboard ||
      panel.dialogueBasis.cast !== versions.cast;
  }
  let prompt = false;
  if (panel.promptBasis) {
    const basis = panel.promptBasis;
    prompt =
      basis.storyboard !== versions.storyboard ||
      basis.metadata !== (versions.metadata ?? 0) ||
      basis.cast !== versions.cast ||
      basis.dialogue !== versions.dialogue ||
      basis.presentation !== versions.presentation;
  }
  let image = false;
  if (panel.generation.status === "success" && panel.imageBasis) {
    image =
      panel.imageBasis.prompt !== versions.prompt ||
      panel.imageBasis.presentation !== versions.presentation;
  }
  return { dialogue, prompt, image };
}

export interface ChapterStaleSummary {
  totalPanels: number;
  dialogue: number;
  prompt: number;
  image: number;
}

export interface ChapterStaleMap {
  summary: ChapterStaleSummary;
  dialogueIds: Set<string>;
  promptIds: Set<string>;
  imageIds: Set<string>;
}

/** 章节级待更新汇总（横幅计数 + 列表逐镜徽标共用） */
export function computePanelStaleMap(
  panels: ComicPanel[],
  chapter: ComicChapter,
): ChapterStaleMap {
  const map: ChapterStaleMap = {
    summary: { totalPanels: panels.length, dialogue: 0, prompt: 0, image: 0 },
    dialogueIds: new Set(),
    promptIds: new Set(),
    imageIds: new Set(),
  };
  for (const panel of panels) {
    const flags = computePanelStale(panel, chapter);
    if (flags.dialogue) {
      map.dialogueIds.add(panel.id);
      map.summary.dialogue += 1;
    }
    if (flags.prompt) {
      map.promptIds.add(panel.id);
      map.summary.prompt += 1;
    }
    if (flags.image) {
      map.imageIds.add(panel.id);
      map.summary.image += 1;
    }
  }
  return map;
}

export function computeChapterStale(
  panels: ComicPanel[],
  chapter: ComicChapter,
): ChapterStaleSummary {
  return computePanelStaleMap(panels, chapter).summary;
}

// ---------------------------------------------------------------------------
// 一键同步（文本链：台词 → 描述词）
// ---------------------------------------------------------------------------

export interface SyncChapterTextParams {
  chapter: ComicChapter;
  panels: ComicPanel[];
  project: ComicProject;
  characters: ComicCharacter[];
  scenes: ComicScene[];
  customFormula?: CustomPromptFormula | null;
  /** 连同手动编辑过的描述词一起重建（默认保护手动内容） */
  includeManualPrompts?: boolean;
  onStageProgress?: (stage: "dialogue" | "prompt", done: number, total: number) => void;
}

export interface SyncChapterTextResult {
  /** 是否执行了台词重提 */
  reExtractedDialogues: boolean;
  /** 重建的描述词数量 */
  rebuiltPrompts: number;
  /** 同步完成后仍待更新的画面数（留给生成步骤处理） */
  imageStale: number;
}

/**
 * 按依赖序重跑文本链。台词重提是全章确定性行为（重提后全章台词版本变化），
 * 因此描述词按同步后的最新状态统一重建；手动编辑的描述词默认跳过并保持待更新标记。
 *
 * 台词/描述词服务会原地改写传入的 chapter/panels；这里统一克隆后再交给服务，
 * 避免突变 react-query 缓存对象——否则失效重取的数据与缓存结构化相等，
 * structural sharing 保留旧引用，横幅等派生状态不会刷新。
 */
export async function syncChapterText(
  params: SyncChapterTextParams,
): Promise<SyncChapterTextResult> {
  const chapter = structuredClone(params.chapter);
  const panels = params.panels.map((panel) => structuredClone(panel));

  const before = computeChapterStale(panels, chapter);

  let reExtractedDialogues = false;
  if (before.dialogue > 0) {
    const form = getFormById(params.project.formId);
    await extractDialogues(chapter, panels, { letteringMode: form?.letteringMode ?? "bubble" });
    reExtractedDialogues = true;
    params.onStageProgress?.("dialogue", panels.length, panels.length);
  }

  let rebuiltPrompts = 0;
  if (before.dialogue > 0 || before.prompt > 0) {
    rebuiltPrompts = await generateChapterPrompts({
      chapter,
      panels,
      project: params.project,
      characters: params.characters,
      scenes: params.scenes,
      customFormula: params.customFormula,
      includeManual: params.includeManualPrompts ?? false,
      onProgress: (done, total) => params.onStageProgress?.("prompt", done, total),
    });
  }

  const imageStale = computeChapterStale(panels, chapter).image;
  return { reExtractedDialogues, rebuiltPrompts, imageStale };
}
