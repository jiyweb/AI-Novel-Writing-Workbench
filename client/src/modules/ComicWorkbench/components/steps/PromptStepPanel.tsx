/**
 * 步骤六：描述词
 *
 * 按公式（config/promptFormula.json 的 segmentOrder 8 段）批量组装分镜描述词，
 * 不走大模型：形态画风来自项目设定，场景/角色来自卡片库，
 * 剧情/镜头来自分镜元数据（缺失时回落到本镜原文）。
 *
 * 支持单镜分段编辑（保存后标记手动，批量重建默认跳过）、
 * 一键重置为自动、个人模板保存（覆盖默认段模板）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { Copy, Loader2, RefreshCw, RotateCcw, Settings2, Sparkles, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppDialogContent, Dialog } from "@/components/ui/dialog";
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
import { useReportStepReady } from "../../components/common/StepNavFooter";
import { promptFormula } from "../../services/configService";
import {
  applyPromptEdit,
  generateChapterPrompts,
  resolveTemplates,
  resetPanelPrompt,
  saveCustomPromptFormula,
} from "../../services/promptEngine";
import {
  repairPanelBindings,
  savePanelBinding,
} from "../../services/storyboard/metadataService";
import { computePanelStaleMap, syncChapterText } from "../../services/syncService";
import { StaleBadge } from "../common/StaleBadge";
import { StaleBanner } from "../common/StaleBanner";
import type { ComicPanel, CustomPromptFormula, PromptSegments } from "../../types";

const SEGMENT_KEYS = promptFormula.segmentOrder;

const SEGMENT_LABELS: Record<keyof PromptSegments, string> = {
  form: "形态",
  style: "画风",
  scene: "场景",
  characters: "角色",
  action: "剧情",
  camera: "镜头",
  lettering: "台词呈现",
  quality: "画质",
};

const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** 章节未就绪时的空待更新集合 */
const EMPTY_IDS: ReadonlySet<string> = new Set();

