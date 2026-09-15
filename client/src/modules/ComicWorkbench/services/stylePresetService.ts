/**
 * 个人风格预设：存全局设置（IndexedDB settings.customStylePresets）
 *
 * 个人预设基于某个内置画风派生：保存时固化当时的调节参数与自定义关键词，
 * 再次选中时整体回填到项目。
 */
import { generateId, getSettings, saveSettings } from "../db/comicDb";
import { stylePresets } from "./configService";
import type { CustomStylePreset, StyleAdjustments } from "../types";

export function listCustomPresets(): Promise<CustomStylePreset[]> {
  return getSettings().then((settings) => settings.customStylePresets);
}

/** 保存个人预设（同名直接覆盖，避免重复堆积） */
export async function saveCustomPreset(params: {
  name: string;
  basePresetId: string;
  adjustments: StyleAdjustments;
  customKeywords: string;
}): Promise<CustomStylePreset> {
  const base = stylePresets.find((p) => p.id === params.basePresetId);
  if (!base) {
    throw new Error("所基于的内置画风不存在，无法保存个人预设");
  }
  const settings = await getSettings();
  const existing = settings.customStylePresets.find((p) => p.name === params.name.trim());
  const preset: CustomStylePreset = {
    id: existing?.id ?? generateId("style"),
    isCustom: true,
    name: params.name.trim(),
    basePresetId: params.basePresetId,
    promptKeywords: base.promptKeywords,
    adjustments: params.adjustments,
    customKeywords: params.customKeywords.trim(),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  const nextList = existing
    ? settings.customStylePresets.map((p) => (p.id === existing.id ? preset : p))
    : [...settings.customStylePresets, preset];
  await saveSettings({ ...settings, customStylePresets: nextList });
  return preset;
}

export async function deleteCustomPreset(id: string): Promise<void> {
  const settings = await getSettings();
  await saveSettings({
    ...settings,
    customStylePresets: settings.customStylePresets.filter((p) => p.id !== id),
  });
}
