/**
 * 步骤四：角色场景
 *
 * 项目级角色库/场景库（跨章节共享）：AI 从当前章节提取 → 同名自动合并，
 * 支持手动编辑、正/侧面参考图上传（Blob 本机存储）、重复卡合并去重。
 * 角色卡支持 AI 补全五要素设定与 7 视图人物设计图（4 全身转向 + 3 面部特写），
 * 场景卡支持概念图生成；两类图都可预览与重新生成，生图走主程序任务链。
 * 卡片描述词片段会随设定保存自动重组，供描述词引擎（下一步）引用。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ImageUp,
  Loader2,
  Maximize2,
  Merge,
  PencilLine,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppDialogContent, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  comicKeys,
  useMainAiStatus,
  useComicCharacters,
  useComicChapters,
  useComicPanels,
  useComicProject,
  useComicScenes,
} from "../../hooks/useComicQuery";
import { useComicWorkbenchStore } from "../../stores/workbenchStore";
import { useReportStepReady } from "../../components/common/StepNavFooter";
import {
  bumpCastVersion,
  CHARACTER_DESIGN_VIEW_SPECS,
  completeCharacterWithAi,
  extractCastFromChapter,
  generateCharacterDesignView,
  generateSceneImage,
  loadReferenceImageBlob,
  mergeCharacterInto,
  mergeSceneInto,
  removeCharacter,
  removeScene,
  saveCharacterCard,
  saveSceneCard,
  uploadCharacterReference,
  type ReferenceSide,
} from "../../services/cast/castService";
import { fetchMainAiStatus, getAiSettings } from "../../services/ai/aiConfigService";
import { AiError, describeAiError } from "../../services/ai/llmClient";
import { getImageRecord } from "../../db/comicDb";
import { ComicRulesDialog } from "./ComicRulesDialog";
import type {
  CharacterDesignView,
  ComicCharacter,
  ComicScene,
  SceneDynamicParams,
} from "../../types";

export function CastStepPanel(props: { projectId: string; onReadyChange?: (ready: boolean, hint?: string) => void }) {
  const { projectId } = props;
  const queryClient = useQueryClient();
  const chapterId = useComicWorkbenchStore((state) => state.chapterId);
  const openChapter = useComicWorkbenchStore((state) => state.openChapter);

  const chaptersQuery = useComicChapters(projectId);
  const chapters = useMemo(
    () => [...(chaptersQuery.data ?? [])].sort((a, b) => a.index - b.index),
    [chaptersQuery.data],
  );
  const panelsQuery = useComicPanels(chapterId);
  const panelCount = panelsQuery.data?.length ?? 0;
  const charactersQuery = useComicCharacters(projectId);
  const characters = charactersQuery.data ?? [];
  const scenesQuery = useComicScenes(projectId);
  const scenes = scenesQuery.data ?? [];

  useReportStepReady(
    props.onReadyChange,
    panelCount > 0,
    panelCount > 0
      ? undefined
      : chapterId
        ? "该章节还没有分镜；回到「智能分镜」先生成分镜，角色/场景提取会更有依据"
        : "先选择一个章节",
  );

  const [editingCharacter, setEditingCharacter] = useState<ComicCharacter | null>(null);
  const [editingScene, setEditingScene] = useState<ComicScene | null>(null);
  const [mergingCharacter, setMergingCharacter] = useState<ComicCharacter | null>(null);
  const [mergingScene, setMergingScene] = useState<ComicScene | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);

  const projectQuery = useComicProject(projectId);
  const project = projectQuery.data;

  const mainAiStatus = useMainAiStatus();
  const llmReady = mainAiStatus.data?.llmReady ?? false;
  const imageReady = mainAiStatus.data?.imageReady ?? false;

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: comicKeys.characters(projectId) });
    await queryClient.invalidateQueries({ queryKey: comicKeys.scenes(projectId) });
    await queryClient.invalidateQueries({ queryKey: comicKeys.chapters(projectId) });
  };

  const extractMutation = useMutation({
    mutationFn: async () => {
      const chapter = chapters.find((item) => item.id === chapterId);
      if (!chapter) throw new Error("请先选择一个章节作为提取来源");
      if (!llmReady) throw new Error("主程序文本模型未就绪，请先在主程序「模型设置」中配置");
      return extractCastFromChapter({ chapter });
    },
    onSuccess: async (result) => {
      toast.success(
        `提取完成：新增角色 ${result.addedCharacters}、合并 ${result.mergedCharacters}；新增场景 ${result.addedScenes}、合并 ${result.mergedScenes}`,
      );
      await invalidate();
    },
    onError: (error: Error) => toast.error(describeAiError(error)),
  });

  const characterMutation = useMutation({
    mutationFn: async (task: () => Promise<unknown>) => task(),
    onSuccess: async (_data, _task) => {
      await invalidate();
    },
    onError: (error: Error) => toast.error(`操作失败：${error.message}`),
  });

  const sceneMutation = useMutation({
    mutationFn: async (task: () => Promise<unknown>) => task(),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error: Error) => toast.error(`操作失败：${error.message}`),
  });

  // ---------------------------------------------------------------------------
  // AI 补全设定 / 人物设计图 / 场景概念图
  // ---------------------------------------------------------------------------

  /** 生图前的统一检查：主程序生图模型就绪 + 项目可用 */
  const ensureImageReady = async () => {
    if (!project) throw new Error("项目不存在");
    const status = await fetchMainAiStatus();
    if (!status.imageReady) {
      throw new AiError("notConfigured", "主程序尚未配置可用的生图模型，请先在主程序「模型设置」中配置");
    }
    const settings = await getAiSettings();
    return settings?.image ?? null;
  };

  /** 逐张生成设计图并实时回报进度；串行执行，单张成功即落库 */
  const [designProgress, setDesignProgress] = useState<{
    characterId?: string;
    sceneId?: string;
    message: string;
  } | null>(null);

  const runDesignViews = async (character: ComicCharacter, views: CharacterDesignView[]) => {
    const imageChoice = await ensureImageReady();
    if (!project) throw new Error("项目不存在");
    let current = character;
    for (let i = 0; i < views.length; i += 1) {
      current = await generateCharacterDesignView({
        character: current,
        project,
        imageChoice,
        view: views[i],
        onProgress: (message) =>
          setDesignProgress({ characterId: character.id, message: `${message}（${i + 1}/${views.length}）` }),
      });
    }
    return current;
  };

  const designMutation = useMutation({
    mutationFn: async (task: () => Promise<unknown>) => task(),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error: Error) => toast.error(describeAiError(error)),
    onSettled: () => setDesignProgress(null),
  });

  const completeMutation = useMutation({
    mutationFn: async (character: ComicCharacter) => {
      if (!llmReady) throw new AiError("notConfigured", "主程序文本模型未就绪，请先在主程序「模型设置」中配置");
      const chapter = chapters.find((item) => item.id === chapterId);
      return completeCharacterWithAi({ character, chapter });
    },
    onSuccess: async (updated) => {
      toast.success(`「${updated.name}」设定已补全，可检查后生成设计图`);
      await invalidate();
    },
    onError: (error: Error) => toast.error(describeAiError(error)),
  });

  // 大图预览（角色设计图 / 场景概念图共用）
  const [preview, setPreview] = useState<{ url: string; title: string; isObjectUrl: boolean } | null>(null);
  const openPreview = async (imageId: string | undefined, title: string) => {
    if (!imageId) return;
    const blob = await loadReferenceImageBlob(imageId);
    if (blob) {
      setPreview({ url: URL.createObjectURL(blob), title, isObjectUrl: true });
      return;
    }
    const record = await getImageRecord(imageId);
    if (record?.remoteUrl) {
      setPreview({ url: record.remoteUrl, title, isObjectUrl: false });
      return;
    }
    toast.error("图片不存在或已被清理，请重新生成");
  };
  useEffect(
    () => () => {
      if (preview?.isObjectUrl) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );

  const busy =
    extractMutation.isPending ||
    characterMutation.isPending ||
    sceneMutation.isPending ||
    designMutation.isPending ||
    completeMutation.isPending;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-3 border-b pb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">提取来源章节</span>
          {chapters.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => openChapter(item.id)}
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
          {chapters.length === 0 && (
            <span className="text-xs text-muted-foreground">暂无章节，请先完成内容导入</span>
          )}
        </div>
        <Button
          size="sm"
          disabled={busy || !llmReady || !chapterId}
          onClick={() => extractMutation.mutate()}
        >
          {extractMutation.isPending ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-1.5 h-4 w-4" />
          )}
          AI 提取角色与场景
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !project}
          onClick={() => setRulesOpen(true)}
        >
          <SlidersHorizontal className="mr-1.5 h-4 w-4" />
          漫画规则
        </Button>
        <span className="text-xs text-muted-foreground">
          角色库与场景库整个项目共用；同名卡片会自动合并保留已有设定
        </span>
      </div>

      {/* 主体：角色库 / 场景库 */}
      <div className="grid flex-1 grid-cols-1 gap-4 pt-4 lg:grid-cols-2">
        <section className="flex min-h-0 flex-col rounded-xl bg-muted/20">
          <div className="flex items-center justify-between px-3 pb-1 pt-2">
            <span className="text-xs text-muted-foreground">角色库（{characters.length}）</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() =>
                setEditingCharacter({
                  id: "",
                  projectId,
                  name: "",
                  gender: "未知",
                  appearance: "",
                  clothing: "",
                  features: "",
                  promptFragment: "",
                  updatedAt: "",
                })
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              手动添加
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
            {characters.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                还没有角色卡。选择章节后点击「AI 提取角色与场景」，或手动添加。
              </div>
            ) : (
              characters.map((character) => (
                <CharacterCard
                  key={character.id}
                  character={character}
                  characters={characters}
                  busy={busy}
                  imageReady={imageReady}
                  progress={designProgress?.characterId === character.id ? designProgress.message : null}
                  onEdit={() => setEditingCharacter(character)}
                  onMerge={() => setMergingCharacter(character)}
                  onDelete={() =>
                    characterMutation.mutate(() => removeCharacter(character.id, projectId))
                  }
                  onUpload={(file, side) =>
                    characterMutation.mutate(() => uploadCharacterReference(character, file, side))
                  }
                  onCompleteAi={() => completeMutation.mutate(character)}
                  onGenerateAllDesign={(regenerate) =>
                    designMutation.mutate(async () => {
                      const views = regenerate
                        ? CHARACTER_DESIGN_VIEW_SPECS.map((item) => item.view)
                        : CHARACTER_DESIGN_VIEW_SPECS.map((item) => item.view).filter(
                            (view) => !character.designImages?.[view],
                          );
                      if (views.length === 0) {
                        toast.info("全套设计图已生成，可点击单个视图重新生成");
                        return;
                      }
                      await runDesignViews(character, views);
                      toast.success(`「${character.name}」设计图已生成（${views.length} 张）`);
                    })
                  }
                  onGenerateDesignView={(view) =>
                    designMutation.mutate(async () => {
                      await runDesignViews(character, [view]);
                    })
                  }
                  onPreview={(imageId, title) => void openPreview(imageId, title)}
                />
              ))
            )}
          </div>
        </section>

        <section className="flex min-h-0 flex-col rounded-xl bg-muted/20">
          <div className="flex items-center justify-between px-3 pb-1 pt-2">
            <span className="text-xs text-muted-foreground">场景库（{scenes.length}）</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() =>
                setEditingScene({
                  id: "",
                  projectId,
                  name: "",
                  spaceStructure: "",
                  environment: "",
                  dynamic: { time: "", weather: "", lighting: "" },
                  promptFragment: "",
                  updatedAt: "",
                })
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              手动添加
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
            {scenes.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                还没有场景卡。AI 会从正文提取具体地点的空间结构与氛围，也可手动添加。
              </div>
            ) : (
              scenes.map((scene) => (
                <SceneCard
                  key={scene.id}
                  scene={scene}
                  scenes={scenes}
                  busy={busy}
                  imageReady={imageReady}
                  progress={designProgress?.sceneId === scene.id ? designProgress.message : null}
                  onEdit={() => setEditingScene(scene)}
                  onMerge={() => setMergingScene(scene)}
                  onDelete={() => sceneMutation.mutate(() => removeScene(scene.id, projectId))}
                  onDynamic={(updates) =>
                    sceneMutation.mutate(() => saveSceneCard(scene, { dynamic: updates }))
                  }
                  onGenerateImage={() =>
                    designMutation.mutate(async () => {
                      const imageChoice = await ensureImageReady();
                      if (!project) throw new Error("项目不存在");
                      setDesignProgress({ sceneId: scene.id, message: "正在生成场景概念图…" });
                      await generateSceneImage({ scene, project, imageChoice });
                    })
                  }
                  onPreview={(imageId, title) => void openPreview(imageId, title)}
                />
              ))
            )}
          </div>
        </section>
      </div>

      {/* 编辑弹窗 */}
      {editingCharacter && (
        <CharacterEditorDialog
          character={editingCharacter}
          isNew={editingCharacter.id === ""}
          onClose={() => setEditingCharacter(null)}
          onSave={(updates) =>
            characterMutation.mutate(async () => {
              if (editingCharacter.id === "") {
                const fresh: ComicCharacter = {
                  ...editingCharacter,
                  ...updates,
                  id: `char_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
                  updatedAt: new Date().toISOString(),
                };
                await saveCharacterCard(fresh, {});
                // 新增角色（即使只填姓名）也影响说话人归属，需要标记台词待更新
                await bumpCastVersion(projectId);
              } else {
                await saveCharacterCard(editingCharacter, updates);
              }
              setEditingCharacter(null);
              toast.success("角色卡已保存");
            })
          }
        />
      )}
      {editingScene && (
        <SceneEditorDialog
          scene={editingScene}
          isNew={editingScene.id === ""}
          onClose={() => setEditingScene(null)}
          onSave={(updates) =>
            sceneMutation.mutate(async () => {
              if (editingScene.id === "") {
                const fresh: ComicScene = {
                  ...editingScene,
                  ...updates,
                  id: `scene_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
                  updatedAt: new Date().toISOString(),
                };
                await saveSceneCard(fresh, {});
              } else {
                await saveSceneCard(editingScene, updates);
              }
              setEditingScene(null);
              toast.success("场景卡已保存");
            })
          }
        />
      )}
      {mergingCharacter && (
        <MergeDialog
          title={`合并角色「${mergingCharacter.name}」`}
          description="选择要并入的目标角色：被合并卡的空缺设定会补充过去，已有的重复角色卡会被删除。"
          items={characters.filter((item) => item.id !== mergingCharacter.id)}
          onClose={() => setMergingCharacter(null)}
          onPick={(targetId) =>
            characterMutation.mutate(async () => {
              await mergeCharacterInto(projectId, targetId, mergingCharacter.id);
              setMergingCharacter(null);
              toast.success("角色已合并");
            })
          }
        />
      )}
      {mergingScene && (
        <MergeDialog
          title={`合并场景「${mergingScene.name}」`}
          description="选择要并入的目标场景：空缺字段会补充过去，被合并的重复场景卡会被删除。"
          items={scenes.filter((item) => item.id !== mergingScene.id)}
          onClose={() => setMergingScene(null)}
          onPick={(targetId) =>
            sceneMutation.mutate(async () => {
              await mergeSceneInto(projectId, targetId, mergingScene.id);
              setMergingScene(null);
              toast.success("场景已合并");
            })
          }
        />
      )}
      {rulesOpen && project && (
        <ComicRulesDialog projectId={projectId} onClose={() => setRulesOpen(false)} />
      )}
      {preview && (
        <Dialog open onOpenChange={(open) => !open && setPreview(null)}>
          <AppDialogContent title={preview.title} description="生成图保存在本机项目内，可随时重新生成">
            <div className="flex max-h-[70vh] items-center justify-center overflow-hidden rounded-lg bg-muted/30 p-2">
              <img
                src={preview.url}
                alt={preview.title}
                className="max-h-[64vh] max-w-full rounded object-contain"
              />
            </div>
          </AppDialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 角色卡
// ---------------------------------------------------------------------------

function CharacterCard(props: {
  character: ComicCharacter;
  characters: ComicCharacter[];
  busy: boolean;
  imageReady: boolean;
  progress: string | null;
  onEdit: () => void;
  onMerge: () => void;
  onDelete: () => void;
  onUpload: (file: File, side: ReferenceSide) => void;
  onCompleteAi: () => void;
  onGenerateAllDesign: (regenerate: boolean) => void;
  onGenerateDesignView: (view: CharacterDesignView) => void;
  onPreview: (imageId: string | undefined, title: string) => void;
}) {
  const { character, characters, busy, imageReady, progress } = props;
  const designImages = character.designImages ?? {};
  const generatedCount = CHARACTER_DESIGN_VIEW_SPECS.filter((spec) => designImages[spec.view]).length;
  const designStale =
    generatedCount > 0 &&
    Boolean(character.designBasisStamp) &&
    character.designBasisStamp !== character.promptFragment;
  return (
    <div className="rounded-lg bg-background/60 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <div className="flex gap-1.5">
          <ReferenceThumb imageId={character.frontImageId} side="正面" />
          <ReferenceThumb imageId={character.sideImageId} side="侧面" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold">{character.name}</span>
            <Badge variant="secondary" className="text-[10px]">
              {character.gender}
            </Badge>
            {character.mergedFrom && character.mergedFrom.length > 0 && (
              <Badge variant="outline" className="text-[10px]">
                已合并 {character.mergedFrom.length} 张卡
              </Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {character.appearance || "外貌待补充（可点「AI 补全设定」）"}
            {character.clothing ? ` · ${character.clothing}` : ""}
            {character.features ? ` · ${character.features}` : ""}
            {character.palette ? ` · 主色调：${character.palette}` : ""}
          </p>
          <p className="mt-1 line-clamp-1 text-[10px] text-muted-foreground/70">
            描述词片段：{character.promptFragment || "（保存设定后自动生成）"}
          </p>
        </div>
      </div>

      {/* 7 视图人物设计图 */}
      <div className="mt-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">
            人物设计图（{generatedCount}/7）
            {designStale && (
              <span className="ml-1 text-amber-600">设定已更新，建议重新生成</span>
            )}
          </span>
          <button
            type="button"
            disabled={busy || !imageReady}
            title={imageReady ? undefined : "主程序生图模型未就绪"}
            onClick={() => props.onGenerateAllDesign(generatedCount >= CHARACTER_DESIGN_VIEW_SPECS.length)}
            className="flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
          >
            {generatedCount >= CHARACTER_DESIGN_VIEW_SPECS.length ? (
              <RefreshCw className="h-3 w-3" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            {generatedCount >= CHARACTER_DESIGN_VIEW_SPECS.length ? "重新生成全套" : "生成全套设计图"}
          </button>
        </div>
        <div className="mt-1 grid grid-cols-7 gap-1">
          {CHARACTER_DESIGN_VIEW_SPECS.map((spec) => (
            <DesignThumbSlot
              key={spec.view}
              label={spec.label}
              imageId={designImages[spec.view]}
              disabled={busy || !imageReady}
              onGenerate={() => props.onGenerateDesignView(spec.view)}
              onPreview={() => props.onPreview(designImages[spec.view], `${character.name}·${spec.label}`)}
            />
          ))}
        </div>
      </div>

      {progress && (
        <p className="mt-1.5 flex items-center gap-1 text-[10px] text-primary">
          <Loader2 className="h-3 w-3 animate-spin" />
          {progress}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <CardAction
          title="AI 依据当前章节原文补全发型/眼睛/脸型/体型/色板等完整设定"
          disabled={busy}
          onClick={props.onCompleteAi}
        >
          <Sparkles className="h-3.5 w-3.5" />
          AI 补全设定
        </CardAction>
        <UploadButton label="正面图" side="front" disabled={busy} onUpload={props.onUpload} />
        <UploadButton label="侧面图" side="side" disabled={busy} onUpload={props.onUpload} />
        <CardAction title="编辑设定" disabled={busy} onClick={props.onEdit}>
          <PencilLine className="h-3.5 w-3.5" />
          编辑
        </CardAction>
        <CardAction
          title="与其他重复卡合并"
          disabled={busy || characters.length < 2}
          onClick={props.onMerge}
        >
          <Merge className="h-3.5 w-3.5" />
          合并去重
        </CardAction>
        <CardAction title="删除角色卡" disabled={busy} onClick={props.onDelete} danger>
          <Trash2 className="h-3.5 w-3.5" />
          删除
        </CardAction>
      </div>
    </div>
  );
}

function UploadButton(props: {
  label: string;
  side: ReferenceSide;
  disabled: boolean;
  onUpload: (file: File, side: ReferenceSide) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        disabled={props.disabled}
        onClick={() => inputRef.current?.click()}
        className="flex h-6 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <ImageUp className="h-3.5 w-3.5" />
        {props.label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) props.onUpload(file, props.side);
        }}
      />
    </>
  );
}

/** 读取图片展示地址：优先本地 Blob，跨域下载失败时回退 remoteUrl */
function useImageDisplayUrl(imageId?: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    setUrl(null);
    if (!imageId) return;
    void (async () => {
      const blob = await loadReferenceImageBlob(imageId);
      if (blob && !revoked) {
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        return;
      }
      const record = await getImageRecord(imageId);
      if (!revoked && record?.remoteUrl) {
        setUrl(record.remoteUrl);
      }
    })();
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageId]);
  return url;
}

function ReferenceThumb(props: { imageId?: string; side: string }) {
  const url = useImageDisplayUrl(props.imageId);
  if (!props.imageId || !url) {
    return (
      <div className="flex h-14 w-11 flex-col items-center justify-center rounded border border-dashed border-border/70 bg-muted/30 text-[9px] text-muted-foreground/60">
        <UserRound className="mb-0.5 h-3.5 w-3.5" />
        {props.side}
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={props.side}
      className="h-14 w-11 rounded border border-border/70 object-cover"
    />
  );
}

/** 设计图槽位：无图时点击生成，有图时点击预览 + 悬停出现重新生成按钮 */
function DesignThumbSlot(props: {
  label: string;
  imageId?: string;
  disabled: boolean;
  onGenerate: () => void;
  onPreview: () => void;
}) {
  const url = useImageDisplayUrl(props.imageId);
  return (
    <div className="group relative">
      {props.imageId && url ? (
        <button
          type="button"
          title={`预览「${props.label}」`}
          onClick={props.onPreview}
          className="block w-full"
        >
          <img
            src={url}
            alt={props.label}
            className="h-12 w-full rounded border border-border/70 object-cover"
          />
        </button>
      ) : (
        <button
          type="button"
          title={props.disabled ? "生图模型未就绪或操作进行中" : `生成「${props.label}」设计图`}
          disabled={props.disabled}
          onClick={props.onGenerate}
          className="flex h-12 w-full items-center justify-center rounded border border-dashed border-border/70 bg-muted/30 text-[8px] leading-tight text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          {props.label}
        </button>
      )}
      {props.imageId && (
        <button
          type="button"
          title={`重新生成「${props.label}」`}
          disabled={props.disabled}
          onClick={props.onGenerate}
          className="absolute right-0.5 top-0.5 hidden rounded bg-background/85 p-0.5 text-muted-foreground transition-colors hover:text-foreground group-hover:block disabled:opacity-40"
        >
          <RefreshCw className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 场景卡
// ---------------------------------------------------------------------------

function SceneCard(props: {
  scene: ComicScene;
  scenes: ComicScene[];
  busy: boolean;
  imageReady: boolean;
  progress: string | null;
  onEdit: () => void;
  onMerge: () => void;
  onDelete: () => void;
  onDynamic: (updates: SceneDynamicParams) => void;
  onGenerateImage: () => void;
  onPreview: (imageId: string | undefined, title: string) => void;
}) {
  const { scene, scenes, busy, imageReady, progress, onDynamic } = props;
  const imageStale =
    Boolean(scene.imageId) &&
    Boolean(scene.imageBasisStamp) &&
    scene.imageBasisStamp !== scene.promptFragment;
  return (
    <div className="rounded-lg bg-background/60 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <SceneThumbSlot
          imageId={scene.imageId}
          disabled={busy || !imageReady}
          onGenerate={props.onGenerateImage}
          onPreview={() => props.onPreview(scene.imageId, `场景·${scene.name}`)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold">{scene.name}</span>
            {scene.mergedFrom && scene.mergedFrom.length > 0 && (
              <Badge variant="outline" className="text-[10px]">
                已合并 {scene.mergedFrom.length} 张卡
              </Badge>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {scene.spaceStructure || "空间结构待补充"}
            {scene.environment ? ` · ${scene.environment}` : ""}
          </p>
          <p className="mt-1 line-clamp-1 text-[10px] text-muted-foreground/70">
            描述词片段：{scene.promptFragment || "（保存设定后自动生成）"}
          </p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground">动态参数（默认值）</span>
        <DynamicInput
          placeholder="时间"
          value={scene.dynamic.time}
          disabled={busy}
          onCommit={(value) => onDynamic({ ...scene.dynamic, time: value })}
        />
        <DynamicInput
          placeholder="天气"
          value={scene.dynamic.weather}
          disabled={busy}
          onCommit={(value) => onDynamic({ ...scene.dynamic, weather: value })}
        />
        <DynamicInput
          placeholder="光影"
          value={scene.dynamic.lighting}
          disabled={busy}
          onCommit={(value) => onDynamic({ ...scene.dynamic, lighting: value })}
        />
      </div>
      {progress && (
        <p className="mt-1.5 flex items-center gap-1 text-[10px] text-primary">
          <Loader2 className="h-3 w-3 animate-spin" />
          {progress}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <CardAction
          title={
            scene.imageId
              ? imageStale
                ? "设定已更新，重新生成场景概念图"
                : "重新生成场景概念图"
              : "生成场景概念图"
          }
          disabled={busy || !imageReady}
          onClick={props.onGenerateImage}
        >
          {scene.imageId ? <RefreshCw className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
          {scene.imageId ? "重新生成概念图" : "AI 生成概念图"}
        </CardAction>
        {imageStale && (
          <span className="text-[10px] text-amber-600">设定已更新，建议重新生成</span>
        )}
        <CardAction title="编辑设定" disabled={busy} onClick={props.onEdit}>
          <PencilLine className="h-3.5 w-3.5" />
          编辑
        </CardAction>
        <CardAction
          title="与其他重复卡合并"
          disabled={busy || scenes.length < 2}
          onClick={props.onMerge}
        >
          <Merge className="h-3.5 w-3.5" />
          合并去重
        </CardAction>
        <CardAction title="删除场景卡" disabled={busy} onClick={props.onDelete} danger>
          <Trash2 className="h-3.5 w-3.5" />
          删除
        </CardAction>
      </div>
    </div>
  );
}

/** 场景概念图缩略：无图时点击生成，有图时点击预览（悬停出现重新生成） */
function SceneThumbSlot(props: {
  imageId?: string;
  disabled: boolean;
  onGenerate: () => void;
  onPreview: () => void;
}) {
  const url = useImageDisplayUrl(props.imageId);
  return (
    <div className="group relative shrink-0">
      {props.imageId && url ? (
        <button
          type="button"
          title="预览场景概念图"
          onClick={props.onPreview}
          className="block"
        >
          <img
            src={url}
            alt="场景概念图"
            className="h-14 w-24 rounded border border-border/70 object-cover"
          />
        </button>
      ) : (
        <button
          type="button"
          title={props.disabled ? "生图模型未就绪或操作进行中" : "生成场景概念图"}
          disabled={props.disabled}
          onClick={props.onGenerate}
          className="flex h-14 w-24 flex-col items-center justify-center gap-0.5 rounded border border-dashed border-border/70 bg-muted/30 text-[9px] text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Sparkles className="h-3.5 w-3.5" />
          生成概念图
        </button>
      )}
      {props.imageId && (
        <button
          type="button"
          title="重新生成场景概念图"
          disabled={props.disabled}
          onClick={props.onGenerate}
          className="absolute right-0.5 top-0.5 hidden rounded bg-background/85 p-0.5 text-muted-foreground transition-colors hover:text-foreground group-hover:block disabled:opacity-40"
        >
          <RefreshCw className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  );
}

function DynamicInput(props: {
  placeholder: string;
  value: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  return (
    <input
      defaultValue={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onBlur={(event) => {
        if (event.target.value !== props.value) props.onCommit(event.target.value);
      }}
      className="h-6 w-20 rounded border border-border bg-transparent px-1.5 text-[10px] placeholder:text-muted-foreground/50"
    />
  );
}

function CardAction(props: {
  title: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "flex h-6 items-center gap-1 rounded px-1.5 text-[10px] transition-colors disabled:opacity-40",
        props.danger
          ? "text-destructive hover:bg-destructive/10"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 编辑弹窗
// ---------------------------------------------------------------------------

interface CharacterFormState {
  name: string;
  gender: string;
  appearance: string;
  clothing: string;
  features: string;
  palette: string;
  promptFragment: string;
}

function CharacterEditorDialog(props: {
  character: ComicCharacter;
  isNew: boolean;
  onClose: () => void;
  onSave: (updates: Partial<CharacterFormState>) => void;
}) {
  const [form, setForm] = useState<CharacterFormState>({
    name: props.character.name,
    gender: props.character.gender,
    appearance: props.character.appearance,
    clothing: props.character.clothing,
    features: props.character.features,
    palette: props.character.palette ?? "",
    promptFragment: props.character.promptFragment,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <AppDialogContent
        title={props.isNew ? "添加角色卡" : `编辑角色「${props.character.name}」`}
        description="外貌/服装/特征越具体，生成时角色越稳定；保存后会自动重组描述词片段。"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={props.onClose}>
              取消
            </Button>
            <Button size="sm" disabled={!form.name.trim()} onClick={() => props.onSave(form)}>
              保存
            </Button>
          </div>
        }
      >
        <div className="space-y-3 overflow-y-auto px-6 py-4">
          <div className="flex gap-3">
            <LabeledInput
              label="姓名"
              value={form.name}
              onChange={(value) => setForm((prev) => ({ ...prev, name: value }))}
            />
            <LabeledInput
              label="性别"
              value={form.gender}
              onChange={(value) => setForm((prev) => ({ ...prev, gender: value }))}
            />
          </div>
          <LabeledTextarea
            label="外貌（发型发色/五官/体型）"
            value={form.appearance}
            onChange={(value) => setForm((prev) => ({ ...prev, appearance: value }))}
          />
          <LabeledTextarea
            label="服装"
            value={form.clothing}
            onChange={(value) => setForm((prev) => ({ ...prev, clothing: value }))}
          />
          <LabeledTextarea
            label="辨识特征（疤/饰物/习惯动作）"
            value={form.features}
            onChange={(value) => setForm((prev) => ({ ...prev, features: value }))}
          />
          <LabeledInput
            label="主色调（发色/肤色/服装主色，用于设计图与分镜色彩锁定）"
            value={form.palette}
            onChange={(value) => setForm((prev) => ({ ...prev, palette: value }))}
          />
          <LabeledTextarea
            label="描述词片段（留空则按上面设定自动生成）"
            value={form.promptFragment}
            onChange={(value) => setForm((prev) => ({ ...prev, promptFragment: value }))}
          />
        </div>
      </AppDialogContent>
    </Dialog>
  );
}

interface SceneFormState {
  name: string;
  spaceStructure: string;
  environment: string;
  promptFragment: string;
}

function SceneEditorDialog(props: {
  scene: ComicScene;
  isNew: boolean;
  onClose: () => void;
  onSave: (updates: Partial<SceneFormState>) => void;
}) {
  const [form, setForm] = useState<SceneFormState>({
    name: props.scene.name,
    spaceStructure: props.scene.spaceStructure,
    environment: props.scene.environment,
    promptFragment: props.scene.promptFragment,
  });
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <AppDialogContent
        title={props.isNew ? "添加场景卡" : `编辑场景「${props.scene.name}」`}
        description="空间结构保持固定以便画面复用；时间/天气等变化在卡片的动态参数里填写。"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={props.onClose}>
              取消
            </Button>
            <Button size="sm" disabled={!form.name.trim()} onClick={() => props.onSave(form)}>
              保存
            </Button>
          </div>
        }
      >
        <div className="space-y-3 overflow-y-auto px-6 py-4">
          <LabeledInput
            label="场景名称"
            value={form.name}
            onChange={(value) => setForm((prev) => ({ ...prev, name: value }))}
          />
          <LabeledTextarea
            label="空间结构（布局/方位，供构图复用）"
            value={form.spaceStructure}
            onChange={(value) => setForm((prev) => ({ ...prev, spaceStructure: value }))}
          />
          <LabeledTextarea
            label="环境氛围"
            value={form.environment}
            onChange={(value) => setForm((prev) => ({ ...prev, environment: value }))}
          />
          <LabeledTextarea
            label="描述词片段（留空则按上面设定自动生成）"
            value={form.promptFragment}
            onChange={(value) => setForm((prev) => ({ ...prev, promptFragment: value }))}
          />
        </div>
      </AppDialogContent>
    </Dialog>
  );
}

function MergeDialog(props: {
  title: string;
  description: string;
  items: Array<{ id: string; name: string }>;
  onClose: () => void;
  onPick: (targetId: string) => void;
}) {
  const [targetId, setTargetId] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <AppDialogContent
        title={props.title}
        description={props.description}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={props.onClose}>
              取消
            </Button>
            <Button size="sm" disabled={!targetId} onClick={() => props.onPick(targetId)}>
              合并
            </Button>
          </div>
        }
      >
        <div className="space-y-2 overflow-y-auto px-6 py-4">
          {props.items.map((item) => (
            <label
              key={item.id}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm",
                targetId === item.id ? "bg-primary/10" : "hover:bg-muted/50",
              )}
            >
              <input
                type="radio"
                name="merge-target"
                checked={targetId === item.id}
                onChange={() => setTargetId(item.id)}
              />
              {item.name}
            </label>
          ))}
        </div>
      </AppDialogContent>
    </Dialog>
  );
}

function LabeledInput(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block flex-1">
      <span className="mb-1 block text-xs text-muted-foreground">{props.label}</span>
      <Input
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className="h-9"
      />
    </label>
  );
}

function LabeledTextarea(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted-foreground">{props.label}</span>
      <textarea
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        rows={2}
        className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </label>
  );
}