export function PromptStepPanel(props: { projectId: string; onReadyChange?: (ready: boolean, hint?: string) => void }) {
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

  useReportStepReady(
    props.onReadyChange,
    panels.length > 0,
    panels.length > 0
      ? undefined
      : chapterId
        ? "该章节还没有分镜；回到「智能分镜」先生成分镜，再生成描述词"
        : "先选择一个章节",
  );
  const charactersQuery = useComicCharacters(projectId);
  const characters = charactersQuery.data ?? [];
  const scenesQuery = useComicScenes(projectId);
  const scenes = scenesQuery.data ?? [];
  const settingsQuery = useWorkbenchSettings();
  const customFormula = settingsQuery.data?.customPromptFormula ?? null;
  const currentTemplates = useMemo(() => resolveTemplates(customFormula), [customFormula]);

  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [editingSegments, setEditingSegments] = useState<PromptSegments | null>(null);
  /** 本镜绑定（角色多选/场景单选），保存时随描述词一并落库 */
  const [bindCharacterIds, setBindCharacterIds] = useState<string[]>([]);
  const [bindSceneId, setBindSceneId] = useState<string>("");
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // 版本链待更新状态（横幅计数 + 列表逐镜徽标）
  const stale = useMemo(
    () => (chapter ? computePanelStaleMap(panels, chapter) : null),
    [panels, chapter],
  );

  // 绑定检查：非空镜且未标记空镜的画镜，应至少绑定角色或场景（多场景时）
  const unboundCount = useMemo(
    () =>
      panels.filter((panel) => {
        if (panel.sourceEndIndex <= panel.sourceStartIndex) return false;
        if (panel.metadata?.emptyShot) return false;
        const hasCharacter =
          (panel.metadata?.characterIds?.length ?? 0) > 0 ||
          panel.dialogues.some((dialogue) => dialogue.characterId);
        const hasScene = scenes.length <= 1 || Boolean(panel.metadata?.sceneId);
        return !hasCharacter || !hasScene;
      }).length,
    [panels, scenes.length],
  );

  const selectedPanel = panels.find((panel) => panel.id === selectedPanelId) ?? null;

  // 切镜/数据刷新后同步编辑态（保存后的刷新结果与编辑内容一致，无跳变）
  useEffect(() => {
    if (!selectedPanel) {
      setEditingSegments(null);
      setBindCharacterIds([]);
      setBindSceneId("");
      return;
    }
    const base = selectedPanel.prompt?.segments;
    setEditingSegments({
      form: base?.form ?? "",
      style: base?.style ?? "",
      scene: base?.scene ?? "",
      characters: base?.characters ?? "",
      action: base?.action ?? "",
      camera: base?.camera ?? "",
      lettering: base?.lettering ?? "",
      quality: base?.quality ?? "",
    });
    setBindCharacterIds(selectedPanel.metadata?.characterIds ?? []);
    setBindSceneId(selectedPanel.metadata?.sceneId ?? "");
  }, [selectedPanel]);

  const invalidate = async () => {
    if (chapterId) {
      await queryClient.invalidateQueries({ queryKey: comicKeys.panels(chapterId) });
      await queryClient.invalidateQueries({ queryKey: comicKeys.chapter(chapterId) });
    }
  };

  const generateMutation = useMutation({
    mutationFn: async (includeManual: boolean) => {
      if (!chapter) throw new Error("章节不存在");
      if (!project) throw new Error("项目不存在");
      // generateChapterPrompts 会原地改写传入对象，克隆后传入以免突变 react-query 缓存
      return generateChapterPrompts({
        chapter: structuredClone(chapter),
        panels: panels.map((panel) => structuredClone(panel)),
        project,
        characters,
        scenes,
        customFormula,
        includeManual,
        onProgress: (done, total) => setProgress({ done, total }),
      });
    },
    onSuccess: async (updated, includeManual) => {
      toast.success(
        includeManual
          ? `已重建 ${updated} 个分镜描述词（含手动编辑）`
          : `已生成 ${updated} 个分镜描述词（手动编辑的保持不变）`,
      );
      await invalidate();
    },
    onError: (error: Error) => toast.error(`描述词生成失败：${error.message}`),
    onSettled: () => setProgress(null),
  });

  const panelMutation = useMutation({
    mutationFn: async (task: () => Promise<unknown>) => task(),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error: Error) => toast.error(`保存失败：${error.message}`),
  });

  /** 一键修复绑定缺失：台词说话人→角色、唯一场景→场景、无人镜标记空镜 */
  const repairMutation = useMutation({
    mutationFn: async () => {
      if (!chapter) throw new Error("章节不存在");
      return repairPanelBindings({
        chapter: structuredClone(chapter),
        panels: panels.map((panel) => structuredClone(panel)),
        scenes,
      });
    },
    onSuccess: async (result) => {
      toast.success(
        result.repaired > 0
          ? `已修复 ${result.repaired} 个分镜的绑定${result.manual > 0 ? `，还有 ${result.manual} 镜请在右侧手动勾选角色` : ""}`
          : "没有需要自动修复的绑定",
      );
      await invalidate();
    },
    onError: (error: Error) => toast.error(`修复失败：${error.message}`),
  });

  /** 一键同步：先补齐台词重提（若有待更新），再重建描述词（画面重生成在生成步骤进行） */
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
          : "同步完成：描述词已与最新内容对齐",
      );
      await invalidate();
    },
    onError: (error: Error) => toast.error(`同步失败：${error.message}`),
  });

  if (chapters.length === 0) {
    return <EmptyHint text="还没有章节。先回到「内容导入」导入或生成正文。" />;
  }
  if (!chapter || !project) {
    return <EmptyHint text="请选择上方一个章节生成描述词。" />;
  }
  if (panels.length === 0) {
    return <EmptyHint text="本章还没有分镜。先回到「智能分镜」生成分镜，再来生成描述词。" />;
  }

  const busy = generateMutation.isPending || panelMutation.isPending || syncMutation.isPending || repairMutation.isPending;
  const promptCount = panels.filter((panel) => panel.prompt).length;
  const manualCount = panels.filter((panel) => panel.prompt?.manualOverride).length;

  const toggleBoundCharacter = (characterId: string) => {
    setBindCharacterIds((prev) =>
      prev.includes(characterId)
        ? prev.filter((id) => id !== characterId)
        : [...prev, characterId],
    );
  };

  const saveSelected = () => {
    if (!selectedPanel || !editingSegments || !chapter) return;
    const chapterSnapshot = structuredClone(chapter);
    panelMutation.mutate(async () => {
      await applyPromptEdit(chapterSnapshot, selectedPanel, editingSegments);
      await savePanelBinding({
        chapter: chapterSnapshot,
        panel: selectedPanel,
        characterIds: bindCharacterIds,
        sceneId: bindSceneId || undefined,
      });
    });
  };

  const resetSelected = () => {
    if (!selectedPanel) return;
    panelMutation.mutate(() =>
      resetPanelPrompt({ chapter, panel: selectedPanel, project, characters, scenes, customFormula }),
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

      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-3 border-b pb-3">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            if (
              unboundCount > 0 &&
              !window.confirm(
                `还有 ${unboundCount} 个分镜未绑定角色/场景，描述词会缺少角色或场景信息。可先点「一键修复」，或确定继续？`,
              )
            ) {
              return;
            }
            generateMutation.mutate(false);
          }}
        >
          {generateMutation.isPending ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 h-4 w-4" />
          )}
          {progress ? `${progress.done}/${progress.total}` : promptCount > 0 ? "补齐未生成的描述词" : "生成全部描述词"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            if (
              manualCount > 0 &&
              !window.confirm(`重新生成会覆盖全部 ${manualCount} 个手动编辑过的描述词，确定继续？`)
            ) {
              return;
            }
            generateMutation.mutate(true);
          }}
        >
          <RefreshCw className="mr-1.5 h-4 w-4" />
          重建全部（含手动）
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setTemplateDialogOpen(true)}>
          <Settings2 className="mr-1.5 h-4 w-4" />
          模板设置
        </Button>
        <span className="text-xs text-muted-foreground">
          共 {panels.length} 镜 · 已生成 {promptCount}
          {manualCount > 0 ? ` · ${manualCount} 镜手动编辑` : ""}
        </span>
      </div>

      {/* 待更新横幅：上游内容变化后提示同步 */}
      {stale && stale.summary.prompt > 0 ? (
        <div className="pt-3">
          <StaleBanner
            text={`分镜、角色或台词有更新，${stale.summary.prompt} 个分镜的描述词需要重建`}
            actionLabel="一键同步"
            busy={syncMutation.isPending}
            onAction={() => syncMutation.mutate()}
          />
        </div>
      ) : null}

      {/* 绑定检查条：描述词需要角色/场景信息才能组装出完整画面 */}
      {unboundCount > 0 ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <span className="text-xs text-amber-700 dark:text-amber-400">
            {unboundCount} 个分镜未绑定出场角色或场景，描述词会缺少画面主体信息
          </span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => repairMutation.mutate()}>
            {repairMutation.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Wand2 className="mr-1.5 h-4 w-4" />
            )}
            一键修复
          </Button>
        </div>
      ) : null}

      {/* 主体：左列表 / 右编辑 */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 pt-4 lg:grid-cols-2">
        <section className="flex min-h-0 flex-col rounded-xl bg-muted/20">
          <div className="px-3 pb-1 pt-2 text-xs text-muted-foreground">
            分镜列表（点击查看与编辑描述词）
          </div>
          <PromptPanelList
            panels={panels}
            staleIds={stale?.promptIds ?? EMPTY_IDS}
            selectedPanelId={selectedPanelId}
            onSelect={setSelectedPanelId}
          />
        </section>

        <section className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-xl bg-muted/20 p-3">
          {selectedPanel && editingSegments ? (
            <>
              <div className="rounded-lg bg-background/60 px-3 py-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">最终描述词</span>
                  <div className="flex items-center gap-1">
                    {selectedPanel.prompt?.manualOverride ? (
                      <Badge variant="secondary" className="text-[10px]">
                        手动编辑
                      </Badge>
                    ) : selectedPanel.prompt ? (
                      <Badge variant="outline" className="text-[10px]">
                        自动组装
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">
                        未生成
                      </Badge>
                    )}
                    <button
                      type="button"
                      title="复制描述词"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(selectedPanel.prompt?.final ?? "")
                          .then(() => toast.success("已复制"));
                      }}
                      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <p className="text-xs leading-relaxed">
                  {selectedPanel.prompt?.final || "尚未生成。点击左上角「生成全部描述词」，或直接在下方分段编辑后保存。"}
                </p>
              </div>

              {/* 本镜绑定：出场角色/场景是描述词「角色/场景段」的信息来源 */}
              <div className="rounded-lg bg-background/60 px-3 py-2">
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">本镜绑定</div>
                <div className="text-xs text-muted-foreground">出场角色</div>
                {characters.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {characters.map((character) => {
                      const active = bindCharacterIds.includes(character.id);
                      return (
                        <button
                          key={character.id}
                          type="button"
                          onClick={() => toggleBoundCharacter(character.id)}
                          className={cn(
                            "rounded-full px-2.5 py-0.5 text-xs transition-colors",
                            active
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                        >
                          {character.name}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    项目还没有角色卡，先到「角色场景」步骤创建。
                  </p>
                )}
                {scenes.length > 0 ? (
                  <label className="mt-2 block">
                    <span className="mb-1 block text-xs text-muted-foreground">所属场景</span>
                    <select
                      value={bindSceneId}
                      onChange={(event) => setBindSceneId(event.target.value)}
                      className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="">未绑定</option>
                      {scenes.map((scene) => (
                        <option key={scene.id} value={scene.id}>
                          {scene.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    项目还没有场景卡，先到「角色场景」步骤创建。
                  </p>
                )}
                <p className="mt-2 text-[11px] text-muted-foreground">
                  绑定后点「保存本镜」，描述词的角色/场景段会引用对应卡片信息。
                </p>
              </div>

              {SEGMENT_KEYS.map((key) => (
                <label key={key} className="block">
                  <span className="mb-1 block text-xs text-muted-foreground">
                    {SEGMENT_LABELS[key]}
                  </span>
                  <textarea
                    value={editingSegments[key]}
                    onChange={(event) =>
                      setEditingSegments((prev) =>
                        prev ? { ...prev, [key]: event.target.value } : prev,
                      )
                    }
                    rows={2}
                    className={TEXTAREA_CLASS}
                  />
                </label>
              ))}

              <div className="flex items-center gap-2">
                <Button size="sm" disabled={busy} onClick={saveSelected}>
                  保存本镜
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={resetSelected}
                >
                  <RotateCcw className="mr-1.5 h-4 w-4" />
                  重置为自动
                </Button>
                <span className="text-xs text-muted-foreground">
                  保存后标记为手动，批量生成默认跳过
                </span>
              </div>
            </>
          ) : (
            <p className="py-16 text-center text-sm text-muted-foreground">
              从左侧选择一个分镜查看与编辑描述词。
            </p>
          )}
        </section>
      </div>

      <TemplateDialog
        open={templateDialogOpen}
        onOpenChange={setTemplateDialogOpen}
        currentTemplates={currentTemplates}
        hasCustom={Boolean(customFormula)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 分镜列表（虚拟滚动）
// ---------------------------------------------------------------------------

function PromptPanelList(props: {
  panels: ComicPanel[];
  staleIds: ReadonlySet<string>;
  selectedPanelId: string | null;
  onSelect: (panelId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: props.panels.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 84,
    overscan: 4,
    getItemKey: (index) => props.panels[index]?.id ?? index,
  });

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const panel = props.panels[item.index];
          if (!panel) return null;
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
                  {panel.prompt?.manualOverride ? (
                    <Badge variant="secondary" className="text-[10px]">
                      手动
                    </Badge>
                  ) : panel.prompt ? (
                    <Badge variant="outline" className="text-[10px]">
                      自动
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      未生成
                    </Badge>
                  )}
                  {props.staleIds.has(panel.id) ? <StaleBadge /> : null}
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {panel.prompt?.final || "尚未生成描述词"}
                </p>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 模板编辑对话框
// ---------------------------------------------------------------------------

function TemplateDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentTemplates: Record<keyof PromptSegments, string>;
  hasCustom: boolean;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<keyof PromptSegments, string>>(props.currentTemplates);

  // 打开时同步当前生效模板
  useEffect(() => {
    if (props.open) {
      setDraft({ ...props.currentTemplates });
    }
  }, [props.open, props.currentTemplates]);

  const saveMutation = useMutation({
    mutationFn: async (formula: CustomPromptFormula | null) => saveCustomPromptFormula(formula),
    onSuccess: async (_data, formula) => {
      toast.success(formula ? "个人模板已保存，将用于后续描述词生成" : "已恢复默认模板");
      await queryClient.invalidateQueries({ queryKey: comicKeys.settings });
      props.onOpenChange(false);
    },
    onError: (error: Error) => toast.error(`模板保存失败：${error.message}`),
  });

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <AppDialogContent
        title="描述词模板设置"
        description="每个段落是一个模板，{占位符} 会在生成时替换为项目与分镜的实际内容。留空表示该段不参与拼接。"
        bodyClassName="max-w-2xl"
        footer={
          <>
            <Button
              variant="outline"
              disabled={saveMutation.isPending || !props.hasCustom}
              onClick={() => saveMutation.mutate(null)}
            >
              恢复默认
            </Button>
            <Button
              disabled={saveMutation.isPending}
              onClick={() =>
                saveMutation.mutate({
                  segmentTemplates: { ...draft },
                  updatedAt: new Date().toISOString(),
                })
              }
            >
              保存模板
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {SEGMENT_KEYS.map((key) => (
            <label key={key} className="block">
              <span className="mb-1 block text-xs text-muted-foreground">{SEGMENT_LABELS[key]}段模板</span>
              <textarea
                value={draft[key]}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, [key]: event.target.value }))
                }
                rows={2}
                className={TEXTAREA_CLASS}
              />
            </label>
          ))}
        </div>
      </AppDialogContent>
    </Dialog>
  );
}

function EmptyHint(props: { text: string }) {
  return (
    <div className="rounded-xl bg-muted/30 px-6 py-16 text-center text-sm text-muted-foreground">
      {props.text}
    </div>
  );
}
