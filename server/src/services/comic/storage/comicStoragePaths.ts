/**
 * 漫画本地图片存储布局（唯一归属）
 *
 * 所有漫画生成图片都落在 resolveGeneratedImagesRoot() 下，按实体类型分目录：
 * - comic-characters/{characterId}/        角色三视图/表情稿
 * - comic-character-assets/{assetId}/      角色可选视觉资产
 * - comic-scenes/{sceneId}/                场景设定图
 * - comic-panels/{panelId}/                格子原图
 * - comic-panels-lettered/{panelId}/       加字后的格子图
 * - comic-exports/{jobId}/                 条漫/视频导出产物
 *
 * 历史上这些目录名散落在各服务文件里，删除项目时无法集中清理；
 * 统一收敛到这里，各服务与项目级清理都只从这里取路径，避免目录名漂移。
 */
import path from "node:path";

import { resolveGeneratedImagesRoot } from "../../../runtime/appPaths";

export const COMIC_CHARACTERS_DIR = "comic-characters";
export const COMIC_CHARACTER_ASSETS_DIR = "comic-character-assets";
export const COMIC_SCENES_DIR = "comic-scenes";
export const COMIC_PANELS_DIR = "comic-panels";
export const COMIC_PANELS_LETTERED_DIR = "comic-panels-lettered";
export const COMIC_EXPORTS_DIR = "comic-exports";

export function comicGeneratedImagesRoot(): string {
  return resolveGeneratedImagesRoot();
}

export function comicCharacterDir(characterId: string): string {
  return path.join(resolveGeneratedImagesRoot(), COMIC_CHARACTERS_DIR, characterId);
}

export function comicCharacterAssetDir(assetId: string): string {
  return path.join(resolveGeneratedImagesRoot(), COMIC_CHARACTER_ASSETS_DIR, assetId);
}

export function comicSceneDir(sceneId: string): string {
  return path.join(resolveGeneratedImagesRoot(), COMIC_SCENES_DIR, sceneId);
}

export function comicPanelDir(panelId: string): string {
  return path.join(resolveGeneratedImagesRoot(), COMIC_PANELS_DIR, panelId);
}

export function comicLetteredPanelDir(panelId: string): string {
  return path.join(resolveGeneratedImagesRoot(), COMIC_PANELS_LETTERED_DIR, panelId);
}

export function comicExportJobDir(jobId: string): string {
  return path.join(resolveGeneratedImagesRoot(), COMIC_EXPORTS_DIR, jobId);
}
