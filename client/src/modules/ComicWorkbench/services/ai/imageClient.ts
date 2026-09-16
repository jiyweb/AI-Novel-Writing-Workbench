/**
 * 生图客户端：统一调用主程序服务端 /api/images/generate 任务链（comic_panel 场景）
 *
 * 提交任务 → 轮询任务状态 → 按任务取图片资产 → 下载为本地 Blob 持久化。
 * 服务商/模型/API Key 全部来自主程序模型设置；choice 仅表示「用主程序里
 * 哪个生图厂商/模型」，为空时跟随主程序当前选择。
 */
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { apiClient } from "@/api/client";
import { resolveImageAssetUrl } from "@/api/images";
import { AiError } from "./llmClient";
import { getAiDefaults, resolveImageChoice } from "./aiConfigService";
import type { ComicImageModelChoice } from "../../types";

export interface GenerateImageParams {
  prompt: string;
  negativePrompt?: string;
  /** 分镜面板 id（服务端任务展示标识；测试图等无面板场景传说明性 id） */
  comicPanelId: string;
  /** 期望像素尺寸（内部映射到主程序支持的尺寸档位） */
  width: number;
  height: number;
  /** 外部取消信号 */
  signal?: AbortSignal;
  /** 阶段进展回调（测试图按钮/队列进度展示用） */
  onProgress?: (message: string) => void;
}

export interface GeneratedImage {
  /** 本地 Blob；下载失败时为 null，用 remoteUrl 展示 */
  blob: Blob | null;
  remoteUrl?: string;
  mime: string;
}

interface ImageTaskDto {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  error?: string | null;
}

interface ImageAssetDto {
  id: string;
  url: string;
  mimeType: string | null;
}

/** 统一入口：提交主程序生图任务并等待完成 */
export async function generateImage(
  choice: ComicImageModelChoice | null,
  params: GenerateImageParams,
): Promise<GeneratedImage> {
  if (params.signal?.aborted) {
    throw new AiError("timeout", "任务已取消");
  }
  const defaults = getAiDefaults();
  const resolved = await resolveImageChoice(choice);
  const size = pickImageSize(params.width, params.height, defaults.imageSizes);

  params.onProgress?.("正在提交生图任务…");
  const taskId = await submitTask(resolved, params, size);

  // 轮询直到 succeeded / 失败 / 超时（imagePollMaxMs）
  const deadline = Date.now() + defaults.imagePollMaxMs;
  for (;;) {
    await sleep(defaults.imagePollIntervalMs, params.signal);
    const task = await fetchTask(taskId, params.signal);
    params.onProgress?.(describeTaskProgress(task));
    if (task.status === "succeeded") {
      break;
    }
    if (task.status === "failed") {
      throw new AiError("http", task.error?.trim() || "生图任务失败，请调整描述词后重试");
    }
    if (task.status === "cancelled") {
      throw new AiError("timeout", "生图任务已取消");
    }
    if (Date.now() > deadline) {
      throw new AiError("timeout", "生图任务超时：服务端长时间未返回结果，可稍后重试");
    }
  }

  const asset = await fetchPrimaryAsset(taskId, params.signal);
  params.onProgress?.("图片已生成，正在保存到本地…");
  const remoteUrl = resolveImageAssetUrl(asset.url);
  const blob = await urlToBlob(remoteUrl, params.signal);
  return { blob, remoteUrl, mime: asset.mimeType || blob?.type || "image/png" };
}

async function submitTask(
  resolved: { provider: string; model?: string },
  params: GenerateImageParams,
  size: string,
): Promise<string> {
  try {
    const { data } = await apiClient.post<ApiResponse<ImageTaskDto>>(
      "/images/generate",
      {
        sceneType: "comic_panel",
        sceneId: params.comicPanelId,
        prompt: params.prompt.trim(),
        negativePrompt: params.negativePrompt?.trim() || undefined,
        provider: resolved.provider,
        model: resolved.model,
        size,
        count: 1,
        maxRetries: 2,
      },
      { signal: params.signal },
    );
    const taskId = data.data?.id;
    if (!taskId) {
      throw new AiError("badJson", "生图服务已受理任务但没有返回任务 id");
    }
    return taskId;
  } catch (error) {
    throw normalizeApiError(error);
  }
}

async function fetchTask(taskId: string, signal?: AbortSignal): Promise<ImageTaskDto> {
  try {
    const { data } = await apiClient.get<ApiResponse<ImageTaskDto>>(
      `/images/tasks/${taskId}`,
      { signal },
    );
    if (!data.data) {
      throw new AiError("badJson", "生图任务查询结果为空");
    }
    return data.data;
  } catch (error) {
    throw normalizeApiError(error);
  }
}

async function fetchPrimaryAsset(taskId: string, signal?: AbortSignal): Promise<ImageAssetDto> {
  try {
    const { data } = await apiClient.get<ApiResponse<ImageAssetDto[]>>(
      `/images/tasks/${taskId}/assets`,
      { signal },
    );
    const asset = data.data?.[0];
    if (!asset?.url) {
      throw new AiError("badJson", "生图任务已完成但未返回图片资产");
    }
    return asset;
  } catch (error) {
    throw normalizeApiError(error);
  }
}

/** 把 apiClient 拦截器抛出的错误规整为 AiError（拦截器已做过用户提示） */
function normalizeApiError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new AiError("timeout", "任务已取消");
  }
  const status = (error as { status?: number } | undefined)?.status;
  if (error instanceof Error) {
    return new AiError(status ? "http" : "network", error.message, status);
  }
  return new AiError("network", "生图请求失败");
}

function describeTaskProgress(task: ImageTaskDto): string {
  if (task.status === "queued") return "生图任务排队中…";
  if (task.status === "running" && typeof task.progress === "number" && task.progress > 0) {
    return `生图任务进行中（${Math.round(task.progress * 100)}%）`;
  }
  return "生图任务进行中…";
}

/** 把期望像素就近映射到主程序支持的尺寸档位（纵横比差异 + 分辨率不足罚分） */
export function pickImageSize(width: number, height: number, sizes: string[]): string {
  let best = sizes[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of sizes) {
    const [w, h] = candidate.split("x").map(Number);
    if (!w || !h) continue;
    const ratioDiff = Math.abs(Math.log(width / height / (w / h)));
    const resPenalty = Math.max(0, Math.log((w * h) / Math.max(width * height, 1))) * 0.5;
    const score = ratioDiff + resPenalty;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new AiError("timeout", "任务已取消"));
      },
      { once: true },
    );
  });
}

/** 结果图 URL → Blob；下载失败时返回 null（回退 remoteUrl 展示） */
async function urlToBlob(url: string, signal?: AbortSignal): Promise<Blob | null> {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.type.startsWith("image/") ? blob : new Blob([blob], { type: "image/png" });
  } catch {
    return null;
  }
}
