/**
 * 步骤八：导出
 *
 * 两种成品导出方式，范围可选本章节或全部章节：
 * - ZIP 打包：单张 PNG 按章节分文件夹归档；
 * - 条漫长图：每章纵向拼接为一张长图（可把台词按气泡布局合成进画面），
 *   多章时自动打成 ZIP。
 * 另提供爆款运营文案：按发布平台（config/narrativeTemplates.json）用 AI
 * 生成标题/摘要/发布正文/话题标签，一键复制直接发布。
 */
import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, FileArchive, Images, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  comicKeys,
  useAiSettings,
  useComicChapter,
  useComicChapters,
  useComicProject,
  useMarketingCopy,
} from "../../hooks/useComicQuery";
import { useComicWorkbenchStore } from "../../stores/workbenchStore";
import { AiSettingsDialog } from "../settings/AiSettingsDialog";
import { listPanels } from "../../db/comicDb";
import { getFormById, narrativeTemplates } from "../../services/configService";
import { isLlmReady } from "../../services/ai/aiConfigService";
import { describeAiError } from "../../services/ai/llmClient";
import { generateMarketingCopy } from "../../services/marketingService";
import {
  collectPanelImages,
  downloadBlob,
  packZip,
  renderChapterStrip,
  type PanelImage,
} from "../../services/export/exportService";
import type { ComicChapter, ComicProject, MarketingCopy } from "../../types";

type ExportScope = "chapter" | "all";
type ExportMethod = "zip" | "strip";

