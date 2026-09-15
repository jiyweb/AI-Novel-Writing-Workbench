/**
 * 步骤五：台词
 *
 * 确定性台词提取（引号扫描 + 提示语归属角色库，不走大模型、无需 AI 配置）；
 * 台词呈现样式随漫画形态适配（气泡对白/底部字幕/聊天框/无台词）。
 * 支持手动编辑说话人与文本、拖拽气泡定位、宽度和字号微调。
 *
 * 原文零修改（规则第5条）：台词仅引用原文索引，编辑只改台词副本。
 * 重新提取会整体覆盖（含手动编辑与拖拽位置），故需确认后执行。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { Loader2, MessageSquare, Plus, Sparkles, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  comicKeys,
  useComicChapter,
  useComicChapters,
  useComicCharacters,
  useComicPanels,
  useComicProject,
  useComicScenes,
  useWorkbenchSettings,
} from "../../hooks/useComicQuery";
import { useComicWorkbenchStore } from "../../stores/workbenchStore";
import { getFormById } from "../../services/configService";
import {
  addManualDialogue,
  defaultDialogueLayout,
  deleteDialogue,
  extractDialogues,
  updateDialogue,
} from "../../services/dialogueService";
import { computePanelStaleMap, syncChapterText } from "../../services/syncService";
import { StaleBadge } from "../common/StaleBadge";
import { StaleBanner } from "../common/StaleBanner";
import type {
  ComicCharacter,
  ComicLetteringMode,
  ComicPanel,
  DialogueLayout,
  PanelDialogue,
} from "../../types";

const LETTERING_LABELS: Record<ComicLetteringMode, string> = {
  bubble: "气泡对白",
  caption: "底部字幕",
  chat: "聊天框",
  none: "无台词呈现",
};

/** 章节未就绪时的空待更新集合 */
const EMPTY_IDS: ReadonlySet<string> = new Set();

