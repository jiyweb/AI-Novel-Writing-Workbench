import { PlugZap, ServerCog } from "lucide-react";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { APIKeyStatus } from "@/api/settings";
import { AppDialogContent, Dialog } from "@/components/ui/dialog";

/**
 * 添加模型厂商弹窗（文本模型与生图模型两个分区共用）。
 * 只负责选择：内置厂商模板走配置弹窗，自定义厂商走创建流程。
 */
export default function AddProviderDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  addableBuiltIns: APIKeyStatus[];
  onPickBuiltIn: (provider: LLMProvider) => void;
  onCreateCustom: () => void;
}) {
  const { open, onOpenChange, addableBuiltIns, onPickBuiltIn, onCreateCustom } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <AppDialogContent
        title="添加模型厂商"
        description="选择一个内置厂商模板，或添加你自己的 OpenAI 兼容服务。"
        className="max-w-2xl"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {addableBuiltIns.map((provider) => {
            const imageOnly = provider.textCapable === false;
            return (
              <button
                key={provider.provider}
                type="button"
                className="rounded-xl border bg-background p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary hover:bg-primary/5 hover:shadow-sm"
                onClick={() => {
                  onOpenChange(false);
                  onPickBuiltIn(provider.provider);
                }}
              >
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  <PlugZap className="h-4 w-4 text-primary" /> {provider.name}
                  {imageOnly ? <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-normal text-primary">仅生图</span> : null}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {imageOnly
                    ? `推荐生图模型：${provider.defaultImageModel ?? "需手动填写"}`
                    : `推荐模型：${provider.defaultModel}`}
                </div>
              </button>
            );
          })}
          <button
            type="button"
            className="rounded-xl border border-dashed bg-background p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary hover:bg-primary/5 hover:shadow-sm"
            onClick={() => {
              onOpenChange(false);
              onCreateCustom();
            }}
          >
            <div className="flex items-center gap-2 font-medium"><ServerCog className="h-4 w-4 text-primary" /> 自定义厂商</div>
            <div className="mt-2 text-xs text-muted-foreground">连接任意 OpenAI 兼容服务。</div>
          </button>
        </div>
        {!addableBuiltIns.length ? (
          <div className="mt-3 text-sm text-muted-foreground">所有内置厂商都已添加；你仍可以添加自定义厂商。</div>
        ) : null}
      </AppDialogContent>
    </Dialog>
  );
}
