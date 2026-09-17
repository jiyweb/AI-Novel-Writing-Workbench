import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleAlert,
  Images,
  KeyRound,
  Loader2,
  PlugZap,
  ServerCog,
  Sparkles,
  Type,
} from "lucide-react";
import type {
  CompleteQuickSetupRequest,
  QuickSetupProviderOption,
  QuickSetupStatus,
} from "@ai-novel/shared/types/onboarding";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { completeQuickSetup } from "@/api/onboarding";
import {
  getAPIKeySettings,
  getImageSelectionSettings,
  previewCustomProviderModels,
  saveImageSelectionSettings,
} from "@/api/settings";
import { queryKeys } from "@/api/queryKeys";
import { AppDialogContent, Dialog } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ProviderConfigDialog, useProviderConfigFlow } from "@/pages/settings/components/providers";
import LLMSelector from "@/components/common/LLMSelector";
import { useLLMStore } from "@/store/llmStore";
import {
  shouldInitializeProviderSelection,
  shouldShowFirstNovelHandoff,
} from "./creationSetupState";

interface QuickSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: QuickSetupStatus | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  forceConfiguration?: boolean;
}

interface SetupForm {
  providerKind: "builtin" | "custom";
  provider: LLMProvider | "";
  customProviderName: string;
  apiKey: string;
  baseURL: string;
  model: string;
}

const EMPTY_FORM: SetupForm = {
  providerKind: "builtin",
  provider: "",
  customProviderName: "",
  apiKey: "",
  baseURL: "",
  model: "",
};

function providerDescription(provider: QuickSetupProviderOption): string {
  if (provider.id === "deepseek") return "推荐 DeepSeek V4 Flash，兼顾中文长篇质量与响应速度";
  if (provider.id === "ollama") return "使用本机模型，不要求 API Key";
  if (provider.id === "openai") return "适合通用规划、正文与结构化任务";
  return provider.configured ? "已有配置，可以直接检测并设为全局默认" : "配置后可用于整条小说生产链";
}