export function DialogueStepPanel(props: { projectId: string }) {
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
  const form = project ? getFormById(project.formId) : undefined;
  const letteringMode: ComicLetteringMode = form?.letteringMode ?? "bubble";

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
  const customFormula = settingsQuery.data?.customPromptFormula ?? null;

  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [selectedDialogueId, setSelectedDialogueId] = useState<string | null>(null);
  /** 拖拽/滑杆过程中的临时布局（提交落库后与查询数据一致） */
  const [liveLayouts, setLiveLayouts] = useState<Record<string, DialogueLayout>>({});

  // 版本链待更新状态（横幅计数 + 列表逐镜徽标）
  const stale = useMemo(
    () => (chapter ? computePanelStaleMap(panels, chapter) : null),
    [panels, chapter],
  );

  const selectedPanel = panels.find((panel) => panel.id === selectedPanelId) ?? null;
  const selectedDialogueIndex = selectedPanel
    ? selectedPanel.dialogues.findIndex((item) => item.id === selectedDialogueId)
    : -1;
  const selectedDialogue =
    selectedPanel && selectedDialogueIndex >= 0
      ? selectedPanel.dialogues[selectedDialogueIndex]
      : null;
  const selectedLayout = selectedDialogue
    ? (liveLayouts[selectedDialogue.id] ??
      selectedDialogue.layout ??
      defaultDialogueLayout(selectedDialogueIndex, letteringMode))
    : null;

  // 默认选中第一镜；当前镜被删除后回落
  useEffect(() => {
    if (selectedPanelId && !panels.some((panel) => panel.id === selectedPanelId)) {
      setSelectedPanelId(null);
      setSelectedDialogueId(null);
    }
    if (!selectedPanelId && panels.length > 0) {
      setSelectedPanelId(panels[0].id);
    }
  }, [panels, selectedPanelId]);

  // 切镜后清空临时布局与台词选中
  useEffect(() => {
    setLiveLayouts({});
    setSelectedDialogueId(null);
  }, [selectedPanelId]);

  const invalidate = async () => {
    if (chapterId) {
      await queryClient.invalidateQueries({ queryKey: comicKeys.panels(chapterId) });
      await queryClient.invalidateQueries({ queryKey: comicKeys.chapter(chapterId) });
    }
  };

  const extractMutation = useMutation({
    mutationFn: async () => {
      if (!chapter) throw new Error("章节不存在");
      return extractDialogues(chapter, panels);
    },
    onSuccess: async (result) => {
      toast.success(
        `台词提取完成：${result.panelsWithDialogue} 个分镜共 ${result.totalDialogues} 条台词`,
      );
      await invalidate();
    },
    onError: (error: Error) => toast.error(`台词提取失败：${error.message}`),
  });

  const dialogueMutation = useMutation({
    mutationFn: async (task: () => Promise<unknown>) => task(),
    onSuccess: invalidate,
    onError: (error: Error) => toast.error(`保存失败：${error.message}`),
  });

  /** 一键同步：按依赖序重跑台词提取与描述词组装（画面重生成在生成步骤进行） */
  const syncMutation = useMutation({
    mutationFn: async () => {
      if (!chapter || !project) throw new Error("章节或项目不存在");
      return syncChapterText({
        chapter,
        panels,
        project,
        characters,
        scenes,
        customFormula,
      });
    },
    onSuccess: async (result) => {
      toast.success(
        result.imageStale > 0
          ? `同步完成，${result.imageStale} 张画面待在「生成」步骤重新生成`
          : "同步完成：台词与描述词已与最新内容对齐",
      );
      await invalidate();
    },
    onError: (error: Error) => toast.error(`同步失败：${error.message}`),
  });

  if (chapters.length === 0) {
    return <EmptyHint text="还没有章节。先回到「内容导入」导入或生成正文，再来提取台词。" />;
  }
  if (!chapter) {
    return <EmptyHint text="请选择上方一个章节开始台词编排。" />;
  }
  if (panels.length === 0) {
    return <EmptyHint text="本章还没有分镜。先回到「智能分镜」生成分镜，再来进行台词编排。" />;
  }

  const busy = extractMutation.isPending || dialogueMutation.isPending || syncMutation.isPending;
  const totalDialogues = panels.reduce((sum, panel) => sum + panel.dialogues.length, 0);

  const handleExtract = () => {
    const hasExisting = panels.some((panel) => panel.dialogues.length > 0);
    if (
      hasExisting &&
      !window.confirm("重新提取会覆盖本章全部台词（包括手动编辑和拖拽位置），确定继续？")
    ) {
      return;
    }
    extractMutation.mutate();
  };

  /** 提交某条台词的当前临时布局到数据库 */
  const commitLayout = (dialogueId: string) => {
    if (!selectedPanel) return;
    const index = selectedPanel.dialogues.findIndex((item) => item.id === dialogueId);
    const dialogue = selectedPanel.dialogues[index];
    if (!dialogue) return;
    const layout = liveLayouts[dialogue.id] ?? dialogue.layout;
    if (!layout) return;
    dialogueMutation.mutate(() => updateDialogue(selectedPanel, dialogueId, { layout }));
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
              setSelectedPanelId(null);
              setSelectedDialogueId(null);
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
        <Badge variant="outline">台词呈现：{LETTERING_LABELS[letteringMode]}</Badge>
        <Button size="sm" disabled={busy} onClick={handleExtract}>
          {extractMutation.isPending ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 h-4 w-4" />
          )}
          {chapter.dialogueExtracted ? "重新提取台词" : "提取台词"}
        </Button>
        <span className="text-xs text-muted-foreground">
          共 {panels.length} 镜 · {totalDialogues} 条台词
        </span>
        {letteringMode === "none" ? (
          <span className="text-xs text-muted-foreground">
            当前形态不呈现台词气泡，台词仅作内容记录供后续参考
          </span>
        ) : null}
      </div>

      {/* 待更新横幅：分镜/角色库变化后提示同步 */}
      {stale && stale.summary.dialogue > 0 ? (
        <div className="pt-3">
          <StaleBanner
            text={`分镜或角色库有更新，${stale.summary.dialogue} 个分镜的台词需要重新提取`}
            actionLabel="一键同步"
            busy={syncMutation.isPending}
            onAction={() => syncMutation.mutate()}
          />
        </div>
      ) : null}

      {/* 主体：左编排 / 右分镜列表 */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 pt-4 lg:grid-cols-2">
        <section className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-xl bg-muted/20 p-3">
          {selectedPanel ? (
            <>
              <div className="text-xs text-muted-foreground">
                第 {panels.findIndex((panel) => panel.id === selectedPanel.id) + 1} 镜 ·
                拖动气泡调整位置，点击气泡或下方条目调整宽度和字号
              </div>
              {letteringMode === "none" ? (
                <div className="rounded-lg bg-muted/40 px-4 py-12 text-center text-sm text-muted-foreground">
                  当前形态（{form?.name ?? "未知形态"}）不呈现台词，可继续编辑台词内容作文字记录。
                </div>
              ) : (
                <DialogueStage
                  ratioWidth={form?.ratioWidth ?? 3}
                  ratioHeight={form?.ratioHeight ?? 4}
                  letteringMode={letteringMode}
                  panel={selectedPanel}
                  liveLayouts={liveLayouts}
                  selectedDialogueId={selectedDialogueId}
                  onSelectDialogue={setSelectedDialogueId}
                  onLiveLayout={(dialogueId, layout) =>
                    setLiveLayouts((prev) => ({ ...prev, [dialogueId]: layout }))
                  }
                  onCommitLayout={commitLayout}
                />
              )}

              {/* 选中台词的布局属性 */}
              {selectedDialogue && selectedLayout ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-background/60 px-3 py-2">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    宽度
                    <input
                      type="range"
                      min={12}
                      max={96}
                      step={1}
                      value={Math.round(selectedLayout.width)}
                      onChange={(event) =>
                        setLiveLayouts((prev) => ({
                          ...prev,
                          [selectedDialogue.id]: {
                            ...selectedLayout,
                            width: Number(event.target.value),
                          },
                        }))
                      }
                      onPointerUp={() => commitLayout(selectedDialogue.id)}
                      onKeyUp={() => commitLayout(selectedDialogue.id)}
                      className="w-24 accent-primary"
                    />
                    <span className="w-9 tabular-nums">{Math.round(selectedLayout.width)}%</span>
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    字号
                    <input
                      type="range"
                      min={0.6}
                      max={1.8}
                      step={0.1}
                      value={selectedLayout.fontScale}
                      onChange={(event) =>
                        setLiveLayouts((prev) => ({
                          ...prev,
                          [selectedDialogue.id]: {
                            ...selectedLayout,
                            fontScale: Number(event.target.value),
                          },
                        }))
                      }
                      onPointerUp={() => commitLayout(selectedDialogue.id)}
                      onKeyUp={() => commitLayout(selectedDialogue.id)}
                      className="w-24 accent-primary"
                    />
                    <span className="w-9 tabular-nums">
                      ×{selectedLayout.fontScale.toFixed(1)}
                    </span>
                  </label>
                </div>
              ) : null}

              {/* 台词条目编辑 */}
              {selectedPanel.dialogues.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  本镜暂无台词。可点击「添加台词」补画外音/旁白，或回到分镜调整原文切分。
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {selectedPanel.dialogues.map((dialogue) => (
                    <DialogueRow
                      key={dialogue.id}
                      dialogue={dialogue}
                      characters={characters}
                      isActive={dialogue.id === selectedDialogueId}
                      onSelect={() => setSelectedDialogueId(dialogue.id)}
                      onCommit={(updates) =>
                        dialogueMutation.mutate(() =>
                          updateDialogue(selectedPanel, dialogue.id, updates),
                        )
                      }
                      onDelete={() =>
                        dialogueMutation.mutate(() => deleteDialogue(selectedPanel, dialogue.id))
                      }
                    />
                  ))}
                </div>
              )}

              <Button
                size="sm"
                variant="outline"
                className="self-start"
                disabled={busy}
                onClick={() =>
                  dialogueMutation.mutate(() => addManualDialogue(selectedPanel, letteringMode))
                }
              >
                <Plus className="mr-1.5 h-4 w-4" />
                添加台词
              </Button>
            </>
          ) : (
            <p className="py-16 text-center text-sm text-muted-foreground">
              从右侧选择一个分镜开始编排台词。
            </p>
          )}
        </section>

        <section className="flex min-h-0 flex-col rounded-xl bg-muted/20">
          <div className="px-3 pb-1 pt-2 text-xs text-muted-foreground">
            分镜列表（点击选择要编排台词的分镜）
          </div>
          <DialoguePanelList
            panels={panels}
            sourceContent={chapter.sourceContent}
            staleIds={stale?.dialogueIds ?? EMPTY_IDS}
            selectedPanelId={selectedPanelId}
            onSelect={(panelId) => setSelectedPanelId(panelId)}
          />
        </section>
      </div>

      {/* 角色名候选（说话人输入自动补全） */}
      <datalist id="comic-dlg-name-options">
        {characters.map((character) => (
          <option key={character.id} value={character.name} />
        ))}
      </datalist>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 台词舞台：按形态比例的预览框 + 可拖拽气泡
