/**
 * AI 连接配置服务
 *
 * API Key 只存本机 IndexedDB，不经过任何服务器。
 * 服务商预设来自 config/aiProviders.json。
 */
import { aiProvidersConfig } from "../configService";
import { getSettings, saveSettings } from "../../db/comicDb";
import { getAPIKeySettings, getLLMSelectionSetting } from "@/api/settings";
import type {
  AiConnectionSettings,
  AiProviderConfig,
  AiProviderProtocolConfig,
  AiProvidersConfig,
} from "../../types";

export async function getAiSettings(): Promise<AiConnectionSettings | null> {
  return (await getSettings()).ai;
}

export async function saveAiSettings(ai: AiConnectionSettings): Promise<void> {
  const settings = await getSettings();
  await saveSettings({ ...settings, ai });
}

/** 未配置时的默认值（取第一个 llm/image 可用服务商的预设） */
export function buildDefaultAiSettings(): AiConnectionSettings {
  const llmProvider = aiProvidersConfig.providers.find((p) => p.llm) ?? aiProvidersConfig.providers[0];
  const imageProvider = aiProvidersConfig.providers.find((p) => p.image) ?? aiProvidersConfig.providers[0];
  return {
    llm: {
      providerId: llmProvider.id,
      baseUrl: llmProvider.llm?.defaultBaseUrl ?? "",
      apiKey: "",
      model: llmProvider.llm?.models[0] ?? "",
    },
    image: {
      providerId: imageProvider.id,
      baseUrl: imageProvider.image?.defaultBaseUrl ?? "",
      apiKey: "",
      model: imageProvider.image?.models[0] ?? "",
    },
  };
}

export function getProviderById(id: string): AiProviderConfig | undefined {
  return aiProvidersConfig.providers.find((provider) => provider.id === id);
}

export function getProtocolOf(
  provider: AiProviderConfig | undefined,
  kind: "llm" | "image",
): AiProviderProtocolConfig | undefined {
  return kind === "llm" ? provider?.llm : provider?.image;
}

/** 全局调用参数（超时/重试） */
export function getAiDefaults(): AiProvidersConfig["defaults"] {
  return aiProvidersConfig.defaults;
}

/** AI 配置是否可用（至少文本模型配好，生图按需检查） */
export function isLlmReady(settings: AiConnectionSettings | null | undefined): boolean {
  return Boolean(settings?.llm.baseUrl && settings.llm.apiKey && settings.llm.model);
}

export function isImageReady(settings: AiConnectionSettings | null | undefined): boolean {
  return Boolean(settings?.image.baseUrl && settings.image.apiKey && settings.image.model);
}

// ---------------------------------------------------------------------------
// 从主程序导入模型选择（只读，不修改主程序任何数据）
// ---------------------------------------------------------------------------

/** 主程序模型选择导入结果（Key 一律留空，由用户补填） */
export interface ImportSelectionResult {
  llm: Partial<AiConnectionSettings["llm"]>;
  image: Partial<AiConnectionSettings["image"]>;
  /** 面向用户的导入说明（已导入/跳过/未配置） */
  notes: string[];
}

/**
 * 读取主程序的文本模型选择与厂商状态，映射到本模块的服务商预设。
 * 主程序接口不返回明文 Key，因此只回填 服务商/模型/baseUrl；
 * 厂商匹配不上预设时跳过并记入 notes（映射表见 config/aiProviders.json 的 appProviderAliases）。
 */
export async function importSelectionFromApp(): Promise<ImportSelectionResult> {
  const aliases = aiProvidersConfig.appProviderAliases ?? {};
  const notes: string[] = [];
  const [selectionRes, keysRes] = await Promise.all([
    getLLMSelectionSetting().catch(() => null),
    getAPIKeySettings().catch(() => null),
  ]);
  const selection = selectionRes?.data ?? null;
  const keyStatuses = keysRes?.data ?? [];
  const result: ImportSelectionResult = { llm: {}, image: {}, notes };

  // 文本模型：优先主程序选定的文本模型，缺失时回落到启用中的文本厂商
  const llmStatus =
    (selection ? keyStatuses.find((s) => s.provider === selection.provider) : null) ??
    keyStatuses.find((s) => s.isActive && s.textCapable) ??
    null;
  const llmProviderId = selection?.provider ?? llmStatus?.provider;
  const llmComic = llmProviderId ? getProviderById(aliases[llmProviderId] ?? "") : undefined;
  if (llmComic?.llm) {
    result.llm = {
      providerId: llmComic.id,
      baseUrl:
        llmStatus?.currentBaseURL?.trim() ||
        llmStatus?.defaultBaseURL?.trim() ||
        llmComic.llm.defaultBaseUrl,
      model: selection?.model || llmStatus?.currentModel || "",
    };
    notes.push(`文本模型：已从主程序导入「${llmComic.name}」，请补填 API Key`);
  } else if (llmProviderId) {
    notes.push(`文本模型：主程序厂商「${llmProviderId}」暂无对应的浏览器直连预设，未导入`);
  } else {
    notes.push("文本模型：主程序尚未配置文本模型，未导入");
  }

  // 生图模型：取主程序启用中（或任一）支持生图的厂商
  const imageStatus =
    keyStatuses.find((s) => s.isActive && s.supportsImageGeneration) ??
    keyStatuses.find((s) => s.supportsImageGeneration && s.currentImageModel) ??
    null;
  const imageComic = imageStatus ? getProviderById(aliases[imageStatus.provider] ?? "") : undefined;
  if (imageStatus && imageComic?.image) {
    result.image = {
      providerId: imageComic.id,
      baseUrl:
        imageStatus.currentBaseURL?.trim() ||
        imageStatus.defaultBaseURL?.trim() ||
        imageComic.image.defaultBaseUrl,
      model: imageStatus.currentImageModel ?? "",
    };
    notes.push(`生图模型：已从主程序导入「${imageComic.name}」，请补填 API Key`);
  } else if (imageStatus) {
    notes.push(`生图模型：主程序厂商「${imageStatus.provider}」暂无对应的浏览器直连预设，未导入`);
  } else {
    notes.push("生图模型：主程序尚未配置生图模型，未导入");
  }

  return result;
}
