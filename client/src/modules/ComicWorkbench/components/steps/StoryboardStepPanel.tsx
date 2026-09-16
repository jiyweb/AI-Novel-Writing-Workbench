/**
 * 步骤三：智能分镜
 *
 * 左侧原文（虚拟滚动，双向高亮联动），右侧分镜卡片列表（虚拟滚动）。
 * 支持：5 档密度 + 动态密度智能分镜、手动拆分/合并/删除/插入空镜/
 * 拖拽排序、单镜密度覆盖重切、LLM 元数据增强（可跳过）。
 *
 * 原文零修改（规则第5条）：所有分镜仅以字符索引锚定原文。
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import {
  Combine,
  GripVertical,
  Loader2,
  Plus,
  Sparkles,
  SplitSquareHorizontal,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
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
  useComicPanels,
} from "../../hooks/useComicQuery";
import { useComicWorkbenchStore } from "../../stores/workbenchStore";
import { VirtualTextView } from "../../components/common/VirtualTextView";
import { getDensityLevel, narrativeTemplates, shotDensity } from "../../services/configService";
import {
  applyDensityOverride,
  deletePanel,
  generateStoryboard,
  insertEmptyPanel,
  mergePanelWithNext,
  reorderPanels,
  splitPanel,
  updateDensityPlan,
} from "../../services/storyboard/storyboardService";
import {
  describeMetadataError,
  enrichPanelMetadata,
} from "../../services/storyboard/metadataService";
import { isLlmReady } from "../../services/ai/aiConfigService";
import type { ComicPanel, ShotDensityLevel } from "../../types";

export function StoryboardStepPanel(props: { projectId: string }) {
  const { projectId } = props;
  const queryClient = useQueryClient();
  const chapterId = useComicWorkbenchStore((state) => state.chapterId);
  const openChapter = useComicWorkbenchStore((state) => state.openChapter);

  const chaptersQuery = useComicChapters(projectId);
  const chapters = useMemo(
    () => [...(chaptersQuery.data ?? [])].sort((a, b) => a.index - b.index),
    [chaptersQuery.data],
  );
  const chapterQuery = useComicChapter(chapterId);
  const chapter = chapterQuery.data ?? null;
  const panelsQuery = useComicPanels(chapterId);
  const panels = useMemo(
    () => [...(panelsQuery.data ?? [])].sort((a, b) => a.order - b.order),
    [panelsQuery.data],
  );

  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [dragPanelId, setDragPanelId] = useState<string | null>(null);
  const [metadataProgress, setMetadataProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const aiSettings = useAiSettings();
  const llmReady = isLlmReady(aiSettings.data);
  // 爆款增强：灵感导入选择的叙事模板，提示分镜节奏（元数据增强同样遵循）
  const narrativeTemplate = chapter
    ? narrativeTemplates.templates.find(
        (item) => item.id === chapter.inspiration?.brief.narrativeTemplateId,
      )
    : undefined;

  const selectedPanel = panels.find((panel) => panel.id === selectedPanelId) ?? null;

  const invalidate = async () => {
    if (chapterId) {
      await queryClient.invalidateQueries({ queryKey: comicKeys.panels(chapterId) });
      await queryClient.invalidateQueries({ queryKey: comicKeys.chapter(chapterId) });
    }
  };

  const generateMutation = useMutation({
    mutationFn: async () => {
      if (!chapter) throw new Error("章节不存在");
      await generateStoryboard(chapter);
    },
    onSuccess: async () => {
      toast.success("分镜已生成，可拖动调整顺序或继续微调");
      await invalidate();
    },
    onError: (error: Error) => toast.error(`分镜生成失败：${error.message}`),
  });

  const densityMutation = useMutation({
    mutationFn: async (plan: { global: ShotDensityLevel; dynamic: boolean }) => {
      if (!chapter) throw new Error("章节不存在");
      await updateDensityPlan(chapter, plan);
    },
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error: Error) => toast.error(`密度方案保存失败：${error.message}`),
  });

  const structuralMutation = useMutation({
    mutationFn: async (task: () => Promise<ComicPanel[]>) => {
      await task();
    },
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error: Error) => toast.error(`操作失败：${error.message}`),
  });

  const overrideMutation = useMutation({
    mutationFn: async (params: { panelId: string; level: ShotDensityLevel }) => {
      if (!chapter) throw new Error("章节不存在");
      await applyDensityOverride(chapter, params.panelId, params.level);
    },
    onSuccess: async () => {
      toast.success("已按新密度重切该镜");
      await invalidate();
    },
    onError: (error: Error) => toast.error(`重切失败：${error.message}`),
  });

  const metadataMutation = useMutation({
    mutationFn: async () => {
      if (!chapter) throw new Error("章节不存在");
      if (!aiSettings.data) throw new Error("尚未配置 AI 接口，请先在 AI 设置中填写");
      setMetadataProgress({ done: 0, total: panels.length });
      const updated = await enrichPanelMetadata({
        chapter,
        panels,
        settings: aiSettings.data,
        onProgress: (done, total) => setMetadataProgress({ done, total }),
      });
      return updated;
    },
    onSuccess: async (updated) => {
      toast.success(`已为 ${updated} 个分镜补充镜头/情绪/动作元数据`);
      await invalidate();
    },
    onError: (error: Error) => toast.error(describeMetadataError(error)),
    onSettled: () => setMetadataProgress(null),
  });

  if (chapters.length === 0) {
    return <EmptyHint text="还没有章节。先回到「内容导入」导入或生成正文，再来进行分镜。" />;
  }
  if (!chapter) {
    return <EmptyHint text="请选择上方一个章节开始分镜。" />;
  }

  const busy =
    generateMutation.isPending ||
    densityMutation.isPending ||
    structuralMutation.isPending ||
    overrideMutation.isPending ||
    metadataMutation.isPending;

  const movePanel = (panelId: string, direction: -1 | 1) => {
    const index = panels.findIndex((panel) => panel.id === panelId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= panels.length) return;
    const ids = panels.map((panel) => panel.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(target, 0, moved);
    structuralMutation.mutate(() => reorderPanels(chapter, ids));
  };

  const dropPanel = (targetId: string) => {
    const dragId = dragPanelId;
    setDragPanelId(null);
    if (!dragId || dragId === targetId) return;
    const ids = panels.map((panel) => panel.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    structuralMutation.mutate(() => reorderPanels(chapter, ids));
  };

  const highlightRanges = panels
    .filter((panel) => panel.sourceEndIndex > panel.sourceStartIndex)
    .map((panel) => ({
      start: panel.sourceStartIndex,
      end: panel.sourceEndIndex,
      tone: (panel.id === selectedPanelId ? "active" : "idle") as "active" | "idle",
    }));

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
              setSelectedPanelId(null);
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

      {/* 叙事节奏提示（爆款增强：灵感导入时选择的叙事模板） */}
      {narrativeTemplate ? (
        <div className="rounded-lg bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">叙事节奏 · {narrativeTemplate.name}</span>
          ：{narrativeTemplate.description}。AI 元数据增强会按此节奏判断镜头与情绪。
        </div>
      ) : null}

      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-3 border-b pb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">分镜密度</span>
          <Select
            value={chapter.densityPlan.global}
            onValueChange={(value) =>
              densityMutation.mutate({ global: value as ShotDensityLevel, dynamic: chapter.densityPlan.dynamic })
            }
          >
            <SelectTrigger className="h-9 w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {shotDensity.levels.map((level) => (
                <SelectItem key={level.id} value={level.id}>
                  {level.name}（{level.minSentences}-{level.maxSentences}句）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          动态密度（高潮/对话自动调紧）
          <Switch
            checked={chapter.densityPlan.dynamic}
            onCheckedChange={(checked) =>
              densityMutation.mutate({ global: chapter.densityPlan.global, dynamic: checked })
            }
          />
        </label>
        <Button size="sm" disabled={busy} onClick={() => generateMutation.mutate()}>
          {generateMutation.isPending ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 h-4 w-4" />
          )}
          {panels.length > 0 ? "按密度重新分镜" : "生成分镜"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !llmReady || panels.length === 0}
          onClick={() => metadataMutation.mutate()}
        >
          {metadataMutation.isPending ? (
            <>
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              {metadataProgress ? `${metadataProgress.done}/${metadataProgress.total}` : "处理中"}
            </>
          ) : (
            "AI 元数据增强"
          )}
        </Button>
        {panels.length > 0 && (
          <span className="text-xs text-muted-foreground">共 {panels.length} 镜</span>
        )}
      </div>

      {/* 主体：左原文 / 右分镜 */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 pt-4 lg:grid-cols-2">
        <section className="flex min-h-0 flex-col rounded-xl bg-muted/20 p-1">
          <div className="px-3 pb-1 pt-2 text-xs text-muted-foreground">
            章节原文（选中分镜时自动定位并高亮）
          </div>
          <div className="min-h-0 flex-1">
            <VirtualTextView
              content={chapter.sourceContent}
              highlightRanges={highlightRanges}
              scrollIntoRange={
                selectedPanel
                  ? { start: selectedPanel.sourceStartIndex, end: selectedPanel.sourceEndIndex }
                  : null
              }
            />
          </div>
        </section>

        <section className="flex min-h-0 flex-col rounded-xl bg-muted/20">
          <div className="px-3 pb-1 pt-2 text-xs text-muted-foreground">
            分镜列表（拖动卡片或用箭头调整顺序；点击卡片定位原文）
          </div>
          {panels.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-sm text-muted-foreground">
                还没有分镜。选择密度后点击「生成分镜」，AI 会按密度把原文切成一格格画面。
              </p>
              <Button size="sm" disabled={busy} onClick={() => generateMutation.mutate()}>
                <Sparkles className="mr-1.5 h-4 w-4" />
                生成分镜
              </Button>
            </div>
          ) : (
            <PanelList
              panels={panels}
              sourceContent={chapter.sourceContent}
              selectedPanelId={selectedPanelId}
              dragPanelId={dragPanelId}
              busy={busy}
              onSelect={setSelectedPanelId}
              onDragStart={setDragPanelId}
              onDrop={dropPanel}
              onMove={movePanel}
              onSplit={(panelId) =>
                structuralMutation.mutate(() => splitPanel(chapter, panelId))
              }
              onMerge={(panelId) =>
                structuralMutation.mutate(() => mergePanelWithNext(chapter, panelId))
              }
              onDelete={(panelId) => structuralMutation.mutate(() => deletePanel(chapter, panelId))}
              onInsert={(panelId) =>
                structuralMutation.mutate(() => insertEmptyPanel(chapter, panelId))
              }
              onOverride={(panelId, level) => overrideMutation.mutate({ panelId, level })}
            />
          )}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 分镜列表（虚拟滚动）
