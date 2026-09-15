/**
 * react-query 查询钩子：包装 IndexedDB 异步读取
 * 集中管理 queryKey，供各面板失效刷新。
 */
import { useQuery } from "@tanstack/react-query";
import {
  getChapter,
  getProject,
  getSettings,
  listChapters,
  listCharacters,
  listPanels,
  listProjects,
  listScenes,
} from "../db/comicDb";
import { getAiSettings } from "../services/ai/aiConfigService";
import type { AiConnectionSettings, WorkbenchSettings } from "../types";

export const comicKeys = {
  projects: ["comic-workbench", "projects"] as const,
  project: (id: string) => ["comic-workbench", "project", id] as const,
  chapters: (projectId: string) => ["comic-workbench", "chapters", projectId] as const,
  chapter: (chapterId: string) => ["comic-workbench", "chapter", chapterId] as const,
  panels: (chapterId: string) => ["comic-workbench", "panels", chapterId] as const,
  characters: (projectId: string) => ["comic-workbench", "characters", projectId] as const,
  scenes: (projectId: string) => ["comic-workbench", "scenes", projectId] as const,
  aiSettings: ["comic-workbench", "aiSettings"] as const,
  settings: ["comic-workbench", "settings"] as const,
};

export function useComicProjects() {
  return useQuery({ queryKey: comicKeys.projects, queryFn: listProjects });
}

export function useComicProject(projectId: string | null | undefined) {
  return useQuery({
    queryKey: comicKeys.project(projectId ?? "none"),
    queryFn: () => (projectId ? getProject(projectId) : Promise.resolve(undefined)),
    enabled: Boolean(projectId),
  });
}

export function useComicChapters(projectId: string | null | undefined) {
  return useQuery({
    queryKey: comicKeys.chapters(projectId ?? "none"),
    queryFn: () => (projectId ? listChapters(projectId) : Promise.resolve([])),
    enabled: Boolean(projectId),
  });
}

export function useComicChapter(chapterId: string | null | undefined) {
  return useQuery({
    queryKey: comicKeys.chapter(chapterId ?? "none"),
    queryFn: () => (chapterId ? getChapter(chapterId) : Promise.resolve(undefined)),
    enabled: Boolean(chapterId),
  });
}

export function useComicPanels(chapterId: string | null | undefined) {
  return useQuery({
    queryKey: comicKeys.panels(chapterId ?? "none"),
    queryFn: () => (chapterId ? listPanels(chapterId) : Promise.resolve([])),
    enabled: Boolean(chapterId),
  });
}

/** 项目级角色库（跨章节共享） */
export function useComicCharacters(projectId: string | null | undefined) {
  return useQuery({
    queryKey: comicKeys.characters(projectId ?? "none"),
    queryFn: () => (projectId ? listCharacters(projectId) : Promise.resolve([])),
    enabled: Boolean(projectId),
  });
}

/** 项目级场景库（跨章节共享） */
export function useComicScenes(projectId: string | null | undefined) {
  return useQuery({
    queryKey: comicKeys.scenes(projectId ?? "none"),
    queryFn: () => (projectId ? listScenes(projectId) : Promise.resolve([])),
    enabled: Boolean(projectId),
  });
}

export function useAiSettings() {
  return useQuery({
    queryKey: comicKeys.aiSettings,
    queryFn: getAiSettings,
  });
}

/** 全局设置（AI 配置 / 个人画风预设 / 最近打开记录） */
export function useWorkbenchSettings() {
  return useQuery({
    queryKey: comicKeys.settings,
    queryFn: getSettings,
  });
}

export type { AiConnectionSettings, WorkbenchSettings };
