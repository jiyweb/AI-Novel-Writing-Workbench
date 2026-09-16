/**
 * 漫画规则管理（资产区入口）
 *
 * 集中查看与调整项目内可改动的漫画规则：
 * 1. 画风参数（线条/画质/光影/色调/追加关键词）——项目级，保存后全部章节
 *    presentation 递增，已生成的画面链路自动标记待更新；
 * 2. 分镜密度方案（档位 + 动态密度）——章节级，支持「当前章节」或「全部章节」
 *    统一应用；
 * 3. 台词呈现方式与描述词模板——跟随配置（漫画形态 / 描述词步骤），此处只读说明。
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { AppDialogContent, Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  comicKeys,
  useComicChapters,
  useComicProject,
  useWorkbenchSettings,
} from "../../hooks/useComicQuery";
import { useComicWorkbenchStore } from "../../stores/workbenchStore";
import { getFormById, getStylePresetById, shotDensity } from "../../services/configService";
import { changeProjectStyle } from "../../services/projectService";
import { updateDensityPlan } from "../../services/storyboard/storyboardService";
import type {
  ComicProject,
  ComicLetteringMode,
  ShotDensityLevel,
  StyleAdjustments,
} from "../../types";

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

export function ComicRulesDialog(props: { projectId: string; onClose: () => void }) {
  const { projectId, onClose } = props;
  const queryClient = useQueryClient();
  const projectQuery = useComicProject(projectId);
  const project = projectQuery.data;
  const chaptersQuery = useComicChapters(projectId);
  const chapters = [...(chaptersQuery.data ?? [])].sort((a, b) => a.index - b.index);
  const chapterId = useComicWorkbenchStore((state) => state.chapterId);
  const settingsQuery = useWorkbenchSettings();

  const chapter = chapters.find((item) => item.id === chapterId) ?? chapters[0] ?? null;
  const form = project ? getFormById(project.formId) : undefined;
  const style = project ? getStylePresetById(project.stylePresetId) : undefined;

  // 画风参数本地草稿态（保存时才落库，避免逐键触发版本递增）
  const [adjustments, setAdjustments] = useState<StyleAdjustments>({
    colorTone: "",
    lineWeight: "normal",
    quality: "standard",
    lighting: "balanced",
  });
  const [customKeywords, setCustomKeywords] = useState("");
  useEffect(() => {
    if (!project) return;
    setAdjustments({ ...project.styleAdjustments });
    setCustomKeywords(project.customStyleKeywords);
  }, [project]);

  const [densityLevel, setDensityLevel] = useState<ShotDensityLevel>(
    chapter?.densityPlan.global ?? shotDensity.defaultDensity,
  );
  const [densityDynamic, setDensityDynamic] = useState(chapter?.densityPlan.dynamic ?? false);
  const [densityScope, setDensityScope] = useState<"current" | "all">("current");
  useEffect(() => {
    if (!chapter) return;
    setDensityLevel(chapter.densityPlan.global);
    setDensityDynamic(chapter.densityPlan.dynamic);
  }, [chapter]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: comicKeys.project(projectId) });
    await queryClient.invalidateQueries({ queryKey: comicKeys.chapters(projectId) });
  };

  const styleMutation = useMutation({
    mutationFn: async () => {
      if (!project) throw new Error("项目不存在");
      return changeProjectStyle(project, {
        styleAdjustments: adjustments,
        customStyleKeywords: customKeywords,
      });
    },
    onSuccess: async () => {
      toast.success("画风参数已保存，已生成的画面将标记为待更新");
      await invalidate();
    },
    onError: (error: Error) => toast.error(`画风参数保存失败：${error.message}`),
  });

  const densityMutation = useMutation({
    mutationFn: async () => {
      if (!chapter) throw new Error("请先选择一个章节");
      const plan = { global: densityLevel, dynamic: densityDynamic };
      const targets = densityScope === "all" ? chapters : [chapter];
      for (const item of targets) {
        await updateDensityPlan(item, plan);
      }
      return targets.length;
    },
    onSuccess: async (count) => {
      toast.success(
        densityScope === "all"
          ? `分镜密度方案已应用到全部 ${count} 个章节，重新生成后生效`
          : "分镜密度方案已保存，重新生成后生效",
      );
      await invalidate();
    },
    onError: (error: Error) => toast.error(`密度方案保存失败：${error.message}`),
  });

  const busy = styleMutation.isPending || densityMutation.isPending;
  const customFormula = settingsQuery.data?.customPromptFormula ?? null;

  if (!project) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <AppDialogContent title="漫画规则" description="项目加载中…">
          <div className="py-6 text-center text-sm text-muted-foreground">正在加载项目</div>
        </AppDialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <AppDialogContent
        title="漫画规则"
        description="集中调整本项目可改动的创作规则；改动会按数据链路自动标记下游待更新"
        className="max-w-2xl"
      >
        <div className="max-h-[65vh] space-y-5 overflow-y-auto pr-1">
          {/* 画风参数 */}
          <section>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">画风参数</h3>
              <Badge variant="outline" className="text-[10px]">
                当前画风：{style?.name ?? "默认"}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              更换画风预设请到「形态画风」步骤；这里调整当前画风的细节参数。
            </p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <RuleSelect
                label="线条"
                value={adjustments.lineWeight}
                options={LINE_WEIGHT_OPTIONS}
                onChange={(value) =>
                  setAdjustments((prev) => ({ ...prev, lineWeight: value as StyleAdjustments["lineWeight"] }))
                }
              />
              <RuleSelect
                label="画质"
                value={adjustments.quality}
                options={QUALITY_OPTIONS}
                onChange={(value) =>
                  setAdjustments((prev) => ({ ...prev, quality: value as StyleAdjustments["quality"] }))
                }
              />
              <RuleSelect
                label="光影"
                value={adjustments.lighting}
                options={LIGHTING_OPTIONS}
                onChange={(value) =>
                  setAdjustments((prev) => ({ ...prev, lighting: value as StyleAdjustments["lighting"] }))
                }
              />
            </div>
            <label className="mt-2 block">
              <span className="text-xs text-muted-foreground">色调倾向（如：暖色、冷灰、高饱和）</span>
              <input
                type="text"
                value={adjustments.colorTone}
                onChange={(event) => setAdjustments((prev) => ({ ...prev, colorTone: event.target.value }))}
                className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              />
            </label>
            <label className="mt-2 block">
              <span className="text-xs text-muted-foreground">追加画风关键词（会拼进所有画面描述词）</span>
              <textarea
                value={customKeywords}
                rows={2}
                onChange={(event) => setCustomKeywords(event.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              />
            </label>
            <div className="mt-2 flex justify-end">
              <Button size="sm" disabled={busy} onClick={() => styleMutation.mutate()}>
                保存画风参数
              </Button>
            </div>
          </section>

          <div className="border-t" />

          {/* 分镜密度 */}
          <section>
            <h3 className="text-sm font-semibold">分镜密度</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              控制每章切分的镜头数量；修改后需要重新生成分镜才会应用。
            </p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs text-muted-foreground">密度档位</span>
                <select
                  value={densityLevel}
                  onChange={(event) => setDensityLevel(event.target.value as ShotDensityLevel)}
                  className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {shotDensity.levels.map((level) => (
                    <option key={level.id} value={level.id}>
                      {level.name}（{level.description}）
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col justify-end gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={densityDynamic}
                    onChange={(event) => setDensityDynamic(event.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  智能动态密度（高潮/对话密集段自动调紧）
                </label>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">应用范围</span>
                  <button
                    type="button"
                    onClick={() => setDensityScope("current")}
                    className={cn(
                      "rounded-full px-2.5 py-0.5 text-xs transition-colors",
                      densityScope === "current"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted/50 text-muted-foreground hover:bg-muted",
                    )}
                  >
                    当前章节{chapter ? `（${chapter.title}）` : ""}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDensityScope("all")}
                    className={cn(
                      "rounded-full px-2.5 py-0.5 text-xs transition-colors",
                      densityScope === "all"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted/50 text-muted-foreground hover:bg-muted",
                    )}
                  >
                    全部章节（{chapters.length}）
                  </button>
                </div>
              </div>
            </div>
            <div className="mt-2 flex justify-end">
              <Button size="sm" disabled={busy || !chapter} onClick={() => densityMutation.mutate()}>
                保存密度方案
              </Button>
            </div>
          </section>

          <div className="border-t" />

          {/* 台词呈现（跟随形态，只读） */}
          <section>
            <h3 className="text-sm font-semibold">台词呈现</h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">
                {form ? `${form.name} · ${LETTERING_LABELS[form.letteringMode]}` : "未选择形态"}
              </Badge>
              <span className="text-xs text-muted-foreground">
                台词呈现方式跟随所选漫画形态；更换形态请到「形态画风」步骤。
              </span>
            </div>
          </section>

          <div className="border-t" />

          {/* 描述词模板（只读说明） */}
          <section>
            <h3 className="text-sm font-semibold">描述词模板</h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant={customFormula ? "default" : "secondary"}>
                {customFormula ? "使用个人模板" : "使用默认模板"}
              </Badge>
              <span className="text-xs text-muted-foreground">
                在「描述词」步骤可查看与自定义模板。
              </span>
            </div>
          </section>
        </div>
      </AppDialogContent>
    </Dialog>
  );
}

function RuleSelect(props: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{props.label}</span>
      <select
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
