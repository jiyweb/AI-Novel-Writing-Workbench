/**
 * 步骤八：导出
 *
 * 两种成品导出方式，范围可选本章节或全部章节：
 * - ZIP 打包：单张 PNG 按章节分文件夹归档；
 * - 条漫长图：每章纵向拼接为一张长图（可把台词按气泡布局合成进画面），
 *   多章时自动打成 ZIP。
 */
import { useMemo, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileArchive, Images, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useComicChapters, useComicProject } from "../../hooks/useComicQuery";
import { useComicWorkbenchStore } from "../../stores/workbenchStore";
import { listPanels } from "../../db/comicDb";
import { getFormById } from "../../services/configService";
import {
  collectPanelImages,
  downloadBlob,
  packZip,
  renderChapterStrip,
  type PanelImage,
} from "../../services/export/exportService";
import type { ComicChapter, ComicProject } from "../../types";

type ExportScope = "chapter" | "all";
type ExportMethod = "zip" | "strip";

export function ExportStepPanel(props: { projectId: string }) {
  const { projectId } = props;
  const chaptersQuery = useComicChapters(projectId);
  const chapters = useMemo(
    () => [...(chaptersQuery.data ?? [])].sort((a, b) => a.index - b.index),
    [chaptersQuery.data],
  );
  const projectQuery = useComicProject(projectId);
  const project = projectQuery.data ?? null;
  const chapterId = useComicWorkbenchStore((state) => state.chapterId);
  const openChapter = useComicWorkbenchStore((state) => state.openChapter);

  const [scope, setScope] = useState<ExportScope>("chapter");
  const [method, setMethod] = useState<ExportMethod>("strip");
  const [includeDialogues, setIncludeDialogues] = useState(true);

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
      </div>
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
