/**
 * /comic 漫画工作台首页：项目管理
 * 新建 / 重命名 / 删除（级联清理）项目，点击卡片进入工作台。
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, Clock, Layers, Plus, SquareStack } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AppDialogContent,
  Dialog,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  createEmptyProject,
  loadFormSummaries,
  renameProject,
} from "../services/projectService";
import { deleteProjectCascade, listProjects } from "../db/comicDb";
import type { ComicFormSummary } from "../services/projectService";
import type { ComicProject } from "../types";

const projectsQueryKey = ["comic-workbench", "projects"] as const;

export default function ComicWorkbenchPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [renameTarget, setRenameTarget] = useState<ComicProject | null>(null);
  const [renameName, setRenameName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ComicProject | null>(null);

  const projectsQuery = useQuery({
    queryKey: projectsQueryKey,
    queryFn: listProjects,
  });

  const formsQuery = useQuery({
    queryKey: ["comic-workbench", "forms"] as const,
    queryFn: loadFormSummaries,
  });
  const formMap = useMemo(
    () => new Map((formsQuery.data ?? []).map((form) => [form.id, form])),
    [formsQuery.data],
  );

  const createMutation = useMutation({
    mutationFn: async (name: string) => createEmptyProject(name),
    onSuccess: () => {
      toast.success("项目已创建，去导入第一章内容吧");
      setCreateOpen(false);
      setNewName("");
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
    onError: (error: Error) => toast.error(`创建失败：${error.message}`),
  });

  const renameMutation = useMutation({
    mutationFn: async ({ project, name }: { project: ComicProject; name: string }) =>
      renameProject(project, name),
    onSuccess: () => {
      toast.success("项目已重命名");
      setRenameTarget(null);
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
    onError: (error: Error) => toast.error(`重命名失败：${error.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: async (project: ComicProject) => deleteProjectCascade(project.id),
    onSuccess: () => {
      toast.success("项目及其全部数据已删除");
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
    onError: (error: Error) => toast.error(`删除失败：${error.message}`),
  });

  const projects = projectsQuery.data ?? [];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <SquareStack className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">漫画工作台</h1>
            <p className="text-sm text-muted-foreground">
              从小说原文或灵感开始，分镜、角色、生成、导出全流程本地完成
            </p>
          </div>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4" />
              新建项目
            </Button>
          </DialogTrigger>
          <AppDialogContent
            title="新建漫画项目"
            description="输入项目名称，创建后可在工作台中选择漫画形态与画风"
            footer={
              <>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                  取消
                </Button>
                <Button
                  disabled={!newName.trim() || createMutation.isPending}
                  onClick={() => createMutation.mutate(newName.trim())}
                >
                  创建
                </Button>
              </>
            }
          >
            <Input
              value={newName}
              placeholder="例如：都市重生条漫"
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && newName.trim()) {
                  createMutation.mutate(newName.trim());
                }
              }}
            />
          </AppDialogContent>
        </Dialog>
      </header>

      {projectsQuery.isLoading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">加载中…</div>
      ) : projects.length === 0 ? (
        <EmptyGuide onCreate={() => setCreateOpen(true)} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              form={formMap.get(project.formId)}
              onRename={() => {
                setRenameTarget(project);
                setRenameName(project.name);
              }}
              onDelete={() => setDeleteTarget(project)}
            />
          ))}
        </div>
      )}

      {/* 重命名弹窗 */}
      <Dialog open={renameTarget !== null} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <AppDialogContent
          title="重命名项目"
          footer={
            <>
              <Button variant="outline" onClick={() => setRenameTarget(null)}>
                取消
              </Button>
              <Button
                disabled={!renameName.trim() || renameMutation.isPending}
                onClick={() =>
                  renameTarget && renameMutation.mutate({ project: renameTarget, name: renameName.trim() })
                }
              >
                保存
              </Button>
            </>
          }
        >
          <Input value={renameName} onChange={(event) => setRenameName(event.target.value)} />
        </AppDialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AppDialogContent
          title="删除项目"
          description="将永久删除该项目下的全部章节、分镜、角色/场景库与生成图片，且无法恢复。"
          footer={
            <>
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>
                取消
              </Button>
              <Button
                variant="destructive"
                disabled={deleteMutation.isPending}
                onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
              >
                确认删除
              </Button>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">
            即将删除：<span className="font-medium text-foreground">{deleteTarget?.name}</span>
          </p>
        </AppDialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

function ProjectCard(props: {
  project: ComicProject;
  form?: ComicFormSummary;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { project, form } = props;
  return (
    <div className="group flex flex-col rounded-xl bg-muted/40 p-4 transition-colors hover:bg-muted/70">
      <div className="flex items-start justify-between gap-2">
        <Link
          to={`/comic/projects/${project.id}`}
          className="min-w-0 flex-1 rounded-md text-left"
        >
          <h3 className="truncate text-base font-semibold group-hover:text-primary">
            {project.name}
          </h3>
        </Link>
        {form ? <Badge variant="secondary">{form.name}</Badge> : null}
      </div>
      <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Layers className="h-3.5 w-3.5" />
          {form?.aspectRatio ?? "--"}
        </span>
        <span className="inline-flex items-center gap-1">
          <BookOpen className="h-3.5 w-3.5" />
          {new Date(project.updatedAt).toLocaleDateString()}
        </span>
        <span className="inline-flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          {new Date(project.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
      <div className="mt-4 flex items-center justify-between">
        <Link
          to={`/comic/projects/${project.id}`}
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          进入工作台
        </Link>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={props.onRename}>
            重命名
          </Button>
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={props.onDelete}>
            删除
          </Button>
        </div>
      </div>
    </div>
  );
}

function EmptyGuide(props: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl bg-muted/30 px-6 py-16 text-center">
      <SquareStack className="h-12 w-12 text-muted-foreground/50" />
      <h2 className="mt-4 text-lg font-semibold">还没有漫画项目</h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        新建项目后，只需四步：导入小说内容 → 选择形态与画风 → 生成分镜与角色 → 批量生成并导出。
        所有数据保存在本机浏览器中，刷新页面不会丢失。
      </p>
      <Button className="mt-6" onClick={props.onCreate}>
        <Plus className="h-4 w-4" />
        创建第一个项目
      </Button>
    </div>
  );
}