export default function QuickSetupDialog(props: QuickSetupDialogProps) {
  const queryClient = useQueryClient();
  const llmStore = useLLMStore();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [form, setForm] = useState<SetupForm>(EMPTY_FORM);
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [customModelsMessage, setCustomModelsMessage] = useState("");
  const [showAllProviderChoices, setShowAllProviderChoices] = useState(false);

  useEffect(() => {
    if (props.open && props.forceConfiguration) {
      setStep(1);
    }
  }, [props.forceConfiguration, props.open]);

  const selectedProvider = useMemo(
    () => props.status?.providers.find((provider) => provider.id === form.provider) ?? null,
    [form.provider, props.status?.providers],
  );
  const recommendedProvider = useMemo(
    () => props.status?.providers.find((provider) => provider.id === props.status?.selectedProvider)
      ?? props.status?.providers.find((provider) => provider.id === "deepseek")
      ?? props.status?.providers[0]
      ?? null,
    [props.status?.providers, props.status?.selectedProvider],
  );
  const preferredProvider = selectedProvider ?? recommendedProvider;
  const providerChoices: QuickSetupProviderOption[] = showAllProviderChoices
    ? props.status?.providers ?? []
    : preferredProvider ? [preferredProvider] : [];
  const modelOptions = form.providerKind === "custom"
    ? customModels
    : selectedProvider?.models ?? [];

  useEffect(() => {
    if (!shouldInitializeProviderSelection({
      open: props.open,
      statusAvailable: Boolean(props.status),
      providerKind: form.providerKind,
      provider: form.provider,
    })) {
      return;
    }
    if (!props.status) return;
    const preferred = props.status.providers.find(
      (provider) => provider.id === props.status?.selectedProvider,
    ) ?? props.status.providers.find((provider) => provider.id === "deepseek")
      ?? props.status.providers[0];
    if (!preferred) return;
    setForm({
      providerKind: preferred.kind,
      provider: preferred.id,
      customProviderName: preferred.kind === "custom" ? preferred.name : "",
      apiKey: "",
      baseURL: preferred.currentBaseURL || preferred.defaultBaseURL,
      model: preferred.currentModel || preferred.defaultModel,
    });
  }, [form.provider, form.providerKind, props.open, props.status]);

  const completeMutation = useMutation({
    mutationFn: (payload: CompleteQuickSetupRequest) => completeQuickSetup(payload),
    onSuccess: async (response) => {
      if (response.data) {
        llmStore.setSelection({
          provider: response.data.provider,
          model: response.data.model,
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.settings.quickSetup }),
        queryClient.invalidateQueries({ queryKey: queryKeys.settings.apiKeys }),
        queryClient.invalidateQueries({ queryKey: queryKeys.settings.llmSelection }),
        queryClient.invalidateQueries({ queryKey: queryKeys.settings.modelRoutes }),
        queryClient.invalidateQueries({ queryKey: queryKeys.settings.modelRouteConnectivity }),
        queryClient.invalidateQueries({ queryKey: queryKeys.onboarding.firstNovel }),
      ]);
    },
  });

  const previewMutation = useMutation({
    mutationFn: () => previewCustomProviderModels({
      key: form.apiKey.trim() || undefined,
      baseURL: form.baseURL.trim(),
    }),
    onSuccess: (response) => {
      const models = response.data?.models ?? [];
      setCustomModels(models);
      setCustomModelsMessage(models.length > 0 ? `找到 ${models.length} 个可用模型。` : "接口没有返回模型列表，可以手动填写。");
      setForm((current) => ({ ...current, model: current.model.trim() || models[0] || "" }));
    },
    onError: (error) => {
      setCustomModels([]);
      setCustomModelsMessage(error instanceof Error ? error.message : "获取模型列表失败，可以手动填写模型名称。");
    },
  });

  const chooseProvider = (provider: QuickSetupProviderOption) => {
    setForm({
      providerKind: provider.kind,
      provider: provider.id,
      customProviderName: provider.kind === "custom" ? provider.name : "",
      apiKey: "",
      baseURL: provider.currentBaseURL || provider.defaultBaseURL,
      model: provider.currentModel || provider.defaultModel,
    });
    setCustomModels([]);
    setCustomModelsMessage("");
  };

  const chooseCustom = (continueToConnection = false) => {
    setForm({
      providerKind: "custom",
      provider: "",
      customProviderName: "",
      apiKey: "",
      baseURL: "",
      model: "",
    });
    setCustomModels([]);
    setCustomModelsMessage("");
    setShowAllProviderChoices(false);
    if (continueToConnection) {
      setStep(2);
    }
  };

  const canContinueProvider = form.providerKind === "custom" || Boolean(form.provider);
  const requiresApiKey = form.providerKind === "builtin" && selectedProvider?.requiresApiKey !== false;
  const hasSavedKey = selectedProvider?.configured === true;
  const canSubmit = Boolean(
    form.model.trim()
    && form.baseURL.trim()
    && (form.providerKind === "builtin" ? form.provider : form.customProviderName.trim())
    && (!requiresApiKey || form.apiKey.trim() || hasSavedKey),
  );
  const showFirstNovelHandoff = shouldShowFirstNovelHandoff({
    configurationSucceeded: completeMutation.isSuccess,
    forceConfiguration: props.forceConfiguration === true,
  });

  const [configKind, setConfigKind] = useState<"text" | "image">("text");

  const apiKeysQuery = useQuery({
    queryKey: queryKeys.settings.apiKeys,
    queryFn: getAPIKeySettings,
    enabled: props.open && configKind === "image",
  });
  const providerConfigList = apiKeysQuery.data?.data ?? [];
  const providerConfigFlow = useProviderConfigFlow({
    providers: providerConfigList,
    onSaved: (message) => toast.success(message),
    onFailed: (message) => toast.error(message),
  });
  const imageProviderOptions = useMemo(() => {
    const imageCapable = providerConfigList.filter((item) => item.imageModels.length > 0);
    return [...imageCapable].sort(
      (a, b) => Number(b.isConfigured && b.isActive) - Number(a.isConfigured && a.isActive),
    );
  }, [providerConfigList]);
  const imageSelectionProviderOptions = useMemo(
    () => imageProviderOptions.filter((item) => item.isConfigured && item.isActive),
    [imageProviderOptions],
  );

  const imageSelectionQuery = useQuery({
    queryKey: queryKeys.settings.imageSelection,
    queryFn: getImageSelectionSettings,
    enabled: props.open && configKind === "image",
  });
  const [imageSelection, setImageSelection] = useState<{ provider: string; model: string }>({
    provider: "",
    model: "",
  });

  useEffect(() => {
    const saved = imageSelectionQuery.data?.data ?? null;
    setImageSelection(saved ? { provider: saved.provider, model: saved.model } : { provider: "", model: "" });
  }, [imageSelectionQuery.data]);

  const imageSelectionProviderConfig = providerConfigList.find(
    (item) => item.provider === imageSelection.provider,
  ) ?? null;
  const imageSelectionModelOptions = imageSelectionProviderConfig
    ? Array.from(new Set([
      ...imageSelectionProviderConfig.imageModels,
      imageSelectionProviderConfig.currentImageModel || "",
    ].filter(Boolean)))
    : [];

  const saveImageSelectionMutation = useMutation({
    mutationFn: () => saveImageSelectionSettings({
      provider: imageSelection.provider as LLMProvider,
      model: imageSelection.model,
    }),
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.imageSelection });
      toast.success(response.message || "默认生图模型已保存，生图任务会按这个模型执行。");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "默认生图模型保存失败。");
    },
  });

  const showReadyScreen = props.status?.readyForCreation && !props.forceConfiguration && !completeMutation.isSuccess;

  const submit = () => {
    setStep(3);
    completeMutation.mutate({
      providerKind: form.providerKind,
      ...(form.provider ? { provider: form.provider } : {}),
      ...(form.providerKind === "custom" ? { customProviderName: form.customProviderName.trim() } : {}),
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      baseURL: form.baseURL.trim(),
      model: form.model.trim(),
    });
  };

  const footer = props.loading || props.error || showReadyScreen
    ? null
    : configKind === "image"
      ? (
          <Button onClick={() => props.onOpenChange(false)}>
            <Check className="h-4 w-4" /> 完成
          </Button>
        )
      : step === 1
      ? (
          <Button onClick={() => setStep(2)} disabled={!canContinueProvider}>
            填写连接信息 <ArrowRight className="h-4 w-4" />
          </Button>
        )
      : step === 2
        ? (
            <>
              <Button variant="ghost" onClick={() => setStep(1)}><ArrowLeft className="h-4 w-4" /> 返回选择</Button>
              <Button onClick={submit} disabled={!canSubmit}>检测并完成配置 <PlugZap className="h-4 w-4" /></Button>
            </>
          )
        : completeMutation.isSuccess
          ? (
              showFirstNovelHandoff
                ? (
                    <>
                      <Button variant="outline" asChild><Link to="/help">查看创作向导</Link></Button>
                      <Button asChild><Link to="/novels/auto-director">用一句话开始第一本小说 <ArrowRight className="h-4 w-4" /></Link></Button>
                    </>
                  )
                : (
                    <>
                      <Button variant="outline" asChild><Link to="/settings">查看高级设置</Link></Button>
                      <Button onClick={() => props.onOpenChange(false)}>开始创作 <Sparkles className="h-4 w-4" /></Button>
                    </>
                  )
            )
          : completeMutation.isError
            ? (
                <Button variant="outline" onClick={() => setStep(2)}><ArrowLeft className="h-4 w-4" /> 修改配置</Button>
              )
            : null;

  return (
    <>
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <AppDialogContent
        className="max-w-3xl"
        title={props.forceConfiguration ? "模型设置" : "让 AI 创作环境先跑起来"}
        description="配置文本模型和生图模型；文本模型就绪后，系统会自动准备规划、正文、审校和修复所需的任务路由。"
        footer={footer}
        footerClassName="gap-2"
      >
        {props.loading ? (
          <div className="flex min-h-56 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 正在检查创作环境
          </div>
        ) : props.error ? (
          <div className="flex min-h-56 flex-col items-center justify-center gap-4 text-center">
            <CircleAlert className="h-9 w-9 text-amber-600" />
            <div>
              <div className="font-semibold">暂时无法读取模型配置</div>
              <div className="mt-1 text-sm text-muted-foreground">重新加载后，系统会继续判断是否可以开始创作。</div>
            </div>
            <Button variant="outline" onClick={props.onRetry}>重新加载</Button>
          </div>
        ) : showReadyScreen ? (
          <div className="flex min-h-56 flex-col items-center justify-center gap-4 text-center">
            <CheckCircle2 className="h-10 w-10 text-emerald-600" />
            <div>
              <div className="text-lg font-semibold">创作环境可以使用</div>
              <div className="mt-2 text-sm text-muted-foreground">
                {props.status?.selectedProvider} · {props.status?.selectedModel}，{props.status?.routeCoverage.total ?? 0} 类核心任务均已就绪。
              </div>
            </div>
            <Button onClick={() => props.onOpenChange(false)}>继续创作</Button>
          </div>
        ) : (
          <>
            <div className="mb-5 grid grid-cols-2 gap-2">
              {([
                { id: "text" as const, label: "文本模型", icon: Type },
                { id: "image" as const, label: "生图模型", icon: Images },
              ]).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={cn(
                    "flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition",
                    configKind === item.id
                      ? "border-primary bg-primary/5 text-primary"
                      : "text-muted-foreground hover:bg-muted/40",
                  )}
                  onClick={() => setConfigKind(item.id)}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </button>
              ))}
            </div>

            {configKind === "image" ? (
              <div className="space-y-4">
                <div className="rounded-lg bg-muted/30 p-4">
                  <div className="font-semibold">默认生图模型</div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    选择配置好的厂商和模型设为全局默认，角色形象、封面、漫画分镜等生图任务都会按它执行。
                  </p>
                  {imageSelectionQuery.isPending ? (
                    <div className="mt-3 flex items-center text-sm text-muted-foreground">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在读取默认生图模型
                    </div>
                  ) : imageSelectionProviderOptions.length === 0 ? (
                    <div className="mt-3 text-sm text-muted-foreground">
                      先在下方配置一个可用的生图厂商，再回到这里设为默认。
                    </div>
                  ) : (
                    <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                      <Select
                        value={imageSelection.provider}
                        onValueChange={(value) => {
                          const config = providerConfigList.find((item) => item.provider === value) ?? null;
                          const nextModel = config?.currentImageModel
                            || config?.defaultImageModel
                            || config?.imageModels[0]
                            || "";
                          setImageSelection({ provider: value, model: nextModel });
                        }}
                      >
                        <SelectTrigger><SelectValue placeholder="选择生图厂商" /></SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {imageSelectionProviderOptions.map((item) => (
                              <SelectItem key={item.provider} value={item.provider}>
                                {item.displayName?.trim() || item.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <Select
                        value={imageSelection.model}
                        onValueChange={(value) => setImageSelection((current) => ({ ...current, model: value }))}
                        disabled={!imageSelection.provider || imageSelectionModelOptions.length === 0}
                      >
                        <SelectTrigger><SelectValue placeholder="选择生图模型" /></SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {imageSelectionModelOptions.map((model) => (
                              <SelectItem key={model} value={model}>{model}</SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <Button
                        onClick={() => saveImageSelectionMutation.mutate()}
                        disabled={!imageSelection.provider || !imageSelection.model || saveImageSelectionMutation.isPending}
                      >
                        {saveImageSelectionMutation.isPending
                          ? <Loader2 className="h-4 w-4 animate-spin" />
                          : <Check className="h-4 w-4" />}
                        设为默认
                      </Button>
                    </div>
                  )}
                </div>
                <div>
                  <h3 className="font-semibold">生图模型</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    角色形象、漫画分镜、小说封面等图片生成使用的模型。选择一个厂商，填写 API Key 和生图模型后保存即可生效。
                  </p>
                </div>
                {apiKeysQuery.isPending ? (
                  <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 正在读取生图厂商
                  </div>
                ) : apiKeysQuery.isError ? (
                  <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
                    <CircleAlert className="h-8 w-8 text-amber-600" />
                    暂时无法读取生图厂商状态。
                    <Button variant="outline" size="sm" onClick={() => void apiKeysQuery.refetch()}>重新加载</Button>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {imageProviderOptions.map((item) => {
                      const ready = item.isConfigured && item.isActive;
                      const imageModel = item.currentImageModel || item.defaultImageModel || "";
                      return (
                        <button
                          key={item.provider}
                          type="button"
                          className={cn(
                            "rounded-xl border p-4 text-left transition hover:border-primary/50 hover:bg-primary/5",
                            ready ? "border-primary/25" : "border-dashed",
                          )}
                          onClick={() => providerConfigFlow.openBuiltInDialog(item.provider, "image")}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-semibold">{item.displayName?.trim() || item.name}</div>
                              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                                生图模型：{imageModel || "未设置"}
                              </div>
                            </div>
                            <Badge
                              variant={ready ? "default" : "outline"}
                              className={ready ? "bg-emerald-600 text-white hover:bg-emerald-600" : ""}
                            >
                              {ready ? "可用" : "待配置"}
                            </Badge>
                          </div>
                          <div className="mt-2 text-xs leading-5 text-muted-foreground">
                            {ready
                              ? "点击可以更换生图模型、API Key 和请求限制。"
                              : "点击填写 API Key，并选择这个厂商的生图模型。"}
                          </div>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className="rounded-xl border border-dashed p-4 text-left transition hover:border-primary/50 hover:bg-primary/5"
                      onClick={() => providerConfigFlow.openCreateCustomDialog("image")}
                    >
                      <div className="flex items-center gap-2 font-semibold"><ServerCog className="h-4 w-4" /> 添加第三方厂商</div>
                      <div className="mt-2 text-xs leading-5 text-muted-foreground">
                        连接任意 OpenAI 兼容的生图服务，例如中转接口、本地网关或自建服务。
                      </div>
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="mb-6 grid grid-cols-3 gap-2">
                  {[
                    { index: 1, label: "选择厂商" },
                    { index: 2, label: "连接模型" },
                    { index: 3, label: "检测完成" },
                  ].map((item) => (
                    <div key={item.index} className={cn(
                      "rounded-lg border px-3 py-2 text-xs",
                      step === item.index ? "border-primary bg-primary/5 text-primary" : step > item.index ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "text-muted-foreground",
                    )}>
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full border text-[11px]">
                          {step > item.index ? <Check className="h-3 w-3" /> : item.index}
                        </span>
                        {item.label}
                      </div>
                    </div>
                  ))}
                </div>

        {step === 1 ? (
          <div className="space-y-4">
            <div>
              <h3 className="font-semibold">{showAllProviderChoices ? "选择一个内置模型厂商" : "从推荐方案开始"}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {showAllProviderChoices
                  ? "选择一个厂商后，再填写连接信息。"
                  : "先配置一个文本模型即可开始创作；需要时再选择其他厂商。"}
              </p>
            </div>
            <div className="rounded-lg bg-muted/30 p-4">
              <div className="font-semibold">默认文本模型</div>
              <p className="mt-1 text-sm text-muted-foreground">
                从已配置好的模型里选择全局默认，写作、规划、审校等全部文字任务都按它执行。
              </p>
              <div className="mt-3">
                <LLMSelector compact showBadge={false} />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {providerChoices.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  className={cn(
                    "rounded-xl border p-4 text-left transition hover:border-primary/50 hover:bg-primary/5",
                    form.provider === provider.id && "border-primary bg-primary/5 ring-1 ring-primary/20",
                  )}
                  onClick={() => chooseProvider(provider)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">{provider.name}</div>
                      <div className="mt-1 text-xs leading-5 text-muted-foreground">{providerDescription(provider)}</div>
                    </div>
                    {form.provider === provider.id
                      ? <Badge>已选择</Badge>
                      : provider.configured ? <Badge variant="outline">已有配置</Badge> : null}
                  </div>
                <div className="mt-3 text-xs text-muted-foreground">推荐模型：{provider.currentModel || provider.defaultModel}</div>
              </button>
              ))}
              {!showAllProviderChoices ? (
                <button
                  type="button"
                  className="rounded-xl border border-dashed p-4 text-left transition hover:border-primary/50 hover:bg-primary/5"
                  onClick={() => setShowAllProviderChoices(true)}
                >
                  <div className="flex items-center gap-2 font-semibold"><PlugZap className="h-4 w-4" /> 查看全部内置厂商</div>
                  <div className="mt-2 text-xs leading-5 text-muted-foreground">选择你已有账号的厂商，再继续填写连接信息。</div>
                </button>
              ) : null}
              <button
                type="button"
                className={cn(
                  "rounded-xl border border-dashed p-4 text-left transition hover:border-primary/50 hover:bg-primary/5",
                  form.providerKind === "custom" && !form.provider && "border-primary bg-primary/5 ring-1 ring-primary/20",
                )}
                onClick={() => chooseCustom(true)}
              >
                <div className="flex items-center gap-2 font-semibold"><ServerCog className="h-4 w-4" /> 添加第三方厂商 <ArrowRight className="h-4 w-4" /></div>
                <div className="mt-2 text-xs leading-5 text-muted-foreground">新增一份独立的厂商配置，适合中转服务、本地网关或 OpenAI 兼容接口。</div>
              </button>
            </div>
            {showAllProviderChoices ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowAllProviderChoices(false)}>
                <ArrowLeft className="h-4 w-4" /> 返回推荐方案
              </Button>
            ) : null}
          </div>
        ) : step === 2 ? (
          <div className="space-y-5">
            <div>
              <h3 className="font-semibold">{form.providerKind === "custom" ? "添加第三方厂商" : `连接 ${selectedProvider?.name ?? "模型厂商"}`}</h3>
              <p className="mt-1 text-sm text-muted-foreground">API Key 只会保存到本机或服务端密钥存储，不会显示在完成结果中。</p>
              {form.providerKind === "custom" ? (
                <p className="mt-1 text-xs text-muted-foreground">厂商名称、API 地址和模型将保存为独立配置，不会覆盖已有内置厂商。</p>
              ) : null}
            </div>
            {form.providerKind === "custom" ? (
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">厂商名称</span>
                <Input value={form.customProviderName} placeholder="例如：我的模型网关" onChange={(event) => setForm((current) => ({ ...current, customProviderName: event.target.value }))} />
              </label>
            ) : null}
            <label className="block space-y-1.5">
              <span className="flex items-center gap-2 text-sm font-medium"><KeyRound className="h-4 w-4" /> API Key {requiresApiKey ? "" : "（可选）"}</span>
              <Input
                type="password"
                autoComplete="off"
                value={form.apiKey}
                placeholder={hasSavedKey ? "留空则继续使用已保存的 Key" : requiresApiKey ? "输入 API Key" : "本地接口可以留空"}
                onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">API 地址</span>
              <Input value={form.baseURL} placeholder="https://api.example.com/v1" onChange={(event) => setForm((current) => ({ ...current, baseURL: event.target.value }))} />
            </label>
            {form.providerKind === "custom" ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" size="sm" onClick={() => previewMutation.mutate()} disabled={!form.baseURL.trim() || previewMutation.isPending}>
                  {previewMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ServerCog className="h-4 w-4" />}
                  获取模型列表
                </Button>
                {customModelsMessage ? <span className="text-xs text-muted-foreground">{customModelsMessage}</span> : null}
              </div>
            ) : null}
            {modelOptions.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {modelOptions.slice(0, 8).map((model) => (
                  <button
                    key={model}
                    type="button"
                    className={cn("rounded-full border px-3 py-1.5 text-xs", form.model === model && "border-primary bg-primary/10 text-primary")}
                    onClick={() => setForm((current) => ({ ...current, model }))}
                  >
                    {model}
                  </button>
                ))}
              </div>
            ) : null}
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">文本模型</span>
              <Input value={form.model} placeholder="选择上方模型，或直接填写模型名称" onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))} />
            </label>
            <div className="rounded-lg border bg-muted/20 p-3 text-xs leading-5 text-muted-foreground">
              完成后，这个模型会作为规划、正文、审核、修复、重规划和摘要等核心任务的初始默认值。
            </div>
          </div>
        ) : (
          <div className="flex min-h-64 flex-col items-center justify-center gap-4 text-center">
            {completeMutation.isPending ? (
              <>
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
                  <Loader2 className="h-7 w-7 animate-spin text-primary" />
                </div>
                <div>
                  <div className="text-lg font-semibold">正在检测普通文本与结构化输出</div>
                  <div className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">检测通过后，系统会自动准备全部核心创作任务，不需要逐项配置路由。</div>
                </div>
              </>
            ) : completeMutation.isSuccess ? (
              <>
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
                  <CheckCircle2 className="h-8 w-8 text-emerald-700" />
                </div>
                <div>
                  <div className="text-lg font-semibold">创作环境配置完成</div>
                  <div className="mt-2 text-sm text-muted-foreground">{completeMutation.data.data?.model} 已可用于整条小说生产链。</div>
                </div>
                {showFirstNovelHandoff ? (
                  <div className="w-full max-w-xl rounded-2xl border border-primary/15 bg-primary/[0.035] p-5 text-left shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-primary">开始第一本小说</div>
                      <Link to="/settings" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">配置更多模型</Link>
                    </div>
                    <h3 className="mt-2 text-xl font-semibold tracking-tight">从一句想写的故事开始</h3>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">告诉 AI 你想写什么，它会先给出可选方向；选定后继续准备故事、世界、角色和首章。</p>
                    <div className="mt-4 grid gap-2 sm:grid-cols-3">
                      {["说想法", "选择方向", "阅读首章"].map((label, index) => (
                        <div key={label} className="rounded-xl border bg-background/80 px-3 py-2.5 text-sm font-medium">
                          <span className="mr-2 text-primary">{index + 1}</span>{label}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-100">
                  <CircleAlert className="h-8 w-8 text-amber-700" />
                </div>
                <div>
                  <div className="text-lg font-semibold">模型检测没有通过</div>
                  <div className="mt-2 max-w-lg text-sm leading-6 text-destructive">
                    {completeMutation.error instanceof Error ? completeMutation.error.message : "请检查 API Key、地址和模型名称后重试。"}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
              </>
            )}
          </>
        )}
      </AppDialogContent>
    </Dialog>

    <ProviderConfigDialog
      open={providerConfigFlow.isDialogOpen}
      mode={providerConfigFlow.dialogMode}
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
    </>
  );
}
