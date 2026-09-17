import type {
  CompleteQuickSetupRequest,
  CompleteQuickSetupResult,
  QuickSetupProviderOption,
  QuickSetupStatus,
} from "@ai-novel/shared/types/onboarding";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { ModelRouteTaskType } from "@ai-novel/shared/types/novel";
import { setProviderSecretCache } from "../../../../llm/factory";
import { llmConnectivityService } from "../../../../llm/connectivity";
import {
  MODEL_ROUTE_TASK_TYPES,
  resolveModel,
  upsertModelRouteConfig,
} from "../../../../llm/modelRouter";
import { evictSharedLimiters } from "../../../../llm/requestLimiter";
import { normalizeReasoningEffort } from "../../../../llm/reasoning";
import {
  getProviderEnvApiKey,
  getProviderEnvBaseUrl,
  getProviderEnvModel,
  isBuiltInProvider,
  providerRequiresApiKey,
  providerSupportsText,
  PROVIDERS,
  SUPPORTED_PROVIDERS,
} from "../../../../llm/providers";
import { AppError } from "../../../../middleware/errorHandler";
import {
  getLLMSelectionSettings,
  saveLLMSelectionSettings,
} from "../../../../services/settings/LLMSelectionSettingsService";
import { secretStore } from "../../../../services/settings/secretStore";

const ROUTE_TEMPERATURES: Record<ModelRouteTaskType, number> = {
  planner: 0.3,
  writer: 0.8,
  review: 0.2,
  light_review: 0.2,
  critical_review: 0.1,
  repair: 0.4,
  replan: 0.2,
  state_resolution: 0.1,
  summary: 0.2,
  fact_extraction: 0.2,
  chat: 0.7,
};

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function buildCustomProviderId(name: string): LLMProvider {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `custom_${normalized || "provider"}`;
}

interface ProviderOptionsResult {
  /** 全量厂商（含与内置同名的自定义记录），用于任务路由与当前选择的解析 */
  allOptions: QuickSetupProviderOption[];
  /** 展示用厂商列表：与内置厂商同名的自定义记录已并入内置卡片，避免出现重复厂商 */
  displayOptions: QuickSetupProviderOption[];
  /** 被合并的自定义厂商 id → 承接它的内置厂商 id */
  mergedIntoBuiltin: Map<LLMProvider, LLMProvider>;
}

async function listProviderOptions(): Promise<ProviderOptionsResult> {
  const records = await secretStore.listProviders();
  const recordByProvider = new Map(records.map((record) => [record.provider, record]));
  const builtinNameById = new Map(
    SUPPORTED_PROVIDERS
      .filter((provider) => providerSupportsText(provider))
      .map((provider) => [PROVIDERS[provider].name.toLowerCase(), provider] as const),
  );
  const builtins: QuickSetupProviderOption[] = [];
  const builtinExplicit = new Map<LLMProvider, { model?: string; baseURL?: string }>();
  for (const provider of SUPPORTED_PROVIDERS.filter((item) => providerSupportsText(item))) {
    const config = PROVIDERS[provider];
    const record = recordByProvider.get(provider);
    const explicitModel = normalizeOptionalText(record?.model) ?? getProviderEnvModel(provider);
    const explicitBaseURL = normalizeOptionalText(record?.baseURL) ?? getProviderEnvBaseUrl(provider);
    builtinExplicit.set(provider, { model: explicitModel, baseURL: explicitBaseURL });
    const currentModel = explicitModel ?? config.defaultModel;
    const currentBaseURL = explicitBaseURL ?? config.baseURL;
    const hasRequiredKey = !providerRequiresApiKey(provider)
      || Boolean(normalizeOptionalText(record?.key) ?? getProviderEnvApiKey(provider));
    builtins.push({
      id: provider,
      kind: "builtin",
      name: config.name,
      requiresApiKey: providerRequiresApiKey(provider),
      configured: (record?.isActive ?? true) && hasRequiredKey && Boolean(currentModel),
      active: record?.isActive ?? true,
      currentModel,
      defaultModel: config.defaultModel,
      currentBaseURL,
      defaultBaseURL: config.baseURL,
      models: Array.from(new Set([...(config.models ?? []), currentModel].filter(Boolean))),
    });
  }
  const builtinById = new Map(builtins.map((option) => [option.id, option]));
  const mergedIntoBuiltin = new Map<LLMProvider, LLMProvider>();
  const customs: QuickSetupProviderOption[] = [];
  for (const record of records) {
    if (isBuiltInProvider(record.provider)) {
      continue;
    }
    const displayName = normalizeOptionalText(record.displayName) ?? record.provider;
    const mergeTarget = builtinNameById.get(displayName.toLowerCase());
    if (mergeTarget) {
      // 历史第三方记录与内置厂商同名（如内置接入前手工添加的厂商）：
      // 并入内置卡片展示，避免同一厂商出现两条；运行时数据保持不变。
      mergedIntoBuiltin.set(record.provider, mergeTarget);
      const builtin = builtinById.get(mergeTarget);
      if (!builtin) {
        continue;
      }
      const currentModel = normalizeOptionalText(record.model);
      const currentBaseURL = normalizeOptionalText(record.baseURL);
      const explicit = builtinExplicit.get(mergeTarget);
      if (currentModel && !explicit?.model) {
        builtin.currentModel = currentModel;
        builtin.models = Array.from(new Set([...builtin.models, currentModel]));
      }
      if (currentBaseURL && !explicit?.baseURL) {
        builtin.currentBaseURL = currentBaseURL;
      }
      if (record.isActive && Boolean(currentModel && currentBaseURL)) {
        builtin.configured = true;
      }
      continue;
    }
    const currentModel = normalizeOptionalText(record.model) ?? "";
    const currentBaseURL = normalizeOptionalText(record.baseURL) ?? "";
    customs.push({
      id: record.provider,
      kind: "custom",
      name: displayName,
      requiresApiKey: false,
      configured: record.isActive && Boolean(currentModel && currentBaseURL),
      active: record.isActive,
      currentModel,
      defaultModel: currentModel,
      currentBaseURL,
      defaultBaseURL: currentBaseURL,
      models: currentModel ? [currentModel] : [],
    });
  }
  const allOptions = [...builtins, ...customs];
  return { allOptions, displayOptions: [...builtins, ...customs], mergedIntoBuiltin };
}

