/**
 * 步骤七：生成
 *
 * 草稿/高清两档批量生成分镜画面（并发与重试由服务层控制）：
 * - 断点续传：页面打开时自动恢复上次中断的任务，随时可取消/继续；
 * - 失败自动重试（指数退避，上限 3 次），仍失败的任务可手动重跑；
 * - 单镜可单独生成/重绘/换档。
 * 成品图 Blob 存 IndexedDB，跨域兜底时记录 remoteUrl 直接展示。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { Ban, Loader2, Play, RefreshCw, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  comicKeys,
  useAiSettings,
  useComicChapter,
  useComicChapters,
  useComicCharacters,
  useComicPanels,
  useComicProject,
  useComicScenes,
  useMainAiStatus,
  useWorkbenchSettings,
} from "../../hooks/useComicQuery";
import { useComicWorkbenchStore } from "../../stores/workbenchStore";
import { useReportStepReady } from "../../components/common/StepNavFooter";
import { getImageBlob, getImageRecord, saveChapter } from "../../db/comicDb";
import { getFormById } from "../../services/configService";
import { saveAiSettings } from "../../services/ai/aiConfigService";
import { describeAiError } from "../../services/ai/llmClient";
import {
  ensureChapterTasks,
  recoverInterruptedTasks,
  regeneratePanelImage,
  runChapterQueue,
} from "../../services/generationQueue";
import { computePanelStaleMap } from "../../services/syncService";
import { StaleBadge } from "../common/StaleBadge";
import { StaleBanner } from "../common/StaleBanner";
import type { ComicImageModelChoice, ComicPanel, GenerationMode, GenerationStatus } from "../../types";

/** 章节未就绪时的空待更新集合 */
const EMPTY_IDS: ReadonlySet<string> = new Set();

