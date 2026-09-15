/**
 * 漫画工作台全局状态（zustand）
 *
 * 只存放会话态（当前打开的项目/章节/步骤）；
 * 业务数据（项目/章节/分镜等）由 react-query + comicDb 管理，避免双写。
 */
import { create } from "zustand";

/** 工作台步骤（与 ComicProjectPage 的步骤面板一一对应） */
export type WorkbenchStep =
  | "import"
  | "formStyle"
  | "storyboard"
  | "cast"
  | "dialogue"
  | "prompt"
  | "generate"
  | "export";

export const WORKBENCH_STEPS: Array<{ id: WorkbenchStep; label: string }> = [
  { id: "import", label: "内容导入" },
  { id: "formStyle", label: "形态画风" },
  { id: "storyboard", label: "智能分镜" },
  { id: "cast", label: "角色场景" },
  { id: "dialogue", label: "台词" },
  { id: "prompt", label: "描述词" },
  { id: "generate", label: "生成" },
  { id: "export", label: "导出" },
];

interface WorkbenchState {
  /** 当前打开的项目 */
  projectId: string | null;
  /** 当前编辑的章节 */
  chapterId: string | null;
  /** 当前工作台步骤 */
  step: WorkbenchStep;
  openProject: (projectId: string) => void;
  openChapter: (chapterId: string | null) => void;
  setStep: (step: WorkbenchStep) => void;
  /** 返回项目列表时清空会话态 */
  closeProject: () => void;
}

export const useComicWorkbenchStore = create<WorkbenchState>((set) => ({
  projectId: null,
  chapterId: null,
  step: "import",
  openProject: (projectId) => set({ projectId, chapterId: null, step: "import" }),
  openChapter: (chapterId) => set({ chapterId }),
  setStep: (step) => set({ step }),
  closeProject: () => set({ projectId: null, chapterId: null, step: "import" }),
}));
