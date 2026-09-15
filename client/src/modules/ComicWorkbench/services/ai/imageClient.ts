/**
 * 文生图客户端：浏览器直连（用户自配 API Key）
 *
 * 协议族来自 config/aiProviders.json：
 * - ark-images：OpenAI 兼容 POST {baseURL}/images/generations（火山方舟 / 自定义网关共用）；
 *   尺寸只接收 1K/2K 档位关键字（与服务端 volcengineAdapter 行为一致）。
 * - grsai：非标异步协议，POST {root}/v1/api/generate 提交后轮询 GET {root}/v1/api/result?id=。
 *
 * 返回的图片尽量转成本地 Blob 持久化；若图片宿主跨域读取被拦，
 * 回退为仅记录 remoteUrl（可直接 <img> 展示，但可能随平台过期）。
 */
import { AiError } from "./llmClient";
import { getAiDefaults, getProviderById, getProtocolOf } from "./aiConfigService";
import type { AiConnectionSettings } from "../../types";

export interface GenerateImageParams {
  prompt: string;
  negativePrompt?: string;
  /** 期望像素尺寸（Ark 走档位近似；GrsAI 换算宽高比或直传像素） */
  width: number;
  height: number;
  /** 外部取消信号 */
  signal?: AbortSignal;
  /** 阶段进展回调（测试图按钮/队列进度展示用） */
  onProgress?: (message: string) => void;
}

export interface GeneratedImage {
  /** 本地 Blob；跨域读取失败时为 null，用 remoteUrl 展示 */
  blob: Blob | null;
  remoteUrl?: string;
  mime: string;
}

/** 统一入口：按连接配置中的服务商协议分流 */
export async function generateImage(
  settings: AiConnectionSettings,
  params: GenerateImageParams,
): Promise<GeneratedImage> {
  if (!settings.image.baseUrl || !settings.image.apiKey || !settings.image.model) {
    throw new AiError("notConfigured", "AI 生图模型未配置");
  }
  const provider = getProviderById(settings.image.providerId);
  const protocol = getProtocolOf(provider, "image")?.protocol ?? "ark-images";
  if (params.signal?.aborted) {
    throw new AiError("timeout", "任务已取消");
  }
  return protocol === "grsai"
    ? generateWithGrsai(settings, params)
    : generateWithArkCompatible(settings, params);
}

/** 拼接正向词与负面词（与服务端适配器一致的 "Avoid:" 约定） */
function buildPrompt(prompt: string, negativePrompt?: string): string {
  const cleanPrompt = prompt.trim();
  const cleanNegative = negativePrompt?.trim();
  if (!cleanNegative) return cleanPrompt;
  return `${cleanPrompt}\n\nAvoid: ${cleanNegative}`;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

// ---------------------------------------------------------------------------
// ark-images：OpenAI 兼容同步接口
// ---------------------------------------------------------------------------

interface ArkImageRow {
  url?: unknown;
  b64_json?: unknown;
}

interface ArkImagePayload {
  data?: ArkImageRow[];
}

/** 项目内部尺寸都是像素值，Seedream 只接收档位关键字：长边≥2K 用 "2K"，否则 "1K" */
function toArkSizeTier(width: number, height: number): string {
  return Math.max(width, height) >= 2048 ? "2K" : "1K";
}

async function generateWithArkCompatible(
  settings: AiConnectionSettings,
  params: GenerateImageParams,
): Promise<GeneratedImage> {
  const defaults = getAiDefaults();
  const url = joinUrl(settings.image.baseUrl, "/images/generations");
  const response = await rawFetch(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.image.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.image.model,
        prompt: buildPrompt(params.prompt, params.negativePrompt),
        size: toArkSizeTier(params.width, params.height),
        response_format: "url",
        watermark: false,
      }),
      signal: params.signal,
    },
    defaults.imageTimeoutMs,
  );
  if (!response.ok) {
    const detail = await safeReadError(response);
    throw new AiError("http", `生图接口返回 HTTP ${response.status}: ${detail}`, response.status);
  }
  const payload = (await response.json()) as ArkImagePayload;
  const row = payload.data?.[0];
  const b64 = typeof row?.b64_json === "string" ? row.b64_json : "";
  if (b64) {
    return { blob: base64ToBlob(b64), mime: "image/png" };
  }
  const remoteUrl = typeof row?.url === "string" ? row.url : "";
  if (!remoteUrl) {
    throw new AiError("badJson", "生图接口未返回图片数据（data[0] 缺少 url/b64_json）");
  }
  params.onProgress?.("图片已生成，正在保存到本地…");
  const blob = await urlToBlob(remoteUrl, params.signal);
  return { blob, remoteUrl, mime: "image/png" };
}

