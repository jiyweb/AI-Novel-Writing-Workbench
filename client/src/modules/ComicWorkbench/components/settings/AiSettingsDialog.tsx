/**
 * AI 模型状态弹窗：展示主程序「模型设置」的文本/生图模型就绪状态，
 * 并支持为本模块单独指定生图模型偏好（默认跟随主程序）。
 * 文本模型与生图能力的配置全部在主程序完成，这里只读状态 + 保存覆盖偏好。
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppDialogContent, Dialog } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { comicKeys, useMainAiStatus } from "../../hooks/useComicQuery";
import { getAiSettings, saveAiSettings } from "../../services/ai/aiConfigService";
import type { ComicImageModelChoice } from "../../types";

/** 「跟随主程序」选项的占位值（不会与 provider::model 冲突） */
const FOLLOW_MAIN = "__follow__";

export interface AiSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 保存成功后回调（例如继续触发生成） */
  onSaved?: () => void;
}

export function AiSettingsDialog(props: AiSettingsDialogProps) {
  const { open, onOpenChange, onSaved } = props;
  const queryClient = useQueryClient();
  const mainAiStatus = useMainAiStatus();
  const status = mainAiStatus.data ?? null;

  const [override, setOverride] = useState<ComicImageModelChoice | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  // 打开时读取当前生图模型覆盖偏好
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getAiSettings().then((value) => {
      if (!cancelled) {
        setOverride(value?.image ?? null);
        setLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveAiSettings(override ? { image: override } : null);
      await queryClient.invalidateQueries({ queryKey: comicKeys.aiSettings });
      toast.success("生图模型偏好已保存");
      onOpenChange(false);
      onSaved?.();
    } catch (error) {
      toast.error(`保存失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setSaving(false);
    }
  };

  const imageOptions = status?.imageOptions ?? [];
  const selectValue = override ? `${override.providerId ?? ""}::${override.model ?? ""}` : FOLLOW_MAIN;

  const handleOverrideChange = (value: string) => {
    if (value === FOLLOW_MAIN) {
      setOverride(null);
      return;
    }
    const separatorIndex = value.indexOf("::");
    if (separatorIndex < 0) return;
    setOverride({
      providerId: value.slice(0, separatorIndex),
      model: value.slice(separatorIndex + 2),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <AppDialogContent
        title="AI 模型"
        description="文本与生图模型统一使用主程序「模型设置」，此处可查看状态并指定本模块的生图偏好"
        className="max-w-xl"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button disabled={!loaded || saving} onClick={() => void handleSave()}>
              保存
            </Button>
          </>
        }
      >
        {!status ? (
          <div className="py-10 text-center text-sm text-muted-foreground">正在读取主程序模型状态…</div>
        ) : (
          <div className="flex flex-col gap-5">
            {/* 主程序模型状态卡 */}
            <section className="flex flex-col gap-3 rounded-lg bg-muted/40 p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">主程序模型状态</h3>
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" asChild>
                  <Link to="/settings">
                    <ExternalLink className="mr-1 h-3.5 w-3.5" />
                    打开模型设置
                  </Link>
                </Button>
              </div>
              <StatusRow
                label="文本模型"
                ready={status.llmReady}
                detail={
                  status.llmReady && status.llmProvider && status.llmModel
                    ? `${status.llmProvider} / ${status.llmModel}`
                    : "灵感扩写、角色提取、AI 分镜等文本任务将不可用"
                }
              />
              <StatusRow
                label="生图模型"
                ready={status.imageReady}
                detail={
                  status.imageReady
                    ? `${imageOptions.map((o) => o.label).join("、")} 可用`
                    : "分镜图、角色/场景参考图生成将不可用"
                }
              />
            </section>

            {/* 生图模型覆盖偏好 */}
            <section className="flex flex-col gap-2">
              <div>
                <h3 className="text-sm font-medium">本模块生图模型</h3>
                <p className="text-xs text-muted-foreground">
                  默认跟随主程序；也可以单独指定一个生图模型，仅影响漫画工作台的出图
                </p>
              </div>
              {imageOptions.length === 0 ? (
                <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                  主程序还没有可用的生图模型，请先到「模型设置」完成配置
                </p>
              ) : (
                <Select value={selectValue} onValueChange={handleOverrideChange}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="选择生图模型" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={FOLLOW_MAIN}>跟随主程序</SelectItem>
                    {imageOptions.map((option) => (
                      <SelectGroup key={option.provider}>
                        <SelectLabel>{option.label}</SelectLabel>
                        {option.models.map((model) => (
                          <SelectItem key={model} value={`${option.provider}::${model}`}>
                            {model}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </section>
          </div>
        )}
      </AppDialogContent>
    </Dialog>
  );
}

function StatusRow(props: { label: string; ready: boolean; detail: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{props.label}</span>
      <div className="flex items-center gap-2">
        <span className={cn("text-xs", props.ready ? "text-foreground" : "text-muted-foreground")}>
          {props.detail}
        </span>
        <Badge variant={props.ready ? "secondary" : "outline"} className="text-[10px]">
          {props.ready ? "已就绪" : "未配置"}
        </Badge>
      </div>
    </div>
  );
}
