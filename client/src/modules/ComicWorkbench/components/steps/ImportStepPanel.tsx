/**
 * 步骤一：内容导入
 * 三种来源：TXT 文件 / 粘贴原文 / 灵感生成（仅灵感走大模型）
 * 右侧为章节原文预览（虚拟滚动）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  FileText,
  Lightbulb,
  Loader2,
  PencilLine,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppDialogContent, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  comicKeys,
  useAiSettings,
  useComicChapters,
} from "../../hooks/useComicQuery";
import { useComicWorkbenchStore } from "../../stores/workbenchStore";
import { createChapter, deleteChapterCascade, getProject, saveChapter } from "../../db/comicDb";
import { touchProject } from "../../services/projectService";
import { AiSettingsDialog } from "../../components/settings/AiSettingsDialog";
import { VirtualTextView } from "../../components/common/VirtualTextView";
import { useReportStepReady } from "../../components/common/StepNavFooter";
import { describeAiError } from "../../services/ai/llmClient";
import { isLlmReady } from "../../services/ai/aiConfigService";
import { importTxtFile, TxtImportError } from "../../services/import/txtImporter";
import {
  cleanPastedText,
  detectSensitiveWords,
  PASTE_MAX_CHARS,
  PASTE_MIN_CHARS,
  PasteImportError,
  validatePastedText,
} from "../../services/import/pasteImporter";
import { generateInspirationDraft } from "../../services/import/inspirationService";
import { narrativeTemplates } from "../../services/configService";
import type { ComicChapter, InspirationBrief, InspirationDraft } from "../../types";

type SourceTab = "txt" | "paste" | "inspiration";

export function ImportStepPanel(props: { projectId: string; onReadyChange?: (ready: boolean, hint?: string) => void }) {
  const { projectId } = props;
  const queryClient = useQueryClient();
  const chapterId = useComicWorkbenchStore((state) => state.chapterId);
  const openChapter = useComicWorkbenchStore((state) => state.openChapter);

  const chaptersQuery = useComicChapters(projectId);
  const chapters = useMemo(
    () => [...(chaptersQuery.data ?? [])].sort((a, b) => a.index - b.index),
    [chaptersQuery.data],
  );

  useReportStepReady(
    props.onReadyChange,
    chapters.length > 0,
    chapters.length > 0 ? undefined : "先在左侧用「导入文件 / 粘贴小说 / 灵感」导入至少一个章节",
  );

  // 默认选中第一章
  useEffect(() => {
    if (!chapterId && chapters.length > 0) {
      openChapter(chapters[0].id);
    }
  }, [chapterId, chapters, openChapter]);

  const selectedChapter = chapters.find((chapter) => chapter.id === chapterId) ?? null;

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: comicKeys.chapters(projectId) });
    await queryClient.invalidateQueries({ queryKey: comicKeys.project(projectId) });
  };

  const deleteMutation = useMutation({
    mutationFn: async (chapter: ComicChapter) => {
      await deleteChapterCascade(chapter.id, projectId);
      await touchProjectIfPossible(projectId);
    },
    onSuccess: async (_data, chapter) => {
      if (chapterId === chapter.id) openChapter(null);
      toast.success(`章节「${chapter.title}」已删除`);
      await invalidate();
    },
    onError: (error: Error) => toast.error(`删除失败：${error.message}`),
  });

  const createChapterInternal = async (params: {
    title: string;
    sourceType: ComicChapter["sourceType"];
    content: string;
    inspiration?: { brief: InspirationBrief; draft: InspirationDraft };
  }): Promise<ComicChapter> => {
    const project = await getProject(projectId);
    if (!project) throw new Error("项目不存在");
    const chapter = await createChapter({
      projectId,
      title: params.title,
      index: chapters.length + 1,
      sourceType: params.sourceType,
      sourceContent: params.content,
      inspiration: params.inspiration,
    });
    await touchProject(project);
    return chapter;
  };

  const importMutation = useMutation({
    mutationFn: createChapterInternal,
    onSuccess: async (chapter) => {
      openChapter(chapter.id);
      toast.success(`章节「${chapter.title}」已导入，可前往下一步设置形态画风`);
      await invalidate();
    },
    onError: (error: Error) => toast.error(`导入失败：${error.message}`),
  });

  const renameMutation = useMutation({
    mutationFn: async ({ chapter, title }: { chapter: ComicChapter; title: string }) =>
      saveChapter({ ...chapter, title, updatedAt: new Date().toISOString() }),
    onSuccess: () => {
      toast.success("章节已重命名");
      void invalidate();
    },
    onError: (error: Error) => toast.error(`重命名失败：${error.message}`),
  });

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 lg:grid-cols-5">
      {/* 左：章节列表 + 导入 */}
      <div className="flex min-h-0 flex-col gap-4 lg:col-span-2">
        <ChapterList
          chapters={chapters}
          selectedId={chapterId}
          onSelect={openChapter}
          onRename={(chapter, title) => renameMutation.mutate({ chapter, title })}
          onDelete={(chapter) => deleteMutation.mutate(chapter)}
          deleting={deleteMutation.isPending}
        />
        <ImportSources
          disabled={importMutation.isPending}
          onImport={(params) => importMutation.mutate(params)}
        />
      </div>

      {/* 右：原文预览 */}
      <div className="flex min-h-0 flex-col rounded-xl bg-muted/30 lg:col-span-3">
        {selectedChapter ? (
          <>
            <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className="truncate text-sm font-medium">{selectedChapter.title}</h3>
                <Badge variant="secondary">{sourceLabel(selectedChapter.sourceType)}</Badge>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {selectedChapter.sourceCharCount} 字
                </span>
              </div>
              <p className="shrink-0 text-xs text-muted-foreground">原文只读，分镜仅引用位置</p>
            </div>
            <VirtualTextView content={selectedChapter.sourceContent} className="min-h-0 flex-1" />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <FileText className="h-10 w-10 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              左侧导入第一个章节后，这里会显示原文预览
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 章节列表
// ---------------------------------------------------------------------------

function ChapterList(props: {
  chapters: ComicChapter[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRename: (chapter: ComicChapter, title: string) => void;
  onDelete: (chapter: ComicChapter) => void;
  deleting: boolean;
}) {
  const [renaming, setRenaming] = useState<ComicChapter | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [deleting, setDeleting] = useState<ComicChapter | null>(null);

  return (
    <section className="rounded-xl bg-muted/30 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">章节</h2>
        <span className="text-xs text-muted-foreground">共 {props.chapters.length} 章 · 共享角色库</span>
      </div>
      {props.chapters.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">还没有章节，用下方任意方式导入第一章</p>
      ) : (
        <ul className="mt-3 flex max-h-44 flex-col gap-1 overflow-y-auto">
          {props.chapters.map((chapter) => (
            <li key={chapter.id}>
              <div
                className={cn(
                  "group flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                  props.selectedId === chapter.id
                    ? "bg-primary/15 font-medium"
                    : "hover:bg-muted",
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  onClick={() => props.onSelect(chapter.id)}
                >
                  {chapter.index}. {chapter.title}
                </button>
                <span className="shrink-0 text-xs text-muted-foreground">{chapter.sourceCharCount}字</span>
                <button
                  type="button"
                  aria-label="重命名章节"
                  className="opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
                  onClick={() => {
                    setRenaming(chapter);
                    setRenameTitle(chapter.title);
                  }}
                >
                  <PencilLine className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="删除章节"
                  className="opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  onClick={() => setDeleting(chapter)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <AppDialogContent
          title="重命名章节"
          footer={
            <>
              <Button variant="outline" onClick={() => setRenaming(null)}>取消</Button>
              <Button
                disabled={!renameTitle.trim()}
                onClick={() => {
                  if (renaming) props.onRename(renaming, renameTitle.trim());
                  setRenaming(null);
                }}
              >
                保存
              </Button>
            </>
          }
        >
          <Input value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} />
        </AppDialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AppDialogContent
          title="删除章节"
          description="该章节的分镜、台词与生成图片会一并删除；角色库与场景库保留。"
          footer={
            <>
              <Button variant="outline" onClick={() => setDeleting(null)}>取消</Button>
              <Button
                variant="destructive"
                disabled={props.deleting}
                onClick={() => {
                  if (deleting) props.onDelete(deleting);
                  setDeleting(null);
                }}
              >
                确认删除
              </Button>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">
            即将删除：<span className="font-medium text-foreground">{deleting?.title}</span>
          </p>
        </AppDialogContent>
      </Dialog>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 三种导入来源
// ---------------------------------------------------------------------------

function ImportSources(props: {
  disabled: boolean;
  onImport: (params: {
    title: string;
    sourceType: ComicChapter["sourceType"];
    content: string;
    inspiration?: { brief: InspirationBrief; draft: InspirationDraft };
  }) => void;
}) {
  const [tab, setTab] = useState<SourceTab>("txt");

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-xl bg-muted/30 p-4">
      <div className="flex items-center gap-1">
        <SourceTabButton active={tab === "txt"} onClick={() => setTab("txt")} icon={<FileText className="h-3.5 w-3.5" />}>
          导入文件
        </SourceTabButton>
        <SourceTabButton active={tab === "paste"} onClick={() => setTab("paste")} icon={<PencilLine className="h-3.5 w-3.5" />}>
          粘贴小说
        </SourceTabButton>
        <SourceTabButton active={tab === "inspiration"} onClick={() => setTab("inspiration")} icon={<Lightbulb className="h-3.5 w-3.5" />}>
          灵感
        </SourceTabButton>
      </div>
      <div className="mt-4 min-h-0 flex-1">
        {tab === "txt" && <TxtSource disabled={props.disabled} onImport={props.onImport} />}
        {tab === "paste" && <PasteSource disabled={props.disabled} onImport={props.onImport} />}
        {tab === "inspiration" && (
          <InspirationSource disabled={props.disabled} onImport={props.onImport} />
        )}
      </div>
    </section>
  );
}

function SourceTabButton(props: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
        props.active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
      )}
    >
      {props.icon}
      {props.children}
    </button>
  );
}

// --- TXT 文件导入 ---

function TxtSource(props: {
  disabled: boolean;
  onImport: (params: { title: string; sourceType: "txt"; content: string }) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [reading, setReading] = useState(false);

  const handleFile = async (file: File) => {
    setReading(true);
    try {
      const result = await importTxtFile(file);
      const title = file.name.replace(/\.txt$/i, "").trim() || "未命名章节";
      props.onImport({ title, sourceType: "txt", content: result.content });
      setFileName(file.name);
      for (const warning of result.warnings) {
        toast.warning(warning);
      }
      if (result.removedJunkLines > 0) {
        toast.info(`已自动清理 ${result.removedJunkLines} 行页码/页眉`);
      }
    } catch (error) {
      if (error instanceof TxtImportError) {
        toast.error(error.message);
      } else {
        toast.error("导入文件失败，请重试");
      }
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed px-6 py-10 text-center">
      <input
        ref={fileRef}
        type="file"
        accept=".txt,text/plain"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />
      <FileText className="h-8 w-8 text-muted-foreground/60" />
      <div>
        <p className="text-sm font-medium">选择 TXT 文件导入</p>
        <p className="mt-1 text-xs text-muted-foreground">
          支持 UTF-8 / GBK 自动识别，单文件最大 10MB
        </p>
      </div>
      <Button disabled={props.disabled || reading} onClick={() => fileRef.current?.click()}>
        {reading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        {reading ? "读取中…" : "选择文件"}
      </Button>
      {fileName ? <p className="text-xs text-muted-foreground">上次导入：{fileName}</p> : null}
    </div>
  );
}

// --- 粘贴导入 ---

function PasteSource(props: {
  disabled: boolean;
  onImport: (params: { title: string; sourceType: "paste"; content: string }) => void;
}) {
  const [raw, setRaw] = useState("");
  const [title, setTitle] = useState("");
  const [confirmHits, setConfirmHits] = useState<string[] | null>(null);

  const cleaned = useMemo(() => cleanPastedText(raw), [raw]);
  const charCount = cleaned.length;
  const countTone =
    charCount === 0
      ? "text-muted-foreground"
      : charCount < PASTE_MIN_CHARS || charCount > PASTE_MAX_CHARS
        ? "text-destructive"
        : "text-emerald-600";

  const submit = () => {
    try {
      validatePastedText(cleaned);
      const hits = detectSensitiveWords(cleaned);
      if (hits.length > 0) {
        setConfirmHits(hits);
        return;
      }
      props.onImport({
        title: title.trim() || `粘贴章节`,
        sourceType: "paste",
        content: cleaned,
      });
      setRaw("");
      setTitle("");
    } catch (error) {
      if (error instanceof PasteImportError) {
        toast.error(error.message);
      } else {
        toast.error("导入失败，请重试");
      }
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Input
        value={title}
        placeholder="章节标题（可留空自动命名）"
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        value={raw}
        onChange={(event) => setRaw(event.target.value)}
        placeholder={`粘贴小说原文（${PASTE_MIN_CHARS}-${PASTE_MAX_CHARS} 字），粘贴时会自动清除格式`}
        className="min-h-0 flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex items-center justify-between">
        <span className={cn("text-xs", countTone)}>{charCount} 字</span>
        <Button disabled={props.disabled || charCount === 0} onClick={submit}>
          导入该章节
        </Button>
      </div>

      <Dialog open={confirmHits !== null} onOpenChange={(open) => !open && setConfirmHits(null)}>
        <AppDialogContent
          title="检测到敏感词"
          description="以下词汇出现在内容中，请确认是否继续导入（内容不会被修改）"
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirmHits(null)}>返回修改</Button>
              <Button
                onClick={() => {
                  if (confirmHits) {
                    props.onImport({
                      title: title.trim() || "粘贴章节",
                      sourceType: "paste",
                      content: cleaned,
                    });
                    setRaw("");
                    setTitle("");
                  }
                  setConfirmHits(null);
                }}
              >
                仍然导入
              </Button>
            </>
          }
        >
          <div className="flex flex-wrap gap-2">
            {(confirmHits ?? []).map((word) => (
              <Badge key={word} variant="outline">
                {word}
              </Badge>
            ))}
          </div>
        </AppDialogContent>
      </Dialog>
    </div>
  );
}

// --- 灵感生成 ---

function InspirationSource(props: {
  disabled: boolean;
  onImport: (params: {
    title: string;
    sourceType: "inspiration";
    content: string;
    inspiration: { brief: InspirationBrief; draft: InspirationDraft };
  }) => void;
}) {
  const queryClient = useQueryClient();
  const aiQuery = useAiSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingGenerate, setPendingGenerate] = useState(false);

  const [keywords, setKeywords] = useState("");
  const [length, setLength] = useState<InspirationBrief["length"]>("short");
  const [genre, setGenre] = useState("");
  const [styleHint, setStyleHint] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [draft, setDraft] = useState<InspirationDraft | null>(null);
  const [editedContent, setEditedContent] = useState("");

  const runGenerate = async () => {
    const settings = aiQuery.data;
    if (!isLlmReady(settings)) {
      toast.info("请先配置 AI 文本模型（API Key 只保存在本机）");
      setSettingsOpen(true);
      setPendingGenerate(true);
      return;
    }
    try {
      const result = await generateInspirationDraft(settings!, {
        keywords,
        length,
        genre,
        styleHint,
        narrativeTemplateId: templateId || undefined,
      });
      setDraft(result);
      setEditedContent(result.content);
      toast.success("灵感草稿已生成，可修改后导入");
    } catch (error) {
      toast.error(describeAiError(error));
    }
  };

  // 设置保存后自动继续生成
  useEffect(() => {
    if (pendingGenerate && aiQuery.data && isLlmReady(aiQuery.data)) {
      setPendingGenerate(false);
      void runGenerate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiQuery.data]);

  const confirmImport = () => {
    if (!draft) return;
    const finalDraft: InspirationDraft = { ...draft, content: editedContent };
    props.onImport({
      title: keywords.trim().slice(0, 12) || "灵感章节",
      sourceType: "inspiration",
      content: finalDraft.content,
      inspiration: {
        brief: { keywords, length, genre, styleHint, narrativeTemplateId: templateId || undefined },
        draft: finalDraft,
      },
    });
    setDraft(null);
    setEditedContent("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">输入灵感关键词，AI 生成人物、场景与正文（唯一走大模型的导入方式）</p>
        <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
          <Settings2 className="h-3.5 w-3.5" />
          AI 设置
        </Button>
      </div>
      <AiSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <Input
        value={keywords}
        placeholder="灵感关键词 / 一句话梗概，例如：修仙者重生都市当外卖员"
        onChange={(event) => setKeywords(event.target.value)}
      />
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          篇幅
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            value={length}
            onChange={(event) => setLength(event.target.value as InspirationBrief["length"])}
          >
            <option value="short">短（约1-2千字）</option>
            <option value="medium">中（约3-5千字）</option>
            <option value="long">长（约6-10千字）</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          题材
          <Input value={genre} placeholder="如：都市、玄幻" onChange={(event) => setGenre(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          风格倾向
          <Input value={styleHint} placeholder="如：轻松搞笑" onChange={(event) => setStyleHint(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          叙事模板（可选）
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
          >
            <option value="">不使用</option>
            {narrativeTemplates.templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {draft ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 rounded-lg bg-background/60 p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">{draft.characters.length} 个角色</Badge>
            <Badge variant="secondary">{draft.scenes.length} 个场景</Badge>
            <Badge variant="secondary">{draft.plotNodes.length} 个剧情节点</Badge>
            <Badge variant="outline">{draft.content.length} 字正文</Badge>
          </div>
          <textarea
            value={editedContent}
            onChange={(event) => setEditedContent(event.target.value)}
            className="min-h-0 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed"
          />
          <div className="flex items-center justify-between">
            <Button variant="outline" size="sm" disabled={props.disabled} onClick={() => void runGenerate()}>
              <RefreshCw className="h-3.5 w-3.5" />
              重新生成
            </Button>
            <Button size="sm" onClick={confirmImport}>
              确认导入
            </Button>
          </div>
        </div>
      ) : (
        <Button
          className="mt-auto"
          disabled={props.disabled || !keywords.trim()}
          onClick={() => void runGenerate()}
        >
          <Lightbulb className="h-4 w-4" />
          生成灵感草稿
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function sourceLabel(source: ComicChapter["sourceType"]): string {
  switch (source) {
    case "txt":
      return "文件导入";
    case "paste":
      return "粘贴导入";
    case "inspiration":
      return "灵感生成";
  }
}

async function touchProjectIfPossible(projectId: string): Promise<void> {
  const project = await getProject(projectId);
  if (project) await touchProject(project);
}
