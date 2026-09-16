/**
 * 运营文案服务（爆款增强）
 *
 * 按发布平台生成漫画章节的运营文案：标题 / 摘要 / 发布正文 / 话题标签。
 * 文案为新增产物，绝不改写原文（规则第5条）；平台与叙事模板指令全部来自
 * config/narrativeTemplates.json（规则第6条），此处不硬编码平台规则。
 *
 * 存储：文案按 章节id+平台id 存独立键 comic:marketing:*，
 * 删除项目时由数据层全键扫描兜底清理（见 comicDb.purgeOrphanKeys）。
 */
import { z } from "zod";
import { dbGet, dbGetRequired, dbSet, saveProject } from "../db/comicDb";
import { getAiDefaults } from "./ai/aiConfigService";
import { chatJson } from "./ai/llmClient";
import { narrativeTemplates } from "./configService";
import { ComicDbKeys } from "../types";
import type {
  ComicChapter,
  ComicProject,
  MarketingCopy,
} from "../types";

// ---------------------------------------------------------------------------
// 平台适配查询
// ---------------------------------------------------------------------------

export function getPlatformById(platformId: string) {
  return narrativeTemplates.platforms.find((platform) => platform.id === platformId);
}

/** 平台推荐的形态配置 id（平台不存在时返回 undefined） */
export function getRecommendedFormId(platformId: string): string | undefined {
  return getPlatformById(platformId)?.recommendedFormId;
}

// ---------------------------------------------------------------------------
// 运营文案生成
// ---------------------------------------------------------------------------

/** 单镜原文注入 LLM 的截断长度（文案只需故事梗概，控制 token） */
const SOURCE_LIMIT = 1600;

const marketingSchema = z.object({
  title: z.string().min(1).max(40),
  summary: z.string().min(1).max(120),
  post: z.string().min(1).max(2000),
  tags: z.array(z.string().min(1).max(20)).max(10),
});

const SYSTEM_PROMPT = [
  "你是漫画运营助手。根据漫画章节正文，为指定内容平台撰写发布文案。",
  "必须输出 JSON，结构如下：",
  '{"title":"吸引点击的标题（30字内）","summary":"一句话摘要（60字内）",',
  ' "post":"发布正文：开头钩子+看点介绍+互动引导，用换行分段","tags":["话题标签1","话题标签2"]}',
  "要求：标题与正文符合该平台的流行风格；tags 为不带 # 号的话题词，3-8 个；",
  "禁止剧透关键反转；禁止出现设定清单式写法。",
].join("\n");

export interface GenerateMarketingParams {
  project: ComicProject;
  chapter: ComicChapter;
  platformId: string;
  signal?: AbortSignal;
}

/** 生成并保存运营文案（失败抛 AiError，由调用方兜底提示） */
export async function generateMarketingCopy(
  params: GenerateMarketingParams,
): Promise<MarketingCopy> {
  const { project, chapter, platformId, signal } = params;
  const platform = getPlatformById(platformId);
  if (!platform) {
    throw new Error("发布平台配置不存在，请检查 narrativeTemplates.json");
  }

  const defaults = getAiDefaults();
  const template = narrativeTemplates.templates.find(
    (item) => item.id === chapter.inspiration?.brief.narrativeTemplateId,
  );
  const characters = (chapter.inspiration?.draft.characters ?? [])
    .map((item) => item.name)
    .filter(Boolean);

  const user = [
    `发布平台：${platform.name}`,
    `平台节奏与风格要求：${platform.pacingHint}`,
    template ? `本篇叙事节奏：${template.promptDirective}` : "",
    `作品名：${project.name}`,
    `章节：第 ${chapter.index} 章 ${chapter.title}`,
    characters.length > 0 ? `主要角色：${characters.join("、")}` : "",
    "",
    "章节正文（节选）：",
    chapter.sourceContent.slice(0, SOURCE_LIMIT),
    "",
    "请按系统提示中的 JSON 结构输出该平台的发布文案。",
  ]
    .filter(Boolean)
    .join("\n");

  const result = await chatJson({
    system: SYSTEM_PROMPT,
    user,
    schema: marketingSchema,
    timeoutMs: defaults.llmTimeoutMs,
    signal,
    label: "营销文案生成",
  });

  const copy: MarketingCopy = {
    platformId,
    title: result.title,
    summary: result.summary,
    post: result.post,
    tags: result.tags,
    generatedAt: new Date().toISOString(),
  };
  await dbSet(ComicDbKeys.marketing(chapter.id, platformId), copy);
  return copy;
}

/** 读取已保存的运营文案（没有则返回 undefined） */
export async function loadMarketingCopy(
  chapterId: string,
  platformId: string,
): Promise<MarketingCopy | undefined> {
  return dbGet<MarketingCopy>(ComicDbKeys.marketing(chapterId, platformId));
}

// ---------------------------------------------------------------------------
// 项目平台适配（纯运营信息，不参与版本链）
// ---------------------------------------------------------------------------

/** 保存项目的发布平台选择；平台不影响任何下游产物，不递增版本 */
export async function saveProjectPlatform(
  projectId: string,
  platformId: string | undefined,
): Promise<ComicProject> {
  const project = await dbGetRequired<ComicProject>(ComicDbKeys.project(projectId), "项目");
  const next: ComicProject = {
    ...project,
    platformId: platformId || undefined,
    updatedAt: new Date().toISOString(),
  };
  await saveProject(next);
  return next;
}
