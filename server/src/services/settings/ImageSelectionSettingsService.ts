import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { prisma } from "../../db/prisma";

const IMAGE_SELECTION_SETTING_KEY = "image.currentSelection";

export interface ImageSelectionSettings {
  provider: LLMProvider;
  model: string;
}

export type SaveImageSelectionSettingsInput = ImageSelectionSettings;

function normalizeProvider(value: unknown): LLMProvider | null {
  return typeof value === "string" && value.trim() ? (value.trim() as LLMProvider) : null;
}

function normalizeModel(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseSelectionPayload(value: string): ImageSelectionSettings | null {
  try {
    const payload = JSON.parse(value) as Record<string, unknown>;
    const provider = normalizeProvider(payload.provider);
    const model = normalizeModel(payload.model);
    if (!provider || !model) {
      return null;
    }
    return { provider, model };
  } catch {
    return null;
  }
}

export async function getImageSelectionSettings(): Promise<ImageSelectionSettings | null> {
  const record = await prisma.appSetting.findUnique({
    where: { key: IMAGE_SELECTION_SETTING_KEY },
  });
  return record ? parseSelectionPayload(record.value) : null;
}

export async function saveImageSelectionSettings(
  input: SaveImageSelectionSettingsInput,
): Promise<ImageSelectionSettings> {
  const provider = normalizeProvider(input.provider);
  const model = normalizeModel(input.model);
  if (!provider || !model) {
    throw new Error("生图厂商和生图模型名称不能为空。");
  }
  const settings: ImageSelectionSettings = { provider, model };
  await prisma.appSetting.upsert({
    where: { key: IMAGE_SELECTION_SETTING_KEY },
    update: { value: JSON.stringify(settings) },
    create: { key: IMAGE_SELECTION_SETTING_KEY, value: JSON.stringify(settings) },
  });
  return settings;
}
