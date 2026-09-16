/**
 * AI 配置服务：本模块不再自建服务商 / API Key / baseUrl 配置。
 *
 * 文本模型与生图模型全部使用主程序「模型设置」；此处只维护：
 * - 分镜生图模型的覆盖选择（存 IndexedDB WorkbenchSettings.ai，null = 跟随主程序）
 * - 主程序模型状态查询（就绪判断 + 生图选项列表 + 覆盖选择解析）
 */
import { getAPIKeySettings, getLLMSelectionSetting } from "@/api/settings";
import { aiProvidersConfig } from "../configService";
import { getSettings, saveSettings } from "../../db/comicDb";
import { AiError } from "./llmClient";
import type { ComicImageModelChoice } from "../../types";

/** 读取生图模型覆盖选择；IndexedDB 里的旧版直连配置直接视为未覆盖 */
export async function getAiSettings(): Promise<{ image: ComicImageModelChoice } | null> {
  const raw = (await getSettings()).ai as unknown;
  if (!raw || typeof raw !== "object") return null;
  const image = (raw as { image?: unknown }).image;
  if (!image || typeof image !== "object") return null;
  const legacy = image as { baseUrl?: unknown; apiKey?: unknown };
  if (typeof legacy.baseUrl === "string" && legacy.baseUrl.trim()) return null;
  const candidate = image as { providerId?: unknown; model?: unknown };
  const choice: ComicImageModelChoice = {
    providerId: typeof candidate.providerId === "string" && candidate.providerId.trim() ? candidate.providerId : undefined,
    model: typeof candidate.model === "string" && candidate.model.trim() ? candidate.model : undefined,
  };
  if (!choice.providerId && !choice.model) return null;
  return { image: choice };
}

export async function saveAiSettings(ai: { image: ComicImageModelChoice } | null): Promise<void> {
  const settings = await getSettings();
  await saveSettings({ ...settings, ai });
}

/** 全局调用参数（超时/重试/尺寸档位） */
export function getAiDefaults() {
  return aiProvidersConfig.defaults;
}

// ---------------------------------------------------------------------------
// 主程序模型状态
// ---------------------------------------------------------------------------

export interface MainImageProviderOption {
  /** 主程序厂商 id（作为生图 provider 提交参数） */
  provider: string;
  label: string;
  models: string[];
  /** 主程序当前为该厂商选中的生图模型 */
  currentImageModel: string | null;
  defaultImageModel: string | null;
}

export interface MainAiStatus {
  /** 主程序文本模型是否可用（漫画文本 AI 直接使用它） */
  llmReady: boolean;
  llmProvider: string | null;
  llmModel: string | null;
  /** 主程序是否有已配置的生图厂商 */
  imageReady: boolean;
  imageOptions: MainImageProviderOption[];
}

/** 查询主程序模型设置状态（只读，不修改主程序任何数据） */
export async function fetchMainAiStatus(): Promise<MainAiStatus> {
  const [selectionRes, keysRes] = await Promise.all([
    getLLMSelectionSetting().catch(() => null),
    getAPIKeySettings().catch(() => null),
  ]);
  const selection = selectionRes?.data ?? null;
  const statuses = keysRes?.data ?? [];

  const imageOptions: MainImageProviderOption[] = statuses
    .filter((s) => s.supportsImageGeneration && s.isConfigured)
    .map((s) => ({
      provider: s.provider,
      label: s.displayName?.trim() || s.name,
      models: s.imageModels ?? [],
      currentImageModel: s.currentImageModel,
      defaultImageModel: s.defaultImageModel,
    }));

  const selectedStatus = selection ? statuses.find((s) => s.provider === selection.provider) : null;
  return {
    llmReady: Boolean(selection?.model) && (!selectedStatus || selectedStatus.isConfigured),
    llmProvider: selection?.provider ?? null,
    llmModel: selection?.model ?? null,
    imageReady: imageOptions.length > 0,
    imageOptions,
  };
}

/**
 * 把覆盖选择解析成具体 provider/model：显式选择优先；
 * 所选厂商已不可用或未选择时，回落到主程序第一个可用生图厂商。
 */
export async function resolveImageChoice(
  choice: ComicImageModelChoice | null | undefined,
): Promise<{ provider: string; model?: string }> {
  const status = await fetchMainAiStatus();
  const options = status.imageOptions;

  const hit = choice?.providerId ? options.find((o) => o.provider === choice.providerId) : undefined;
  const target = hit ?? options[0];
  if (!target) {
    throw new AiError("notConfigured", "主程序尚未配置可用的生图模型，请先在主程序「模型设置」中配置");
  }
  const model =
    (hit ? choice?.model || target.currentImageModel : target.currentImageModel)
    ?? target.defaultImageModel
    ?? target.models[0]
    ?? undefined;
  return { provider: target.provider, model };
}
