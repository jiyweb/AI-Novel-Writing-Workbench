/**
 * 删除漫画项目时的本地文件清理
 *
 * 数据库行通过外键 ON DELETE CASCADE 级联删除；磁盘文件 DB 管不到，
 * 需要在删除前收集项目下全部实体 id，删除后按存储布局尽力清理。
 *
 * 清理是 best-effort：单个目录删除失败只记录失败项，不阻断项目删除，
 * 避免因为一个被占用的图片文件让整个删除请求失败、数据库与列表状态不一致。
 */
import path from "node:path";
import { promises as fs } from "node:fs";

import {
  comicCharacterAssetDir,
  comicCharacterDir,
  comicExportJobDir,
  comicGeneratedImagesRoot,
  comicLetteredPanelDir,
  comicPanelDir,
  comicSceneDir,
} from "./comicStoragePaths";

export interface ComicProjectStorageRefs {
  characterIds: string[];
  characterAssetIds: string[];
  sceneIds: string[];
  panelIds: string[];
  exportJobIds: string[];
  /** ComicUploadAsset.filePath 原值，可能是绝对路径或相对生成图根目录的路径 */
  uploadFilePaths: string[];
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * 删除项目关联的本地图片/导出目录。
 * @returns 删除失败的目标路径及原因列表（为空表示全部清理成功）
 */
export async function removeComicProjectStorage(refs: ComicProjectStorageRefs): Promise<string[]> {
  const root = comicGeneratedImagesRoot();
  const targets = new Set<string>([
    ...refs.characterIds.map(comicCharacterDir),
    ...refs.characterAssetIds.map(comicCharacterAssetDir),
    ...refs.sceneIds.map(comicSceneDir),
    ...refs.panelIds.flatMap((panelId) => [comicPanelDir(panelId), comicLetteredPanelDir(panelId)]),
    ...refs.exportJobIds.map(comicExportJobDir),
  ]);

  // 上传资产只按 filePath 清理，且严格限制在生成图根目录内，防止异常相对路径越界删除
  for (const filePath of refs.uploadFilePaths) {
    const trimmed = filePath.trim();
    if (!trimmed) continue;
    const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(root, trimmed);
    if (isPathInside(root, resolved)) {
      targets.add(resolved);
    }
  }

  const failures: string[] = [];
  for (const target of targets) {
    try {
      await fs.rm(target, { recursive: true, force: true });
    } catch (error) {
      failures.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}
