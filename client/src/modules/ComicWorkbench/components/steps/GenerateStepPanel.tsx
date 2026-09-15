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
import { Ban, ImageUp, Loader2, Play, RefreshCw, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  useWorkbenchSettings,
} from "../../hooks/useComicQuery";
import { useComicWorkbenchStore } from "../../stores/workbenchStore";
import { getImageBlob, getImageRecord } from "../../db/comicDb";
import { isImageReady } from "../../services/ai/aiConfigService";
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
import type { ComicPanel, GenerationMode, GenerationStatus } from "../../types";

/** 章节未就绪时的空待更新集合 */
const EMPTY_IDS: ReadonlySet<string> = new Set();

export function GenerateStepPanel(props: { projectId: string }) {
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
  const charactersQuery = useComicCharacters(projectId);
  const characters = charactersQuery.data ?? [];
  const scenesQuery = useComicScenes(projectId);
  const scenes = scenesQuery.data ?? [];
  const settingsQuery = useWorkbenchSettings();
  const aiSettings = useAiSettings();
  const imageReady = isImageReady(aiSettings.data);

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
      if (!aiSettings.data) throw new Error("尚未配置 AI 接口，请先在 AI 设置中填写");
      if (!isImageReady(aiSettings.data)) throw new Error("生图模型配置不完整，请在 AI 设置中检查");
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
        settings: aiSettings.data,
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
      if (!aiSettings.data) throw new Error("尚未配置 AI 接口，请先在 AI 设置中填写");
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
        settings: aiSettings.data,
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
            请先在 AI 设置中配置生图模型
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

      {/* 分镜生成列表（虚拟滚动） */}
      <section className="mt-4 flex min-h-0 flex-1 flex-col rounded-xl bg-muted/20">
        <div className="px-3 pb-1 pt-2 text-xs text-muted-foreground">
          分镜画面（单镜可重新生成或切换草稿/高清档位）
        </div>
        <GeneratePanelList
          panels={panels}
          mode={mode}
          busy={busy}
          redrawingId={redrawingId}
          staleIds={stale?.imageIds ?? EMPTY_IDS}
          onRedraw={(panel, targetMode) => redrawMutation.mutate({ panel, targetMode })}
        />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 分镜生成列表（虚拟滚动）
// ---------------------------------------------------------------------------

function GeneratePanelList(props: {
  panels: ComicPanel[];
  mode: GenerationMode;
  busy: boolean;
  redrawingId: string | null;
  staleIds: ReadonlySet<string>;
  onRedraw: (panel: ComicPanel, mode: GenerationMode) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: props.panels.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 150,
    overscan: 3,
    getItemKey: (index) => props.panels[index]?.id ?? index,
  });

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const panel = props.panels[item.index];
          if (!panel) return null;
          const generation = panel.generation;
          const isRedrawing = props.redrawingId === panel.id;
          return (
            <div
              key={panel.id}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${item.start}px)`,
              }}
              className="pb-2"
            >
              <div className="flex gap-3 rounded-lg border border-transparent bg-background/60 px-3 py-2.5">
                <PanelThumb imageId={generation.imageId} className="h-28 w-20 shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{item.index + 1}</span>
                    <GenerationBadge status={generation.status} mode={generation.mode} attempts={generation.attempts} />
                    {props.staleIds.has(panel.id) ? <StaleBadge /> : null}
                    {isRedrawing ? (
                      <Badge variant="outline" className="text-[10px]">
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        处理中
                      </Badge>
                    ) : null}
                    <div className="ml-auto">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        disabled={props.busy}
                        onClick={() => props.onRedraw(panel, props.mode)}
                      >
                        {generation.status === "success" ? (
                          <>
                            <RefreshCw className="mr-1 h-3 w-3" />
                            重绘为{props.mode === "draft" ? "草稿" : "高清"}
                          </>
                        ) : (
                          <>
                            <ImageUp className="mr-1 h-3 w-3" />
                            生成{props.mode === "draft" ? "草稿" : "高清"}
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                  {generation.error ? (
                    <p className="text-xs text-destructive" title={generation.error}>
                      {generation.error}
                    </p>
                  ) : null}
                  <p className="line-clamp-2 text-xs text-muted-foreground">
                    {panel.prompt?.final || "该镜还没有描述词，生成时会按公式自动组装"}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
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
