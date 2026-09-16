/**
 * 灵感导入服务（唯一走大模型扩写的导入方式）
 * 输入关键词/梗概 → 结构化产出：人物设定 + 场景设定 + 剧情节点 + 完整正文
 */
import { z } from "zod";
import { getAiDefaults } from "../ai/aiConfigService";
import { chatJson } from "../ai/llmClient";
import { narrativeTemplates } from "../configService";
import type { InspirationBrief, InspirationDraft } from "../../types";

const inspirationSchema = z.object({
  characters: z
    .array(
      z.object({
        name: z.string().min(1),
        gender: z.string(),
        appearance: z.string(),
        clothing: z.string(),
        features: z.string(),
      }),
    )
    .min(1),
  scenes: z
    .array(
      z.object({
        name: z.string().min(1),
        spaceStructure: z.string(),
        environment: z.string(),
      }),
    )
    .min(1),
  plotNodes: z.array(z.string()).min(1),
  content: z.string().min(100),
});

const LENGTH_HINTS: Record<InspirationBrief["length"], string> = {
  short: "正文约 1000-2000 字",
  medium: "正文约 3000-5000 字",
  long: "正文约 6000-10000 字",
};

const SYSTEM_PROMPT = [
  "你是一位网文作者助手。根据用户给出的灵感关键词，创作一段可用于漫画改编的小说正文。",
  "必须输出 JSON，结构如下：",
  '{"characters":[{"name":"姓名","gender":"性别","appearance":"外貌","clothing":"服装","features":"性格与记忆点"}],',
  ' "scenes":[{"name":"场景名","spaceStructure":"空间布局","environment":"环境细节"}],',
  ' "plotNodes":["剧情节点1","剧情节点2"],',
  ' "content":"完整小说正文"}',
  "要求：正文分段自然、每段独立成行；人物与场景设定必须与正文一致；不得在正文中出现设定清单式写法。",
].join("\n");

/** 生成灵感草稿（失败抛 AiError，由调用方兜底提示） */
export async function generateInspirationDraft(
  brief: InspirationBrief,
  signal?: AbortSignal,
): Promise<InspirationDraft> {
  const defaults = getAiDefaults();
  const template = narrativeTemplates.templates.find((t) => t.id === brief.narrativeTemplateId);
  const user = [
    `灵感关键词：${brief.keywords}`,
    `题材：${brief.genre || "不限"}`,
    `风格倾向：${brief.styleHint || "不限"}`,
    `篇幅：${LENGTH_HINTS[brief.length]}`,
    template ? `叙事节奏要求：${template.promptDirective}` : "",
    "",
    "请按系统提示中的 JSON 结构输出。",
  ]
    .filter(Boolean)
    .join("\n");

  return chatJson({
    system: SYSTEM_PROMPT,
    user,
    schema: inspirationSchema,
    timeoutMs: defaults.longTextTimeoutMs,
    signal,
    label: "inspiration_draft",
  });
}
