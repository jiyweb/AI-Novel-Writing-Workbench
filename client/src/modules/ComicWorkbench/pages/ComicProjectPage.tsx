/**
 * /comic/projects/:id 漫画工作台
 * 步骤式布局：导入 → 形态画风 → 分镜 → 角色场景 → 台词 → 描述词 → 生成 → 导出
 */
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getFormById, getStylePresetById } from "../services/configService";
import { getProject } from "../db/comicDb";
import { WORKBENCH_STEPS, useComicWorkbenchStore } from "../stores/workbenchStore";
import { ImportStepPanel } from "../components/steps/ImportStepPanel";
import { FormStyleStepPanel } from "../components/steps/FormStyleStepPanel";
import { StoryboardStepPanel } from "../components/steps/StoryboardStepPanel";
import type { WorkbenchStep } from "../stores/workbenchStore";

export default function ComicProjectPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id ?? null;

  const step = useComicWorkbenchStore((state) => state.step);
  const setStep = useComicWorkbenchStore((state) => state.setStep);

  const projectQuery = useQuery({
    queryKey: ["comic-workbench", "project", projectId] as const,
    queryFn: () => (projectId ? getProject(projectId) : Promise.resolve(undefined)),
    enabled: Boolean(projectId),
  });
  const project = projectQuery.data;

  const form = useMemo(() => (project ? getFormById(project.formId) : undefined), [project]);
  const style = useMemo(() => (project ? getStylePresetById(project.stylePresetId) : undefined), [project]);

  if (!projectId) {
    return <MissingProject />;
  }
  if (projectQuery.isLoading) {
    return <div className="py-20 text-center text-sm text-muted-foreground">加载中…</div>;
  }
  if (!project) {
    return <MissingProject />;
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-7xl flex-col px-4 py-6">
      {/* 头部：返回 + 项目信息 */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/comic" aria-label="返回项目列表">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">{project.name}</h1>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              {form ? <Badge variant="secondary">{form.name} {form.aspectRatio}</Badge> : null}
              {style ? <Badge variant="outline">{style.name}</Badge> : null}
            </div>
          </div>
        </div>
      </header>

      {/* 步骤导航 */}
      <nav className="mt-5 flex flex-wrap items-center gap-1 border-b pb-3">
        {WORKBENCH_STEPS.map((item, index) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setStep(item.id)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              step === item.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <span className="mr-1.5 text-xs opacity-70">{index + 1}</span>
            {item.label}
          </button>
        ))}
      </nav>

      {/* 步骤面板 */}
      <div className="flex min-h-0 flex-1 flex-col pt-5">
        <StepBody step={step} projectId={projectId} />
      </div>
    </div>
  );
}

function StepBody(props: { step: WorkbenchStep; projectId: string }) {
  switch (props.step) {
    case "import":
      return <ImportStepPanel projectId={props.projectId} />;
    case "formStyle":
      return <FormStyleStepPanel projectId={props.projectId} />;
    case "storyboard":
      return <StoryboardStepPanel projectId={props.projectId} />;
    default:
      return (
        <div className="rounded-xl bg-muted/30 px-6 py-16 text-center text-sm text-muted-foreground">
          此步骤将在后续阶段开放，请先从「内容导入」开始。
        </div>
      );
  }
}

function MissingProject() {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
      <h2 className="text-lg font-semibold">找不到这个漫画项目</h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        项目可能已被删除，或数据尚未在本机创建。回到项目列表查看现有项目。
      </p>
      <Button className="mt-6" asChild>
        <Link to="/comic">返回项目列表</Link>
      </Button>
    </div>
  );
}
