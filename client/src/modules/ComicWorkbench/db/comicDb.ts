/**
 * IndexedDB 数据层（基于现有依赖 idb-keyval）
 *
 * 键空间约定见 types/index.ts 的 ComicDbKeys。
 * 所有持久化操作集中在此文件，业务代码不直接触碰 idb-keyval。
 */
import { del, get, keys, set } from "idb-keyval";
import type {
  ComicChapter,
  ComicCharacter,
  ComicImageRecord,
  ComicPanel,
  ComicProject,
  GenerationTask,
  WorkbenchSettings,
} from "../types";
import { ComicDbKeys, emptyChapterVersions } from "../types";

// ---------------------------------------------------------------------------
// 基础读写
// ---------------------------------------------------------------------------

export async function dbGet<T>(key: string): Promise<T | undefined> {
  return get<T>(key);
}

export async function dbSet<T>(key: string, value: T): Promise<void> {
  await set(key, value);
}

export async function dbDel(key: string): Promise<void> {
  await del(key);
}

/** 读取实体不存在时抛错（用于必须存在的场景） */
export async function dbGetRequired<T>(key: string, what: string): Promise<T> {
  const value = await get<T>(key);
  if (value === undefined) {
    throw new Error(`数据不存在或已被删除：${what}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// ID 生成
// ---------------------------------------------------------------------------

/** 生成唯一 ID：时间戳 + 随机段，前缀便于调试辨认 */
export function generateId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<ComicProject[]> {
  const ids = (await get<string[]>(ComicDbKeys.projectIndex())) ?? [];
  const projects = await Promise.all(ids.map((id) => get<ComicProject>(ComicDbKeys.project(id))));
  return projects.filter((p): p is ComicProject => Boolean(p));
}

export async function getProject(id: string): Promise<ComicProject | undefined> {
  return get<ComicProject>(ComicDbKeys.project(id));
}

export async function saveProject(project: ComicProject): Promise<void> {
  const ids = (await get<string[]>(ComicDbKeys.projectIndex())) ?? [];
  if (!ids.includes(project.id)) {
    await set(ComicDbKeys.projectIndex(), [...ids, project.id]);
  }
  await set(ComicDbKeys.project(project.id), project);
}

/**
 * 删除项目并级联清理全部下游数据：
 * 章节、分镜、角色、场景、生成任务、图片 blob、运营文案。
 */
export async function deleteProjectCascade(projectId: string): Promise<void> {
  const chapterIds = (await get<string[]>(ComicDbKeys.chapterIndexOfProject(projectId))) ?? [];
  for (const chapterId of chapterIds) {
    const panelIds = (await get<string[]>(ComicDbKeys.panelIndexOfChapter(chapterId))) ?? [];
    for (const panelId of panelIds) {
      await del(ComicDbKeys.panel(panelId));
    }
    await del(ComicDbKeys.panelIndexOfChapter(chapterId));
    await del(ComicDbKeys.chapter(chapterId));
    await del(ComicDbKeys.generationTaskIndexOfChapter(chapterId));
    // 运营文案按 platformId 存储，统一由全键扫描兜底清理
  }

  const characterIds = (await get<string[]>(ComicDbKeys.characterIndexOfProject(projectId))) ?? [];
  for (const characterId of characterIds) {
    await del(ComicDbKeys.character(characterId));
  }
  await del(ComicDbKeys.characterIndexOfProject(projectId));

  const sceneIds = (await get<string[]>(ComicDbKeys.sceneIndexOfProject(projectId))) ?? [];
  for (const sceneId of sceneIds) {
    await del(ComicDbKeys.scene(sceneId));
  }
  await del(ComicDbKeys.sceneIndexOfProject(projectId));

  const imageRecordIds =
    (await get<string[]>(ComicDbKeys.imageRecordIndexOfProject(projectId))) ?? [];
  for (const imageRecordId of imageRecordIds) {
    await del(ComicDbKeys.imageRecord(imageRecordId));
    await del(ComicDbKeys.image(imageRecordId));
  }
  await del(ComicDbKeys.imageRecordIndexOfProject(projectId));

  const taskIds = (await get<string[]>(ComicDbKeys.generationTaskIndexOfChapter(projectId))) ?? [];

  // 全键扫描兜底：清理未挂在索引上的遗留数据（生成任务、运营文案等）
  const allPanelIds = await panelIdsOf(chapterIds);
  await purgeOrphanKeys(new Set([...chapterIds, ...allPanelIds, ...taskIds]));

  const projectIds = (await get<string[]>(ComicDbKeys.projectIndex())) ?? [];
  await set(
    ComicDbKeys.projectIndex(),
    projectIds.filter((id) => id !== projectId),
  );
  await del(ComicDbKeys.project(projectId));

  // 清理“最近打开”记录
  const settings = await getSettings();
  const nextLastChapterByProject = { ...settings.lastChapterByProject };
  delete nextLastChapterByProject[projectId];
  await saveSettings({
    ...settings,
    lastProjectId: settings.lastProjectId === projectId ? undefined : settings.lastProjectId,
    lastChapterByProject: nextLastChapterByProject,
  });
}

async function panelIdsOf(chapterIds: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const chapterId of chapterIds) {
    const panelIds = (await get<string[]>(ComicDbKeys.panelIndexOfChapter(chapterId))) ?? [];
    result.push(...panelIds);
  }
  return result;
}

/** 扫描全部键，删除属于给定项目命名空间且不在保护名单内的键 */
async function purgeOrphanKeys(protectedKeys: Set<string>): Promise<void> {
  const allKeys = await keys();
  for (const key of allKeys) {
    if (typeof key !== "string" || !key.startsWith("comic:")) continue;
    if (protectedKeys.has(key)) continue;
    // 项目命名空间内的数据键（非 index 键）在此统一兜底清理
    const isDataKey =
      key.startsWith("comic:genTask:") ||
      key.startsWith("comic:marketing:") ||
      key.startsWith("comic:index:genTasks:");
    if (isDataKey) {
      await del(key);
    }
  }
}

// ---------------------------------------------------------------------------
// 章节
// ---------------------------------------------------------------------------

export async function listChapters(projectId: string): Promise<ComicChapter[]> {
  const ids = (await get<string[]>(ComicDbKeys.chapterIndexOfProject(projectId))) ?? [];
  const chapters = await Promise.all(ids.map((id) => get<ComicChapter>(ComicDbKeys.chapter(id))));
  return chapters
    .filter((c): c is ComicChapter => Boolean(c))
    .sort((a, b) => a.index - b.index);
}

export async function getChapter(id: string): Promise<ComicChapter | undefined> {
  return get<ComicChapter>(ComicDbKeys.chapter(id));
}

export async function saveChapter(chapter: ComicChapter): Promise<void> {
  const ids =
    (await get<string[]>(ComicDbKeys.chapterIndexOfProject(chapter.projectId))) ?? [];
  if (!ids.includes(chapter.id)) {
    await set(ComicDbKeys.chapterIndexOfProject(chapter.projectId), [...ids, chapter.id]);
  }
  await set(ComicDbKeys.chapter(chapter.id), chapter);
}

export async function deleteChapterCascade(chapterId: string, projectId: string): Promise<void> {
  const panelIds = (await get<string[]>(ComicDbKeys.panelIndexOfChapter(chapterId))) ?? [];
  for (const panelId of panelIds) {
    await del(ComicDbKeys.panel(panelId));
  }
  await del(ComicDbKeys.panelIndexOfChapter(chapterId));
  await del(ComicDbKeys.chapter(chapterId));

  const ids = (await get<string[]>(ComicDbKeys.chapterIndexOfProject(projectId))) ?? [];
  await set(
    ComicDbKeys.chapterIndexOfProject(projectId),
    ids.filter((id) => id !== chapterId),
  );
}

/** 创建空白章节（原文内容由导入流程写入） */
export async function createChapter(params: {
  projectId: string;
  title: string;
  index: number;
  sourceType: ComicChapter["sourceType"];
  sourceContent: string;
  inspiration?: ComicChapter["inspiration"];
  /** 非正文块（前言/作者的话等），导入预处理识别后传入 */
  annotations?: ComicChapter["annotations"];
}): Promise<ComicChapter> {
  const now = new Date().toISOString();
  const chapter: ComicChapter = {
    id: generateId("chapter"),
    projectId: params.projectId,
    title: params.title,
    index: params.index,
    sourceType: params.sourceType,
    sourceContent: params.sourceContent,
    annotations: params.annotations ?? [],
    sourceCharCount: params.sourceContent.length,
    inspiration: params.inspiration,
    createdAt: now,
    updatedAt: now,
    versions: emptyChapterVersions(),
    densityPlan: { global: "standard", dynamic: true },
    panelOrder: [],
    dialogueExtracted: false,
    marketing: {},
  };
  // content 版本从 1 开始：导入即视为第一版内容
  chapter.versions.content = 1;
  await saveChapter(chapter);
  return chapter;
}

// ---------------------------------------------------------------------------
// 分镜
// ---------------------------------------------------------------------------

export async function listPanels(chapterId: string): Promise<ComicPanel[]> {
  const ids = (await get<string[]>(ComicDbKeys.panelIndexOfChapter(chapterId))) ?? [];
  const panels = await Promise.all(ids.map((id) => get<ComicPanel>(ComicDbKeys.panel(id))));
  return panels.filter((p): p is ComicPanel => Boolean(p)).sort((a, b) => a.order - b.order);
}

export async function getPanel(id: string): Promise<ComicPanel | undefined> {
  return get<ComicPanel>(ComicDbKeys.panel(id));
}

export async function savePanel(panel: ComicPanel): Promise<void> {
  await withPanelIndexLock(async () => {
    const ids = (await get<string[]>(ComicDbKeys.panelIndexOfChapter(panel.chapterId))) ?? [];
    if (!ids.includes(panel.id)) {
      await set(ComicDbKeys.panelIndexOfChapter(panel.chapterId), [...ids, panel.id]);
    }
  });
  await set(ComicDbKeys.panel(panel.id), panel);
}

export async function savePanels(panels: ComicPanel[]): Promise<void> {
  // 面板本体键相互独立，可并发写；章节索引必须经互斥链串行合并
  await Promise.all(panels.map((panel) => set(ComicDbKeys.panel(panel.id), panel)));
  const chapterIds = [...new Set(panels.map((panel) => panel.chapterId))];
  await withPanelIndexLock(async () => {
    for (const chapterId of chapterIds) {
      const indexKey = ComicDbKeys.panelIndexOfChapter(chapterId);
      const ids = (await get<string[]>(indexKey)) ?? [];
      const incoming = panels
        .filter((panel) => panel.chapterId === chapterId)
        .map((panel) => panel.id);
      const merged = [...ids];
      for (const id of incoming) {
        if (!merged.includes(id)) merged.push(id);
      }
      await set(indexKey, merged);
    }
  });
}

export async function deletePanels(panelIds: string[], chapterId: string): Promise<void> {
  for (const panelId of panelIds) {
    await del(ComicDbKeys.panel(panelId));
  }
  await withPanelIndexLock(async () => {
    const ids = (await get<string[]>(ComicDbKeys.panelIndexOfChapter(chapterId))) ?? [];
    await set(
      ComicDbKeys.panelIndexOfChapter(chapterId),
      ids.filter((id) => !panelIds.includes(id)),
    );
  });
}

// ---------------------------------------------------------------------------
// 角色与场景
// ---------------------------------------------------------------------------

export async function listCharacters(projectId: string): Promise<ComicCharacter[]> {
  const ids = (await get<string[]>(ComicDbKeys.characterIndexOfProject(projectId))) ?? [];
  const list = await Promise.all(ids.map((id) => get<ComicCharacter>(ComicDbKeys.character(id))));
  return list.filter((c): c is ComicCharacter => Boolean(c));
}

export async function saveCharacter(character: ComicCharacter): Promise<void> {
  await withCastIndexLock(async () => {
    const ids =
      (await get<string[]>(ComicDbKeys.characterIndexOfProject(character.projectId))) ?? [];
    if (!ids.includes(character.id)) {
      await set(ComicDbKeys.characterIndexOfProject(character.projectId), [...ids, character.id]);
    }
  });
  await set(ComicDbKeys.character(character.id), character);
}

export async function deleteCharacter(id: string, projectId: string): Promise<void> {
  await del(ComicDbKeys.character(id));
  await withCastIndexLock(async () => {
    const ids = (await get<string[]>(ComicDbKeys.characterIndexOfProject(projectId))) ?? [];
    await set(
      ComicDbKeys.characterIndexOfProject(projectId),
      ids.filter((item) => item !== id),
    );
  });
}

export async function listScenes(projectId: string): Promise<import("../types").ComicScene[]> {
  const ids = (await get<string[]>(ComicDbKeys.sceneIndexOfProject(projectId))) ?? [];
  const list = await Promise.all(
    ids.map((id) => get<import("../types").ComicScene>(ComicDbKeys.scene(id))),
  );
  return list.filter((s): s is import("../types").ComicScene => Boolean(s));
}

export async function saveScene(scene: import("../types").ComicScene): Promise<void> {
  await withCastIndexLock(async () => {
    const ids = (await get<string[]>(ComicDbKeys.sceneIndexOfProject(scene.projectId))) ?? [];
    if (!ids.includes(scene.id)) {
      await set(ComicDbKeys.sceneIndexOfProject(scene.projectId), [...ids, scene.id]);
    }
  });
  await set(ComicDbKeys.scene(scene.id), scene);
}

export async function deleteScene(id: string, projectId: string): Promise<void> {
  await del(ComicDbKeys.scene(id));
  await withCastIndexLock(async () => {
    const ids = (await get<string[]>(ComicDbKeys.sceneIndexOfProject(projectId))) ?? [];
    await set(
      ComicDbKeys.sceneIndexOfProject(projectId),
      ids.filter((item) => item !== id),
    );
  });
}

// ---------------------------------------------------------------------------
// 图片 blob
// ---------------------------------------------------------------------------

// 索引「读-改-写」互斥链工厂：所有 *_IndexOf* 索引的更新必须串行执行——
// 并发"读索引-改-写回"会互相覆盖导致索引丢项，表现为「重新进入后数据消失」
// （分镜/台词/描述词/生成任务在数据键里还在，但章节索引查不到了）
function createIndexLock() {
  let lock: Promise<unknown> = Promise.resolve();
  return function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = lock.then(task);
    lock = result.catch(() => undefined);
    return result;
  };
}
const withPanelIndexLock = createIndexLock();
const withTaskIndexLock = createIndexLock();
const withCastIndexLock = createIndexLock();
const withImageIndexLock = createIndexLock();

export async function saveImageBlob(
  record: Omit<ComicImageRecord, "id" | "createdAt">,
  blob: Blob | null,
): Promise<ComicImageRecord> {
  const now = new Date().toISOString();
  const fullRecord: ComicImageRecord = { ...record, id: generateId("img"), createdAt: now };
  if (blob) {
    await set(ComicDbKeys.image(fullRecord.id), blob);
  }
  await set(ComicDbKeys.imageRecord(fullRecord.id), fullRecord);
  await withImageIndexLock(async () => {
    const ids =
      (await get<string[]>(ComicDbKeys.imageRecordIndexOfProject(record.projectId))) ?? [];
    if (!ids.includes(fullRecord.id)) {
      await set(ComicDbKeys.imageRecordIndexOfProject(record.projectId), [...ids, fullRecord.id]);
    }
  });
  return fullRecord;
}

export async function getImageBlob(id: string): Promise<Blob | undefined> {
  return get<Blob>(ComicDbKeys.image(id));
}

/** 读取图片元数据记录（remoteUrl 回退展示用） */
export async function getImageRecord(id: string): Promise<ComicImageRecord | undefined> {
  return get<ComicImageRecord>(ComicDbKeys.imageRecord(id));
}

/** 删除单条图片记录及其 blob（替换参考图时清理旧图） */
export async function deleteImageRecord(imageRecordId: string, projectId: string): Promise<void> {
  await del(ComicDbKeys.imageRecord(imageRecordId));
  await del(ComicDbKeys.image(imageRecordId));
  await withImageIndexLock(async () => {
    const ids =
      (await get<string[]>(ComicDbKeys.imageRecordIndexOfProject(projectId))) ?? [];
    await set(
      ComicDbKeys.imageRecordIndexOfProject(projectId),
      ids.filter((id) => id !== imageRecordId),
    );
  });
}

// ---------------------------------------------------------------------------
// 生成任务
// ---------------------------------------------------------------------------

export async function listGenerationTasks(chapterId: string): Promise<GenerationTask[]> {
  const ids =
    (await get<string[]>(ComicDbKeys.generationTaskIndexOfChapter(chapterId))) ?? [];
  const list = await Promise.all(
    ids.map((id) => get<GenerationTask>(ComicDbKeys.generationTask(id))),
  );
  return list.filter((t): t is GenerationTask => Boolean(t));
}

export async function saveGenerationTask(task: GenerationTask): Promise<void> {
  await withTaskIndexLock(async () => {
    const ids =
      (await get<string[]>(ComicDbKeys.generationTaskIndexOfChapter(task.chapterId))) ?? [];
    if (!ids.includes(task.id)) {
      await set(ComicDbKeys.generationTaskIndexOfChapter(task.chapterId), [...ids, task.id]);
    }
  });
  await set(ComicDbKeys.generationTask(task.id), task);
}

// ---------------------------------------------------------------------------
// 全局设置
// ---------------------------------------------------------------------------

export async function getSettings(): Promise<WorkbenchSettings> {
  const settings = await get<WorkbenchSettings>(ComicDbKeys.settings());
  return (
    settings ?? {
      ai: null,
      customStylePresets: [],
      lastChapterByProject: {},
    }
  );
}

export async function saveSettings(settings: WorkbenchSettings): Promise<void> {
  await set(ComicDbKeys.settings(), settings);
}