// ---------------------------------------------------------------------------

function DialogueStage(props: {
  ratioWidth: number;
  ratioHeight: number;
  letteringMode: ComicLetteringMode;
  panel: ComicPanel;
  liveLayouts: Record<string, DialogueLayout>;
  selectedDialogueId: string | null;
  onSelectDialogue: (dialogueId: string) => void;
  onLiveLayout: (dialogueId: string, layout: DialogueLayout) => void;
  onCommitLayout: (dialogueId: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    dialogueId: string;
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    width: number;
  } | null>(null);

  const layoutOf = (dialogue: PanelDialogue, index: number): DialogueLayout =>
    props.liveLayouts[dialogue.id] ??
    dialogue.layout ??
    defaultDialogueLayout(index, props.letteringMode);

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    dialogue: PanelDialogue,
    index: number,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const layout = layoutOf(dialogue, index);
    dragRef.current = {
      dialogueId: dialogue.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origX: layout.x,
      origY: layout.y,
      width: layout.width,
    };
    props.onSelectDialogue(dialogue.id);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const stage = stageRef.current;
    if (!drag || !stage || drag.pointerId !== event.pointerId) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dx = ((event.clientX - drag.startX) / rect.width) * 100;
    const dy = ((event.clientY - drag.startY) / rect.height) * 100;
    const index = props.panel.dialogues.findIndex((item) => item.id === drag.dialogueId);
    const dialogue = props.panel.dialogues[index];
    if (!dialogue) return;
    const base = layoutOf(dialogue, index);
    props.onLiveLayout(drag.dialogueId, {
      ...base,
      x: clamp(drag.origX + dx, 0, 100 - drag.width),
      y: clamp(drag.origY + dy, 0, 94),
    });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    props.onCommitLayout(drag.dialogueId);
  };

  return (
    <div
      ref={stageRef}
      className="relative mx-auto w-full max-w-sm overflow-hidden rounded-lg border bg-gradient-to-b from-muted/60 to-muted/20"
      style={{ aspectRatio: `${props.ratioWidth} / ${props.ratioHeight}` }}
    >
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground/50">
        画面示意（生成成图后替换为漫画画面）
      </div>
      {props.panel.dialogues.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-background/80 px-3 py-1 text-xs text-muted-foreground">
            本镜暂无台词
          </span>
        </div>
      ) : (
        props.panel.dialogues.map((dialogue, index) => {
          const layout = layoutOf(dialogue, index);
          const isActive = dialogue.id === props.selectedDialogueId;
          return (
            <div
              key={dialogue.id}
              onPointerDown={(event) => handlePointerDown(event, dialogue, index)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              className={cn(
                "absolute min-h-6 cursor-grab touch-none select-none leading-snug active:cursor-grabbing",
                BUBBLE_CLASS[props.letteringMode],
                isActive && "ring-2 ring-primary/60",
              )}
              style={{
                left: `${layout.x}%`,
                top: `${layout.y}%`,
                width: `${layout.width}%`,
                fontSize: `${13 * layout.fontScale}px`,
                zIndex: isActive ? 20 : 10,
              }}
            >
              {dialogue.characterName ? (
                <span className="block text-[10px] leading-tight opacity-70">
                  {dialogue.characterName}
                </span>
              ) : null}
              <span className="block">{dialogue.text || "（空台词）"}</span>
            </div>
          );
        })
      )}
    </div>
  );
}