export function ExportStepPanel(props: { projectId: string }) {
  const { projectId } = props;
  const queryClient = useQueryClient();
  const chaptersQuery = useComicChapters(projectId);
  const chapters = useMemo(
    () => [...(chaptersQuery.data ?? [])].sort((a, b) => a.index - b.index),
    [chaptersQuery.data],
  );
  const projectQuery = useComicProject(projectId);
  const project = projectQuery.data ?? null;
  const chapterId = useComicWorkbenchStore((state) => state.chapterId);
  const openChapter = useComicWorkbenchStore((state) => state.openChapter);
  const chapterQuery = useComicChapter(chapterId);
  const chapter = chapterQuery.data ?? null;
  const aiSettingsQuery = useAiSettings();

  const [scope, setScope] = useState<ExportScope>("chapter");
  const [method, setMethod] = useState<ExportMethod>("strip");
  const [includeDialogues, setIncludeDialogues] = useState(true);
  // 运营文案（爆款增强）：平台本地选择，默认取配置的第一个平台
  const [platformId, setPlatformId] = useState(
    () => narrativeTemplates.platforms[0]?.id ?? "douyin",
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const copyQuery = useMarketingCopy(chapterId, platformId);

  const marketingMutation = useMutation({
    mutationFn: async () => {
      if (!project) throw new Error("项目不存在");
      if (!chapter) throw new Error("请先选择一个章节");
      return generateMarketingCopy({
        settings: aiSettingsQuery.data!,
        project,
        chapter,
        platformId,
      });
    },
    onSuccess: async (copy: MarketingCopy) => {
      toast.success("运营文案已生成");
      await queryClient.invalidateQueries({
        queryKey: comicKeys.marketing(chapter?.id ?? "none", copy.platformId),
      });
    },
    onError: (error: unknown) => toast.error(describeAiError(error)),
  });

  const runGenerateCopy = () => {
    if (!isLlmReady(aiSettingsQuery.data)) {
      toast.info("请先配置 AI 文本模型（API Key 只保存在本机）");
      setSettingsOpen(true);
      return;
    }
    marketingMutation.mutate();
  };

  const copyMarketingToClipboard = async (copy: MarketingCopy) => {
    const platformName =
      narrativeTemplates.platforms.find((item) => item.id === copy.platformId)?.name ?? "";
    const text = [
      copy.title,
      "",
      copy.post,
      "",
      copy.tags.map((tag) => `#${tag}`).join(" "),
    ]
      .join("\n")
      .trim();
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`已复制 ${platformName} 文案，可直接去发布`);
    } catch {
      toast.error("复制失败，请手动选择文本复制");
    }
  };

  const exportMutation = useMutation({
    mutationFn: async () => {
      if (!project) throw new Error("项目不存在");
      const form = getFormById(project.formId);
      if (!form) throw new Error("项目形态配置缺失，请回到「形态画风」重新选择");
      const targets = scope === "chapter" ? chapters.filter((item) => item.id === chapterId) : chapters;
      if (targets.length === 0) throw new Error("请先选择一个章节");
      return method === "zip"
        ? exportAsZip(project, targets)
        : exportAsStrip(project, targets, form, includeDialogues);
    },
    onSuccess: (result) => {
      toast.success(
        result.count > 1
          ? `已导出 ${result.count} 个文件（打包下载）`
          : "导出完成，文件已开始下载",
      );
    },
    onError: (error: Error) => toast.error(`导出失败：${error.message}`),
  });

  if (chapters.length === 0) {
    return <EmptyHint text="还没有章节。先完成导入、分镜与生成，再来导出成品。" />;
  }

  const busy = exportMutation.isPending;
  const form = project ? getFormById(project.formId) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 pt-1">
        {/* 范围 */}
        <section className="rounded-xl bg-muted/20 p-4">
          <h3 className="text-sm font-semibold">导出范围</h3>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <SegmentButton active={scope === "chapter"} onClick={() => setScope("chapter")}>
              当前章节{chapterId ? `（第 ${chapterIndex(chapters, chapterId)} 章）` : ""}
            </SegmentButton>
            <SegmentButton active={scope === "all"} onClick={() => setScope("all")}>
              全部章节（{chapters.length} 章）
            </SegmentButton>
          </div>
          {scope === "chapter" ? (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
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
            </div>
          ) : null}
        </section>

        {/* 方式 */}
        <section className="rounded-xl bg-muted/20 p-4">
          <h3 className="text-sm font-semibold">导出方式</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <MethodCard
              active={method === "strip"}
              onClick={() => setMethod("strip")}
              icon={<Images className="h-4 w-4" />}
              title="条漫长图"
              description={`每章拼接为一张长图${form ? `（宽 ${form.referencePixel.width}px，${form.aspectRatio}）` : ""}，多章自动打包`}
            />
            <MethodCard
              active={method === "zip"}
              onClick={() => setMethod("zip")}
              icon={<FileArchive className="h-4 w-4" />}
              title="单张 ZIP 打包"
              description="全部成品图按章节分文件夹归档为一个 ZIP"
            />
          </div>
          {method === "strip" ? (
            <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Switch checked={includeDialogues} onCheckedChange={setIncludeDialogues} />
              把台词按编排位置合成到长图上（气泡/字幕/聊天框样式）
            </label>
          ) : null}
        </section>

        {/* 执行 */}
        <section className="flex items-center gap-3">
          <Button disabled={busy} onClick={() => exportMutation.mutate()}>
            {busy ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Images className="mr-1.5 h-4 w-4" />
            )}
            {method === "strip" ? "导出条漫长图" : "导出 ZIP 打包"}
          </Button>
          <span className="text-xs text-muted-foreground">
            只包含已生成的画面；未生成的分镜会自动跳过
          </span>
        </section>

        {/* 运营文案 */}
        {chapter ? (
          <section className="rounded-xl bg-muted/20 p-4">
            <h3 className="text-sm font-semibold">爆款运营文案</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              为当前章节（第 {chapter.index} 章 {chapter.title}）生成贴合平台风格的标题、发布正文与话题标签
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {narrativeTemplates.platforms.map((platform) => (
                <SegmentButton
                  key={platform.id}
                  active={platformId === platform.id}
                  onClick={() => setPlatformId(platform.id)}
                >
                  {platform.name}
                </SegmentButton>
              ))}
              <span className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={marketingMutation.isPending}
                  onClick={runGenerateCopy}
                >
                  {marketingMutation.isPending ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : copyQuery.data ? (
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  ) : (
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {copyQuery.data ? "重新生成文案" : "生成运营文案"}
                </Button>
              </span>
            </div>
            {copyQuery.data ? (
              <div className="mt-4 flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{copyQuery.data.title}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => void copyMarketingToClipboard(copyQuery.data!)}
                  >
                    <Copy className="mr-1 h-3 w-3" />
                    复制全部
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{copyQuery.data.summary}</p>
                <p className="whitespace-pre-wrap rounded-lg bg-background/60 px-3 py-2.5 text-xs leading-relaxed">
                  {copyQuery.data.post}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {copyQuery.data.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-[10px]">
                      #{tag}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : copyQuery.isFetching ? (
              <p className="mt-3 text-xs text-muted-foreground">正在读取已保存的文案…</p>
            ) : null}
          </section>
        ) : null}
      </div>
      <AiSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 导出实现
// ---------------------------------------------------------------------------

interface ExportResult {
  count: number;
}

async function exportAsZip(
  project: ComicProject,
  chapters: ComicChapter[],
): Promise<ExportResult> {
  const entries: Array<{ name: string; data: Uint8Array<ArrayBuffer> }> = [];
  for (const chapter of chapters) {
    const panels = await listPanels(chapter.id);
    const images = await collectPanelImages(panels);
    const folder = `第${String(chapter.index).padStart(2, "0")}章`;
    let saved = 0;
    for (const [index, image] of images.entries()) {
      const data = await imageBytes(image);
      if (!data) continue;
      saved += 1;
      entries.push({ name: `${folder}/panel-${String(saved).padStart(3, "0")}.png`, data });
    }
  }
  if (entries.length === 0) {
    throw new Error("所选范围没有已生成的画面，请先完成生成步骤");
  }
  downloadBlob(packZip(entries), `${sanitizeFilename(project.name)}-单张打包.zip`);
  return { count: entries.length };
}

async function exportAsStrip(
  project: ComicProject,
  chapters: ComicChapter[],
  form: NonNullable<ReturnType<typeof getFormById>>,
  includeDialogues: boolean,
): Promise<ExportResult> {
  const strips: Array<{ name: string; blob: Blob }> = [];
  for (const chapter of chapters) {
    const panels = await listPanels(chapter.id);
    const blob = await renderChapterStrip(panels, form, { includeDialogues });
    if (!blob) continue;
    strips.push({
      name: `${sanitizeFilename(project.name)}-第${String(chapter.index).padStart(2, "0")}章-条漫.png`,
      blob,
    });
  }
  if (strips.length === 0) {
    throw new Error("所选范围没有已生成的画面，请先完成生成步骤");
  }
  if (strips.length === 1) {
    downloadBlob(strips[0].blob, strips[0].name);
  } else {
    const entries = await Promise.all(
      strips.map(async (strip) => ({
        name: strip.name,
        data: new Uint8Array(await strip.blob.arrayBuffer()),
      })),
    );
    downloadBlob(packZip(entries), `${sanitizeFilename(project.name)}-条漫打包.zip`);
  }
  return { count: strips.length };
}

/** remoteUrl 兜底：尝试直接拉取，跨域失败则跳过 */
async function imageBytes(image: PanelImage): Promise<Uint8Array<ArrayBuffer> | null> {
  if (image.blob) return new Uint8Array(await image.blob.arrayBuffer());
  try {
    const response = await fetch(image.remoteUrl ?? "");
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "漫画导出";
}

function chapterIndex(chapters: ComicChapter[], chapterId: string | null): number {
  const found = chapters.find((item) => item.id === chapterId);
  return found?.index ?? 1;
}

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

function SegmentButton(props: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "rounded-lg px-3 py-1.5 text-xs transition-colors",
        props.active
          ? "bg-primary text-primary-foreground"
          : "bg-background/60 text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

function MethodCard(props: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "rounded-lg border px-3 py-3 text-left transition-colors",
        props.active
          ? "border-primary/60 bg-primary/5"
          : "border-border bg-background/60 hover:border-primary/40",
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        {props.icon}
        {props.title}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{props.description}</p>
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
