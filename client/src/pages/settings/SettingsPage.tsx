import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import type { LLMProvider, ReasoningEffort } from "@ai-novel/shared/types/llm";
import {
  type APIKeyStatus,
  deleteCustomProvider,
  getAPIKeySettings,
  getProviderBalances,
  refreshProviderBalance,
  refreshProviderModelList,
  saveAPIKeySetting,
} from "@/api/settings";
import { queryKeys } from "@/api/queryKeys";
import {
  ImageModelProvidersSection,
  ProviderConfigDialog,
  TextModelProvidersSection,
  useProviderConfigFlow,
} from "./components/providers";
import SettingsActionResult from "./SettingsActionResult";
import { AUTO_DIRECTOR_MOBILE_CLASSES } from "@/mobile/autoDirector";

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [actionResult, setActionResult] = useState("");

  const apiKeySettingsQuery = useQuery({
    queryKey: queryKeys.settings.apiKeys,
    queryFn: getAPIKeySettings,
  });

  const providerBalancesQuery = useQuery({
    queryKey: queryKeys.settings.apiKeyBalances,
    queryFn: getProviderBalances,
  });

  const providerConfigs = useMemo(() => apiKeySettingsQuery.data?.data ?? [], [apiKeySettingsQuery.data?.data]);

  const providerConfigFlow = useProviderConfigFlow({
    providers: providerConfigs,
    onSaved: setActionResult,
    onFailed: setActionResult,
  });

  const invalidateProviderQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.apiKeys }),
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.apiKeyBalances }),
      queryClient.invalidateQueries({ queryKey: queryKeys.llm.providers }),
    ]);
  };

  const updateProviderModelsInCache = (provider: string, models: string[], currentModel: string) => {
    queryClient.setQueryData<ApiResponse<APIKeyStatus[]>>(queryKeys.settings.apiKeys, (previous) => {
      if (!previous?.data) {
        return previous;
      }
      return {
        ...previous,
        data: previous.data.map((item) => item.provider === provider
          ? {
            ...item,
            models,
            currentModel,
          }
          : item),
      };
    });
  };

  const invalidateProviderAuxiliaryQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.apiKeyBalances }),
      queryClient.invalidateQueries({ queryKey: queryKeys.llm.providers }),
    ]);
  };

  const removeProviderMutation = useMutation({
    mutationFn: async (provider: APIKeyStatus) => {
      if (provider.kind === "custom") {
        return deleteCustomProvider(provider.provider);
      }
      return saveAPIKeySetting(provider.provider, { isActive: false });
    },
    onSuccess: async (response, provider) => {
      setActionResult(response.message ?? (provider.kind === "builtin" ? "厂商已从列表移除。" : "自定义厂商已删除。"));
      await invalidateProviderQueries();
    },
    onError: (error) => {
      setActionResult(error instanceof Error ? error.message : "移除厂商失败。");
    },
  });

  const refreshModelsMutation = useMutation({
    mutationFn: (provider: LLMProvider) => refreshProviderModelList(provider),
    onSuccess: async (response, provider) => {
      const count = response.data?.models?.length ?? 0;
      const providerName = providerConfigs.find((item) => item.provider === provider)?.name ?? provider;
      if (response.data) {
        updateProviderModelsInCache(response.data.provider, response.data.models, response.data.currentModel);
      }
      setActionResult(`${providerName} 模型列表已刷新（${count} 个）。`);
      await invalidateProviderAuxiliaryQueries();
    },
    onError: (error) => {
      setActionResult(error instanceof Error ? error.message : "刷新模型列表失败。");
    },
  });

  const modelControlsMutation = useMutation({
    mutationFn: (payload: {
      provider: LLMProvider;
      reasoningEnabled?: boolean;
      reasoningEffort?: ReasoningEffort;
      hiddenModels?: string[];
      message: string;
    }) => saveAPIKeySetting(payload.provider, {
      reasoningEnabled: payload.reasoningEnabled,
      reasoningEffort: payload.reasoningEffort,
      hiddenModels: payload.hiddenModels,
    }),
    onSuccess: async (_response, variables) => {
      const providerName = providerConfigs.find((item) => item.provider === variables.provider)?.name ?? variables.provider;
      setActionResult(`${providerName}：${variables.message}`);
      await invalidateProviderQueries();
    },
    onError: (error) => {
      setActionResult(error instanceof Error ? error.message : "更新模型设置失败。");
    },
  });

  const refreshBalanceMutation = useMutation({
    mutationFn: (provider: LLMProvider) => refreshProviderBalance(provider),
    onSuccess: async (response, provider) => {
      const providerName = providerConfigs.find((item) => item.provider === provider)?.name ?? provider;
      setActionResult(response.message ?? `${providerName} 余额已刷新。`);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.apiKeyBalances });
    },
    onError: (error) => {
      setActionResult(error instanceof Error ? error.message : "刷新余额失败。");
    },
  });

  const handleRemoveProvider = (provider: APIKeyStatus) => {
    const label = provider.kind === "builtin" ? "从列表移除" : "删除";
    if (!window.confirm(`确认${label} ${provider.name} 吗？`)) {
      return;
    }
    removeProviderMutation.mutate(provider);
  };

  const openProviderConfig = (provider: LLMProvider) => {
    setActionResult("");
    providerConfigFlow.openBuiltInDialog(provider);
  };

  const openCreateCustomProvider = () => {
    setActionResult("");
    providerConfigFlow.openCreateCustomDialog();
  };

  return (
    <div className={AUTO_DIRECTOR_MOBILE_CLASSES.settingsPageRoot}>
      <div className="space-y-4">
        <TextModelProvidersSection
          providers={providerConfigs}
          balances={providerBalancesQuery.data?.data ?? []}
          isBalanceLoading={providerBalancesQuery.isLoading}
          testingProvider={providerConfigFlow.testingProvider}
          providerTestResults={providerConfigFlow.providerTestResults}
          refreshingModelProvider={refreshModelsMutation.isPending ? refreshModelsMutation.variables : undefined}
          refreshingBalanceProvider={refreshBalanceMutation.isPending ? refreshBalanceMutation.variables : undefined}
          reasoningProvider={modelControlsMutation.isPending ? modelControlsMutation.variables?.provider : undefined}
          onCreateCustomProvider={openCreateCustomProvider}
          onRemoveProvider={handleRemoveProvider}
          onOpenConfig={openProviderConfig}
          onTest={providerConfigFlow.testProviderCard}
          onRefreshModels={(provider) => {
            setActionResult("");
            refreshModelsMutation.mutate(provider);
          }}
          onRefreshBalance={(provider) => {
            setActionResult("");
            refreshBalanceMutation.mutate(provider);
          }}
          onSetReasoning={(provider, reasoningEnabled, reasoningEffort) => {
            setActionResult("");
            const effortLabel = reasoningEffort === "low" ? "低" : reasoningEffort === "max" ? "最大" : "高";
            modelControlsMutation.mutate({
              provider,
              reasoningEnabled,
              reasoningEffort,
              message: reasoningEnabled ? `思考深度设为${effortLabel}。` : "思考功能已关闭。",
            });
          }}
          onSetHiddenModels={(provider, hiddenModels, message) => {
            setActionResult("");
            modelControlsMutation.mutate({ provider, hiddenModels, message });
          }}
          removingProvider={removeProviderMutation.isPending ? removeProviderMutation.variables?.provider : undefined}
        />
        <ImageModelProvidersSection
          providers={providerConfigs}
          onCreateCustomProvider={openCreateCustomProvider}
          onOpenConfig={openProviderConfig}
          onRemoveProvider={handleRemoveProvider}
        />
      </div>

      <SettingsActionResult message={actionResult} />

      <ProviderConfigDialog
        open={providerConfigFlow.isDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            providerConfigFlow.resetDialogState();
          }
        }}
        isCreatingCustomProvider={providerConfigFlow.isCreatingCustomProvider}
        isCustomDialog={providerConfigFlow.isCustomDialog}
        editingConfig={providerConfigFlow.editingConfig}
        form={providerConfigFlow.form}
        setForm={providerConfigFlow.setForm}
        selectableModels={providerConfigFlow.selectableModels}
        previewModelsResult={providerConfigFlow.previewModelsResult}
        isPreviewingModels={providerConfigFlow.isPreviewingModels}
        onClearPreviewModels={providerConfigFlow.clearPreviewModels}
        onPreviewModels={providerConfigFlow.handlePreviewCustomModels}
        onSubmit={providerConfigFlow.handleSubmitProviderDialog}
        submitDisabled={providerConfigFlow.submitDisabled}
        submitLabel={providerConfigFlow.submitLabel}
        onTest={providerConfigFlow.handleTestProviderDialog}
        testDisabled={providerConfigFlow.testDisabled}
        testResult={providerConfigFlow.dialogTestResult}
        onDeleteCustomProvider={providerConfigFlow.handleDeleteCustomProvider}
        deleteDisabled={providerConfigFlow.deleteDisabled}
        deleteLabel={providerConfigFlow.deleteLabel}
      />
    </div>
  );
}