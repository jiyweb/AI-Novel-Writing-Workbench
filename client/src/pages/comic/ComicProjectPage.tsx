import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronDown,
  Download,
  Loader2,
  Pencil,
  BookText,
  Palette,
  Check,
} from "lucide-react";
import {
  exportComicEpisode,
  getComicProject,
  listComicEpisodes,
  updateComicPreset,
  type ComicEpisode,
  type ComicProject,
} from "@/api/comic";
import { COMIC_FORMATS } from "@/pages/comic/ComicWorkspacePage";
import { CharactersPanel } from "@/pages/comic/project/CharactersPanel";
import { ScenesPanel } from "@/pages/comic/project/ScenesPanel";
import { EpisodeListPanel } from "@/pages/comic/project/EpisodeListPanel";
import { PanelsGridPanel } from "@/pages/comic/project/PanelsGridPanel";
import { getAPIKeySettings, saveAPIKeySetting, type APIKeyStatus } from "@/api/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import SelectControl from "@/components/common/SelectControl";
import {
  COMIC_STYLE_OPTIONS,
  CUSTOM_STYLE_MAX_LENGTH,
  CUSTOM_STYLE_VALUE,
} from "./comicStyle";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeJsonParseProject(raw: string | null | undefined): {
  style?: string;
  customStyle?: string;
  format?: string;
  imageSize?: string;
} {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function ExportPanel({ projectId, episodes }: { projectId: string; episodes: ComicEpisode[] }) {
  const [selectedEpId, setSelectedEpId] = useState(episodes[0]?.id ?? "");
  const exportMut = useMutation({
    mutationFn: (episodeId: string) => exportComicEpisode(episodeId, { format: "long_image" }),
    onSuccess: (result) => {
      const artifact = result.artifacts[0];
      if (artifact?.url) {
        window.open(artifact.url, "_blank");
      }
      toast.success("导出完成");
    },
    onError: (e) => toast.error(String(e)),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-end">
        <div className="space-y-1">
          <label className="text-sm font-medium">选择话数</label>
          <SelectControl
            className="rounded-md border bg-background px-3 py-2 text-sm"
            value={selectedEpId}
            onChange={(e) => setSelectedEpId(e.target.value)}
          >
            {episodes.map((ep) => (
              <option key={ep.id} value={ep.id}>
                第 {ep.order} 话 {ep.title ? `《${ep.title}》` : ""}（{ep._count?.panels ?? 0} 格）
              </option>
            ))}
          </SelectControl>
        </div>
        <Button
          type="button"
          disabled={!selectedEpId || exportMut.isPending}
          onClick={() => exportMut.mutate(selectedEpId)}
        >
          <Download className="h-4 w-4" />
          {exportMut.isPending ? "导出中…" : "导出长图"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        导出前请确保所有格子已生成图像。图像内文字由模型直接渲染。
      </p>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ComicProjectPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [showFormatPicker, setShowFormatPicker] = useState(false);
  const [showStylePicker, setShowStylePicker] = useState(false);
  // 当前工作页签：空状态引导可以直接跳到对应步骤
  const [activeTab, setActiveTab] = useState("outline");
  // 自定义画风草稿：打开画风选择器时用当前保存值初始化（openStylePicker 在 preset 解析后定义）
  const [customStyleDraft, setCustomStyleDraft] = useState("");
  // 弹层内是否展开自定义画风编辑区（未保存前不改变项目画风）
  const [customEditing, setCustomEditing] = useState(false);
  // 生图模型选择跨项目/跨刷新保留（用户通常长期用同一个生图模型）
  const [selectedProvider, setSelectedProvider] = useState<string>(() => {
    try { return localStorage.getItem("comic.preferredImageProvider") ?? ""; } catch { return ""; }
  });
  const handleProviderChange = (value: string) => {
    setSelectedProvider(value);
    try { localStorage.setItem("comic.preferredImageProvider", value); } catch { /* ignore */ }
  };

  const { data: project, isLoading } = useQuery({
    queryKey: ["comic", "project", id],
    queryFn: () => getComicProject(id!),
    enabled: Boolean(id),
  });

  const { data: episodes = [] } = useQuery({
    queryKey: ["comic", "episodes", id],
    queryFn: () => listComicEpisodes(id!),
    enabled: Boolean(id),
  });

  // 已配置且支持生图的厂商（每家可在模型设置里配置多个生图模型）
  const { data: imageProviders = [] } = useQuery({
    queryKey: ["settings", "api-keys"],
    queryFn: getAPIKeySettings,
    select: (res) =>
      (res.data ?? []).filter((p) => p.supportsImageGeneration && p.isConfigured),
  });
  const providerOptions = imageProviders.map((p) => ({
    value: p.provider,
    label: p.displayName ?? p.name,
  }));
  // 缓存的 provider 仍存在于可用列表才用，否则回退到第一个（避免引用已失效的 provider 配置）
  const resolvedProvider =
    (selectedProvider && providerOptions.some((p) => p.value === selectedProvider))
      ? selectedProvider
      : providerOptions[0]?.value || "";
  const activeImageProvider =
    imageProviders.find((p) => p.provider === resolvedProvider) ?? imageProviders[0];
  // 当前实际生效的生图模型：DB 显式选择 → 厂商默认 → 首个可选模型
  const effectiveImageModel =
    activeImageProvider?.currentImageModel
      ?? activeImageProvider?.defaultImageModel
      ?? activeImageProvider?.imageModels[0]
      ?? "";
  const imageModelOptions = Array.from(
    new Set(
      [effectiveImageModel, ...(activeImageProvider?.imageModels ?? [])].filter(
        (m): m is string => Boolean(m),
      ),
    ),
  );

  // 切换某厂商的默认生图模型（保存在模型设置中，全应用的图片生成共用）
  const imageModelMut = useMutation({
    mutationFn: (input: { provider: APIKeyStatus["provider"]; imageModel: string }) =>
      saveAPIKeySetting(input.provider, { imageModel: input.imageModel }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings", "api-keys"] });
      toast.success("该厂商的默认生图模型已切换，后续生成的图片都会使用这个模型");
    },
    onError: (e) => toast.error(String(e)),
  });

  const presetMut = useMutation({
    mutationFn: (payload: Parameters<typeof updateComicPreset>[1]) => updateComicPreset(id!, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["comic", "project", id] });
      setShowFormatPicker(false);
      setShowStylePicker(false);
      toast.success("设置已更新，新图片将使用新设置生成");
    },
    onError: (e) => toast.error(String(e)),
  });

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!project) {
    return <div className="p-8 text-center text-muted-foreground">漫画项目不存在。</div>;
  }

  const preset = safeJsonParseProject(project.stylePreset);
  const formatDef = COMIC_FORMATS.find((f) => f.value === preset.format) ?? COMIC_FORMATS[0];
  const styleDef = COMIC_STYLE_OPTIONS.find((s) => s.value === preset.style);
  const openStylePicker = () => {
    setShowFormatPicker(false);
    setCustomStyleDraft(preset.customStyle ?? "");
    setCustomEditing(preset.style === CUSTOM_STYLE_VALUE);
    setShowStylePicker(true);
  };
  const saveCustomStyle = () => {
    const text = customStyleDraft.trim();
    if (text.length < 5) return;
    presetMut.mutate({ style: CUSTOM_STYLE_VALUE, customStyle: text });
  };
  const statusLabel: Record<string, string> = {
    draft: "草稿", outlined: "大纲已生成", scripted: "脚本已生成", completed: "已完成",
  };
  const sourceLabel: Record<string, string> = {
    novel_import: "小说改编", original: "原创", text_import: "文本导入", comic_import: "漫画改编",
  };

  return (
    <div className="w-full space-y-5 px-4 py-6 lg:px-6">
      {/* 顶部导航 */}
      <div className="flex items-center gap-2">
        <Button asChild type="button" variant="ghost" size="sm" className="-ml-2">
          <Link to="/comic">
            <ChevronLeft className="h-4 w-4" />
            漫画工作台
          </Link>
        </Button>
      </div>

      {/* 项目信息头部：标题与进度在上，创作设置集中在下一行 */}
      <div className="space-y-4 rounded-2xl bg-muted/30 p-5">
        {/* 标题行 */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className="text-2xl font-bold tracking-tight">{project.title}</h1>
          <Badge variant={project.status === "outlined" || project.status === "scripted" ? "default" : "secondary"}>
            {statusLabel[project.status] ?? project.status}
          </Badge>
          <span className="text-xs text-muted-foreground">{sourceLabel[project.sourceType] ?? project.sourceType}</span>
          <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            {project.sourceBundle ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2.5 py-0.5 text-green-600 dark:text-green-400">
                <BookText className="h-3 w-3" />
                内容源已导入
              </span>
            ) : (
              <span>内容源未导入，可在「分话大纲」里导入</span>
            )}
            <span className="tabular-nums">{formatDef.imageSize}</span>
          </div>
        </div>

        {/* 进度统计：用分隔与字重分层，不画描边方块 */}
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <span>
            话数
            <b className="ml-1.5 text-base font-semibold tabular-nums text-foreground">{episodes.length}</b>
          </span>
          <span>
            总格数
            <b className="ml-1.5 text-base font-semibold tabular-nums text-foreground">
              {episodes.reduce((s, e) => s + (e._count?.panels ?? 0), 0)}
            </b>
          </span>
          <span>
            角色
            <b className="ml-1.5 text-base font-semibold tabular-nums text-foreground">
              {project._count?.characters ?? project.characters.length}
            </b>
          </span>
          <span className="hidden sm:inline">{formatDef.tag}</span>
        </div>

        {/* 创作设置行：形态、画风可直接调整，右侧选择生图厂商与模型 */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3.5">
          <span className="mr-0.5 text-xs text-muted-foreground">创作设置</span>

          {/* 漫画形态 — 点击展开选择器 */}
          <div className="relative">
            <button
              type="button"
              title={`${formatDef.label}：${formatDef.desc}（点击更换）`}
              onClick={() => { setShowFormatPicker((v) => !v); setShowStylePicker(false); }}
              className="inline-flex h-8 items-center gap-2 rounded-md border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-accent"
            >
              <span className={`text-primary ${formatDef.imageSize === "1536x1024" ? "h-4 w-7" : "h-7 w-4"}`}>
                {formatDef.layoutSvg}
              </span>
              {formatDef.label}
              <Pencil className="h-3 w-3 text-muted-foreground/60" />
            </button>

            {showFormatPicker && (
              <>
                <button
                  type="button"
                  aria-label="关闭形态选择"
                  className="fixed inset-0 z-40 cursor-default bg-transparent"
                  onClick={() => setShowFormatPicker(false)}
                />
                <div className="absolute left-0 top-full z-50 mt-2 w-[480px] max-w-[calc(100vw-2rem)] rounded-xl border bg-popover p-4 shadow-xl">
                  <p className="mb-3 text-xs font-medium text-muted-foreground">选择漫画形态（决定画面比例和分格方式）</p>
                  <div className="grid grid-cols-4 gap-2">
                    {COMIC_FORMATS.map((fmt) => (
                      <button
                        key={fmt.value}
                        type="button"
                        disabled={presetMut.isPending}
                        onClick={() => presetMut.mutate({ format: fmt.value, promptKeywords: fmt.promptKeywords, imageSize: fmt.imageSize })}
                        className={`relative flex flex-col items-center gap-1.5 rounded-lg p-2 text-center transition-colors hover:bg-accent ${fmt.value === formatDef.value ? "bg-primary/5 ring-1 ring-primary" : ""}`}
                      >
                        {fmt.value === formatDef.value && (
                          <Check className="absolute right-1.5 top-1.5 h-3 w-3 text-primary" />
                        )}
                        <div className={`${fmt.imageSize === "1536x1024" ? "h-8 w-12" : "h-12 w-8"} text-primary`}>
                          {fmt.layoutSvg}
                        </div>
                        <span className="text-xs font-medium">{fmt.label}</span>
                        <span className="text-[10px] leading-tight text-muted-foreground">{fmt.tag}</span>
                      </button>
                    ))}
                  </div>
                  <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                    更换形态后，新生成的场景和格子图会按新比例出图，已经生成的图片不会自动重画。
                  </p>
                </div>
              </>
            )}
          </div>

          {/* 画风 — 点击展开选择器 */}
          <div className="relative">
            <button
              type="button"
              title="点击更换画风（角色、场景和每一格画面统一使用）"
              onClick={() => (showStylePicker ? setShowStylePicker(false) : openStylePicker())}
              className="inline-flex h-8 max-w-[260px] items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-accent"
            >
              <Palette className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {preset.style === CUSTOM_STYLE_VALUE && preset.customStyle
                  ? preset.customStyle
                  : styleDef?.label ?? "彩色韩漫"}
              </span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            </button>

            {showStylePicker && (
              <>
                <button
                  type="button"
                  aria-label="关闭画风选择"
                  className="fixed inset-0 z-40 cursor-default bg-transparent"
                  onClick={() => setShowStylePicker(false)}
                />
                <div className="absolute left-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border bg-popover p-3 shadow-xl">
                <p className="text-xs font-medium text-muted-foreground mb-2">选择画风（角色、场景、格子统一使用）</p>
                <div className="space-y-1">
                  {COMIC_STYLE_OPTIONS.map((opt) => {
                    const active = opt.value === preset.style && !customEditing;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={presetMut.isPending}
                        onClick={() => {
                          if (opt.value === CUSTOM_STYLE_VALUE) {
                            if (!customEditing) setCustomStyleDraft(preset.customStyle ?? "");
                            setCustomEditing(true);
                          } else {
                            presetMut.mutate({ style: opt.value });
                          }
                        }}
                        className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors disabled:opacity-60 ${opt.value === CUSTOM_STYLE_VALUE && customEditing ? "bg-primary/5 text-primary font-medium" : "hover:bg-accent"} ${active ? "bg-primary/5 text-primary font-medium" : ""}`}
                      >
                        <div>
                          <span className="font-medium">{opt.label}</span>
                          <span className="ml-2 text-xs text-muted-foreground">{opt.desc}</span>
                        </div>
                        {active && <Check className="h-3.5 w-3.5 flex-shrink-0" />}
                      </button>
                    );
                  })}
                </div>

                {/* 自定义画风编辑区：点击「自定义画风」后展开，保存后才生效 */}
                {customEditing && (
                  <div className="mt-2 space-y-1.5 border-t pt-2">
                    <textarea
                      autoFocus
                      className="w-full rounded-md border bg-background px-2.5 py-1.5 text-xs resize-y min-h-[72px]"
                      placeholder="描述你想要的画风：风格流派、线条、配色、光影、参考作品等，至少 5 个字"
                      rows={4}
                      maxLength={CUSTOM_STYLE_MAX_LENGTH}
                      value={customStyleDraft}
                      onChange={(e) => setCustomStyleDraft(e.target.value)}
                    />
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground/70 tabular-nums">
                        {customStyleDraft.trim().length}/{CUSTOM_STYLE_MAX_LENGTH}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          disabled={presetMut.isPending}
                          onClick={() => {
                            setCustomEditing(preset.style === CUSTOM_STYLE_VALUE);
                            setCustomStyleDraft(preset.customStyle ?? "");
                          }}
                        >
                          还原
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={presetMut.isPending
                            || customStyleDraft.trim().length < 5
                            || (preset.style === CUSTOM_STYLE_VALUE && customStyleDraft.trim() === (preset.customStyle ?? ""))}
                          onClick={saveCustomStyle}
                        >
                          {presetMut.isPending ? "保存中…" : "保存自定义画风"}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                </div>
              </>
            )}
          </div>

          {/* 生图厂商 + 模型：厂商仅本项目记住，模型切换保存为该厂商的默认生图模型 */}
          <div className="ml-auto flex items-center gap-1.5">
            {imageProviders.length === 0 ? (
              <>
                <span className="text-xs text-destructive">还没有可用的生图模型</span>
                <Button asChild type="button" variant="outline" size="sm" className="h-7 text-xs">
                  <Link to="/settings">去模型设置配置</Link>
                </Button>
              </>
            ) : (
              <>
                <span className="whitespace-nowrap text-xs text-muted-foreground">生图</span>
                <SelectControl
                  aria-label="生图厂商"
                  className="rounded-md border bg-background px-2 py-1 text-xs"
                  value={resolvedProvider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                >
                  {providerOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </SelectControl>
                <SelectControl
                  aria-label="生图模型"
                  title="切换后会保存为该厂商的默认生图模型，角色、场景和格子图都使用它"
                  className="max-w-[200px] rounded-md border bg-background px-2 py-1 text-xs"
                  disabled={imageModelMut.isPending}
                  value={effectiveImageModel}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (next && next !== activeImageProvider?.currentImageModel && activeImageProvider) {
                      imageModelMut.mutate({ provider: activeImageProvider.provider, imageModel: next });
                    }
                  }}
                >
                  {imageModelOptions.map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </SelectControl>
              </>
            )}
          </div>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="w-full justify-start gap-1">
          <TabsTrigger value="outline">分话大纲</TabsTrigger>
          <TabsTrigger value="characters">
            角色
            {project.characters.length > 0 && (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                {project.characters.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="scenes">场景</TabsTrigger>
          <TabsTrigger value="panels">格子图</TabsTrigger>
          <TabsTrigger value="export">导出</TabsTrigger>
        </TabsList>

        <TabsContent value="outline" className="mt-4">
          <EpisodeListPanel projectId={id!} project={project} />
        </TabsContent>

        <TabsContent value="characters" className="mt-4">
          <CharactersPanel project={project} provider={resolvedProvider} />
        </TabsContent>

        <TabsContent value="scenes" className="mt-4">
          <ScenesPanel project={project} provider={resolvedProvider} />
        </TabsContent>

        <TabsContent value="panels" className="mt-4">
          <PanelsGridPanel projectId={id!} provider={resolvedProvider} onGoToTab={setActiveTab} />
        </TabsContent>

        <TabsContent value="export" className="mt-4">
          {episodes.length > 0 ? (
            <ExportPanel projectId={id!} episodes={episodes} />
          ) : (
            <div className="py-12 text-center">
              <p className="text-sm text-muted-foreground">还没有可导出的分话，先完成大纲和分格脚本。</p>
              <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setActiveTab("outline")}>
                去生成分话大纲
              </Button>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