export function GenerateStepPanel(props: { projectId: string; onReadyChange?: (ready: boolean, hint?: string) => void }) {
  const { projectId } = props;
  const queryClient = useQueryClient();
  const chapterId = useComicWorkbenchStore((state) => state.chapterId);
  const openChapter = useComicWorkbenchStore((state) => state.openChapter);

  const chaptersQuery = useComicChapters(projectId);
  const chapters = useMemo(
    () => [...(chaptersQuery.data ?? [])].sort((a, b) => a.index - b.index),
    [chaptersQuery.data],
  );
  const projectQuery = useComicProject(projectId);
  const project = projectQuery.data ?? null;
  const chapterQuery = useComicChapter(chapterId);
  const chapter = chapterQuery.data ?? null;
  const panelsQuery = useComicPanels(chapterId);
  const panels = useMemo(
    () => [...(panelsQuery.data ?? [])].sort((a, b) => a.order - b.order),
    [panelsQuery.data],
  );

  const hasImage = panels.some((panel) => panel.generation.status === "success");
  useReportStepReady(
    props.onReadyChange,
    hasImage,
    panels.length === 0
      ? chapterId
        ? "该章节还没有分镜；回到「智能分镜」先生成分镜"
        : "先选择一个章节"
      : hasImage
        ? undefined
        : "点击「开始生成」为分镜出图后，可进入下一步导出",
  );
  const charactersQuery = useComicCharacters(projectId);
  const characters = charactersQuery.data ?? [];
  const scenesQuery = useComicScenes(projectId);
  const scenes = scenesQuery.data ?? [];
  const settingsQuery = useWorkbenchSettings();
  const aiSettings = useAiSettings();
  const mainAiStatus = useMainAiStatus();
  const imageReady = mainAiStatus.data?.imageReady ?? false;

  const [mode, setMode] = useState<GenerationMode>("draft");
  const [progress, setProgress] = useState<{ done: number; total: number; succeeded: number; failed: number } | null>(null);
  const [redrawingId, setRedrawingId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const customFormula = settingsQuery.data?.customPromptFormula ?? null;

  const selectedCount = {
    success: panels.filter((panel) => panel.generation.status === "success").length,
    failed: panels.filter((panel) => panel.generation.status === "failed").length,
    running: panels.filter((panel) => panel.generation.status === "running").length,
  };

  // 版本链待更新状态（横幅计数 + 列表逐镜徽标）
  const stale = useMemo(
    () => (chapter ? computePanelStaleMap(panels, chapter) : null),
    [panels, chapter],
  );

  // 分镜卡片缩略图随形态画幅等比展示
  const form = project ? getFormById(project.formId) : undefined;
  const formAspectRatio = (form?.aspectRatio ?? "3:4").replace(":", " / ");

  // 断点续传：进入章节时恢复上次中断的任务
  useEffect(() => {
    if (!chapterId) return;
    let active = true;
    void recoverInterruptedTasks(chapterId).then((count) => {
      if (!active || count === 0) return;
      toast.info(`已恢复 ${count} 个上次中断的任务，点击「继续生成」接着跑`);
      void queryClient.invalidateQueries({ queryKey: comicKeys.panels(chapterId) });
    });
    return () => {
      active = false;
    };
  }, [chapterId, queryClient]);

  // 组件卸载时取消进行中的任务（服务层会把 running 任务还原为 pending）
  useEffect(() => () => abortRef.current?.abort(), []);

  const invalidate = async () => {
    if (chapterId) {
      await queryClient.invalidateQueries({ queryKey: comicKeys.panels(chapterId) });
      await queryClient.invalidateQueries({ queryKey: comicKeys.chapter(chapterId) });
    }
  };

  /**
   * 运行生成队列。onlyStale 为 true 时只为待更新画面建任务
   * （成品仍在但基于旧描述词/旧画风），其余情况为全部未完成分镜补任务。
   */
  const runMutation = useMutation({
    mutationFn: async (onlyStale: boolean) => {
      if (!chapter || !project) throw new Error("请先选择章节");
      if (!imageReady) throw new Error("主程序尚未配置可用的生图模型，请先在主程序「模型设置」中配置");
      const targets = onlyStale
        ? panels.filter((panel) => stale?.imageIds.has(panel.id))
        : panels;
      if (targets.length === 0) throw new Error("没有需要生成的画面");
      await ensureChapterTasks(chapter, targets, mode, { includeUpToDate: onlyStale });
      const controller = new AbortController();
      abortRef.current = controller;
      setProgress({ done: 0, total: targets.length, succeeded: 0, failed: 0 });
      return runChapterQueue({
        chapter,
        panels,
        project,
        characters,
        scenes,
        customFormula,
        imageChoice: aiSettings.data?.image ?? null,
        signal: controller.signal,
        onProgress: setProgress,
      });
    },
    onSuccess: async (result) => {
      if (result.cancelled) {
        toast.info(`已取消：本次成功 ${result.succeeded} 张，未完成任务已保留，可随时继续`);
      } else {
        toast.success(
          `生成完成：成功 ${result.succeeded} 张${result.failed > 0 ? `，失败 ${result.failed} 张（可单独重试）` : ""}`,
        );
      }
      await invalidate();
    },
    onError: async (error: Error) => {
      toast.error(`生成中断：${describeAiError(error)}`);
      await invalidate();
    },
    onSettled: () => {
      abortRef.current = null;
      setProgress(null);
    },
  });

  const redrawMutation = useMutation({
    mutationFn: async (params: { panel: ComicPanel; targetMode: GenerationMode }) => {
      if (!chapter || !project) throw new Error("请先选择章节");
      if (!imageReady) throw new Error("主程序尚未配置可用的生图模型，请先在主程序「模型设置」中配置");
      const controller = new AbortController();
      abortRef.current = controller;
      setRedrawingId(params.panel.id);
      return regeneratePanelImage({
        chapter,
        panel: params.panel,
        project,
        characters,
        scenes,
        customFormula,
        imageChoice: aiSettings.data?.image ?? null,
        mode: params.targetMode,
        signal: controller.signal,
      });
    },
    onSuccess: async () => {
      toast.success("该镜已重新生成");
      await invalidate();
    },
    onError: (error: Error) => toast.error(`生成失败：${describeAiError(error)}`),
    onSettled: () => {
      abortRef.current = null;
      setRedrawingId(null);
    },
  });

  // 生图模型快捷切换：厂商/模型全部来自主程序「模型设置」，这里只保存覆盖偏好
  const imageSwitchMutation = useMutation({
    mutationFn: async (image: ComicImageModelChoice) => {
      await saveAiSettings({ image });
    },
    onSuccess: async () => {
      toast.success("生图模型已切换");
      await queryClient.invalidateQueries({ queryKey: comicKeys.aiSettings });
    },
    onError: (error: Error) => toast.error(`生图模型切换失败：${error.message}`),
  });

  const handleImageSwitch = (value: string) => {
    const separatorIndex = value.indexOf("::");
    if (separatorIndex < 0) return;
    imageSwitchMutation.mutate({
      providerId: value.slice(0, separatorIndex),
      model: value.slice(separatorIndex + 2),
    });
  };

  if (chapters.length === 0) {
    return <EmptyHint text="还没有章节。先回到「内容导入」导入正文，并完成分镜与描述词。" />;
  }
  if (!chapter || !project) {
    return <EmptyHint text="请选择上方一个章节生成分镜画面。" />;
  }
  if (panels.length === 0) {
    return <EmptyHint text="本章还没有分镜。先回到「智能分镜」生成分镜，再来生成画面。" />;
  }

  const busy = runMutation.isPending || redrawMutation.isPending;
  const hasResumable = panels.some(
    (panel) => panel.generation.status === "pending" || panel.generation.status === "failed",
  );

  const cancel = () => {
    abortRef.current?.abort();
  };

  // 台词绘制开关：推进表现层版本，已有画面自动标记待更新；重绘时描述词按新开关重组，画面重绘后带台词文字
  const toggleLetteringEmbed = async (checked: boolean) => {
    if (!chapter) return;
    await saveChapter({
      ...chapter,
      letteringEmbed: checked,
      versions: { ...chapter.versions, presentation: chapter.versions.presentation + 1 },
      updatedAt: new Date().toISOString(),
    });
    await invalidate();
    toast.success(
      checked
        ? "已开启台词绘制：已有画面已标记待更新，重新生成后台词会直接绘入图中"
        : "已关闭台词绘制：已有画面已标记待更新，重新生成后仅保留气泡位置提示",
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 章节选择 */}
      <div className="flex flex-wrap items-center gap-1.5 pb-3">
        {chapters.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              openChapter(item.id);
            }}
            className={cn(
              "rounded-full px-3 py-1 text-xs transition-colors",
              item.id === chapterId
                ? "bg-primary text-primary-foreground"
                : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {item.index}. {item.title}
          </button>
        ))}
      </div>

      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-3 border-b pb-3">
        <Select value={mode} onValueChange={(value) => setMode(value as GenerationMode)}>
          <SelectTrigger className="h-9 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="draft">草稿模式（快速预览）</SelectItem>
            <SelectItem value="hd">高清模式（正式成图）</SelectItem>
          </SelectContent>
        </Select>
        {(() => {
          // 选项来自主程序「模型设置」；本模块的覆盖选择仅在命中主程序厂商时生效
          const options = mainAiStatus.data?.imageOptions ?? [];
          if (options.length === 0) return null;
          const override = aiSettings.data?.image ?? null;
          const current =
            (override?.providerId ? options.find((o) => o.provider === override.providerId) : undefined) ??
            options[0];
          const effectiveModel =
            (override && current.provider === override.providerId ? override.model : undefined) ??
            current.currentImageModel ??
            current.defaultImageModel ??
            current.models[0] ??
            "";
          return (
            <Select
              value={`${current.provider}::${effectiveModel}`}
              onValueChange={handleImageSwitch}
              disabled={busy || imageSwitchMutation.isPending}
            >
              <SelectTrigger className="h-9 w-56" title="切换生图模型">
                <SelectValue placeholder="生图模型" />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
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
          );
        })()}
        {form?.letteringMode !== "none" ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            台词绘制到画面
            <Switch
              checked={chapter.letteringEmbed ?? true}
              disabled={busy}
              onCheckedChange={(checked) => void toggleLetteringEmbed(checked)}
            />
          </label>
        ) : null}
        {busy ? (
          <Button size="sm" variant="outline" onClick={cancel}>
            <Ban className="mr-1.5 h-4 w-4" />
            取消生成
          </Button>
        ) : (
          <Button size="sm" disabled={!imageReady} onClick={() => runMutation.mutate(false)}>
            {hasResumable ? <RefreshCw className="mr-1.5 h-4 w-4" /> : <Play className="mr-1.5 h-4 w-4" />}
            {hasResumable ? "继续生成" : "开始生成"}
          </Button>
        )}
        {!imageReady ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Settings2 className="h-3.5 w-3.5" />
            请先在主程序「模型设置」中配置生图模型
          </span>
        ) : null}
        {progress ? (
          <span className="text-xs text-muted-foreground">
            进度 {progress.done}/{progress.total} · 成功 {progress.succeeded}
            {progress.failed > 0 ? ` · 失败 ${progress.failed}` : ""}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            共 {panels.length} 镜 · 已出图 {selectedCount.success}
            {selectedCount.failed > 0 ? ` · 失败 ${selectedCount.failed}` : ""}
          </span>
        )}
      </div>

      {/* 待更新横幅：描述词/画风变化后提示重出画面 */}
      {stale && stale.summary.image > 0 ? (
        <div className="mt-3">
          <StaleBanner
            text={`描述词或画风有更新，${stale.summary.image} 张画面与当前设定不一致`}
            actionLabel="重新生成待更新画面"
            busy={busy}
            disabled={!imageReady}
            onAction={() => runMutation.mutate(true)}
          />
        </div>
      ) : null}

      {/* 分镜生成列表（卡片网格，按行虚拟滚动） */}
      <section className="mt-4 flex min-h-0 flex-1 flex-col rounded-xl bg-muted/20">
        <div className="px-3 pb-1 pt-2 text-xs text-muted-foreground">
          分镜画面（多列卡片布局；单镜可重新生成或切换草稿/高清档位）
        </div>
        <GeneratePanelList
          panels={panels}
          mode={mode}
          busy={busy}
          redrawingId={redrawingId}
          staleIds={stale?.imageIds ?? EMPTY_IDS}
          aspectRatio={formAspectRatio}
          onRedraw={(panel, targetMode) => redrawMutation.mutate({ panel, targetMode })}
        />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 分镜生成列表（卡片网格：ResizeObserver 实测宽度定列数，按行虚拟滚动）
