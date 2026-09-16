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
import { generateImage } from "../ai/imageClient";
import { getStylePresetById, promptFormula } from "../configService";
import type {
  CharacterDesignImages,
  CharacterDesignView,
  ComicChapter,
  ComicCharacter,
  ComicImageModelChoice,
  ComicProject,
  ComicScene,
} from "../../types";

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
        palette: z.string().max(120).default(""),
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
  "你是漫画制片助理。从小说原文中提取出场角色与出现场景，产出可直接用于人物设计图与分镜生图的完整设定。",
  '只输出 JSON：{"characters":[{"name":"…","gender":"男/女/未知","appearance":"外貌","clothing":"服装","features":"辨识特征","palette":"主色调"}],"scenes":[{"name":"…","spaceStructure":"空间结构","environment":"环境氛围"}]}。',
  "角色设定要求：",
  "1. 只提取有正面出场的角色，无名路人不要；同名角色只输出一条，特征取并集。",
  "2. appearance 必须完整覆盖五要素：发型发色、眼睛、脸型、体型、气质，用顿号分隔；原文没有明写的要素，按角色身份、时代背景与整体文风合理补全，保证设定完整可绘制。",
  "3. clothing 写标志性服装（款式/颜色/配饰）；features 写一眼可辨的记号（疤/饰物/习惯动作），原文没有可依据身份合理设计。",
  "4. palette 写角色主色调（发色/肤色/服装主色，3-5 种颜色），必须与 appearance 一致。",
  "5. 场景写具体地点：spaceStructure 写布局方位（供构图复用），environment 写光线天气氛围。",
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
  signal?: AbortSignal;
}): Promise<ExtractCastResult> {
  const { chapter, signal } = params;
  const content = chapter.sourceContent.slice(0, EXTRACT_CHAR_LIMIT);
  const result = await chatJson({
    system: EXTRACT_SYSTEM_PROMPT,
    user: `章节标题：${chapter.title}\n\n正文：\n${content}`,
    schema: extractSchema,
    signal,
    temperature: 0.2,
    label: "角色场景提取",
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
      existing.palette = existing.palette || item.palette;
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
      palette: item.palette,
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
export async function bumpCastVersion(projectId: string): Promise<void> {
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
  // 姓名参与台词说话人匹配（matchSpeaker），新增或改名同样使已提取台词过期
  if (next.promptFragment !== character.promptFragment || next.name !== character.name) {
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
  primary.palette = primary.palette || duplicate.palette;
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

/** 角色 → 描述词片段：外貌+服装+特征+色板压成一句素材 */
export function buildCharacterPromptFragment(character: ComicCharacter): string {
  const parts = [
    character.appearance && `外貌：${character.appearance}`,
    character.clothing && `服装：${character.clothing}`,
    character.features && `特征：${character.features}`,
    character.palette && `主色调：${character.palette}`,
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

// ---------------------------------------------------------------------------
// AI 补全角色设定（五要素锚定）
// ---------------------------------------------------------------------------

const completeSchema = z.object({
  appearance: z.string().max(300).catch(""),
  clothing: z.string().max(300).catch(""),
  features: z.string().max(300).catch(""),
  palette: z.string().max(120).catch(""),
});

const COMPLETE_SYSTEM_PROMPT = [
  "你是漫画角色设计师。根据角色名、已有设定与原文参考，产出完整可用的角色外貌设定，用于绘制人物设计图。",
  '只输出 JSON：{"appearance":"…","clothing":"…","features":"…","palette":"…"}。',
  "硬性要求：",
  "1. appearance 完整覆盖五要素：发型发色、眼睛、脸型、体型、气质，用顿号分隔；已有设定必须保留融入，缺失细节按原文与角色身份合理补全。",
  "2. clothing 给出标志性日常服装（款式/颜色/配饰）。",
  "3. features 给出 1-3 个一眼可辨的记号（疤/饰物/习惯动作），没有可靠依据时设计一个贴合身份的。",
  "4. palette 给出角色主色调（发色/肤色/服装主色，3-5 种颜色），与 appearance 一致。",
].join("\n");

/**
 * AI 补全角色设定：以当前章节原文为依据，把五要素（发型/眼睛/脸型/体型/气质）
 * 与色板补全成完整人设。已有非空设定作为「必须保留」的约束交给模型融合。
 */
export async function completeCharacterWithAi(params: {
  character: ComicCharacter;
  chapter?: ComicChapter;
  signal?: AbortSignal;
}): Promise<ComicCharacter> {
  const { character, chapter, signal } = params;
  const existingText =
    [
      character.appearance && `外貌：${character.appearance}`,
      character.clothing && `服装：${character.clothing}`,
      character.features && `特征：${character.features}`,
      character.palette && `主色调：${character.palette}`,
    ]
      .filter(Boolean)
      .join("；") || "（暂无设定）";
  const excerpt = chapter ? chapter.sourceContent.slice(0, EXTRACT_CHAR_LIMIT) : "";
  const result = await chatJson({
    system: COMPLETE_SYSTEM_PROMPT,
    user: `角色名：${character.name}（${character.gender}）\n已有设定：${existingText}\n${
      excerpt ? `原文参考：\n${excerpt}` : "（无原文参考，请依据角色名与常见人设合理设计）"
    }`,
    schema: completeSchema,
    signal,
    temperature: 0.4,
    label: "角色设定补全",
  });
  const updates = {
    appearance: result.appearance.trim(),
    clothing: result.clothing.trim(),
    features: result.features.trim(),
    palette: result.palette.trim(),
  };
  if (!updates.appearance && !updates.clothing && !updates.features && !updates.palette) {
    throw new Error("AI 没有返回可用的设定内容，请重试");
  }
  return saveCharacterCard(character, updates);
}

// ---------------------------------------------------------------------------
// 人物设计图（7 视图：4 全身转向 + 3 面部特写）
// ---------------------------------------------------------------------------

export interface CharacterDesignViewSpec {
  view: CharacterDesignView;
  /** 展示名（缩略图槽位标签） */
  label: string;
  /** 画面指令（拼入描述词） */
  directive: string;
  width: number;
  height: number;
}

/** 固定 7 视图规格：同一角色多视图参考，保证分镜生图时人物一致性 */
export const CHARACTER_DESIGN_VIEW_SPECS: CharacterDesignViewSpec[] = [
  { view: "full_front", label: "全身正面", directive: "全身正面站立，双臂自然下垂，展示整体造型", width: 832, height: 1216 },
  { view: "full_three_quarter", label: "全身3/4侧", directive: "全身四分之三侧面站立，自然姿态", width: 832, height: 1216 },
  { view: "full_side", label: "全身侧面", directive: "全身正侧面站立，展示身体轮廓", width: 832, height: 1216 },
  { view: "full_back", label: "全身背面", directive: "全身背面站立，展示背部细节", width: 832, height: 1216 },
  { view: "face_front", label: "面部正面", directive: "面部正面特写，胸部以上，突出五官与标准表情", width: 1024, height: 1024 },
  { view: "face_three_quarter", label: "面部3/4侧", directive: "面部四分之三侧面特写，胸部以上", width: 1024, height: 1024 },
  { view: "face_side", label: "面部侧面", directive: "面部正侧面特写，展示侧脸轮廓", width: 1024, height: 1024 },
];

/** 项目画风尾串：画风预设 + 色调微调 + 自定义关键词（与分镜描述词同源，保证画风统一） */
function buildProjectStyleTail(project: ComicProject): string {
  const style = getStylePresetById(project.stylePresetId);
  return [
    style?.promptKeywords,
    project.styleAdjustments.colorTone && `色调：${project.styleAdjustments.colorTone}`,
    project.customStyleKeywords.trim(),
  ]
    .filter((text): text is string => Boolean(text && text.trim()))
    .join("，");
}

function buildCharacterDesignPrompt(
  character: ComicCharacter,
  project: ComicProject,
  spec: CharacterDesignViewSpec,
): { prompt: string; negativePrompt: string } {
  const style = getStylePresetById(project.stylePresetId);
  const parts = [
    `同一角色的角色设定参考图（character reference sheet），${spec.directive}`,
    `角色：${character.name}（${character.gender}）`,
    character.appearance && `外貌：${character.appearance}`,
    character.clothing && `服装：${character.clothing}`,
    character.features && `辨识特征：${character.features}`,
    character.palette && `主色调：${character.palette}`,
    "纯色浅灰背景，画面中只有这一个角色，无文字",
    buildProjectStyleTail(project),
    promptFormula.qualityWords.hd,
  ].filter((text): text is string => Boolean(text && text.trim()));
  const negative = [
    style?.negativeKeywords?.trim(),
    "多人，分格，分镜格子，对话气泡",
    promptFormula.negativeWords,
  ]
    .filter(Boolean)
    .join("，");
  return { prompt: parts.join("，"), negativePrompt: negative };
}

export interface GenerateDesignViewParams {
  character: ComicCharacter;
  project: ComicProject;
  /** 主程序生图模型选择（空=跟随主程序当前选择） */
  imageChoice: ComicImageModelChoice | null;
  view: CharacterDesignView;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

/** 生成/重新生成单张人物设计图：生图 → Blob 落库 → 写回角色卡（清理旧图） */
export async function generateCharacterDesignView(
  params: GenerateDesignViewParams,
): Promise<ComicCharacter> {
  const { character, project, imageChoice, view, signal, onProgress } = params;
  const spec = CHARACTER_DESIGN_VIEW_SPECS.find((item) => item.view === view);
  if (!spec) throw new Error(`未知的设计图视图：${view}`);
  const { prompt, negativePrompt } = buildCharacterDesignPrompt(character, project, spec);
  onProgress?.(`正在生成「${character.name}」${spec.label}设计图…`);
  const image = await generateImage(imageChoice, {
    prompt,
    negativePrompt,
    comicPanelId: `cast:${character.id}`,
    width: spec.width,
    height: spec.height,
    signal,
    onProgress,
  });
  onProgress?.(`「${spec.label}」已生成，正在保存…`);
  const record = await saveImageBlob(
    {
      projectId: character.projectId,
      kind: "character",
      mime: image.mime,
      byteSize: image.blob?.size ?? 0,
      remoteUrl: image.remoteUrl,
    },
    image.blob,
  );
  const oldImageId = character.designImages?.[view];
  if (oldImageId && oldImageId !== record.id) {
    await deleteImageRecord(oldImageId, character.projectId);
  }
  return saveCharacterCard(character, {
    designImages: { ...(character.designImages ?? {}), [view]: record.id } as CharacterDesignImages,
    designBasisStamp: character.promptFragment,
  });
}

// ---------------------------------------------------------------------------
// 场景概念图
// ---------------------------------------------------------------------------

/** 生成/重新生成场景概念图（无人无文字，横版），写回场景卡 */
export async function generateSceneImage(params: {
  scene: ComicScene;
  project: ComicProject;
  imageChoice: ComicImageModelChoice | null;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<ComicScene> {
  const { scene, project, imageChoice, signal, onProgress } = params;
  const style = getStylePresetById(project.stylePresetId);
  const parts = [
    `场景概念设计图：${scene.name}`,
    scene.spaceStructure && `空间布局：${scene.spaceStructure}`,
    scene.environment && `环境氛围：${scene.environment}`,
    scene.dynamic.time && `时间：${scene.dynamic.time}`,
    scene.dynamic.weather && `天气：${scene.dynamic.weather}`,
    scene.dynamic.lighting && `光影：${scene.dynamic.lighting}`,
    "画面中无人物，无文字，展示空间全貌",
    buildProjectStyleTail(project),
    promptFormula.qualityWords.hd,
  ].filter((text): text is string => Boolean(text && text.trim()));
  const negative = [
    style?.negativeKeywords?.trim(),
    "人物，人影，文字，对话气泡，分镜格子",
    promptFormula.negativeWords,
  ]
    .filter(Boolean)
    .join("，");
  onProgress?.(`正在生成场景「${scene.name}」概念图…`);
  const image = await generateImage(imageChoice, {
    prompt: parts.join("，"),
    negativePrompt: negative,
    comicPanelId: `scene:${scene.id}`,
    width: 1216,
    height: 832,
    signal,
    onProgress,
  });
  onProgress?.("场景图已生成，正在保存…");
  const record = await saveImageBlob(
    {
      projectId: scene.projectId,
      kind: "scene",
      mime: image.mime,
      byteSize: image.blob?.size ?? 0,
      remoteUrl: image.remoteUrl,
    },
    image.blob,
  );
  if (scene.imageId && scene.imageId !== record.id) {
    await deleteImageRecord(scene.imageId, scene.projectId);
  }
  return saveSceneCard(scene, { imageId: record.id, imageBasisStamp: scene.promptFragment });
}