/**
 * 自定义厂商记录与同名内置厂商合并后，快速设置弹窗只展示内置卡片；
 * 完成配置时允许回退使用被合并记录的 Key / 地址，避免用户重复粘贴密钥。
 */
async function resolveMergedCustomFallback(
  provider: LLMProvider,
): Promise<{ key?: string; baseURL?: string }> {
  if (!isBuiltInProvider(provider)) {
    return {};
  }
  const builtinName = PROVIDERS[provider].name.toLowerCase();
  const records = await secretStore.listProviders();
  const fallback = records.find((record) => !isBuiltInProvider(record.provider)
    && (normalizeOptionalText(record.displayName) ?? record.provider).toLowerCase()
    === builtinName);
  if (!fallback) {
    return {};
  }
  return {
    key: normalizeOptionalText(fallback.key),
    baseURL: normalizeOptionalText(fallback.baseURL),
  };
}

export async function getQuickSetupStatus(): Promise<QuickSetupStatus> {
  const [providerOptions, selection, resolvedRoutes] = await Promise.all([
    listProviderOptions(),
    getLLMSelectionSettings(),
    Promise.all(MODEL_ROUTE_TASK_TYPES.map(async (taskType) => ({
      taskType,
      route: await resolveModel(taskType),
    }))),
  ]);
  const providers = providerOptions.displayOptions;
  const providerById = new Map(providerOptions.allOptions.map((provider) => [provider.id, provider]));
  const missingTaskTypes = resolvedRoutes
    .filter(({ route }) => {
      const provider = providerById.get(route.provider);
      return !provider?.configured || !route.model.trim();
    })
    .map(({ taskType }) => taskType);
  const plannerRoute = resolvedRoutes.find(({ taskType }) => taskType === "planner")?.route;
  const fallbackProvider = plannerRoute && providerById.get(plannerRoute.provider)?.configured
    ? providerById.get(plannerRoute.provider)
    : providerOptions.allOptions.find((provider) => provider.configured);
  const selectedProviderOption = selection && providerById.get(selection.provider)?.configured
    ? providerById.get(selection.provider)
    : fallbackProvider;
  // 被合并的同名自定义厂商展示为内置卡片；把当前选择重映射到承接它的内置厂商，
  // 弹窗才能正确高亮用户正在使用的厂商。
  const selectedProvider = selectedProviderOption
    ? providerOptions.mergedIntoBuiltin.get(selectedProviderOption.id) ?? selectedProviderOption.id
    : null;
  const selectedModel = selection && selectedProvider === selection.provider
    ? selection.model
    : selectedProviderOption?.currentModel ?? null;
  const hasUsableSelection = Boolean(
    selectedModel?.trim()
    && selectedProviderOption?.configured,
  );
  const readyForCreation = hasUsableSelection && missingTaskTypes.length === 0;
  const blockingReasons: string[] = [];
  if (!hasUsableSelection) {
    blockingReasons.push("还没有可用于创作的默认文本模型。");
  }
  if (missingTaskTypes.length > 0) {
    blockingReasons.push(`还有 ${missingTaskTypes.length} 类创作任务没有可用模型路由。`);
  }
  return {
    readyForCreation,
    providers,
    selectedProvider,
    selectedModel,
    routeCoverage: {
      configured: MODEL_ROUTE_TASK_TYPES.length - missingTaskTypes.length,
      total: MODEL_ROUTE_TASK_TYPES.length,
      missingTaskTypes,
    },
    blockingReasons,
    recommendedAction: !hasUsableSelection
      ? "configure_provider"
      : missingTaskTypes.length > 0
        ? "repair_routes"
        : "start_creating",
  };
}