// ---------------------------------------------------------------------------

/** 卡片目标宽度（px），用于估算列数 */
const CARD_TARGET_WIDTH = 232;
/** 最少/最多列数 */
const MIN_COLS = 2;
const MAX_COLS = 6;

function GeneratePanelList(props: {
  panels: ComicPanel[];
  mode: GenerationMode;
  busy: boolean;
  redrawingId: string | null;
  staleIds: ReadonlySet<string>;
  aspectRatio: string;
  onRedraw: (panel: ComicPanel, mode: GenerationMode) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // 实测容器宽度 → 计算列数（虚拟滚动的行是整行卡片）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setContainerWidth((prev) => (Math.abs(prev - width) < 1 ? prev : width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const cols = Math.max(
    MIN_COLS,
    Math.min(MAX_COLS, Math.floor((containerWidth - 8) / CARD_TARGET_WIDTH) || MIN_COLS),
  );
  const rowCount = Math.ceil(props.panels.length / cols);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 320,
    overscan: 2,
    getItemKey: (index) => props.panels[index * cols]?.id ?? index,
  });

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.index}
            data-index={row.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${row.start}px)`,
            }}
            className="pb-3"
          >
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            >
              {Array.from({ length: cols }, (_, col) => {
                const panelIndex = row.index * cols + col;
                const panel = props.panels[panelIndex];
                if (!panel) return null;
                return (
                  <PanelCard
                    key={panel.id}
                    panel={panel}
                    index={panelIndex}
                    mode={props.mode}
                    busy={props.busy}
                    redrawing={props.redrawingId === panel.id}
                    stale={props.staleIds.has(panel.id)}
                    aspectRatio={props.aspectRatio}
                    onRedraw={props.onRedraw}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PanelCard(props: {
  panel: ComicPanel;
  index: number;
  mode: GenerationMode;
  busy: boolean;
  redrawing: boolean;
  stale: boolean;
  aspectRatio: string;
  onRedraw: (panel: ComicPanel, mode: GenerationMode) => void;
}) {
  const { panel, mode } = props;
  const generation = panel.generation;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-background/60 p-2">
      <div
        className="relative overflow-hidden rounded-md bg-muted/40"
        style={{ aspectRatio: props.aspectRatio }}
      >
        <PanelThumb imageId={generation.imageId} className="absolute inset-0 h-full w-full" />
        <span className="absolute left-1.5 top-1.5 rounded bg-background/85 px-1.5 py-0.5 text-[10px] font-semibold">
          {props.index + 1}
        </span>
        {props.stale ? (
          <div className="absolute right-1.5 top-1.5">
            <StaleBadge />
          </div>
        ) : null}
        {props.redrawing ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5">
        <GenerationBadge status={generation.status} mode={generation.mode} attempts={generation.attempts} />
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-6 px-1.5 text-[10px]"
          disabled={props.busy}
          onClick={() => props.onRedraw(panel, mode)}
        >
          {generation.status === "success" ? "重绘" : "生成"}
          {mode === "draft" ? "·草稿" : "·高清"}
        </Button>
      </div>
      {generation.error ? (
        <p className="line-clamp-2 text-[10px] text-destructive" title={generation.error}>
          {generation.error}
        </p>
      ) : null}
      <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
        {panel.prompt?.final || "该镜还没有描述词，生成时会按公式自动组装"}
      </p>
    </div>
  );
}

const STATUS_LABELS: Record<GenerationStatus, string> = {
  pending: "待生成",
  queued: "排队中",
  running: "生成中",
  success: "已出图",
  failed: "失败",
};

function GenerationBadge(props: {
  status: GenerationStatus;
  mode?: GenerationMode;
  attempts: number;
}) {
  const { status, mode, attempts } = props;
  const variant =
    status === "success" ? "secondary" : status === "failed" ? "destructive" : "outline";
  const label =
    status === "pending" && attempts > 0
      ? `第 ${attempts + 1} 次等待重试`
      : STATUS_LABELS[status] + (status === "success" && mode ? `·${mode === "draft" ? "草稿" : "高清"}` : "");
  return (
    <Badge variant={variant} className="text-[10px]">
      {label}
    </Badge>
  );
}

/** 分镜缩略图：优先本地 Blob，跨域兜底时回退 remoteUrl */
function PanelThumb(props: { imageId?: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    if (!props.imageId) {
      setUrl(null);
      return;
    }
    void (async () => {
      const blob = await getImageBlob(props.imageId ?? "");
      if (blob) {
        objectUrl = URL.createObjectURL(blob);
        if (active) setUrl(objectUrl);
        return;
      }
      const record = await getImageRecord(props.imageId ?? "");
      if (active && record?.remoteUrl) setUrl(record.remoteUrl);
    })();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [props.imageId]);

  if (!props.imageId) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-md bg-muted/50 text-[10px] text-muted-foreground",
          props.className,
        )}
      >
        未生成
      </div>
    );
  }
  return url ? (
    <img src={url} alt="分镜画面" className={cn("rounded-md object-cover", props.className)} />
  ) : (
    <div
      className={cn(
        "flex items-center justify-center rounded-md bg-muted/50 text-[10px] text-muted-foreground",
        props.className,
      )}
    >
      加载中…
    </div>
  );
}

function EmptyHint(props: { text: string }) {
  return (
    <div className="rounded-xl bg-muted/30 px-6 py-16 text-center text-sm text-muted-foreground">
      {props.text}
    </div>
  );
}
