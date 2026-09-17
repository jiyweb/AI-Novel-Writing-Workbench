import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LLMProvider, ProviderAuthMode } from "@ai-novel/shared/types/llm";
import {
  type APIKeyStatus,
  createCustomProvider,
  deleteCustomProvider,
  previewCustomProviderModels,
  saveAPIKeySetting,
  testLLMConnection,
} from "@/api/settings";
import { queryKeys } from "@/api/queryKeys";
import type { ProviderFormState } from "./ProviderConfigDialog";

const EMPTY_PROVIDER_FORM: ProviderFormState = {
  displayName: "",
  key: "",
  model: "",
  imageModel: "",
  baseURL: "",
  authMode: "bearer",
  concurrencyLimit: "0",
  requestIntervalMs: "0",
};

function formatConnectionTestResult(response: Awaited<ReturnType<typeof testLLMConnection>>): string {
  const latency = response.data?.latency ?? 0;
  const plain = response.data?.plain;
  const structured = response.data?.structured;
  const plainText = plain
    ? plain.ok
      ? `普通连通正常${plain.latency != null ? ` (${plain.latency}ms)` : ""}`
      : `普通连通失败${plain.error ? `：${plain.error}` : ""}`
    : "普通连通未检测";
  const structuredText = structured
    ? structured.ok
      ? `结构化正常${structured.strategy ? `，策略 ${structured.strategy}` : ""}${structured.reasoningForcedOff ? "，已强制关闭 thinking" : ""}`
      : `结构化失败${structured.errorCategory ? `，分类 ${structured.errorCategory}` : ""}${structured.error ? `：${structured.error}` : ""}`
    : "结构化未检测";
  return `连接成功，总耗时 ${latency}ms · ${plainText} · ${structuredText}`;
}

/**
 * 模型厂商配置流程：系统设置「模型与厂商」与顶栏「模型设置」快捷入口共用同一套逻辑。
 * 负责厂商配置弹窗的表单状态、保存/创建/删除、连接测试，以及自定义厂商的模型预览。
 */
