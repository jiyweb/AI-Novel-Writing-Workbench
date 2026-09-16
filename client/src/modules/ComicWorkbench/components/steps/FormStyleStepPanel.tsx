/**
 * 步骤二：形态画风
 * - 7 种漫画形态：切换会锁定画幅/分格规则/台词样式/描述词前缀；
 *   已产出分镜的章节需确认后重置分镜。
 * - 画风：内置预设 + 个人预设，可调色调/线条/画质/光影与自定义关键词。
 * - 生成测试图：用当前形态+画风拼最小描述词，单张出图预览效果。
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppDialogContent, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
  useMainAiStatus,
  useComicChapters,
  useComicProject,
  useWorkbenchSettings,
} from "../../hooks/useComicQuery";
import { AiSettingsDialog } from "../settings/AiSettingsDialog";
import { useReportStepReady } from "../common/StepNavFooter";
import { fetchMainAiStatus, getAiSettings } from "../../services/ai/aiConfigService";
import { AiError, describeAiError } from "../../services/ai/llmClient";
import { generateImage } from "../../services/ai/imageClient";
import { saveImageBlob } from "../../db/comicDb";
import { changeProjectForm, changeProjectStyle } from "../../services/projectService";
import { saveProjectPlatform } from "../../services/marketingService";
import {
  deleteCustomPreset,
  saveCustomPreset,
} from "../../services/stylePresetService";
import {
  comicForms,
  getStylePresetById,
  narrativeTemplates,
  promptFormula,
  stylePresets,
} from "../../services/configService";
import type {
  ComicFormConfig,
  ComicLetteringMode,
  ComicProject,
  CustomStylePreset,
  StyleAdjustments,
  StylePresetConfig,
} from "../../types";

/** 台词样式的展示文案（仅 UI 标签，规则本身在 comicForms.json） */
const LETTERING_LABELS: Record<ComicLetteringMode, string> = {
  bubble: "对话气泡",
  caption: "底部字幕",
  chat: "聊天框",
  none: "无文字",
};

const LINE_WEIGHT_OPTIONS: Array<{ value: StyleAdjustments["lineWeight"]; label: string }> = [
  { value: "thin", label: "纤细" },
  { value: "normal", label: "适中" },
  { value: "bold", label: "粗犷" },
];
const QUALITY_OPTIONS: Array<{ value: StyleAdjustments["quality"]; label: string }> = [
  { value: "standard", label: "标准" },
  { value: "fine", label: "精细" },
  { value: "ultra", label: "极致" },
];
const LIGHTING_OPTIONS: Array<{ value: StyleAdjustments["lighting"]; label: string }> = [
  { value: "soft", label: "柔和" },
  { value: "balanced", label: "均衡" },
  { value: "strong", label: "强烈" },
];

type TestImageState =
  | { phase: "idle" }
  | { phase: "running"; progress: string }
  | { phase: "done"; url: string; fromRemote: boolean }
  | { phase: "error"; message: string };

