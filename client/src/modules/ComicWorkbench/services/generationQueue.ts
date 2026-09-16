/**
 * 生图队列：草稿/高清两档、受控并发、失败重试、断点续传
 *
 * - 任务持久化（comic:genTask），页面刷新后可恢复；
 * - 启动时 recoverInterruptedTasks 把遗留的 running/queued 任务重置为 pending，
 *   用户点「继续生成」即从断点续跑；
 * - 单任务失败按指数退避自动重试（上限取 config/aiProviders.json 的 maxRetries）；
 * - 重绘/重试成功后删除旧图片记录，避免孤儿 blob 占空间。
 *
 * 生图调用统一走 services/ai/imageClient（协议分流在那层），本层只管编排。
 */
import { generateImage } from "./ai/imageClient";
import { getAiDefaults } from "./ai/aiConfigService";
import { getFormById, promptFormula } from "./configService";
import { buildPanelPrompt } from "./promptEngine";
import {
  deleteImageRecord,
  generateId,
  getPanel,
  listGenerationTasks,
  saveGenerationTask,
  saveImageBlob,
  savePanel,
} from "../db/comicDb";
import type {
  ComicChapter,
  ComicCharacter,
  ComicImageModelChoice,
  ComicPanel,
  ComicProject,
  ComicScene,
  CustomPromptFormula,
  GenerationMode,
  GenerationTask,
} from "../types";
import { stageBasisSnapshot } from "../types";

export interface QueueProgress {
  done: number;
  total: number;
  succeeded: number;
  failed: number;
}

export interface RunQueueParams {
  chapter: ComicChapter;
  panels: ComicPanel[];
  project: ComicProject;
  characters: ComicCharacter[];
  scenes: ComicScene[];
  customFormula?: CustomPromptFormula | null;
  /** 生图模型覆盖选择（null = 跟随主程序当前生图模型） */
  imageChoice: ComicImageModelChoice | null;
  signal?: AbortSignal;
  onProgress?: (progress: QueueProgress) => void;
}

