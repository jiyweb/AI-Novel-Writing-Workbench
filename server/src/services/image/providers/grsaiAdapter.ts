import type { ImageProviderGenerateInput, ImageProviderGenerateResult } from "../types";
import { collectReferenceImages, pixelSizeToAspectRatio } from "./referenceImages";
import type { ImageAdapterDeps } from "./volcengineAdapter";

/**
 * GrsAI 聚合生图平台适配器（非 OpenAI 协议）。
 * 文档：https://qmy27nhsd9.apifox.cn/452392911e0
 * - 提交：POST {base}/v1/api/generate，返回任务状态，可能处于 running
 * - 轮询：GET  {base}/v1/api/result?id=...
 * - 鉴权：Authorization: Bearer sk-...
 * 平台默认基础地址是根域名（https://grsaiapi.com），不带 /v1 后缀。
 */

const POLL_INTERVAL_MS = 3_000;
const SINGLE_REQUEST_TIMEOUT_MS = 60_000;
const MAX_REFERENCE_IMAGES = 10;

interface GrsaiResultRow {
  url?: unknown;
}

interface GrsaiGenerateResponse {
  id?: unknown;
  status?: unknown;
  progress?: unknown;
  results?: GrsaiResultRow[];
  error?: unknown;
}

function buildPrompt(prompt: string, negativePrompt?: string): string {
  const cleanPrompt = prompt.trim();
  const cleanNegativePrompt = negativePrompt?.trim();
  if (!cleanNegativePrompt) {
    return cleanPrompt;
  }
  return `${cleanPrompt}\n\nAvoid: ${cleanNegativePrompt}`;
}

function resolveApiRoot(baseURL: string): string {
  const normalized = baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL;
  // 用户若误填成 https://host/v1，去掉尾缀，避免拼出 /v1/v1/api/...
  return normalized.replace(/\/v1$/i, "");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("GrsAI 图片生成等待已取消。"));
    }, { once: true });
  });
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  errorLabel: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`${errorLabel}（${response.status}）：${detail || "未知错误"}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function extractImageUrls(payload: GrsaiGenerateResponse | undefined): Array<{ url: string }> {
  if (!payload || !Array.isArray(payload.results)) {
    return [];
  }
  return payload.results
    .filter((row): row is GrsaiResultRow => Boolean(row))
    .map((row) => (typeof row.url === "string" ? row.url : ""))
    .filter((url): url is string => Boolean(url))
    .map((url) => ({ url }));
}

function assertTerminalStatus(payload: GrsaiGenerateResponse): void {
  const status = typeof payload.status === "string" ? payload.status : "";
  if (status === "violation") {
    throw new Error("GrsAI 返回内容违规，未能生成图片，请调整提示词或参考图后重试。");
  }
  if (status === "failed") {
    const detail = typeof payload.error === "string" && payload.error ? payload.error : "任务失败";
    throw new Error(`GrsAI 图片生成失败：${detail}`);
  }
}

async function pollUntilDone(
  root: string,
  apiKey: string | undefined,
  id: string,
  deadlineMs: number,
): Promise<GrsaiGenerateResponse> {
  const pollController = new AbortController();
  try {
    while (Date.now() < deadlineMs) {
      await sleep(POLL_INTERVAL_MS, pollController.signal);
      const payload = await fetchJson(
        `${root}/v1/api/result?id=${encodeURIComponent(id)}`,
        {
          method: "GET",
          headers: {
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
        },
        Math.min(SINGLE_REQUEST_TIMEOUT_MS, Math.max(5_000, deadlineMs - Date.now())),
        "GrsAI 结果查询失败",
      ) as GrsaiGenerateResponse;

      const status = typeof payload.status === "string" ? payload.status : "";
      if (status === "succeeded") {
        return payload;
      }
      assertTerminalStatus(payload);
    }
    throw new Error("GrsAI 图片生成超时：任务长时间未完成。");
  } finally {
    pollController.abort();
  }
}

async function requestSingleImage(
  input: ImageProviderGenerateInput,
  deps: ImageAdapterDeps,
  referenceImages: string[],
): Promise<Array<{ url: string }>> {
  const root = resolveApiRoot(deps.baseURL);
  const model = input.model.toLowerCase();

  // nano-banana 系列只接受宽高比；gpt-image 系列同时接受像素值，直接透传内部尺寸。
  const aspectRatio = model.startsWith("nano-banana")
    ? pixelSizeToAspectRatio(input.size)
    : input.size;

  const body: Record<string, unknown> = {
    model: input.model,
    prompt: buildPrompt(input.prompt, input.negativePrompt),
    replyType: "json",
  };
  if (aspectRatio) {
    body.aspectRatio = aspectRatio;
  }
  if (referenceImages.length > 0) {
    body.images = referenceImages;
  }
  if (input.background === "transparent") {
    body.background = "transparent";
  }

  const deadlineMs = Date.now() + deps.timeoutMs;
  const payload = await fetchJson(
    `${root}/v1/api/generate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(deps.apiKey ? { Authorization: `Bearer ${deps.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    },
    SINGLE_REQUEST_TIMEOUT_MS,
    "GrsAI 图片接口请求失败",
  ) as GrsaiGenerateResponse;

  const status = typeof payload.status === "string" ? payload.status : "";
  if (status === "succeeded") {
    return extractImageUrls(payload);
  }
  assertTerminalStatus(payload);

  const taskId = typeof payload.id === "string" ? payload.id : "";
  if (!taskId) {
    throw new Error("GrsAI 已受理任务但没有返回任务 id，无法查询生成结果。");
  }
  const finalPayload = await pollUntilDone(root, deps.apiKey, taskId, deadlineMs);
  return extractImageUrls(finalPayload);
}

export async function generateWithGrsai(
  input: ImageProviderGenerateInput,
  deps: ImageAdapterDeps,
): Promise<ImageProviderGenerateResult> {
  const count = Math.max(1, Math.floor(input.count) || 1);
  const referenceImages = await collectReferenceImages(input, MAX_REFERENCE_IMAGES);

  // GrsAI 单次调用只产出一张，按张并发后合并。
  const batches = await Promise.all(
    Array.from({ length: count }, () => requestSingleImage(input, deps, referenceImages)),
  );

  const images = batches.flatMap((batch) => batch).map((item, index) => ({
    ...item,
    seed: typeof input.seed === "number" ? input.seed + index : undefined,
  }));

  if (images.length === 0) {
    throw new Error("GrsAI 图片接口没有返回图片结果。");
  }

  return {
    provider: input.provider,
    model: input.model,
    images,
  };
}
