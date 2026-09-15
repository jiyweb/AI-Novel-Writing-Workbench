/**
 * 项目服务：创建/重命名项目，形态与画风的 UI 摘要
 */
import { comicForms, stylePresets } from "./configService";
import { generateId, saveProject } from "../db/comicDb";
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
