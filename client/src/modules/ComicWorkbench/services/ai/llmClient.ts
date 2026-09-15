/**
 * LLM 客户端：OpenAI 兼容 chat completions（浏览器直连）
 *
 * 内置：超时（AbortController）、重试（指数退避，默认3次）、
 * JSON 提取与修复、CORS/网络错误友好提示。
 */
import { z } from "zod";
import { getAiDefaults } from "./aiConfigService";
import type { AiConnectionSettings } from "../../types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class AiError extends Error {
  /** kind 用于 UI 给出针对性提示 */
  kind: "network" | "cors" | "timeout" | "http" | "badJson" | "notConfigured";
  status?: number;
  constructor(kind: AiError["kind"], message: string, status?: number) {
    super(message);
    this.name = "AiError";
    this.kind = kind;
    this.status = status;
  }
}

/** 用户可读的 AI 错误文案（错误兜底规则第12条） */
export function describeAiError(error: unknown): string {
  if (error instanceof AiError) {
    switch (error.kind) {
      case "cors":
        return "浏览器直连该 AI 服务被跨域策略拦截。请在 AI 设置中改用支持跨域的网关地址（例如本地 one-api/new-api），或更换服务商。";
      case "network":
        return "无法连接到 AI 服务，请检查网络与 baseUrl 是否正确。";
      case "timeout":
        return "AI 服务响应超时，请稍后重试，或在 AI 设置中调整超时时间。";
      case "http":
        return `AI 服务返回错误（HTTP ${error.status ?? ""}）。请检查 API Key 与模型名是否有效。`.replace("  ", " ");
      case "badJson":
        return "AI 返回的内容无法解析为约定格式，已自动重试仍失败。请重试一次或换用更稳定的模型。";
      case "notConfigured":
        return "尚未配置 AI 接口，请先在设置中填写 API Key 与模型。";
    }
  }
  return error instanceof Error ? error.message : "发生未知错误";
}

// ---------------------------------------------------------------------------
// 重试与超时
// ---------------------------------------------------------------------------

interface ChatRequestOptions {
  /** 是否要求 JSON 输出（OpenAI response_format） */
  jsonMode?: boolean;
  /** 覆盖默认超时（长文本分镜场景用 longTextTimeoutMs） */
  timeoutMs?: number;
  /** 外部取消信号（组件卸载/用户取消） */
  signal?: AbortSignal;
  /** 温度，缺省 0.7 */
  temperature?: number;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; maxRetries: number; baseDelayMs: number },
): Promise<Response> {
  let lastError: AiError = new AiError("network", "未知网络错误");
  for (let attempt = 1; attempt <= options.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(new AiError("timeout", "timeout")), options.timeoutMs);
    const onExternalAbort = () => controller.abort(init.signal?.reason ?? new AiError("timeout", "aborted"));
    init.signal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      // 429/5xx 视为可重试；其余状态直接返回交由上层处理
      if (response.status === 429 || response.status >= 500) {
        lastError = new AiError("http", `HTTP ${response.status}`, response.status);
        if (attempt < options.maxRetries) {
          await delay(options.baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
      }
      return response;
    } catch (error) {
      lastError = normalizeFetchError(error);
      if (init.signal?.aborted) {
        throw lastError;
      }
      if (attempt < options.maxRetries) {
        await delay(options.baseDelayMs * 2 ** (attempt - 1));
        continue;
      }
    } finally {
      window.clearTimeout(timer);
      init.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
  throw lastError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeFetchError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof TypeError) {
    // 浏览器把 CORS 拦截和网络失败都抛成 TypeError，只能按特征区分提示
    return new AiError("cors", "Failed to fetch（可能是 CORS 或网络问题）");
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new AiError("timeout", "请求超时");
  }
  return new AiError("network", error instanceof Error ? error.message : "网络错误");
}

// ---------------------------------------------------------------------------
// 基础 chat 调用
// ---------------------------------------------------------------------------

/** OpenAI 兼容 chat completions，返回 assistant 文本 */
export async function chatCompletion(
  settings: AiConnectionSettings,
  messages: ChatMessage[],
  options: ChatRequestOptions = {},
): Promise<string> {
  if (!settings.llm.baseUrl || !settings.llm.apiKey || !settings.llm.model) {
    throw new AiError("notConfigured", "AI 文本模型未配置");
  }
  const defaults = getAiDefaults();
  const url = joinUrl(settings.llm.baseUrl, "/chat/completions");
  const body: Record<string, unknown> = {
    model: settings.llm.model,
    messages,
    temperature: options.temperature ?? 0.7,
  };
  if (options.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const response = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.llm.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    },
    {
      timeoutMs: options.timeoutMs ?? defaults.llmTimeoutMs,
      maxRetries: defaults.maxRetries,
      baseDelayMs: defaults.retryBaseDelayMs,
    },
  );

  if (!response.ok) {
    const detail = await safeReadError(response);
    throw new AiError("http", `HTTP ${response.status}: ${detail}`, response.status);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new AiError("badJson", "响应缺少 choices[0].message.content");
  }
  return content;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

async function safeReadError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return "(无响应体)";
  }
}

