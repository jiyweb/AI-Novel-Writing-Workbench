import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { prisma } from "../../db/prisma";
import { resolveModel, toStructuredOutputStrategy } from "../../llm/modelRouter";
import { resolveStructuredOutputProfile } from "../../llm/structuredOutput";
import { runStructuredPrompt } from "../../prompting/core/promptRunner";
import { comicPanelScriptPrompt } from "../../prompting/prompts/comic/comic.prompts";
import { adaptationSourceRegistry } from "../adaptation/source/SourceContentPort";
import { comicFactService } from "./ComicFactService";
import { resolveComicStyleLabel } from "./comicStylePrompt";

// 分格脚本是漫画链路中最大的结构化输出（30-80 格 × 完整 JSON）。
// 历史失败主因：未显式给 maxTokens，厂商默认上限（如 DeepSeek 8192）把 JSON 截断，
// 修复器同样受上限约束，最终报「生成分格脚本失败」。
// 经验值：普通格约 350-420 输出 token，四格（含 4 条子格描述）约 550-650。
const PANEL_TOKEN_BUDGET_DEFAULT = 420;
const PANEL_TOKEN_BUDGET_FOUR_KOMA = 650;
const SCRIPT_FIXED_TOKEN_BUDGET = 2500;
const SCRIPT_MAX_TOKENS_FLOOR = 9000;
const SCRIPT_MAX_TOKENS_CEILING = 32000;
// 大体量 JSON 生成常超过默认 HTTP/模型超时，给足 5 分钟
const SCRIPT_TIMEOUT_MS = 300_000;

/**
 * 按目标格数估算输出 token 预算，并通过与正式调用一致的任务路由探测
 * 真实厂商上限（normalizeMaxTokens 会按厂商 maxTokens 收口）。
 * 返回最终应下发的 maxTokens，以及预算是否被厂商上限压缩（需要极简输出）。
 */
async function resolveScriptTokenBudget(
  targetPanelCount: number,
  comicFormat: string | undefined,
  provider?: LLMProvider,
): Promise<{ maxTokens: number; tightBudget: boolean }> {
  const perPanel = comicFormat === "4koma"
    ? PANEL_TOKEN_BUDGET_FOUR_KOMA
    : PANEL_TOKEN_BUDGET_DEFAULT;
  const desired = Math.min(
    SCRIPT_MAX_TOKENS_CEILING,
    Math.max(SCRIPT_MAX_TOKENS_FLOOR, targetPanelCount * perPanel + SCRIPT_FIXED_TOKEN_BUDGET),
  );
  try {
    const routed = await resolveModel("chapter_drafting", {
      ...(provider ? { provider } : {}),
      maxTokens: desired,
    });
    // 镜像 resolveLLMClientOptions 对结构化调用的二次收口：
    // 部分官方端点（anthropic/minimax/qwen prompt_json 等）会把 maxTokens 限制在安全值
    const structuredProfile = resolveStructuredOutputProfile({
      provider: routed.provider,
      model: routed.model,
      requestProtocol: routed.requestProtocol === "anthropic" ? "anthropic" : "openai_compatible",
      executionMode: "structured",
    });
    const structuredStrategy = toStructuredOutputStrategy(routed.structuredResponseFormat);
    const usesNativeStructured = structuredStrategy != null && structuredStrategy !== "prompt_json";
    let effective = routed.maxTokens ?? desired;
    if (structuredProfile.omitMaxTokensForNativeStructured && usesNativeStructured) {
      // 原生结构化要求省略 maxTokens，模型按自身默认上限输出
      effective = desired;
    } else if (typeof structuredProfile.safeStructuredMaxTokens === "number") {
      effective = Math.min(effective, structuredProfile.safeStructuredMaxTokens);
    }
    return { maxTokens: effective, tightBudget: effective < desired };
  } catch {
    // 路由探测失败不阻断生成：按期望值下发，由底层工厂再次收口
    return { maxTokens: desired, tightBudget: false };
  }
}

export interface GeneratePanelScriptInput {
  targetPanelCount?: number;
  densityMode?: "relaxed" | "balanced" | "compact";
  scriptPromptInstruction?: string;
  /** 强制刷新 sourceText 快照（仅 novel_import 有效） */
  refreshSourceText?: boolean;
}