// ---------------------------------------------------------------------------
// grsai：异步提交 + 轮询
// ---------------------------------------------------------------------------

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

/** 用户误填 https://host/v1 时去掉尾缀，避免拼出 /v1/v1/api/... */
function resolveApiRoot(baseURL: string): string {
  const normalized = baseURL.endsWith("/") ? baseURL.slice(0, -1) : baseURL;
  return normalized.replace(/\/v1$/i, "");
}

/** nano-banana 系列只接受宽高比；gpt-image 系列接受像素尺寸 */
function toGrsaiSize(model: string, width: number, height: number): string {
  if (model.toLowerCase().startsWith("nano-banana")) {
    const divisor = gcd(width, height);
    return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
  }
  return `${width}x${height}`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
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

function grsaiTerminalError(payload: GrsaiGenerateResponse): AiError | null {
  const status = typeof payload.status === "string" ? payload.status : "";
  if (status === "violation") {
    return new AiError("http", "生图平台判定内容违规，请调整描述词后重试");
  }
  if (status === "failed") {
    const detail = typeof payload.error === "string" && payload.error ? payload.error : "任务失败";
    return new AiError("http", `生图任务失败：${detail}`);
  }
  return null;
}

function extractGrsaiUrl(payload: GrsaiGenerateResponse): string {
  for (const row of payload.results ?? []) {
    if (row && typeof row.url === "string" && row.url) {
      return row.url;
    }
  }
  return "";
}

async function generateWithGrsai(
  settings: AiConnectionSettings,
  params: GenerateImageParams,
): Promise<GeneratedImage> {
  const defaults = getAiDefaults();
  const root = resolveApiRoot(settings.image.baseUrl);
  const submit = (await rawFetch(
    `${root}/v1/api/generate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.image.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.image.model,
        prompt: buildPrompt(params.prompt, params.negativePrompt),
        replyType: "json",
        aspectRatio: toGrsaiSize(settings.image.model, params.width, params.height),
      }),
      signal: params.signal,
    },
    Math.min(defaults.imageTimeoutMs, 60_000),
  )) as Awaited<ReturnType<typeof rawFetch>>;
  if (!submit.ok) {
    const detail = await safeReadError(submit);
    throw new AiError("http", `生图接口返回 HTTP ${submit.status}: ${detail}`, submit.status);
  }
  let payload = (await submit.json()) as GrsaiGenerateResponse;

  let directUrl = extractGrsaiUrl(payload);
  if (!directUrl) {
    const terminal = grsaiTerminalError(payload);
    if (terminal) throw terminal;

    const taskId = typeof payload.id === "string" ? payload.id : "";
    if (!taskId) {
      throw new AiError("badJson", "生图平台已受理任务但没有返回任务 id，无法查询结果");
    }

    // 轮询直到 succeeded / 失败 / 超时（imagePollMaxMs）
    const deadline = Date.now() + defaults.imagePollMaxMs;
    while (Date.now() < deadline) {
      await sleep(defaults.imagePollIntervalMs, params.signal);
      params.onProgress?.("生图任务进行中，等待平台完成…");
      const poll = await rawFetch(
        `${root}/v1/api/result?id=${encodeURIComponent(taskId)}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${settings.image.apiKey}` },
          signal: params.signal,
        },
        60_000,
      );
      if (!poll.ok) {
        const detail = await safeReadError(poll);
        throw new AiError("http", `查询生图结果失败 HTTP ${poll.status}: ${detail}`, poll.status);
      }
      payload = (await poll.json()) as GrsaiGenerateResponse;
      directUrl = extractGrsaiUrl(payload);
      if (directUrl) break;
      const terminal = grsaiTerminalError(payload);
      if (terminal) throw terminal;
    }
    if (!directUrl) {
      throw new AiError("timeout", "生图任务超时：平台长时间未返回结果，可稍后重试");
    }
  }

  params.onProgress?.("图片已生成，正在保存到本地…");
  const blob = await urlToBlob(directUrl, params.signal);
  return { blob, remoteUrl: directUrl, mime: "image/png" };
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 不走重试的裸 fetch（重试语义由调用方决定；生图重试在 P7 队列层做） */
async function rawFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new AiError("cors", "Failed to fetch（可能是 CORS 或网络问题）");
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new AiError("timeout", "请求超时");
    }
    throw new AiError("network", error instanceof Error ? error.message : "网络错误");
  } finally {
    window.clearTimeout(timer);
    init.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** 结果图 URL → Blob；跨域拦截时返回 null（回退 remoteUrl 展示） */
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

function base64ToBlob(base64: string): Blob {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: "image/png" });
}

async function safeReadError(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "(无响应体)";
  }
}
