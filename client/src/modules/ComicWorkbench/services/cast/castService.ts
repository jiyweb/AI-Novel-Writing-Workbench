/**
 * 角色与场景库服务（项目级，跨章节共享）
 *
 * 职责：LLM 批量提取 → 同名合并落库 → 手动编辑 → 参考图上传（Blob）→
 * 描述词片段组装。角色/场景卡是描述词引擎（P6）的上游素材。
 *
 * 数据流单向（规则第7条）：提取只新增/合并库内卡片，绝不改写章节原文
 * 与已生成的分镜；提取成功后递增章节 versions.cast 供下游 stale 判定。
 */
import { z } from "zod";
import {
  deleteCharacter,
  deleteImageRecord,
  deleteScene,
  generateId,
  getImageBlob,
  listCharacters,
  listChapters,
  listScenes,
  saveCharacter,
  saveScene,
  saveImageBlob,
  saveChapter,
} from "../../db/comicDb";
import { chatJson } from "../ai/llmClient";
import { getAiDefaults } from "../ai/aiConfigService";
import type { AiConnectionSettings, ComicChapter, ComicCharacter, ComicScene } from "../../types";

/** 单次提取读入的原文上限（角色卡提取只需要主干描写） */
const EXTRACT_CHAR_LIMIT = 12000;

// ---------------------------------------------------------------------------
// LLM 提取
// ---------------------------------------------------------------------------

const extractSchema = z.object({
  characters: z
    .array(
      z.object({
        name: z.string().min(1).max(40),
        gender: z.string().max(10).default("未知"),
        appearance: z.string().max(300).default(""),
        clothing: z.string().max(300).default(""),
        features: z.string().max(300).default(""),
      }),
    )
    .max(30),
  scenes: z
    .array(
      z.object({
        name: z.string().min(1).max(40),
        spaceStructure: z.string().max(300).default(""),
        environment: z.string().max(300).default(""),
      }),
    )
    .max(30),
});

const EXTRACT_SYSTEM_PROMPT = [
  "你是漫画制片助理。从小说原文中提取出场角色与出现场景。",
  "只输出 JSON：{\"characters\":[{\"name\":\"…\",\"gender\":\"男/女/未知\",\"appearance\":\"外貌\",\"clothing\":\"服装\",\"features\":\"辨识特征\"}],\"scenes\":[{\"name\":\"…\",\"spaceStructure\":\"空间结构\",\"environment\":\"环境氛围\"}]}。",
  "要求：",
  "1. 只提取有正面出场的角色，无名路人不要；同名角色只输出一条，特征取并集。",
  "2. appearance 写发型发色/五官/体型，clothing 写当章服装，features 写一眼可辨的记号（疤/饰物/习惯动作）。",
  "3. 场景写具体地点：spaceStructure 写布局方位（供构图复用），environment 写光线天气氛围。",
  "4. 不确定的字段留空字符串，不要编造。",
].join("\n");

export interface ExtractCastResult {
  addedCharacters: number;
  mergedCharacters: number;
  addedScenes: number;
  mergedScenes: number;
}

