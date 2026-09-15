/**
 * AI 连接配置服务
 *
 * API Key 只存本机 IndexedDB，不经过任何服务器。
 * 服务商预设来自 config/aiProviders.json。
 */
import { aiProvidersConfig } from "../configService";
import { getSettings, saveSettings } from "../../db/comicDb";
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
