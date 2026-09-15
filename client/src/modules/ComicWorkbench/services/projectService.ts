/**
 * 项目服务：创建/重命名项目，形态与画风的变更与下游联动
 *
 * 数据流单向（规则第7条）：上游（形态/画风）修改后，下游章节只做
 * 版本计数递增（stale 标记），绝不静默级联改写下游产物；
 * 唯一例外是形态切换——分镜与形态强绑定（画幅/分格/台词样式），
 * 需在用户明确确认后清空分镜数据重来。
 */
import {
  deletePanels,
  generateId,
  listChapters,
  saveProject,
  saveChapter,
} from "../db/comicDb";
import { comicForms, stylePresets } from "./configService";
import type { ComicFormConfig, ComicProject, StyleAdjustments } from "../types";

function defaultAdjustments(formIndex = 0, presetIndex = 0): StyleAdjustments {
  const preset = stylePresets[presetIndex] ?? stylePresets[0];
  return { ...preset.adjustments };
}

/** 创建空白项目：默认第一条形态 + 第一条画风（均可在工作台内更改） */
export async function createEmptyProject(name: string): Promise<ComicProject> {
  const now = new Date().toISOString();
  const project: ComicProject = {
    id: generateId("project"),
    name,
    formId: comicForms[0]?.id ?? "strip",
    stylePresetId: stylePresets[0]?.id ?? "shonen",
    styleAdjustments: defaultAdjustments(),
    customStyleKeywords: "",
    createdAt: now,
    updatedAt: now,
  };
  await saveProject(project);
  return project;
}

export async function renameProject(project: ComicProject, name: string): Promise<ComicProject> {
  const next: ComicProject = { ...project, name, updatedAt: new Date().toISOString() };
  await saveProject(next);
  return next;
}

export async function touchProject(project: ComicProject): Promise<ComicProject> {
  const next: ComicProject = { ...project, updatedAt: new Date().toISOString() };
  await saveProject(next);
  return next;
}

/** 形态摘要（列表页徽标用） */
export interface ComicFormSummary {
  id: string;
  name: string;
  aspectRatio: string;
}

export async function loadFormSummaries(): Promise<ComicFormSummary[]> {
  return comicForms.map((form: ComicFormConfig) => ({
    id: form.id,
    name: form.name,
    aspectRatio: form.aspectRatio,
  }));
}

// ---------------------------------------------------------------------------
// 形态与画风变更（上游修改 → 下游 stale 标记）
// ---------------------------------------------------------------------------

/**
 * 切换项目形态。
 * @param resetStoryboard 为 true 时（用户已在确认弹窗同意）清空已产出分镜；
 *                        全部章节 presentation 递增，分镜章节额外 storyboard 递增。
 */
export async function changeProjectForm(
  project: ComicProject,
  formId: string,
  resetStoryboard: boolean,
): Promise<ComicProject> {
  const next: ComicProject = { ...project, formId, updatedAt: new Date().toISOString() };
  await saveProject(next);

  const chapters = await listChapters(project.id);
  for (const chapter of chapters) {
    const hadStoryboard = chapter.panelOrder.length > 0 || chapter.versions.storyboard > 0;
    if (resetStoryboard && hadStoryboard) {
      await deletePanels(chapter.panelOrder, chapter.id);
      chapter.panelOrder = [];
      chapter.dialogueExtracted = false;
      chapter.versions.storyboard += 1;
    }
    chapter.versions.presentation += 1;
    chapter.updatedAt = new Date().toISOString();
    await saveChapter(chapter);
  }
  return next;
}

/** 更新画风（预设切换重置调节参数为该预设默认值），全部章节 presentation 递增 */
export async function changeProjectStyle(
  project: ComicProject,
  updates: {
    stylePresetId?: string;
    styleAdjustments?: StyleAdjustments;
    customStyleKeywords?: string;
  },
): Promise<ComicProject> {
  const preset = updates.stylePresetId
    ? stylePresets.find((p) => p.id === updates.stylePresetId)
    : undefined;
  const next: ComicProject = {
    ...project,
    stylePresetId: updates.stylePresetId ?? project.stylePresetId,
    // 预设切换时调节参数回到新预设默认值；单独调参时只覆盖传入的字段
    styleAdjustments: updates.styleAdjustments ?? preset?.adjustments ?? project.styleAdjustments,
    customStyleKeywords: updates.customStyleKeywords ?? project.customStyleKeywords,
    updatedAt: new Date().toISOString(),
  };
  await saveProject(next);

  const chapters = await listChapters(project.id);
  for (const chapter of chapters) {
    chapter.versions.presentation += 1;
    chapter.updatedAt = new Date().toISOString();
    await saveChapter(chapter);
  }
  return next;
}
