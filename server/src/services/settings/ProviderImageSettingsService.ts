import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { prisma } from "../../db/prisma";

export type ImageModelProvider = "openai" | "siliconflow" | "grok" | "volcengine" | "grsai";

const IMAGE_MODEL_SETTING_PREFIX = "provider.imageModel";
const IMAGE_MODEL_LIST_SETTING_PREFIX = "provider.imageModels";
const MAX_SAVED_IMAGE_MODELS = 200;

const IMAGE_MODEL_OPTIONS: Record<ImageModelProvider, string[]> = {
  openai: ["gpt-image-2"],
  siliconflow: ["black-forest-labs/FLUX.1-schnell"],
  grok: ["grok-imagine-image"],
  volcengine: [
    "doubao-seedream-5-0-pro-260628",
    "doubao-seedream-5-0-260128",
    "doubao-seedream-4-5-251128",
    "doubao-seedream-4-0-250828",
  ],
  grsai: [
    "gpt-image-2",
    "gpt-image-2.5",
    "nano-banana-2",
    "nano-banana-pro",
  ],
};

function isMissingTableError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === "P2021"
  );
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function supportsImageModelSettings(provider: LLMProvider): boolean {
  return typeof provider === "string" && provider.trim().length > 0;
}

function isKnownImageModelProvider(provider: LLMProvider): provider is ImageModelProvider {
  return provider === "openai"
    || provider === "siliconflow"
    || provider === "grok"
    || provider === "volcengine"
    || provider === "grsai";
}

export function getImageModelSettingKey(provider: LLMProvider): string | null {
  if (!supportsImageModelSettings(provider)) {
    return null;
  }
  return `${IMAGE_MODEL_SETTING_PREFIX}.${provider}`;
}

export function getImageModelOptions(provider: LLMProvider): string[] {
  if (!isKnownImageModelProvider(provider)) {
    return [];
  }
  return [...IMAGE_MODEL_OPTIONS[provider]];
}

export function getDefaultImageModel(provider: LLMProvider): string | undefined {
  return getImageModelOptions(provider)[0];
}

export function getProviderEnvImageModel(provider: LLMProvider): string | undefined {
  switch (provider) {
    case "openai":
      return normalizeOptionalText(process.env.OPENAI_IMAGE_MODEL);
    case "siliconflow":
      return normalizeOptionalText(process.env.SILICONFLOW_IMAGE_MODEL);
    case "grok":
      return normalizeOptionalText(process.env.XAI_IMAGE_MODEL);
    case "volcengine":
      return normalizeOptionalText(process.env.ARK_IMAGE_MODEL);
    case "grsai":
      return normalizeOptionalText(process.env.GRSAI_IMAGE_MODEL);
    default:
      return undefined;
  }
}

export async function getProviderImageModel(provider: LLMProvider): Promise<string | undefined> {
  if (!supportsImageModelSettings(provider)) {
    return undefined;
  }
  const key = getImageModelSettingKey(provider);
  if (!key) {
    return undefined;
  }

  try {
    const record = await prisma.appSetting.findUnique({
      where: { key },
    });
    return normalizeOptionalText(record?.value)
      ?? getProviderEnvImageModel(provider)
      ?? getDefaultImageModel(provider);
  } catch (error) {
    if (isMissingTableError(error)) {
      return getProviderEnvImageModel(provider) ?? getDefaultImageModel(provider);
    }
    throw error;
  }
}

export async function getProviderImageModelMap(
  providers: LLMProvider[],
): Promise<Map<LLMProvider, string | undefined>> {
  const supportedProviders = Array.from(new Set(providers.filter((provider) => supportsImageModelSettings(provider))));
  const result = new Map<LLMProvider, string | undefined>();
  for (const provider of providers) {
    result.set(provider, getProviderEnvImageModel(provider) ?? getDefaultImageModel(provider));
  }
  if (supportedProviders.length === 0) {
    return result;
  }

  const keys = supportedProviders
    .map((provider) => getImageModelSettingKey(provider))
    .filter((value): value is string => Boolean(value));

  try {
    const records = await prisma.appSetting.findMany({
      where: {
        key: {
          in: keys,
        },
      },
    });
    const valueMap = new Map(records.map((item) => [item.key, normalizeOptionalText(item.value)]));
    for (const provider of supportedProviders) {
      const key = getImageModelSettingKey(provider);
      if (!key) {
        continue;
      }
      result.set(
        provider,
        valueMap.get(key)
          ?? getProviderEnvImageModel(provider)
          ?? getDefaultImageModel(provider),
      );
    }
    return result;
  } catch (error) {
    if (isMissingTableError(error)) {
      return result;
    }
    throw error;
  }
}

