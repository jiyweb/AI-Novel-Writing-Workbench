import { useMemo, useState } from "react";
import { Bot, PlugZap, Plus } from "lucide-react";
import type { LLMProvider, ReasoningEffort } from "@ai-novel/shared/types/llm";
import type { APIKeyStatus, ProviderBalanceStatus } from "@/api/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AUTO_DIRECTOR_MOBILE_CLASSES } from "@/mobile/autoDirector";
import ProviderStatusCard, { type ProviderCardViewModel } from "./ProviderStatusCard";
import AddProviderDialog from "./AddProviderDialog";

export default function TextModelProvidersSection(props: {
  providers: APIKeyStatus[];
  balances: ProviderBalanceStatus[];
  isBalanceLoading: boolean;
  testingProvider?: string;
  providerTestResults: Record<string, string>;
  refreshingModelProvider?: string;
  refreshingBalanceProvider?: string;
  reasoningProvider?: string;
  onCreateCustomProvider: () => void;
  onRemoveProvider: (provider: APIKeyStatus) => void;
  onOpenConfig: (provider: LLMProvider) => void;
  onTest: (provider: APIKeyStatus) => void;
  onRefreshModels: (provider: LLMProvider) => void;
  onRefreshBalance: (provider: LLMProvider) => void;
  onSetReasoning: (provider: LLMProvider, reasoningEnabled: boolean, reasoningEffort?: ReasoningEffort) => void;
  onSetHiddenModels: (provider: LLMProvider, hiddenModels: string[], message: string) => void;
  removingProvider?: string;
}) {
  const {
    providers,
    balances,
    isBalanceLoading,
    testingProvider,
    providerTestResults,
    refreshingModelProvider,
    refreshingBalanceProvider,
    reasoningProvider,
    onCreateCustomProvider,
    onRemoveProvider,
    onOpenConfig,
    onTest,
    onRefreshModels,
    onRefreshBalance,
    onSetReasoning,
    onSetHiddenModels,
    removingProvider,
  } = props;
  const [isAddProviderOpen, setIsAddProviderOpen] = useState(false);
  const balanceMap = new Map(balances.map((item) => [item.provider, item]));
  const viewModels: ProviderCardViewModel[] = providers.map((provider) => {
    const balance = balanceMap.get(provider.provider);
    const canRefreshBalance = Boolean(
      provider.kind === "builtin"
      && provider.isConfigured
      && (balance?.canRefresh ?? (provider.provider === "deepseek" || provider.provider === "siliconflow" || provider.provider === "kimi")),
    );
    return {
      provider,
      balance,
      isBalanceLoading: isBalanceLoading && !balance,
      isBalanceRefreshing: refreshingBalanceProvider === provider.provider,
      canRefreshBalance,
      isReasoningUpdating: reasoningProvider === provider.provider,
      isTesting: testingProvider === provider.provider,
      testResult: providerTestResults[provider.provider],
    };
  });
  const visibleViewModels = useMemo(
    () => viewModels.filter(({ provider }) => provider.isConfigured && provider.isActive && provider.textCapable !== false),
    [viewModels],
  );
  const addableBuiltIns = providers.filter(
    (provider) => provider.kind === "builtin"
      && provider.textCapable !== false
      && (!provider.isConfigured || !provider.isActive),
  );

  return (
    <Card id="settings-text-model-section" className="min-w-0 scroll-mt-20 overflow-hidden border-primary/10 bg-gradient-to-b from-primary/[0.035] to-background shadow-sm">
      <CardHeader className="flex flex-col gap-4 border-b bg-background/60 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Bot className="h-5 w-5" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>文本模型</CardTitle>
              <Badge variant={visibleViewModels.length ? "default" : "outline"}>{visibleViewModels.length} 个可用连接</Badge>
            </div>
          <CardDescription className={AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}>
              写作、大纲、审稿、改写等全部文字任务使用的模型。添加厂商并配置 API Key 后即可开始创作。
          </CardDescription>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button className={AUTO_DIRECTOR_MOBILE_CLASSES.fullWidthAction} onClick={() => setIsAddProviderOpen(true)}>
            <Plus className="h-4 w-4" /> 添加厂商
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4 pt-5 md:grid-cols-2">
        {visibleViewModels.map((item) => (
          <ProviderStatusCard
            key={item.provider.provider}
            item={item}
            onOpenConfig={onOpenConfig}
            onTest={onTest}
            onRefreshModels={onRefreshModels}
            onRefreshBalance={onRefreshBalance}
            onSetReasoning={onSetReasoning}
            onSetHiddenModels={onSetHiddenModels}
            onRemove={() => onRemoveProvider(item.provider)}
            isRemoving={removingProvider === item.provider.provider}
            isRefreshingModels={refreshingModelProvider === item.provider.provider}
          />
        ))}
        {!visibleViewModels.length ? (
          <div className="rounded-xl border border-dashed bg-background/70 p-6 text-center text-sm text-muted-foreground md:col-span-2">
            <PlugZap className="mx-auto mb-3 h-6 w-6 text-primary" />
            <div className="font-medium text-foreground">还没有可用的文本模型</div>
            <div className="mt-1">添加内置厂商或自定义服务并完成配置，就能开始文字创作。</div>
          </div>
        ) : null}
      </CardContent>
      <AddProviderDialog
        open={isAddProviderOpen}
        onOpenChange={setIsAddProviderOpen}
        addableBuiltIns={addableBuiltIns}
        onPickBuiltIn={onOpenConfig}
        onCreateCustom={onCreateCustomProvider}
      />
    </Card>
  );
}