// ---------------------------------------------------------------------------

interface PanelListProps {
  panels: ComicPanel[];
  sourceContent: string;
  selectedPanelId: string | null;
  dragPanelId: string | null;
  busy: boolean;
  onSelect: (panelId: string) => void;
  onDragStart: (panelId: string) => void;
  onDrop: (targetPanelId: string) => void;
  onMove: (panelId: string, direction: -1 | 1) => void;
  onSplit: (panelId: string) => void;
  onMerge: (panelId: string) => void;
  onDelete: (panelId: string) => void;
  onInsert: (afterPanelId: string) => void;
  onOverride: (panelId: string, level: ShotDensityLevel) => void;
}

function PanelList(props: PanelListProps) {
  const {
    panels,
    sourceContent,
    selectedPanelId,
    dragPanelId,
    busy,
    onSelect,
    onDragStart,
    onDrop,
    onMove,
    onSplit,
    onMerge,
    onDelete,
    onInsert,
    onOverride,
  } = props;
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: panels.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 168,
    overscan: 4,
    getItemKey: (index) => panels[index]?.id ?? index,
  });

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const panel = panels[item.index];
          if (!panel) return null;
          const text = sourceContent.slice(panel.sourceStartIndex, panel.sourceEndIndex).trim();
          const isEmptyShot = panel.sourceEndIndex <= panel.sourceStartIndex;
          const level = getDensityLevel(panel.densityOverride ?? panel.densityApplied);
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
              <div
                draggable
                onDragStart={() => onDragStart(panel.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => onDrop(panel.id)}
                onClick={() => onSelect(panel.id)}
                className={cn(
                  "group cursor-grab rounded-lg border bg-background/60 px-3 py-2.5 transition-colors active:cursor-grabbing",
                  panel.id === selectedPanelId
                    ? "border-primary/60 bg-primary/5"
                    : "border-transparent hover:border-border hover:bg-background",
                )}
              >
                <div className="flex items-center gap-2">
                  <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                  <span className="text-sm font-semibold">{item.index + 1}</span>
                  <Badge variant="secondary" className="text-[10px]">
                    {isEmptyShot ? "空镜" : (level?.name ?? panel.densityApplied)}
                  </Badge>
                  {panel.metadata?.shotType ? (
                    <Badge variant="outline" className="text-[10px]">
                      {SHOT_TYPE_LABELS[panel.metadata.shotType] ?? panel.metadata.shotType}
                    </Badge>
                  ) : null}
                  {panel.generation.status === "success" ? (
                    <Badge className="text-[10px]">已出图</Badge>
                  ) : null}
                  <div className="ml-auto flex items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                    <IconAction title="上移" disabled={busy || item.index === 0} onClick={() => onMove(panel.id, -1)}>
                      ↑
                    </IconAction>
                    <IconAction
                      title="下移"
                      disabled={busy || item.index === panels.length - 1}
                      onClick={() => onMove(panel.id, 1)}
                    >
                      ↓
                    </IconAction>
                    <IconAction
                      title="在此镜后插入空镜（转场）"
                      disabled={busy}
                      onClick={() => onInsert(panel.id)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </IconAction>
                    <IconAction
                      title="拆分此镜"
                      disabled={busy || isEmptyShot || text.length < 24}
                      onClick={() => onSplit(panel.id)}
                    >
                      <SplitSquareHorizontal className="h-3.5 w-3.5" />
                    </IconAction>
                    <IconAction
                      title="与下一镜合并"
                      disabled={busy || item.index === panels.length - 1}
                      onClick={() => onMerge(panel.id)}
                    >
                      <Combine className="h-3.5 w-3.5" />
                    </IconAction>
                    <IconAction title="删除此镜" disabled={busy} onClick={() => onDelete(panel.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconAction>
                  </div>
                </div>
                <p
                  className={cn(
                    "mt-1.5 line-clamp-3 text-sm leading-relaxed",
                    isEmptyShot && "italic text-muted-foreground",
                  )}
                >
                  {isEmptyShot ? "空镜：不引用原文，用于转场或情绪留白" : text}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">本镜密度</span>
                  <Select
                    value={panel.densityOverride ?? panel.densityApplied}
                    disabled={busy || isEmptyShot}
                    onValueChange={(value) => onOverride(panel.id, value as ShotDensityLevel)}
                  >
                    <SelectTrigger className="h-7 w-32 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {shotDensity.levels.map((levelItem) => (
                        <SelectItem key={levelItem.id} value={levelItem.id}>
                          {levelItem.name}（{levelItem.minSentences}-{levelItem.maxSentences}句）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {panel.densityOverride ? (
                    <span className="text-[10px] text-muted-foreground">已单独重切</span>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SHOT_TYPE_LABELS: Record<string, string> = {
  wide: "远景",
  medium: "中景",
  closeUp: "特写",
  extremeCloseUp: "大特写",
  overShoulder: "过肩",
  aerial: "俯瞰",
  pov: "主观",
};

function IconAction(props: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={props.title}
      disabled={props.disabled}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      className="flex h-6 w-6 items-center justify-center rounded text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    >
      {props.children}
    </button>
  );
}

function EmptyHint(props: { text: string }) {
  return (
    <div className="rounded-xl bg-muted/30 px-6 py-16 text-center text-sm text-muted-foreground">
      {props.text}
    </div>
  );
}