export function FormStyleStepPanel(props: { projectId: string; onReadyChange?: (ready: boolean, hint?: string) => void }) {
  const { projectId } = props;
  const queryClient = useQueryClient();

  useReportStepReady(props.onReadyChange, true);

  const projectQuery = useComicProject(projectId);
  const project = projectQuery.data;
  const chaptersQuery = useComicChapters(projectId);
  const chapters = chaptersQuery.data ?? [];
  const mainAiStatus = useMainAiStatus();
  const settingsQuery = useWorkbenchSettings();
  const customPresets = settingsQuery.data?.customStylePresets ?? [];

  const [pendingFormId, setPendingFormId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pendingTestImage = useRef(false);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  // 文本输入先走本地态，失焦时才落库，避免每键一次版本递增
  const [colorTone, setColorTone] = useState("");
  const [customKeywords, setCustomKeywords] = useState("");
  const [testImage, setTestImage] = useState<TestImageState>({ phase: "idle" });

  // 项目刷新后同步本地草稿态
  useEffect(() => {
    if (!project) return;
    setColorTone(project.styleAdjustments.colorTone);
    setCustomKeywords(project.customStyleKeywords);
  }, [project]);

  // 释放测试图的对象 URL
  useEffect(() => {
    return () => {
      if (testImage.phase === "done" && testImage.url.startsWith("blob:")) {
        URL.revokeObjectURL(testImage.url);
      }
    };
  }, [testImage]);

  const invalidateAll = async () => {
    await queryClient.invalidateQueries({ queryKey: ["comic-workbench"] });
  };

  const form = project ? comicForms.find((f) => f.id === project.formId) : undefined;
  // 当前生效画风：内置 → 个人风格 → 兜底第一个内置（未知 id 的历史项目）
  const preset = project
    ? getStylePresetById(project.stylePresetId) ??
      customPresets.find((item) => item.id === project.stylePresetId) ??
      stylePresets[0]
    : undefined;

  const affectedChapterCount = chapters.filter(
    (c) => c.panelOrder.length > 0 || c.versions.storyboard > 0,
  ).length;

  // ---------------------------------------------------------------------------
  // 形态切换
  // ---------------------------------------------------------------------------

  const applyFormMutation = useMutation({
    mutationFn: async (formId: string) => {
      if (!project) throw new Error("项目不存在");
      const hasStoryboard = chapters.some(
        (c) => c.panelOrder.length > 0 || c.versions.storyboard > 0,
      );
      return changeProjectForm(project, formId, hasStoryboard);
    },
    onSuccess: async (_data, formId) => {
      const nextForm = comicForms.find((f) => f.id === formId);
      toast.success(`已切换为「${nextForm?.name ?? formId}」形态`);
      setPendingFormId(null);
      await invalidateAll();
    },
    onError: (error: Error) => toast.error(`形态切换失败：${error.message}`),
  });

  const onFormClick = (target: ComicFormConfig) => {
    if (!project || target.id === project.formId) return;
    const hasStoryboard = chapters.some(
      (c) => c.panelOrder.length > 0 || c.versions.storyboard > 0,
    );
    if (hasStoryboard) {
      setPendingFormId(target.id);
    } else {
      applyFormMutation.mutate(target.id);
    }
  };

  // ---------------------------------------------------------------------------
  // 画风变更
  // ---------------------------------------------------------------------------

  const styleMutation = useMutation({
    mutationFn: async (updates: Parameters<typeof changeProjectStyle>[1]) => {
      if (!project) throw new Error("项目不存在");
      return changeProjectStyle(project, updates);
    },
    onSuccess: async () => {
      await invalidateAll();
    },
    onError: (error: Error) => toast.error(`画风保存失败：${error.message}`),
  });

  // ---------------------------------------------------------------------------
  // 发布平台（爆款增强：推荐形态联动）
  // ---------------------------------------------------------------------------

  const platformMutation = useMutation({
    mutationFn: (platformId: string | undefined) => saveProjectPlatform(projectId, platformId),
    onSuccess: async () => {
      await invalidateAll();
    },
    onError: (error: Error) => toast.error(`发布平台保存失败：${error.message}`),
  });

  const selectedPlatform = project?.platformId
    ? narrativeTemplates.platforms.find((platform) => platform.id === project.platformId)
    : undefined;
  const recommendedForm = selectedPlatform
    ? comicForms.find((item) => item.id === selectedPlatform.recommendedFormId)
    : undefined;

  const savePresetMutation = useMutation({
    mutationFn: async () => {
      if (!project || !preset) throw new Error("项目不存在");
      return saveCustomPreset({
        name: presetName,
        basePresetId: preset.id,
        adjustments: project.styleAdjustments,
        customKeywords,
      });
    },
    onSuccess: async (saved) => {
      toast.success(`个人风格「${saved.name}」已保存，可在上方列表选用`);
      setPresetDialogOpen(false);
      setPresetName("");
      await queryClient.invalidateQueries({ queryKey: comicKeys.settings });
    },
    onError: (error: Error) => toast.error(`保存个人风格失败：${error.message}`),
  });

  const deletePresetMutation = useMutation({
    mutationFn: deleteCustomPreset,
    onSuccess: async () => {
      toast.success("个人风格已删除");
      await queryClient.invalidateQueries({ queryKey: comicKeys.settings });
    },
    onError: (error: Error) => toast.error(`删除失败：${error.message}`),
  });

  // ---------------------------------------------------------------------------
  // 生成测试图
  // ---------------------------------------------------------------------------

  const testImageMutation = useMutation({
    mutationFn: async () => {
      if (!project || !preset || !form) throw new Error("项目不存在");
      const settings = await getAiSettings();
      const status = await fetchMainAiStatus();
      if (!status.imageReady) {
        throw new AiError("notConfigured", "主程序尚未配置可用的生图模型");
      }
      const { prompt, negativePrompt } = buildTestImagePrompt(project, form, preset);
      setTestImage({ phase: "running", progress: "正在提交生图请求…" });
      const image = await generateImage(settings?.image ?? null, {
        prompt,
        negativePrompt,
        comicPanelId: `form-test:${projectId}`,
        width: form.referencePixel.width,
        height: form.referencePixel.height,
        onProgress: (message) =>
          setTestImage((prev) => (prev.phase === "running" ? { ...prev, progress: message } : prev)),
      });
      const record = await saveImageBlob(
        {
          projectId,
          kind: "test",
          mime: image.mime,
          byteSize: image.blob?.size ?? 0,
          remoteUrl: image.remoteUrl,
        },
        image.blob,
      );
      return { image, recordId: record.id };
    },
    onSuccess: ({ image }) => {
      if (image.blob) {
        setTestImage({ phase: "done", url: URL.createObjectURL(image.blob), fromRemote: false });
      } else if (image.remoteUrl) {
        setTestImage({ phase: "done", url: image.remoteUrl, fromRemote: true });
      } else {
        setTestImage({ phase: "error", message: "生图接口没有返回可用的图片" });
        return;
      }
      toast.success("测试图已生成，可继续调整画风后重新生成");
    },
    onError: (error: unknown) => {
      setTestImage({ phase: "error", message: describeAiError(error) });
    },
  });

  const onTestImageClick = () => {
    if (!mainAiStatus.data?.imageReady) {
      pendingTestImage.current = true;
      setSettingsOpen(true);
      return;
    }
    testImageMutation.mutate();
  };

  if (!project || !form || !preset) {
    return (
      <div className="rounded-xl bg-muted/30 px-6 py-16 text-center text-sm text-muted-foreground">
        项目加载中…
      </div>
    );
  }

  const pendingForm = pendingFormId ? comicForms.find((f) => f.id === pendingFormId) : undefined;

  return (
    <div className="flex flex-col gap-8">
      {/* 形态选择 */}
      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">漫画形态</h2>
          <p className="text-xs text-muted-foreground">
            形态决定画幅比例、每图格数与台词样式；当前「{form.name} · {form.aspectRatio}」
          </p>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {comicForms.map((item) => {
            const selected = item.id === project.formId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onFormClick(item)}
                className={cn(
                  "rounded-lg p-2.5 text-left transition-colors",
                  selected
                    ? "border border-primary bg-primary/5"
                    : "border border-transparent bg-muted/40 hover:bg-muted",
                )}
              >
                <FormThumbnail form={item} />
                <div className="mt-2 flex items-center gap-1.5">
                  <span className="text-sm font-medium">{item.name}</span>
                  <Badge variant="secondary" className="px-1.5 text-[10px]">
                    {item.aspectRatio}
                  </Badge>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.description}</p>
                <p className="mt-1 text-[11px] text-muted-foreground/80">
                  每图 {item.panelGrid.minPerImage}-{item.panelGrid.maxPerImage} 格 ·{" "}
                  {LETTERING_LABELS[item.letteringMode]}
                </p>
              </button>
            );
          })}
        </div>
      </section>

      {/* 画风选择 */}
      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">画风风格</h2>
          <p className="text-xs text-muted-foreground">
            当前「{preset.name}」，可微调参数或追加自定义关键词
          </p>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {stylePresets.map((item) => {
            const selected = item.id === project.stylePresetId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => styleMutation.mutate({ stylePresetId: item.id })}
                className={cn(
                  "rounded-lg px-3 py-2 text-left transition-colors",
                  selected
                    ? "border border-primary bg-primary/5"
                    : "border border-transparent bg-muted/40 hover:bg-muted",
                )}
              >
                <span className="text-sm font-medium">{item.name}</span>
                <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                  {item.promptKeywords}
                </p>
              </button>
            );
          })}
          {customPresets.map((item) => {
            // 个人风格是独立画风：选中态按自身 id 判定，与内置风格互斥
            const selected = item.id === project.stylePresetId;
            return (
              <div
                key={item.id}
                className={cn(
                  "group relative rounded-lg px-3 py-2 text-left transition-colors",
                  selected
                    ? "border border-primary bg-primary/5"
                    : "border border-transparent bg-muted/40 hover:bg-muted",
                )}
              >
                <button
                  type="button"
                  className="block w-full text-left"
                  onClick={() =>
                    styleMutation.mutate({
                      stylePresetId: item.id,
                      styleAdjustments: item.adjustments,
                      customStyleKeywords: item.customKeywords,
                    })
                  }
                >
                  <span className="text-sm font-medium">{item.name}</span>
                  <span className="ml-1.5 text-[10px] text-muted-foreground">个人</span>
                  <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                    {item.customKeywords || item.promptKeywords}
                  </p>
                </button>
                <button
                  type="button"
                  aria-label={`删除个人风格 ${item.name}`}
                  className="absolute right-1.5 top-1.5 hidden rounded-sm p-1 text-muted-foreground/60 hover:bg-background hover:text-destructive group-hover:block"
                  onClick={() => deletePresetMutation.mutate(item.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>

        {/* 调节参数 */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            线条粗细
            <Select
              value={project.styleAdjustments.lineWeight}
              onValueChange={(value) =>
                styleMutation.mutate({
                  styleAdjustments: { ...project.styleAdjustments, lineWeight: value as StyleAdjustments["lineWeight"] },
                })
              }
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LINE_WEIGHT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            画质精细度
            <Select
              value={project.styleAdjustments.quality}
              onValueChange={(value) =>
                styleMutation.mutate({
                  styleAdjustments: { ...project.styleAdjustments, quality: value as StyleAdjustments["quality"] },
                })
              }
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QUALITY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            光影强度
            <Select
              value={project.styleAdjustments.lighting}
              onValueChange={(value) =>
                styleMutation.mutate({
                  styleAdjustments: { ...project.styleAdjustments, lighting: value as StyleAdjustments["lighting"] },
                })
              }
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIGHTING_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            色调倾向
            <Input
              value={colorTone}
              onChange={(event) => setColorTone(event.target.value)}
              onBlur={() => {
                if (colorTone !== project.styleAdjustments.colorTone) {
                  styleMutation.mutate({
                    styleAdjustments: { ...project.styleAdjustments, colorTone },
                  });
                }
              }}
              placeholder="如：高饱和热血色调"
              className="h-9"
            />
          </label>
        </div>
        <label className="mt-3 flex flex-col gap-1.5 text-xs text-muted-foreground">
          自定义关键词（追加到画风描述词末尾）
          <textarea
            value={customKeywords}
            onChange={(event) => setCustomKeywords(event.target.value)}
            onBlur={() => {
              if (customKeywords !== project.customStyleKeywords) {
                styleMutation.mutate({ customStyleKeywords: customKeywords });
              }
            }}
            placeholder="如：扁平色块，粗黑描边，参考港漫封面"
            className="flex min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPresetDialogOpen(true)}>
            保存为个人风格
          </Button>
        </div>
      </section>

      {/* 发布平台 */}
      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">发布平台</h2>
          <p className="text-xs text-muted-foreground">
            选择主要发布平台后，会给出更合适的漫画形态建议与运营节奏参考
          </p>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => platformMutation.mutate(undefined)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs transition-colors",
              !selectedPlatform
                ? "bg-primary text-primary-foreground"
                : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            不限定
          </button>
          {narrativeTemplates.platforms.map((platform) => (
            <button
              key={platform.id}
              type="button"
              onClick={() => platformMutation.mutate(platform.id)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs transition-colors",
                project?.platformId === platform.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {platform.name}
            </button>
          ))}
        </div>
        {selectedPlatform ? (
          <div className="mt-3 rounded-lg bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">{selectedPlatform.name}</span>
              ：{selectedPlatform.pacingHint}
            </p>
            {recommendedForm ? (
              project?.formId === recommendedForm.id ? (
                <p className="mt-1 text-emerald-600 dark:text-emerald-400">
                  当前「{recommendedForm.name}」形态正是 {selectedPlatform.name} 推荐形态
                </p>
              ) : (
                <p className="mt-1 flex flex-wrap items-center gap-2">
                  {selectedPlatform.name} 建议使用「{recommendedForm.name}」形态
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    disabled={platformMutation.isPending}
                    onClick={() => recommendedForm && onFormClick(recommendedForm)}
                  >
                    切换为推荐形态
                  </Button>
                </p>
              )
            ) : null}
          </div>
        ) : null}
      </section>

      {/* 生成测试图 */}
      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">画风试画</h2>
          <p className="text-xs text-muted-foreground">
            用当前形态与画风生成一张样图，确认效果后再进入分镜
          </p>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            onClick={onTestImageClick}
            disabled={testImageMutation.isPending}
          >
            {testImageMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {testImageMutation.isPending ? "生成中…" : "生成测试图"}
          </Button>
          {testImage.phase === "running" ? (
            <span className="text-xs text-muted-foreground">{testImage.progress}</span>
          ) : null}
          {testImage.phase === "error" ? (
            <span className="text-xs text-destructive">{testImage.message}</span>
          ) : null}
        </div>
        {testImage.phase === "done" ? (
          <div className="mt-3 flex flex-col items-start gap-1.5">
            <img
              src={testImage.url}
              alt="画风测试图"
              className="max-h-80 rounded-lg border border-border/60"
            />
            {testImage.fromRemote ? (
              <p className="text-[11px] text-amber-600">
                该图来自生图平台的远程链接，未能保存到本机，重新生成即可替换。
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* 形态切换确认 */}
      <Dialog open={Boolean(pendingForm)} onOpenChange={(open) => !open && setPendingFormId(null)}>
        <AppDialogContent
          title="切换漫画形态"
          description={
            pendingForm
              ? `即将切换为「${pendingForm.name}（${pendingForm.aspectRatio}）」。`
              : undefined
          }
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setPendingFormId(null)}>
                取消
              </Button>
              <Button
                size="sm"
                disabled={applyFormMutation.isPending}
                onClick={() => pendingFormId && applyFormMutation.mutate(pendingFormId)}
              >
                {applyFormMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                确认切换
              </Button>
            </div>
          }
        >
          <p className="text-sm text-muted-foreground">
            本项目已有 {affectedChapterCount} 个章节产出了分镜。形态决定画幅与分格规则，切换后这些章节的分镜与描述词将清空重做；
            已生成的图片会保留，但不会再匹配新形态。
          </p>
        </AppDialogContent>
      </Dialog>

      {/* 保存个人风格 */}
      <Dialog open={presetDialogOpen} onOpenChange={setPresetDialogOpen}>
        <AppDialogContent
          title="保存为个人风格"
          description="记录当前的画风参数与自定义关键词，方便其他项目直接选用。"
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setPresetDialogOpen(false)}>
                取消
              </Button>
              <Button
                size="sm"
                disabled={!presetName.trim() || savePresetMutation.isPending}
                onClick={() => savePresetMutation.mutate()}
              >
                {savePresetMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                保存
              </Button>
            </div>
          }
        >
          <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            风格名称
            <Input
              value={presetName}
              onChange={(event) => setPresetName(event.target.value)}
              placeholder="如：我的热血番风格"
              autoFocus
            />
          </label>
          <p className="mt-2 text-xs text-muted-foreground">
            将基于「{preset.name}」保存：{preset.promptKeywords}
          </p>
        </AppDialogContent>
      </Dialog>

      <AiSettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open && pendingTestImage.current) {
            pendingTestImage.current = false;
          }
        }}
        onSaved={() => {
          if (pendingTestImage.current) {
            pendingTestImage.current = false;
            testImageMutation.mutate();
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 形态缩略图（CSS 示意，由 comicForms.json 的 preview 驱动）
// ---------------------------------------------------------------------------

function FormThumbnail(props: { form: ComicFormConfig }) {
  const { form } = props;
  const { layout, blockCount, accentColor } = form.preview;
  const blocks = Array.from({ length: Math.max(1, blockCount) }, (_, index) => index);
  const blockStyle = (index: number) => ({
    backgroundColor: accentColor,
    opacity: 0.22 + (index % 3) * 0.13,
  });

  return (
    <div
      className="flex h-20 items-center justify-center rounded-md bg-muted/60 p-1.5"
    >
      <div
        className="h-full"
        style={{
          aspectRatio: `${form.ratioWidth} / ${form.ratioHeight}`,
          maxWidth: "100%",
        }}
      >
      {layout === "vertical" ? (
        <div className="flex h-full flex-col gap-1">
          {blocks.map((index) => (
            <div key={index} className="flex-1 rounded-sm" style={blockStyle(index)} />
          ))}
        </div>
      ) : layout === "grid" ? (
        <div className="grid h-full grid-cols-2 gap-1">
          {blocks.map((index) => (
            <div key={index} className="rounded-sm" style={blockStyle(index)} />
          ))}
        </div>
      ) : layout === "chat" ? (
        <div className="flex h-full flex-col justify-center gap-1.5">
          {blocks.map((index) => (
            <div
              key={index}
              className={cn("h-2.5 w-2/3 rounded-full", index % 2 === 0 ? "self-start" : "self-end")}
              style={blockStyle(index)}
            />
          ))}
        </div>
      ) : (
        <div className="h-full w-full rounded-sm" style={blockStyle(0)} />
      )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 测试图描述词（读取 promptFormula 配置组装，禁止硬编码模板）
// ---------------------------------------------------------------------------

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

export function buildTestImagePrompt(
  project: ComicProject,
  form: ComicFormConfig,
  preset: StylePresetConfig | CustomStylePreset,
): { prompt: string; negativePrompt: string } {
  const adjustments = project.styleAdjustments;
  const custom = project.customStyleKeywords.trim();
  const values: Record<string, string> = {
    formPromptPrefix: form.promptPrefix,
    styleKeywords: preset.promptKeywords,
    colorTone: adjustments.colorTone,
    lineWeight: promptFormula.lineWeightLabels[adjustments.lineWeight],
    lighting: promptFormula.lightingLabels[adjustments.lighting],
    customKeywords: custom ? `${promptFormula.segmentJoiner}${custom}` : "",
    qualityWords: promptFormula.qualityWords.hd,
  };
  // 测试图只取 form/style/quality 三段（scene/camera 等属于分镜层）
  const wanted = new Set(["form", "style", "quality"]);
  const prompt = promptFormula.segmentOrder
    .filter((segment) => wanted.has(segment))
    .map((segment) => fillTemplate(promptFormula.segmentTemplates[segment], values).trim())
    .filter(Boolean)
    .join(promptFormula.segmentJoiner);
  return {
    prompt,
    negativePrompt: preset.negativeKeywords?.trim() || promptFormula.negativeWords,
  };
}