export async function saveProviderImageModel(
  provider: LLMProvider,
  imageModel: string | null | undefined,
): Promise<string | undefined> {
  if (!supportsImageModelSettings(provider)) {
    return undefined;
  }
  const key = getImageModelSettingKey(provider);
  if (!key) {
    return undefined;
  }

  const normalized = normalizeOptionalText(imageModel);

  try {
    if (!normalized) {
      await prisma.appSetting.deleteMany({
        where: { key },
      });
      return getProviderEnvImageModel(provider) ?? getDefaultImageModel(provider);
    }

    await prisma.appSetting.upsert({
      where: { key },
      update: { value: normalized },
      create: { key, value: normalized },
    });
    return normalized;
  } catch (error) {
    if (isMissingTableError(error)) {
      return normalized ?? getProviderEnvImageModel(provider) ?? getDefaultImageModel(provider);
    }
    throw error;
  }
}

export function getImageModelListSettingKey(provider: LLMProvider): string | null {
  if (!supportsImageModelSettings(provider)) {
    return null;
  }
  return `${IMAGE_MODEL_LIST_SETTING_PREFIX}.${provider}`;
}

function parseImageModelList(value: string): string[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const models = parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return Array.from(new Set(models)).slice(0, MAX_SAVED_IMAGE_MODELS);
  } catch {
    return null;
  }
}

/**
 * 该厂商保存的生图模型列表：已保存（含空列表）时返回保存值；
 * 从未保存过时回退到内置预设。空列表表示该厂商不再提供生图模型。
 */
export async function getProviderImageModels(provider: LLMProvider): Promise<string[]> {
  const key = getImageModelListSettingKey(provider);
  if (!key) {
    return [];
  }

  try {
    const record = await prisma.appSetting.findUnique({
      where: { key },
    });
    if (!record) {
      return getImageModelOptions(provider);
    }
    return parseImageModelList(record.value) ?? getImageModelOptions(provider);
  } catch (error) {
    if (isMissingTableError(error)) {
      return getImageModelOptions(provider);
    }
    throw error;
  }
}

export async function getProviderImageModelsMap(
  providers: LLMProvider[],
): Promise<Map<LLMProvider, string[]>> {
  const keys = providers
    .map((provider) => getImageModelListSettingKey(provider))
    .filter((value): value is string => Boolean(value));
  const result = new Map<LLMProvider, string[]>();
  if (keys.length === 0) {
    return result;
  }

  try {
    const records = await prisma.appSetting.findMany({
      where: {
        key: {
          in: keys,
        },
      },
    });
    const valueMap = new Map(records.map((item) => [item.key, item.value]));
    for (const provider of providers) {
      const key = getImageModelListSettingKey(provider);
      if (!key) {
        continue;
      }
      const record = valueMap.get(key);
      result.set(provider, record ? parseImageModelList(record) ?? [] : getImageModelOptions(provider));
    }
    return result;
  } catch (error) {
    if (isMissingTableError(error)) {
      return result;
    }
    throw error;
  }
}

/**
 * 保存该厂商的生图模型列表；当前生效的生图模型不在新列表中时会一并清除，
 * 让生效值回退到 env 或默认模型。
 */
export async function saveProviderImageModels(
  provider: LLMProvider,
  models: string[],
): Promise<string[]> {
  const key = getImageModelListSettingKey(provider);
  if (!key) {
    return [];
  }

  const normalized = Array.from(
    new Set(
      models
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).slice(0, MAX_SAVED_IMAGE_MODELS);

  try {
    await prisma.appSetting.upsert({
      where: { key },
      update: { value: JSON.stringify(normalized) },
      create: { key, value: JSON.stringify(normalized) },
    });
    const currentImageModel = await getProviderImageModel(provider);
    if (currentImageModel && !normalized.includes(currentImageModel)) {
      await saveProviderImageModel(provider, null);
    }
    return normalized;
  } catch (error) {
    if (isMissingTableError(error)) {
      return normalized;
    }
    throw error;
  }
}
