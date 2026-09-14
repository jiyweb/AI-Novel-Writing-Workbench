import type { ImageProviderGenerateInput, ImageProviderGenerateResult } from "../types";
import { collectReferenceImages } from "./referenceImages";

/**
 * 火山方舟（豆包 Seedream）图像生成适配器。
 * 接口为 OpenAI 兼容：POST {baseURL}/images/generations
 * 文档：https://www.volcengine.com/docs/82379/1541523
 */

export interface ImageAdapterDeps {
  apiKey: string | undefined;
  baseURL: string;
  timeoutMs: number;
}

interface ArkImageRow {
  url?: unknown;
  b64_json?: unknown;
}

interface ArkImagePayload {
  data?: ArkImageRow[];
}

function parseArkImages(payload: unknown): Array<{ url: string }> {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const data = (payload as ArkImagePayload).data;
  if (!Array.isArray(data)) {
    return [];
  }
  const images: Array<{ url: string }> = [];
  for (const row of data) {
    if (!row || typeof row !== "object") {
      continue;
    }
    if (typeof row.url === "string" && row.url) {
      images.push({ url: row.url });
    } else if (typeof row.b64_json === "string" && row.b64_json) {
      images.push({ url: `data:image/png;base64,${row.b64_json}` });
    }
  }
  return images;
}

function buildPrompt(prompt: string, negativePrompt?: string): string {
  const cleanPrompt = prompt.trim();
  const cleanNegativePrompt = negativePrompt?.trim();
  if (!cleanNegativePrompt) {
    return cleanPrompt;
  }
  return `${cleanPrompt}\n\nAvoid: ${cleanNegativePrompt}`;
}

/**
 * 项目内部尺寸都是像素值（最大 1536px 量级），Seedream 只接收档位关键字。
 * 长边达到 2K 档位才传 "2K"，其余统一 "1K"。
 */
function mapSizeToArkTier(size: string): string {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (match) {
    const longSide = Math.max(Number(match[1]), Number(match[2]));
    if (longSide >= 2048) {
      return "2K";
    }
  }
  return "1K";
}

/** Seedream 4.0/4.5 只输出 jpeg；5.x 支持 png。 */
function resolveOutputFormat(model: string, requested: string | undefined): string | undefined {
  if (requested === "png" || requested === "jpeg") {
    const normalizedModel = model.toLowerCase();
    if (requested === "png" && (normalizedModel.includes("seedream-4-0") || normalizedModel.includes("seedream-4-5"))) {
      return "jpeg";
    }
    return requested;
  }
  return undefined;
}

interface SingleRequestResult {
  images: Array<{ url: string }>;
}

async function requestSingleImage(
  input: ImageProviderGenerateInput,
  deps: ImageAdapterDeps,
  referenceImages: string[],
): Promise<SingleRequestResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`火山方舟图片生成请求超时（${deps.timeoutMs}ms）。`)),
    deps.timeoutMs,
  );

  const body: Record<string, unknown> = {
    model: input.model,
    prompt: buildPrompt(input.prompt, input.negativePrompt),
    size: mapSizeToArkTier(input.size),
    response_format: "url",
    watermark: false,
  };
  const outputFormat = resolveOutputFormat(input.model, input.outputFormat);
  if (outputFormat) {
    body.output_format = outputFormat;
  }
  if (referenceImages.length === 1) {
    body.image = referenceImages[0];
  } else if (referenceImages.length > 1) {
    body.image = referenceImages;
  }

  try {
    const response = await fetch(`${deps.baseURL}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(deps.apiKey ? { Authorization: `Bearer ${deps.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`火山方舟图片接口请求失败（${response.status}）：${detail || "未知错误"}`);
    }
    const payload = (await response.json()) as unknown;
    return { images: parseArkImages(payload) };
  } finally {
    clearTimeout(timer);
  }
}

export async function generateWithVolcengine(
  input: ImageProviderGenerateInput,
  deps: ImageAdapterDeps,
): Promise<ImageProviderGenerateResult> {
  // Seedream 5.0 pro 不支持组图，其它模型组图参数也有版本差异，统一按张并发请求最稳。
  const count = Math.max(1, Math.floor(input.count) || 1);
  const referenceImages = await collectReferenceImages(input);

  const batches = await Promise.all(
    Array.from({ length: count }, () => requestSingleImage(input, deps, referenceImages)),
  );

  const images = batches.flatMap((batch) => batch.images).map((item, index) => ({
    ...item,
    seed: typeof input.seed === "number" ? input.seed + index : undefined,
  }));

  if (images.length === 0) {
    throw new Error("火山方舟图片接口没有返回图片结果。");
  }

  return {
    provider: input.provider,
    model: input.model,
    images,
  };
}