/** 按台词呈现样式的气泡外观 */
const BUBBLE_CLASS: Record<ComicLetteringMode, string> = {
  bubble: "rounded-2xl border bg-background/95 px-2.5 py-1.5 shadow-sm",
  caption: "rounded bg-black/75 px-2 py-1 text-center text-white",
  chat: "rounded-2xl border bg-background/95 px-2.5 py-1.5 shadow-sm",
  none: "",
};

// ---------------------------------------------------------------------------
// 台词条目（说话人 + 文本）
// ---------------------------------------------------------------------------

function DialogueRow(props: {
  dialogue: PanelDialogue;
  characters: ComicCharacter[];
  isActive: boolean;
  onSelect: () => void;
  onCommit: (updates: Partial<Pick<PanelDialogue, "text" | "characterId" | "characterName">>) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(props.dialogue.characterName);
  const [text, setText] = useState(props.dialogue.text);

  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed === props.dialogue.characterName) return;
    const matched = props.characters.find((character) => character.name === trimmed);
    props.onCommit({ characterName: trimmed, characterId: matched?.id });
  };
  const commitText = () => {
    if (text === props.dialogue.text) return;
    props.onCommit({ text });
  };

  return (
    <div
      onClick={props.onSelect}
      className={cn(
        "rounded-lg px-2 py-1.5 transition-colors",
        props.isActive ? "bg-primary/5 ring-1 ring-primary/40" : "hover:bg-muted/40",
      )}
    >
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          placeholder="说话人（留空为旁白）"
          list="comic-dlg-name-options"
          onClick={(event) => event.stopPropagation()}
          className="h-8 w-32 shrink-0 text-xs"
        />
        <Input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={commitText}
          onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          placeholder="台词内容（提取自原文，可修改）"
          onClick={(event) => event.stopPropagation()}
          className="h-8 min-w-0 flex-1 text-xs"
        />
        <button
          type="button"
          title="删除台词"
          onClick={(event) => {
            event.stopPropagation();
            props.onDelete();
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 分镜列表（虚拟滚动）
// ---------------------------------------------------------------------------

function DialoguePanelList(props: {
  panels: ComicPanel[];
  sourceContent: string;
  staleIds: ReadonlySet<string>;
  selectedPanelId: string | null;
  onSelect: (panelId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: props.panels.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 88,
    overscan: 4,
    getItemKey: (index) => props.panels[index]?.id ?? index,
  });

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const panel = props.panels[item.index];
          if (!panel) return null;
          const text = props.sourceContent
            .slice(panel.sourceStartIndex, panel.sourceEndIndex)
            .trim();
          const isEmptyShot = panel.sourceEndIndex <= panel.sourceStartIndex;
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
              <button
                type="button"
                onClick={() => props.onSelect(panel.id)}
                className={cn(
                  "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                  panel.id === props.selectedPanelId
                    ? "border-primary/60 bg-primary/5"
                    : "border-transparent hover:border-border hover:bg-background",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{item.index + 1}</span>
                  {panel.dialogues.length > 0 ? (
                    <Badge variant="secondary" className="text-[10px]">
                      <MessageSquare className="mr-1 h-3 w-3" />
                      {panel.dialogues.length} 条台词
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px]">
                      无台词
                    </Badge>
                  )}
                  {props.staleIds.has(panel.id) ? <StaleBadge /> : null}
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {isEmptyShot ? "空镜：不引用原文" : text}
                </p>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function EmptyHint(props: { text: string }) {
  return (
    <div className="rounded-xl bg-muted/30 px-6 py-16 text-center text-sm text-muted-foreground">
      {props.text}
    </div>
  );
}