export function useProviderConfigFlow(options: {
  providers: APIKeyStatus[];
  onSaved?: (message: string) => void;
  onFailed?: (message: string) => void;
}) {
  const { providers } = options;
  const onSaved = options.onSaved ?? (() => {});
  const onFailed = options.onFailed ?? (() => {});
  const queryClient = useQueryClient();
  const [editingProvider, setEditingProvider] = useState<LLMProvider | "">("");
  const [isCreatingCustomProvider, setIsCreatingCustomProvider] = useState(false);
  const [form, setForm] = useState<ProviderFormState>(EMPTY_PROVIDER_FORM);
  const [dialogTestResult, setDialogTestResult] = useState("");
  const [providerTestResults, setProviderTestResults] = useState<Record<string, string>>({});
  const [previewModels, setPreviewModels] = useState<string[]>([]);
  const [previewModelsResult, setPreviewModelsResult] = useState("");

  const editingConfig = useMemo(
    () => providers.find((item) => item.provider === editingProvider),
    [editingProvider, providers],
  );
  const isDialogOpen = isCreatingCustomProvider || Boolean(editingProvider);
  const isCustomDialog = isCreatingCustomProvider || editingConfig?.kind === "custom";
  const selectableModels = isCreatingCustomProvider ? previewModels : editingConfig?.models ?? [];

  const resetDialogState = () => {
    setEditingProvider("");
    setIsCreatingCustomProvider(false);
    setForm(EMPTY_PROVIDER_FORM);
    setDialogTestResult("");
    setPreviewModels([]);
    setPreviewModelsResult("");
  };

  const invalidateProviderQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.apiKeys }),
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.apiKeyBalances }),
      queryClient.invalidateQueries({ queryKey: queryKeys.llm.providers }),
    ]);
  };

  const saveMutation = useMutation({
    mutationFn: (payload: {
      provider: LLMProvider;
      displayName?: string;
      key?: string;
      model?: string;
      imageModel?: string;
      baseURL?: string;
      authMode?: ProviderAuthMode;
      concurrencyLimit?: number;
      requestIntervalMs?: number;
    }) =>
      saveAPIKeySetting(payload.provider, {
        displayName: payload.displayName,
        key: payload.key,
        model: payload.model,
        imageModel: payload.imageModel,
        baseURL: payload.baseURL,
        authMode: payload.authMode,
        concurrencyLimit: payload.concurrencyLimit,
        requestIntervalMs: payload.requestIntervalMs,
      }),
    onSuccess: async (response) => {
      resetDialogState();
      onSaved(response.message ?? "保存成功。");
      await invalidateProviderQueries();
    },
    onError: (error) => {
      onFailed(error instanceof Error ? error.message : "保存失败。");
    },
  });

  const createCustomProviderMutation = useMutation({
    mutationFn: (payload: {
      name: string;
      key?: string;
      model?: string;
      imageModel?: string;
      baseURL: string;
      authMode?: ProviderAuthMode;
      concurrencyLimit?: number;
      requestIntervalMs?: number;
    }) => createCustomProvider(payload),
    onSuccess: async (response) => {
      resetDialogState();
      onSaved(response.message ?? "自定义厂商创建成功。");
      await invalidateProviderQueries();
    },
    onError: (error) => {
      onFailed(error instanceof Error ? error.message : "创建自定义厂商失败。");
    },
  });

  const previewCustomProviderModelsMutation = useMutation({
    mutationFn: (payload: { key?: string; baseURL: string; authMode?: ProviderAuthMode }) => previewCustomProviderModels(payload),
    onSuccess: (response) => {
      const models = response.data?.models ?? [];
      setPreviewModels(models);
      setPreviewModelsResult(response.message ?? `已获取 ${models.length} 个模型。`);
      setForm((prev) => ({
        ...prev,
        model: prev.model.trim() || models[0] || "",
      }));
    },
    onError: (error) => {
      setPreviewModels([]);
      setPreviewModelsResult(error instanceof Error ? error.message : "获取模型列表失败。");
    },
  });

  const deleteCustomProviderMutation = useMutation({
    mutationFn: (provider: LLMProvider) => deleteCustomProvider(provider),
    onSuccess: async (response) => {
      resetDialogState();
      onSaved(response.message ?? "自定义厂商已删除。");
      await invalidateProviderQueries();
    },
    onError: (error) => {
      onFailed(error instanceof Error ? error.message : "删除自定义厂商失败。");
    },
  });

  const testMutation = useMutation({
    mutationFn: testLLMConnection,
  });

  const openBuiltInDialog = (provider: LLMProvider) => {
    const config = providers.find((item) => item.provider === provider);
    if (!config) {
      return;
    }
    setIsCreatingCustomProvider(false);
    setEditingProvider(provider);
    setForm({
      displayName: config.displayName ?? config.name,
      key: "",
      model: config.currentModel,
      imageModel: config.currentImageModel ?? config.defaultImageModel ?? "",
      baseURL: config.currentBaseURL,
      authMode: config.currentAuthMode,
      concurrencyLimit: String(config.concurrencyLimit ?? 0),
      requestIntervalMs: String(config.requestIntervalMs ?? 0),
    });
    setDialogTestResult("");
    setPreviewModels([]);
    setPreviewModelsResult("");
  };

  const openCreateCustomDialog = () => {
    setEditingProvider("");
    setIsCreatingCustomProvider(true);
    setForm(EMPTY_PROVIDER_FORM);
    setDialogTestResult("");
    setPreviewModels([]);
    setPreviewModelsResult("");
  };

  const clearPreviewModels = () => {
    setPreviewModels([]);
    setPreviewModelsResult("");
  };

  const handlePreviewCustomModels = () => {
    setPreviewModelsResult("");
    previewCustomProviderModelsMutation.mutate({
      key: form.key.trim() ? form.key : undefined,
      baseURL: form.baseURL.trim(),
      authMode: form.authMode,
    });
  };

  const handleSubmitProviderDialog = () => {
    if (isCreatingCustomProvider) {
      createCustomProviderMutation.mutate({
        name: form.displayName.trim(),
        key: form.key.trim() ? form.key : undefined,
        model: form.model.trim() || undefined,
        imageModel: form.imageModel.trim(),
        baseURL: form.baseURL.trim(),
        authMode: form.authMode,
        concurrencyLimit: Number.parseInt(form.concurrencyLimit, 10) || 0,
        requestIntervalMs: Number.parseInt(form.requestIntervalMs, 10) || 0,
      });
      return;
    }
    if (!editingProvider) {
      return;
    }
    saveMutation.mutate({
      provider: editingProvider,
      displayName: isCustomDialog ? form.displayName.trim() || undefined : undefined,
      key: form.key.trim() ? form.key : undefined,
      model: form.model.trim() || undefined,
      imageModel: form.imageModel.trim(),
      baseURL: form.baseURL,
      authMode: isCustomDialog ? form.authMode : undefined,
      concurrencyLimit: Number.parseInt(form.concurrencyLimit, 10) || 0,
      requestIntervalMs: Number.parseInt(form.requestIntervalMs, 10) || 0,
    });
  };

  const handleTestProviderDialog = () => {
    testMutation.mutate(
      {
        provider: editingProvider || "custom_preview",
        apiKey: form.key.trim() ? form.key : undefined,
        model: form.model.trim() || undefined,
        baseURL: form.baseURL.trim() ? form.baseURL : undefined,
        authMode: isCustomDialog ? form.authMode : undefined,
        probeMode: "both",
      },
      {
        onSuccess: (response) => {
          setDialogTestResult(formatConnectionTestResult(response));
        },
        onError: (error) => {
          setDialogTestResult(error instanceof Error ? error.message : "连接测试失败。");
        },
      },
    );
  };

  const testProviderCard = (provider: APIKeyStatus) => {
    setProviderTestResults((prev) => ({
      ...prev,
      [provider.provider]: "",
    }));
    testMutation.mutate(
      {
        provider: provider.provider,
        model: provider.currentModel || undefined,
        baseURL: provider.currentBaseURL || undefined,
      },
      {
        onSuccess: (response) => {
          setProviderTestResults((prev) => ({
            ...prev,
            [provider.provider]: formatConnectionTestResult(response),
          }));
        },
        onError: (error) => {
          setProviderTestResults((prev) => ({
            ...prev,
            [provider.provider]: error instanceof Error ? error.message : "连接测试失败。",
          }));
        },
      },
    );
  };

  const handleDeleteCustomProvider = () => {
    if (!editingProvider || !editingConfig) {
      return;
    }
    if (!window.confirm(`确认删除自定义厂商 ${editingConfig.name} 吗？`)) {
      return;
    }
    deleteCustomProviderMutation.mutate(editingProvider);
  };

  const isSavingProvider = saveMutation.isPending || createCustomProviderMutation.isPending;
  const submitDisabled = isSavingProvider
    || previewCustomProviderModelsMutation.isPending
    || (!isCreatingCustomProvider && editingConfig?.textCapable !== false && !form.model.trim())
    || (isCustomDialog && !form.displayName.trim())
    || (isCreatingCustomProvider && !form.baseURL.trim())
    || (!isCustomDialog && editingConfig?.requiresApiKey !== false && !form.key.trim() && !editingConfig?.isConfigured);
  const submitLabel = isSavingProvider ? "保存中..." : isCreatingCustomProvider ? "创建厂商" : "保存";
  const testDisabled = testMutation.isPending || !form.model.trim() || !form.baseURL.trim();
  const deleteDisabled = deleteCustomProviderMutation.isPending;

  return {
    form,
    setForm,
    editingConfig,
    isCreatingCustomProvider,
    isCustomDialog,
    isDialogOpen,
    selectableModels,
    previewModelsResult,
    isPreviewingModels: previewCustomProviderModelsMutation.isPending,
    dialogTestResult,
    providerTestResults,
    testingProvider: testMutation.isPending ? testMutation.variables?.provider : undefined,
    submitDisabled,
    submitLabel,
    testDisabled,
    deleteDisabled,
    deleteLabel: deleteDisabled ? "删除中..." : "删除",
    openBuiltInDialog,
    openCreateCustomDialog,
    resetDialogState,
    clearPreviewModels,
    handlePreviewCustomModels,
    handleSubmitProviderDialog,
    handleTestProviderDialog,
    testProviderCard,
    handleDeleteCustomProvider,
  };
}