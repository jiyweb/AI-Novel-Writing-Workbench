import { Image as ImageIcon } from "lucide-react";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { APIKeyStatus } from "@/api/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AUTO_DIRECTOR_MOBILE_CLASSES } from "@/mobile/autoDirector";

/**
 * 生图模型分区使用的精简厂商卡片：
 * 只表达「这个厂商当前用哪个生图模型」，文本连接、余额、思考等配置留在文本模型分区。
 */
export default function ImageProviderStatusCard(props: {
  provider: APIKeyStatus;
  onOpenConfig: (provider: LLMProvider) => void;
}) {
  const { provider, onOpenConfig } = props;
  const imageModel = provider.currentImageModel || provider.defaultImageModel || "";
  const ready = Boolean(imageModel);

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
          <ImageIcon className="h-3.5 w-3.5" /> 生图模型
        </div>
        <div className={`mt-1 font-medium ${AUTO_DIRECTOR_MOBILE_CLASSES.wrapText}`}>
          {imageModel || <span className="text-muted-foreground">未设置，点击下方按钮填写</span>}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={ready ? "outline" : "default"} onClick={() => onOpenConfig(provider.provider)}>
          {ready ? "更换生图模型" : "配置生图模型"}
        </Button>
      </div>
    </div>
  );
}
