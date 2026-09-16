/**
 * LLM 客户端：统一调用主程序服务端 /api/llm/invoke
 *
 * 文本模型、API Key、超时重试、JSON 修复与备用模型切换全部由主程序负责，
 * 本模块不再自建任何服务商配置。这里只负责：请求包装、zod 结构校验、
 * 单轮修复重试与错误文案。
 */
import { z } from "zod";
import { apiClient, type ApiHttpError } from "@/api/client";
import { getAiDefaults } from "./aiConfigService";

export class AiError extends Error {
  /** kind 用于 UI 给出针对性提示 */
  kind: "network" | "timeout" | "http" | "badJson" | "notConfigured";
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
      case "network":
        return "无法连接主程序 AI 服务，请确认主程序服务已启动。";
      case "timeout":
        return "AI 服务响应超时，请稍后重试。";
      case "http":
        return `AI 调用失败（HTTP ${error.status ?? ""}）：${error.message}`.replace("（HTTP ）", "");
      case "badJson":
        return "AI 返回的内容无法解析为约定格式，已自动重试仍失败。请重试一次或在主程序模型设置中换用更稳定的模型。";
      case "notConfigured":
        return "主程序尚未配置可用的文本模型，请先到主程序「模型设置」完成配置。";
    }
  }
  return error instanceof Error ? error.message : "发生未知错误";
}

/** 把 apiClient 拦截器抛出的错误规整为 AiError（拦截器已做过用户提示） */
function normalizeApiError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new AiError("timeout", "请求已取消");
  }
  const status = (error as ApiHttpError | undefined)?.status;
  if (error instanceof Error) {
    return new AiError(status ? "http" : "network", error.message, status);
  }
  return new AiError("network", "请求失败");
}

/**
 * 结构化 JSON 调用：主程序负责解析与 JSON 修复；这里再用 zod 校验字段结构，
 * 校验失败时带上错误说明重试一次（修复轮）。
 */
export async function chatJson<T>(params: {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** 覆盖默认超时（长文本分镜场景默认 longTextTimeoutMs） */
  timeoutMs?: number;
  signal?: AbortSignal;
  temperature?: number;
  /** 调用方标识，便于主程序日志定位 */
  label?: string;
}): Promise<T> {
  const defaults = getAiDefaults();

  let lastError: AiError | null = null;
  for (let round = 0; round < 2; round++) {
    const user =
      round === 0
        ? params.user
        : `${params.user}\n\n【输出修正要求】上一次输出不符合约定的 JSON 结构：${lastError?.message ?? ""}\n请严格按原要求重新输出纯 JSON，不要输出任何解释文字。`;

    let payload: unknown;
    try {
      const { data } = await apiClient.post(
        "/llm/invoke",
        {
          system: params.system,
          user,
          temperature: params.temperature,
          label: params.label,
        },
        {
          timeout: params.timeoutMs ?? defaults.longTextTimeoutMs,
          signal: params.signal,
        },
      );
      payload = (data as { data?: unknown }).data;
    } catch (error) {
      throw normalizeApiError(error);
    }

    if (payload === null || typeof payload !== "object") {
      lastError = new AiError("badJson", "输出不是 JSON 对象");
      continue;
    }
    const validated = params.schema.safeParse(payload);
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