export interface RunQueueResult {
  succeeded: number;
  failed: number;
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// 断点恢复
// ---------------------------------------------------------------------------

/** 页面启动时调用：把上次中断的 running/queued 任务重置为 pending，返回恢复数 */
export async function recoverInterruptedTasks(chapterId: string): Promise<number> {
  const tasks = await listGenerationTasks(chapterId);
  let recovered = 0;
  for (const task of tasks) {
    if (task.status !== "running" && task.status !== "queued") continue;
    task.status = "pending";
    task.updatedAt = new Date().toISOString();
    await saveGenerationTask(task);
    const panel = await getPanel(task.panelId);
    if (panel && panel.generation.status === "running") {
      panel.generation = {
        ...panel.generation,
        status: "pending",
        error: "上次任务被中断，可继续生成",
        updatedAt: task.updatedAt,
      };
      await savePanel(panel);
    }
    recovered += 1;
  }
  return recovered;
}

// ---------------------------------------------------------------------------
// 任务编排
// ---------------------------------------------------------------------------

/**
 * 为章节补齐生成任务：已有目标模式成品/已有进行中任务的分镜跳过，
 * 其余（未生成、或成品档位不符）各建一个 pending 任务。
 * includeUpToDate 为 true 时连「已有同档成品」的分镜也建任务
 * （用于重出待更新画面：成品仍在但基于旧描述词/旧画风）。
 */
export async function ensureChapterTasks(
  chapter: ComicChapter,
  panels: ComicPanel[],
  mode: GenerationMode,
  options?: { includeUpToDate?: boolean },
): Promise<number> {
  const existing = await listGenerationTasks(chapter.id);
  let created = 0;
  for (const panel of panels) {
    if (
      !options?.includeUpToDate &&
      panel.generation.status === "success" &&
      panel.generation.mode === mode &&
      panel.generation.imageId
    ) {
      continue;
    }
    const active = existing.find(
      (task) =>
        task.panelId === panel.id &&
        (task.status === "pending" || task.status === "queued" || task.status === "running"),
    );
    if (active) {
      if (active.mode !== mode) {
        active.mode = mode;
        active.updatedAt = new Date().toISOString();
        await saveGenerationTask(active);
      }
      continue;
    }
    const now = new Date().toISOString();
    await saveGenerationTask({
      id: generateId("gtask"),
      projectId: chapter.projectId,
      chapterId: chapter.id,
      panelId: panel.id,
      mode,
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    created += 1;
  }
  return created;
}

/**
 * 运行章节队列：按分镜顺序消费 pending 任务（并发取自配置）。
 * cancelled 为 true 时所有未完成任务保持 pending，可随时继续。
 */
export async function runChapterQueue(params: RunQueueParams): Promise<RunQueueResult> {
  const defaults = getAiDefaults();
  const tasks = (await listGenerationTasks(params.chapter.id)).filter(
    (task) => task.status === "pending",
  );
  const panelById = new Map(params.panels.map((panel) => [panel.id, panel]));
  const ordered = tasks.sort(
    (a, b) => (panelById.get(a.panelId)?.order ?? 0) - (panelById.get(b.panelId)?.order ?? 0),
  );

  const total = ordered.length;
  let cursor = 0;
  let succeeded = 0;
  let failed = 0;
  let cancelled = false;

  const worker = async (): Promise<void> => {
    while (cursor < ordered.length) {
      if (params.signal?.aborted) {
        cancelled = true;
        return;
      }
      const task = ordered[cursor];
      cursor += 1;
      const panel = panelById.get(task.panelId);
      if (!panel) {
        failed += 1;
      } else {
        const outcome = await runSingleTask(params, task, panel);
        if (outcome === "success") succeeded += 1;
        else if (outcome === "failed") failed += 1;
        else cancelled = true;
      }
      params.onProgress?.({ done: succeeded + failed, total, succeeded, failed });
      if (cancelled) return;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(defaults.imageConcurrency, ordered.length) }, () => worker()),
  );

  // 表现层版本（presentation）只由形态/画风变更推进；图片产出不改版本，
  // 否则刚生成的画面会立刻被判定为「基于旧画风」。
  return { succeeded, failed, cancelled };
}

/** 单张生成/重绘入口：建 running 任务并执行（带自动重试），返回最新分镜 */
export async function regeneratePanelImage(params: {
  chapter: ComicChapter;
  panel: ComicPanel;
  project: ComicProject;
  characters: ComicCharacter[];
  scenes: ComicScene[];
  customFormula?: CustomPromptFormula | null;
  imageChoice: ComicImageModelChoice | null;
  mode: GenerationMode;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<ComicPanel> {
  const now = new Date().toISOString();
  const task: GenerationTask = {
    id: generateId("gtask"),
    projectId: params.chapter.projectId,
    chapterId: params.chapter.id,
    panelId: params.panel.id,
    mode: params.mode,
    status: "running",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  await saveGenerationTask(task);
  await runSingleTask(
    {
      chapter: params.chapter,
      project: params.project,
      characters: params.characters,
      scenes: params.scenes,
      customFormula: params.customFormula,
      imageChoice: params.imageChoice,
      signal: params.signal,
    },
    task,
    params.panel,
    params.onProgress,
  );
  const latest = await getPanel(params.panel.id);
  return latest ?? params.panel;
}

// ---------------------------------------------------------------------------
// 单任务执行（含重试）
// ---------------------------------------------------------------------------

type TaskOutcome = "success" | "failed" | "cancelled";

/** 单任务运行所需上下文（与批量队列/单镜重绘共用） */
interface TaskContext {
  chapter: ComicChapter;
  project: ComicProject;
  characters: ComicCharacter[];
  scenes: ComicScene[];
  customFormula?: CustomPromptFormula | null;
  imageChoice: ComicImageModelChoice | null;
  signal?: AbortSignal;
}

async function runSingleTask(
  params: TaskContext,
  task: GenerationTask,
  panel: ComicPanel,
  onProgressMessage?: (message: string) => void,
): Promise<TaskOutcome> {
  const defaults = getAiDefaults();
  const form = getFormById(params.project.formId);
  const pixel =
    task.mode === "draft" ? form?.draftPixel : (form?.referencePixel ?? form?.draftPixel);

  // 描述词兜底：缺失，或表现层版本过期（如切换台词绘制开关后画面尚未重组）时按公式重组；
  // 手动描述词不自动覆盖。重组后按当前上游版本盖章
  const promptBasis = panel.promptBasis;
  const presentationDrift =
    promptBasis != null &&
    promptBasis.presentation !== params.chapter.versions.presentation &&
    panel.prompt?.manualOverride !== true;
  if (!panel.prompt?.final || presentationDrift) {
    panel.prompt = buildPanelPrompt({
      chapter: params.chapter,
      panel,
      project: params.project,
      characters: params.characters,
      scenes: params.scenes,
      customFormula: params.customFormula,
      embedDialogue: params.chapter.letteringEmbed ?? true,
    });
    panel.promptBasis = stageBasisSnapshot(params.chapter);
    await savePanel(panel);
  }

  const markRunning = async (): Promise<void> => {
    const now = new Date().toISOString();
    task.status = "running";
    task.updatedAt = now;
    await saveGenerationTask(task);
    panel.generation = {
      status: "running",
      mode: task.mode,
      attempts: task.attempts,
      updatedAt: now,
    };
    await savePanel(panel);
  };
  await markRunning();

  while (true) {
    try {
      onProgressMessage?.("正在生成画面…");
      const image = await generateImage(params.imageChoice, {
        prompt: panel.prompt.final,
        negativePrompt: promptFormula.negativeWords,
        comicPanelId: panel.id,
        width: pixel?.width ?? 1024,
        height: pixel?.height ?? 1024,
        signal: params.signal,
      });
      const record = await saveImageBlob(
        {
          projectId: params.project.id,
          kind: "panel",
          mime: image.mime,
          byteSize: image.blob?.size ?? 0,
          remoteUrl: image.remoteUrl,
        },
        image.blob,
      );
      // 重绘/换档成功后清理旧图，避免孤儿 blob
      if (panel.generation.imageId && panel.generation.imageId !== record.id) {
        await deleteImageRecord(panel.generation.imageId, params.project.id);
      }
      const now = new Date().toISOString();
      // 盖章：记录成品图所基于的描述词/表现层版本，画风或描述词更新后据此提示重绘
      panel.imageBasis = {
        prompt: params.chapter.versions.prompt,
        presentation: params.chapter.versions.presentation,
      };
      panel.generation = {
        status: "success",
        mode: task.mode,
        imageId: record.id,
        attempts: task.attempts,
        updatedAt: now,
      };
      await savePanel(panel);
      task.status = "success";
      delete task.error;
      task.updatedAt = now;
      await saveGenerationTask(task);
      return "success";
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      task.attempts += 1;
      const now = new Date().toISOString();
      task.updatedAt = now;

      if (params.signal?.aborted) {
        // 用户取消：任务回 pending 保留断点
        task.status = "pending";
        await saveGenerationTask(task);
        panel.generation = {
          status: "pending",
          mode: task.mode,
          attempts: task.attempts,
          error: message,
          updatedAt: now,
        };
        await savePanel(panel);
        return "cancelled";
      }
      if (task.attempts >= defaults.maxRetries) {
        task.status = "failed";
        task.error = message;
        await saveGenerationTask(task);
        panel.generation = {
          status: "failed",
          mode: task.mode,
          attempts: task.attempts,
          error: message,
          updatedAt: now,
        };
        await savePanel(panel);
        return "failed";
      }
      // 指数退避后自动重试
      task.status = "pending";
      await saveGenerationTask(task);
      panel.generation = {
        status: "pending",
        mode: task.mode,
        attempts: task.attempts,
        error: `第 ${task.attempts} 次尝试失败：${message}`,
        updatedAt: now,
      };
      await savePanel(panel);
      const backoff = defaults.retryBaseDelayMs * 2 ** (task.attempts - 1);
      await new Promise<void>((resolve) => window.setTimeout(resolve, backoff));
      if (params.signal?.aborted) {
        return "cancelled";
      }
      await markRunning();
    }
  }
}