export class ComicPanelScriptService {
  async generatePanelScript(
    episodeId: string,
    input: GeneratePanelScriptInput = {},
    provider?: LLMProvider,
  ) {
    const episode = await prisma.comicEpisode.findUnique({
      where: { id: episodeId },
      include: {
        project: {
          include: {
            characters: { orderBy: { createdAt: "asc" } },
            characterAssets: {
              orderBy: [{ assetType: "asc" }, { sortOrder: "asc" }],
            },
            scenes: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
            sourceBundle: true,
            facts: { orderBy: { episodeOrder: "asc" } },
          },
        },
      },
    });
    if (!episode) throw new Error(`未找到漫画话数：${episodeId}`);
    if (!episode.outline) {
      throw new Error("请先生成分话大纲再生成分格脚本。");
    }

    const project = episode.project;

    // Tier-2 快照：novel_import 时按需加载章节原文（导入即快照）
    let sourceText = episode.sourceText ?? "";
    if (!sourceText || input.refreshSourceText) {
      if (project.sourceType === "novel_import" && project.sourceRef) {
        try {
          const adapter = adaptationSourceRegistry.resolve("novel_import");
          if (adapter.loadChapterText) {
            // 从 bundle 中找话对应的章节范围（由分话大纲 LLM 输出写入 bundle 时记录）
            const bundle = project.sourceBundle
              ? (JSON.parse(project.sourceBundle.bundleJson) as Record<string, unknown>)
              : null;
            const epBundles = (bundle?.episodes as Array<{
              order: number;
              sourceChapterStart?: number;
              sourceChapterEnd?: number;
            }> | undefined) ?? [];
            const epMeta = epBundles.find((e) => e.order === episode.order);
            const start = epMeta?.sourceChapterStart ?? episode.order;
            const end = epMeta?.sourceChapterEnd ?? episode.order;
            sourceText = await adapter.loadChapterText(
              { type: "novel_import", ref: project.sourceRef },
              start,
              end,
            );
            await prisma.comicEpisode.update({
              where: { id: episodeId },
              data: { sourceText },
            });
          }
        } catch {
          // 快照失败不阻断分格生成
        }
      }
    }

    const stylePresetRaw = project.stylePreset
      ? (JSON.parse(project.stylePreset) as { style?: string; promptKeywords?: string; format?: string })
      : undefined;
    const stylePreset = stylePresetRaw?.style;
    const stylePromptKeywords = stylePresetRaw?.promptKeywords;
    const comicFormat = stylePresetRaw?.format;
    // 文本 LLM 看到的是可读画风标签（含自定义画风原文），不落英文 id
    const styleLabel = resolveComicStyleLabel(project.stylePreset);
    const densityMode = input.densityMode ?? "balanced";
    const targetPanelCount =
      input.targetPanelCount
      ?? (comicFormat === "4koma"
        ? densityMode === "relaxed" ? 10 : densityMode === "compact" ? 16 : 12
        : densityMode === "relaxed" ? 30 : densityMode === "compact" ? 65 : 45);

    // 取本话及之前的跨话事实
    const factDigest =
      project.facts
        .filter((f) => f.episodeOrder == null || f.episodeOrder <= episode.order)
        .map((f) => `[${f.category}] ${f.text}`)
        .join("\n") || undefined;

    // 按目标格数申请输出 token 预算；厂商上限不足时进入极简输出模式
    const { maxTokens, tightBudget } = await resolveScriptTokenBudget(
      targetPanelCount,
      comicFormat,
      provider,
    );

    const result = await runStructuredPrompt({
      asset: comicPanelScriptPrompt,
      promptInput: {
        projectTitle: project.title,
        episodeOrder: episode.order,
        episodeTitle: episode.title ?? `第 ${episode.order} 话`,
        episodeSynopsis: episode.outline,
        sourceText: sourceText || undefined,
        characters: project.characters.map((c) => ({
          name: c.name,
          visualAnchor: c.visualAnchor,
        })),
        characterAssets: project.characterAssets
          .map((a) => {
            const charName = project.characters.find((c) => c.id === a.characterId)?.name;
            if (!charName) return null;
            return {
              characterName: charName,
              assetType: a.assetType,
              name: a.name,
              description: a.description ?? undefined,
            };
          })
          .filter((a): a is NonNullable<typeof a> => a !== null),
        existingScenes: project.scenes.map((s) => {
          let summary = "";
          try {
            const bible = s.bible ? (JSON.parse(s.bible) as { keyElements?: string }) : null;
            summary = bible?.keyElements ?? "";
          } catch { /* ignore */ }
          return { name: s.name, sceneType: s.sceneType, summary: summary || undefined };
        }),
        stylePreset: styleLabel,
        stylePromptKeywords,
        comicFormat,
        factDigest,
        densityMode,
        scriptPromptInstruction: input.scriptPromptInstruction,
        targetPanelCount,
        tightBudget,
      },
      options: { temperature: 0.55, provider, maxTokens, timeoutMs: SCRIPT_TIMEOUT_MS },
    });

    const panels = result.output.panels;
    const scenes = result.output.scenes ?? [];
    const scriptConfig = {
      densityMode,
      targetPanelCount,
      comicFormat: comicFormat ?? "webtoon",
      stylePreset,
      stylePromptKeywords,
      scriptPromptInstruction: input.scriptPromptInstruction,
      promptAssetId: comicPanelScriptPrompt.id,
      promptAssetVersion: comicPanelScriptPrompt.version,
      provider,
      maxTokens,
      tightBudget,
      generatedAt: new Date().toISOString(),
    };

    // 已存在的场景名集合（跨话/用户编辑过的不覆盖）
    const existingSceneNames = new Set(project.scenes.map((s) => s.name));

    // 事务：upsert 场景（仅新增）+ 清空旧格子重建 + 更新话状态
    await prisma.$transaction(async (tx) => {
      // 仅创建尚不存在的场景草案，保留用户编辑过的 bible 与跨话场景
      const newScenes = scenes.filter((s) => !existingSceneNames.has(s.name));
      if (newScenes.length > 0) {
        await tx.comicScene.createMany({
          data: newScenes.map((s, i) => ({
            projectId: project.id,
            name: s.name,
            sceneType: s.sceneType,
            bible: JSON.stringify({
              palette: s.palette,
              keyElements: s.keyElements,
              materials: s.materials ?? "",
              ambiance: s.ambiance ?? "",
              layout: s.layout ?? "",
            }),
            sortOrder: project.scenes.length + i,
          })),
        });
      }

      await tx.comicPanel.deleteMany({ where: { episodeId } });
      await tx.comicPanel.createMany({
        data: panels.map((panel) => ({
          episodeId,
          order: panel.order,
          panelType: panel.panelType,
          densityLevel: panel.densityLevel,
          focus: panel.focus,
          action: panel.action,
          sceneRef: panel.sceneRef?.trim() || null,
          dialogues: panel.dialogues.length > 0 ? JSON.stringify(panel.dialogues) : null,
          characterRefs:
            panel.characterRefs.length > 0 ? JSON.stringify(panel.characterRefs) : null,
          visualPrompt: panel.visualPrompt,
          layoutData: panel.layoutData ? JSON.stringify(panel.layoutData) : null,
        })),
      });
      await tx.comicEpisode.update({
        where: { id: episodeId },
        data: { status: "scripted", scriptConfig: JSON.stringify(scriptConfig) },
      });
    });

    // 异步提取跨话事实，不阻塞响应
    void comicFactService.extractAndSave(episodeId, provider);

    return prisma.comicEpisode.findUnique({
      where: { id: episodeId },
      include: { panels: { orderBy: { order: "asc" } } },
    });
  }

  async getPanels(episodeId: string) {
    return prisma.comicPanel.findMany({
      where: { episodeId },
      orderBy: { order: "asc" },
    });
  }

  async getPanel(panelId: string) {
    return prisma.comicPanel.findUnique({ where: { id: panelId } });
  }

  async updatePanelVisualPrompt(panelId: string, visualPrompt: string) {
    return prisma.comicPanel.update({
      where: { id: panelId },
      data: { visualPrompt },
    });
  }

  async updatePanelDialogues(panelId: string, dialogues: unknown[]) {
    return prisma.comicPanel.update({
      where: { id: panelId },
      data: { dialogues: JSON.stringify(dialogues) },
    });
  }
}

export const comicPanelScriptService = new ComicPanelScriptService();
