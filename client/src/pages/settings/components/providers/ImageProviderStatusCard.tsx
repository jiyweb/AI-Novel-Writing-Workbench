import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Image as ImageIcon,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { APIKeyStatus } from "@/api/settings";
import { saveAPIKeySetting, saveProviderImageModelList } from "@/api/settings";
import { queryKeys } from "@/api/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AUTO_DIRECTOR_MOBILE_CLASSES } from "@/mobile/autoDirector";

/**
 * 生图模型分区使用的厂商卡片：
 * 展示该厂商当前生效的生图模型，并提供高级维护（增删生图模型、恢复默认、删除厂商）。
 */
export default function ImageProviderStatusCard(props: {
  provider: APIKeyStatus;
  onOpenConfig: (provider: LLMProvider) => void;
  onRemoveProvider?: (provider: APIKeyStatus) => void;
}) {
  const { provider, onOpenConfig, onRemoveProvider } = props;
  const queryClient = useQueryClient();
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [newModel, setNewModel] = useState("");

  const imageModel = provider.currentImageModel || provider.defaultImageModel || "";
  const ready = Boolean(imageModel);

  const refreshSettings = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.apiKeys }),
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.imageSelection }),
    ]);
  };

  const saveModelListMutation = useMutation({
    mutationFn: (models: string[]) => saveProviderImageModelList(provider.provider, models),
    onSuccess: async (response) => {
      await refreshSettings();
      toast.success(response.message || "生图模型列表已保存。");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "生图模型列表保存失败。");
    },
  });

  const resetCurrentModelMutation = useMutation({
    mutationFn: () => saveAPIKeySetting(provider.provider, { imageModel: "" }),
    onSuccess: async (response) => {
      await refreshSettings();
      toast.success(response.message || "已清除当前生图模型，回退到默认模型。");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "操作失败，请稍后重试。");
    },
  });

  const removeModel = (model: string) => {
    saveModelListMutation.mutate(provider.imageModels.filter((item) => item !== model));
  };

  const addModel = () => {
    const trimmed = newModel.trim();
    if (!trimmed) {
      return;
    }
    if (provider.imageModels.includes(trimmed)) {
      toast.error("这个生图模型已在列表中。");
      return;
    }
    saveModelListMutation.mutate([...provider.imageModels, trimmed], {
      onSuccess: async (response) => {
        setNewModel("");
        await refreshSettings();
        toast.success(response.message || "生图模型已添加。");
      },
    });
  };

  const busy = saveModelListMutation.isPending || resetCurrentModelMutation.isPending;

  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border bg-card p-4 shadow-sm transition-all hover:shadow-md",
        ready ? "border-primary/25 hover:border-primary/45" : "border-border",
      )}
    >
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className={`font-semibold ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>{provider.name}</div>
            {provider.kind === "custom" ? <Badge variant="outline">自定义</Badge> : null}
          </div>
          <div className={`text-xs text-muted-foreground ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
            {ready ? "可用于角色、封面、漫画等图片生成。" : "已支持图片生成，还需要填写生图模型。"}
          </div>
        </div>
        <Badge
          variant={ready ? "default" : "outline"}
          className={ready ? "bg-emerald-600 text-white hover:bg-emerald-600" : ""}
        >
          {ready ? "可用" : "待配置"}
        </Badge>
      </div>

      <div className="mb-3 min-w-0 rounded-lg border bg-muted/25 p-3">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ImageIcon className="h-3.5 w-3.5" /> 当前生图模型
        </div>
        <div className={`mt-1 font-medium ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
          {imageModel || <span className="text-muted-foreground">未设置，点击下方按钮填写</span>}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={ready ? "outline" : "default"} onClick={() => onOpenConfig(provider.provider)}>
          {ready ? "更换生图模型" : "配置生图模型"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowMaintenance((current) => !current)}
        >
          {showMaintenance ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          高级维护
        </Button>
      </div>

      {showMaintenance ? (
        <div className="mt-3 space-y-3 rounded-lg bg-muted/30 p-3">
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">生图模型列表</div>
            {provider.imageModels.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {provider.imageModels.map((model) => (
                  <span
                    key={model}
                    className="inline-flex max-w-full items-center gap-1 rounded-full border bg-background py-1 pl-3 pr-1.5 text-xs"
                  >
                    <span className={`truncate ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`} title={model}>{model}</span>
                    <button
                      type="button"
                      className="rounded-full p-0.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      disabled={busy}
                      aria-label={`删除生图模型 ${model}`}
                      onClick={() => removeModel(model)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">这个厂商还没有可用的生图模型，添加后才能生成图片。</div>
            )}
            <div className="flex gap-2">
              <Input
                value={newModel}
                placeholder="输入生图模型名称"
                className="h-8 flex-1 text-xs"
                onChange={(event) => setNewModel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addModel();
                  }
                }}
              />
              <Button size="sm" variant="outline" disabled={busy || !newModel.trim()} onClick={addModel}>
                {saveModelListMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                添加
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !provider.currentImageModel}
              onClick={() => resetCurrentModelMutation.mutate()}
            >
              {resetCurrentModelMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              恢复默认生图模型
            </Button>
            {provider.kind === "custom" && onRemoveProvider ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={busy}
                onClick={() => onRemoveProvider(provider)}
              >
                <Trash2 className="h-4 w-4" /> 删除厂商
              </Button>
            ) : null}
            <span className="text-xs text-muted-foreground">
              删除列表中的模型后，对应选项会从生图模型选择中移除。
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