/** LLM 提取角色与场景，同名卡片自动合并（mergedFrom 记录被并入的旧卡） */
export async function extractCastFromChapter(params: {
  chapter: ComicChapter;
  settings: AiConnectionSettings;
  signal?: AbortSignal;
}): Promise<ExtractCastResult> {
  const { chapter, settings, signal } = params;
  const content = chapter.sourceContent.slice(0, EXTRACT_CHAR_LIMIT);
  const result = await chatJson({
    settings,
    system: EXTRACT_SYSTEM_PROMPT,
    user: `章节标题：${chapter.title}\n\n正文：\n${content}`,
    schema: extractSchema,
    signal,
    temperature: 0.2,
    timeoutMs: getAiDefaults().longTextTimeoutMs,
  });

  const characters = await listCharacters(chapter.projectId);
  const scenes = await listScenes(chapter.projectId);
  const now = new Date().toISOString();
  const summary: ExtractCastResult = {
    addedCharacters: 0,
    mergedCharacters: 0,
    addedScenes: 0,
    mergedScenes: 0,
  };

  for (const item of result.characters) {
    const existing = characters.find((c) => c.name === item.name);
    if (existing) {
      existing.appearance = existing.appearance || item.appearance;
      existing.clothing = existing.clothing || item.clothing;
      existing.features = mergeFeatures(existing.features, item.features);
      existing.promptFragment = buildCharacterPromptFragment(existing);
      existing.updatedAt = now;
      await saveCharacter(existing);
      summary.mergedCharacters += 1;
      continue;
    }
    const character: ComicCharacter = {
      id: generateId("char"),
      projectId: chapter.projectId,
      name: item.name,
      gender: item.gender || "未知",
      appearance: item.appearance,
      clothing: item.clothing,
      features: item.features,
      promptFragment: "",
      updatedAt: now,
    };
    character.promptFragment = buildCharacterPromptFragment(character);
    await saveCharacter(character);
    summary.addedCharacters += 1;
  }

  for (const item of result.scenes) {
    const existing = scenes.find((s) => s.name === item.name);
    if (existing) {
      existing.spaceStructure = existing.spaceStructure || item.spaceStructure;
      existing.environment = existing.environment || item.environment;
      existing.promptFragment = buildScenePromptFragment(existing);
      existing.updatedAt = now;
      await saveScene(existing);
      summary.mergedScenes += 1;
      continue;
    }
    const scene: ComicScene = {
      id: generateId("scene"),
      projectId: chapter.projectId,
      name: item.name,
      spaceStructure: item.spaceStructure,
      environment: item.environment,
      dynamic: { time: "", weather: "", lighting: "" },
      promptFragment: "",
      updatedAt: now,
    };
    scene.promptFragment = buildScenePromptFragment(scene);
    await saveScene(scene);
    summary.addedScenes += 1;
  }

  // 角色库项目级共享：提取/合并后项目内全部章节 cast 递增，供下游 stale 判定
  const chapters = await listChapters(chapter.projectId);
  for (const item of chapters) {
    item.versions.cast += 1;
    item.updatedAt = now;
    await saveChapter(item);
  }
  return summary;
}

function mergeFeatures(base: string, extra: string): string {
  if (!extra) return base;
  if (!base) return extra;
  if (base.includes(extra)) return base;
  return `${base}；${extra}`;
}

/** 角色/场景卡内容变化后递增项目内全部章节 cast 版本，供下游 stale 判定 */
async function bumpCastVersion(projectId: string): Promise<void> {
  const chapters = await listChapters(projectId);
  const now = new Date().toISOString();
  for (const item of chapters) {
    item.versions.cast += 1;
    item.updatedAt = now;
    await saveChapter(item);
  }
}

// ---------------------------------------------------------------------------
// 手动编辑与合并
// ---------------------------------------------------------------------------

/** 保存角色卡（设定变化时自动重组描述词片段；片段变化则递增 cast 版本） */
export async function saveCharacterCard(
  character: ComicCharacter,
  updates: Partial<Omit<ComicCharacter, "id" | "projectId" | "updatedAt">>,
): Promise<ComicCharacter> {
  const next: ComicCharacter = {
    ...character,
    ...updates,
    id: character.id,
    projectId: character.projectId,
    updatedAt: new Date().toISOString(),
  };
  next.promptFragment = buildCharacterPromptFragment(next);
  await saveCharacter(next);
  if (next.promptFragment !== character.promptFragment) {
    await bumpCastVersion(next.projectId);
  }
  return next;
}

export async function saveSceneCard(
  scene: ComicScene,
  updates: Partial<Omit<ComicScene, "id" | "projectId" | "updatedAt">>,
): Promise<ComicScene> {
  const next: ComicScene = {
    ...scene,
    ...updates,
    id: scene.id,
    projectId: scene.projectId,
    updatedAt: new Date().toISOString(),
  };
  next.promptFragment = buildScenePromptFragment(next);
  await saveScene(next);
  if (next.promptFragment !== scene.promptFragment) {
    await bumpCastVersion(next.projectId);
  }
  return next;
}

/** 把重复角色并入主卡（设定字段取主卡优先的并集，mergedFrom 留痕） */
export async function mergeCharacterInto(
  projectId: string,
  primaryId: string,
  duplicateId: string,
): Promise<ComicCharacter> {
  const all = await listCharacters(projectId);
  const primary = all.find((c) => c.id === primaryId);
  const duplicate = all.find((c) => c.id === duplicateId);
  if (!primary || !duplicate) throw new Error("角色不存在或已被删除");
  if (primaryId === duplicateId) throw new Error("不能与自身合并");

  const beforeFragment = primary.promptFragment;
  primary.appearance = primary.appearance || duplicate.appearance;
  primary.clothing = primary.clothing || duplicate.clothing;
  primary.features = mergeFeatures(primary.features, duplicate.features);
  primary.mergedFrom = [...(primary.mergedFrom ?? []), duplicate.id, ...(duplicate.mergedFrom ?? [])];
  primary.promptFragment = buildCharacterPromptFragment(primary);
  primary.updatedAt = new Date().toISOString();
  await saveCharacter(primary);
  await deleteCharacter(duplicateId, projectId);
  if (primary.promptFragment !== beforeFragment) {
    await bumpCastVersion(projectId);
  }
  return primary;
}