async function resolveProviderInput(input: CompleteQuickSetupRequest): Promise<{
  provider: LLMProvider;
  displayName?: string;
  existingKey?: string;
  existingBaseURL?: string;
}> {
  if (input.providerKind === "builtin") {
    if (!input.provider || !isBuiltInProvider(input.provider)) {
      throw new AppError("请选择一个可用的内置模型厂商。", 400);
    }
    const existing = await secretStore.getProvider(input.provider);
    const mergedFallback = await resolveMergedCustomFallback(input.provider);
    return {
      provider: input.provider,
      existingKey: normalizeOptionalText(existing?.key)
        ?? getProviderEnvApiKey(input.provider)
        ?? mergedFallback.key,
      existingBaseURL: normalizeOptionalText(existing?.baseURL)
        ?? getProviderEnvBaseUrl(input.provider)
        ?? mergedFallback.baseURL,
    };
  }
  const displayName = normalizeOptionalText(input.customProviderName);
  if (!displayName) {
    throw new AppError("请填写自定义厂商名称。", 400);
  }
  const provider = input.provider && !isBuiltInProvider(input.provider)
    ? input.provider
    : buildCustomProviderId(displayName);
  const existing = await secretStore.getProvider(provider);
  return {
    provider,
    displayName,
    existingKey: normalizeOptionalText(existing?.key),
    existingBaseURL: normalizeOptionalText(existing?.baseURL),
  };
}

export async function completeQuickSetup(
  input: CompleteQuickSetupRequest,
): Promise<CompleteQuickSetupResult> {
  const resolvedInput = await resolveProviderInput(input);
  const provider = resolvedInput.provider;
  const model = input.model.trim();
  const apiKey = normalizeOptionalText(input.apiKey) ?? resolvedInput.existingKey;
  const baseURL = normalizeOptionalText(input.baseURL)
    ?? resolvedInput.existingBaseURL
    ?? (isBuiltInProvider(provider) ? PROVIDERS[provider].baseURL : undefined);
  if (!model) {
    throw new AppError("请选择或填写一个文本模型。", 400);
  }
  if (isBuiltInProvider(provider) && providerRequiresApiKey(provider) && !apiKey) {
    throw new AppError("请填写 API Key。", 400);
  }
  if (!baseURL) {
    throw new AppError("请填写 API 地址。", 400);
  }

  const probe = await llmConnectivityService.testConnection({
    provider,
    apiKey,
    model,
    baseURL,
    probeMode: "both",
  });
  const plainReady = probe.plain?.ok === true;
  const structuredReady = probe.structured?.ok === true;
  if (!plainReady || !structuredReady) {
    const details = [
      !plainReady ? `普通文本：${probe.plain?.error ?? probe.error ?? "连接失败"}` : "",
      !structuredReady ? `结构化输出：${probe.structured?.error ?? probe.error ?? "连接失败"}` : "",
    ].filter(Boolean).join("；");
    throw new AppError(`模型检测未通过。${details}`, 400);
  }

  const record = await secretStore.upsertProvider(provider, {
    ...(resolvedInput.displayName ? { displayName: resolvedInput.displayName } : {}),
    key: apiKey ?? null,
    model,
    baseURL,
    isActive: true,
    reasoningEnabled: true,
    reasoningEffort: "high",
    hiddenModels: "[]",
  });
  setProviderSecretCache(provider, {
    displayName: record.displayName ?? undefined,
    key: record.key ?? undefined,
    model: record.model ?? undefined,
    baseURL: record.baseURL ?? undefined,
    reasoningEnabled: record.reasoningEnabled ?? true,
    reasoningEffort: normalizeReasoningEffort(record.reasoningEffort),
    concurrencyLimit: record.concurrencyLimit ?? 0,
    requestIntervalMs: record.requestIntervalMs ?? 0,
  });
  evictSharedLimiters(provider);

  await saveLLMSelectionSettings({ provider, model });
  await Promise.all(MODEL_ROUTE_TASK_TYPES.map((taskType) => upsertModelRouteConfig(taskType, {
    provider,
    model,
    temperature: ROUTE_TEMPERATURES[taskType],
    requestProtocol: probe.structured?.requestProtocol ?? probe.requestProtocol,
    structuredResponseFormat: probe.structured?.strategy,
  })));

  return {
    status: await getQuickSetupStatus(),
    provider,
    model,
    plainConnectionReady: plainReady,
    structuredConnectionReady: structuredReady,
  };
}
