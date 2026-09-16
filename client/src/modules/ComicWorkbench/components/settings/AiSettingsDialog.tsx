/**
 * AI 接口设置弹窗：文本模型 / 生图模型 分区配置
 * API Key 仅保存到本机 IndexedDB。
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppDialogContent, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { comicKeys } from "../../hooks/useComicQuery";
import {
  buildDefaultAiSettings,
  getProviderById,
  getAiSettings,
  importSelectionFromApp,
  saveAiSettings,
} from "../../services/ai/aiConfigService";
import { aiProvidersConfig } from "../../services/configService";
import type { AiConnectionSettings } from "../../types";

export interface AiSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 保存成功后回调（例如继续触发生成） */
  onSaved?: () => void;
}

export function AiSettingsDialog(props: AiSettingsDialogProps) {
  const { open, onOpenChange, onSaved } = props;
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AiConnectionSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const current = await getAiSettings();
      if (!cancelled) {
        setDraft(current ?? buildDefaultAiSettings());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const updateLlm = (patch: Partial<AiConnectionSettings["llm"]>) =>
    setDraft((prev) => (prev ? { ...prev, llm: { ...prev.llm, ...patch } } : prev));
  const updateImage = (patch: Partial<AiConnectionSettings["image"]>) =>
    setDraft((prev) => (prev ? { ...prev, image: { ...prev.image, ...patch } } : prev));

  const [importing, setImporting] = useState(false);

  /** 从主程序导入模型选择：回填服务商/模型/baseUrl，API Key 留空由用户补填 */
  const handleImport = async (kind: "llm" | "image") => {
    setImporting(true);
    try {
      const result = await importSelectionFromApp();
      const patch = kind === "llm" ? result.llm : result.image;
      const prefix = kind === "llm" ? "文本模型" : "生图模型";
      const sectionNotes = result.notes.filter((note) => note.startsWith(prefix));
      if (Object.keys(patch).length > 0) {
        if (kind === "llm") updateLlm(patch);
        else updateImage(patch);
        toast.success(sectionNotes.join("；") || "已导入主程序模型选择，请补填 API Key");
      } else {
        toast.info(sectionNotes.join("；") || "主程序暂无可导入的模型配置");
      }
    } catch (error) {
      toast.error(`导入失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setImporting(false);
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await saveAiSettings(draft);
      await queryClient.invalidateQueries({ queryKey: comicKeys.aiSettings });
      toast.success("AI 接口配置已保存");
      onOpenChange(false);
      onSaved?.();
    } catch (error) {
      toast.error(`保存失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <AppDialogContent
        title="AI 接口设置"
        description="填入你自己的 API Key，密钥只保存在本机浏览器中"
        className="max-w-2xl"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button disabled={!draft || saving} onClick={() => void handleSave()}>
              保存
            </Button>
          </>
        }
      >
        {!draft ? (
          <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>
        ) : (
          <div className="flex flex-col gap-6">
            <ModelSection
              title="文本模型"
              description="用于灵感扩写、角色场景提取等文本理解任务"
              providers={aiProvidersConfig.providers.filter((p) => p.llm)}
              value={draft.llm}
              onChange={updateLlm}
              onImport={() => void handleImport("llm")}
              importing={importing}
            />
            <ModelSection
              title="生图模型"
              description="用于分镜图、角色/场景参考图生成"
              providers={aiProvidersConfig.providers.filter((p) => p.image)}
              value={draft.image}
              onChange={updateImage}
              onImport={() => void handleImport("image")}
              importing={importing}
            />
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              部分服务商不允许浏览器直连（跨域限制）。若保存后调用一直失败，
              可改用支持跨域的网关地址（如本地 one-api/new-api），把 baseUrl 指向网关即可。
            </p>
          </div>
        )}
      </AppDialogContent>
    </Dialog>
  );
}

function ModelSection(props: {
  title: string;
  description: string;
  providers: Array<{ id: string; name: string; notes?: string }>;
  value: { providerId: string; baseUrl: string; apiKey: string; model: string };
  onChange: (patch: Partial<{ providerId: string; baseUrl: string; apiKey: string; model: string }>) => void;
  /** 从主程序导入该区的服务商/模型/baseUrl（Key 留空待补填） */
  onImport?: () => void;
  importing?: boolean;
}) {
  const provider = getProviderById(props.value.providerId);
  const models = provider?.llm?.models ?? provider?.image?.models ?? [];
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{props.title}</h3>
          <p className="text-xs text-muted-foreground">{props.description}</p>
        </div>
        {props.onImport ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={props.importing}
            onClick={props.onImport}
          >
            <Download className="mr-1 h-3.5 w-3.5" />
            从主程序导入
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          服务商
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            value={props.value.providerId}
            onChange={(event) => {
              const next = getProviderById(event.target.value);
              const preset = next?.llm ?? next?.image;
              props.onChange({
                providerId: event.target.value,
                baseUrl: preset?.defaultBaseUrl ?? "",
                model: preset?.models[0] ?? "",
              });
            }}
          >
            {props.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          模型
          <Input
            list={`${props.title}-models`}
            value={props.value.model}
            placeholder="填模型 ID 或接入点 ID"
            onChange={(event) => props.onChange({ model: event.target.value })}
          />
          <datalist id={`${props.title}-models`}>
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
          接口地址 baseUrl
          <Input
            value={props.value.baseUrl}
            placeholder="https://…"
            onChange={(event) => props.onChange({ baseUrl: event.target.value.trim() })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
          API Key
          <Input
            type="password"
            className={cn("h-9")}
            value={props.value.apiKey}
            placeholder={props.value.apiKey ? "sk-…" : "请补填 API Key（sk-…）"}
            onChange={(event) => props.onChange({ apiKey: event.target.value.trim() })}
          />
        </label>
      </div>
      {provider?.notes ? (
        <p className="text-xs text-muted-foreground">说明：{provider.notes}</p>
      ) : null}
    </section>
  );
}