// ---------------------------------------------------------------------------
// 结构化 JSON 输出
// ---------------------------------------------------------------------------

/**
 * 要求模型输出 JSON 并用 zod 校验。
 * 解析失败会带错误信息重试一次（JSON 修复轮）。
 */
export async function chatJson<T>(params: {
  settings: AiConnectionSettings;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** 修复轮附带的额外说明 */
  timeoutMs?: number;
  signal?: AbortSignal;
  temperature?: number;
}): Promise<T> {
  const messages: ChatMessage[] = [
    { role: "system", content: params.system },
    { role: "user", content: params.user },
  ];

  let lastError: AiError | null = null;
  for (let round = 0; round < 2; round++) {
    const currentMessages =
      round === 0
        ? messages
        : [
          ...messages,
          { role: "assistant" as const, content: lastRawOutput ?? "" },
          {
            role: "user" as const,
            content: `上面的输出不符合要求的 JSON 结构：${lastError?.message ?? ""}\n请严格按原要求重新输出纯 JSON，不要输出任何解释文字。`,
          },
        ];

    const raw = await chatCompletion(params.settings, currentMessages, {
      jsonMode: true,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      temperature: params.temperature,
    });
    lastRawOutput = raw;

    const parsed = extractJson(raw);
    if (parsed === null) {
      lastError = new AiError("badJson", "输出中找不到合法 JSON");
      continue;
    }
    const validated = params.schema.safeParse(parsed);
    if (validated.success) {
      return validated.data;
    }
    const issue = validated.error.issues[0];
    lastError = new AiError(
      "badJson",
      `字段 ${issue?.path?.join(".") ?? "(根)"} ${issue?.message ?? "校验失败"}`,
    );
  }
  throw lastError ?? new AiError("badJson", "JSON 解析失败");
}

let lastRawOutput = "";

/**
 * 从模型输出中提取 JSON：
 * 剥离 ```json 代码块、截取首个平衡的 {..}、修复常见瑕疵（全角引号/尾逗号）。
 */
export function extractJson(raw: string): unknown | null {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    text = fenceMatch[1].trim();
  }
  const start = text.indexOf("{");
  if (start < 0) return null;
  const balanced = sliceBalanced(text, start);
  const candidates = [balanced, balanced.replace(/，/g, ",").replace(/：/g, ":")];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // 继续尝试修复
    }
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1")) as unknown;
    } catch {
      // 修复失败则尝试下一个候选
    }
  }
  return null;
}

/** 从 start 起截取括号配平的 JSON 串 */
function sliceBalanced(text: string, start: number): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return text.slice(start);
}