export async function mergeSceneInto(
  projectId: string,
  primaryId: string,
  duplicateId: string,
): Promise<ComicScene> {
  const all = await listScenes(projectId);
  const primary = all.find((s) => s.id === primaryId);
  const duplicate = all.find((s) => s.id === duplicateId);
  if (!primary || !duplicate) throw new Error("场景不存在或已被删除");
  if (primaryId === duplicateId) throw new Error("不能与自身合并");

  const beforeFragment = primary.promptFragment;
  primary.spaceStructure = primary.spaceStructure || duplicate.spaceStructure;
  primary.environment = primary.environment || duplicate.environment;
  primary.mergedFrom = [...(primary.mergedFrom ?? []), duplicate.id, ...(duplicate.mergedFrom ?? [])];
  primary.promptFragment = buildScenePromptFragment(primary);
  primary.updatedAt = new Date().toISOString();
  await saveScene(primary);
  await deleteScene(duplicateId, projectId);
  if (primary.promptFragment !== beforeFragment) {
    await bumpCastVersion(projectId);
  }
  return primary;
}

export async function removeCharacter(id: string, projectId: string): Promise<void> {
  await deleteCharacter(id, projectId);
  // 删除可能影响引用该角色的描述词组合，保守递增版本提示下游
  await bumpCastVersion(projectId);
}

export async function removeScene(id: string, projectId: string): Promise<void> {
  await deleteScene(id, projectId);
  await bumpCastVersion(projectId);
}

// ---------------------------------------------------------------------------
// 描述词片段组装
// ---------------------------------------------------------------------------

/** 角色 → 描述词片段：外貌+服装+特征压成一句素材 */
export function buildCharacterPromptFragment(character: ComicCharacter): string {
  const parts = [
    character.appearance && `外貌：${character.appearance}`,
    character.clothing && `服装：${character.clothing}`,
    character.features && `特征：${character.features}`,
  ].filter(Boolean);
  return parts.join("，");
}

/** 场景 → 描述词片段：固定空间结构 + 环境（动态参数由分镜级覆盖） */
export function buildScenePromptFragment(scene: ComicScene): string {
  const parts = [
    scene.spaceStructure && `空间：${scene.spaceStructure}`,
    scene.environment && `环境：${scene.environment}`,
  ].filter(Boolean);
  return parts.join("，");
}

// ---------------------------------------------------------------------------
// 参考图上传
// ---------------------------------------------------------------------------

/** 参考图大小上限（正/侧面参考图不需要原图分辨率） */
export const REFERENCE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export type ReferenceSide = "front" | "side";

/** 上传角色正/侧面参考图：校验 → Blob 入库 → 记录到角色卡（替换旧图） */
export async function uploadCharacterReference(
  character: ComicCharacter,
  file: File,
  side: ReferenceSide,
): Promise<ComicCharacter> {
  if (!file.type.startsWith("image/")) {
    throw new Error("请选择图片文件（PNG/JPG/WebP）");
  }
  if (file.size > REFERENCE_IMAGE_MAX_BYTES) {
    throw new Error(`图片过大（${Math.round(file.size / 1024)}KB），请控制在 5MB 以内`);
  }

  const blob = await file.arrayBuffer().then((buffer) => new Blob([buffer], { type: file.type }));
  const record = await saveImageBlob(
    { projectId: character.projectId, kind: "character", mime: file.type, byteSize: blob.size },
    blob,
  );
  const oldImageId = side === "front" ? character.frontImageId : character.sideImageId;
  if (oldImageId) {
    await deleteImageRecord(oldImageId, character.projectId);
  }
  return saveCharacterCard(character, {
    [side === "front" ? "frontImageId" : "sideImageId"]: record.id,
  } as Partial<ComicCharacter>);
}

/** 读取参考图 Blob（组件用 objectURL 展示，注意 revoke） */
export async function loadReferenceImageBlob(imageId: string): Promise<Blob | undefined> {
  return getImageBlob(imageId);
}
