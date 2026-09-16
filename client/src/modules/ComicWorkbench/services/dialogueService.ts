/**
 * 台词服务：LLM 提取（对白/旁白/内心独白，每镜必有文字）+ 引号扫描兜底 + 气泡布局
 *
 * 提取策略（AI 优先，用户确认方案）：
 * 1. LLM 提取：走主程序 /api/llm/invoke（AI 实况可见），逐镜产出
 *    dialogue（逐字摘录的对白）/ narration（旁白）/ inner（内心独白），
 *    每镜（含空镜）至少 1 条，保证传统漫画每格都有文字；
 * 2. 确定性兜底：AI 未配置或调用失败时回落到引号扫描（scanDialogues）；
 * 3. 缺口补写：LLM 结果仍有空镜时，用确定性旁白兜底补写。
 *
 * 台词文本取自原文或 AI 改写副本（零修改：索引始终锚定 sourceContent，原文不动）。
 * 手动编辑（改字/拖拽位置/字号）是用户产物，重新提取会整体覆盖。
 */
import { z } from "zod";
import { generateId, saveChapter, savePanel } from "../db/comicDb";
import { listCharacters } from "../db/comicDb";
import { shotDensity } from "./configService";
import { chatJson, describeAiError } from "./ai/llmClient";
import {
  stageBasisSnapshot,
  type ComicChapter,
  type ComicCharacter,
  type ComicLetteringMode,
  type ComicPanel,
  type DialogueKind,
  type DialogueLayout,
  type PanelDialogue,
} from "../types";

// ---------------------------------------------------------------------------
// LLM 提取
// ---------------------------------------------------------------------------

/** 每次调用送入的分镜数量（控制上下文长度与失败重试粒度） */
const LLM_CHUNK_SIZE = 25;

const llmLineSchema = z.object({
  kind: z.enum(["dialogue", "narration", "inner"]).catch("narration"),
  speakerName: z.string().catch(""),
  text: z.string().catch(""),
});
const llmPanelSchema = z.object({
  index: z.number().catch(0),
  lines: z.array(llmLineSchema).catch([]),
});
const llmResultSchema = z.object({
  panels: z.array(llmPanelSchema).catch([]),
});

interface LlmLine {
  kind: DialogueKind;
  speakerName: string;
  text: string;
}

function buildDialoguePrompt(panels: ComicPanel[], chapter: ComicChapter, characterNames: string[]): string {
  const panelList = panels
    .map((panel, i) => {
      const slice = chapter.sourceContent.slice(panel.sourceStartIndex, panel.sourceEndIndex).trim();
      const isEmpty = panel.sourceEndIndex <= panel.sourceStartIndex;
      const label = isEmpty ? "【空镜/过场】" : `原文：${slice}`;
      return `【${i + 1}】${label}`;
    })
    .join("\n");
  const characterText = characterNames.length > 0 ? characterNames.join("、") : "（无角色库）";
  return `角色库：${characterText}\n分镜原文（共 ${panels.length} 镜）：\n${panelList}`;
}

const DIALOGUE_SYSTEM_PROMPT = `你是漫画分镜台词师。根据每个分镜引用的原文，为每个分镜输出要绘制在画面上的文字清单（台词/旁白/内心独白）。
硬性要求：
1. 每个分镜至少输出 1 条文字，包括标注为「空镜/过场」的分镜（为其写场景过渡旁白），保证每一格画面都有文字。
2. kind 只能是 dialogue、narration、inner 三者之一。
3. dialogue：角色说出的对白，必须逐字摘录原文引号内的话；speakerName 填说话的角色名，无法确定则留空字符串。
4. narration：旁白/画外音，用于交代场景、时间、动作或衔接剧情，可基于原文改写，不超过 40 字，speakerName 留空。
5. inner：角色内心独白，可基于原文改写，不超过 30 字，speakerName 填该角色名。
6. 每镜最多 6 条，按剧情顺序排列。
只输出 JSON：{"panels":[{"index":分镜序号,"lines":[{"kind":"dialogue|narration|inner","speakerName":"角色名","text":"文字"}]}]}`;

/** 调一次 LLM 提取一个分镜块的台词清单；失败抛错由调用方统一兜底 */
async function extractChunkWithLlm(
  panels: ComicPanel[],
  chapter: ComicChapter,
  characterNames: string[],
  globalOffset: number,
): Promise<Map<number, LlmLine[]>> {
  const result = await chatJson({
    system: DIALOGUE_SYSTEM_PROMPT,
    user: buildDialoguePrompt(panels, chapter, characterNames),
    schema: llmResultSchema,
    label: "漫画台词提取",
  });
  const byPanel = new Map<number, LlmLine[]>();
  for (const item of result.panels) {
    const localIndex = Math.round(item.index) - 1;
    if (!Number.isInteger(localIndex) || localIndex < 0 || localIndex >= panels.length) continue;
    const lines = item.lines
      .map((line) => ({ kind: line.kind, speakerName: line.speakerName.trim(), text: line.text.trim() }))
      .filter((line) => line.text.length > 0)
      .slice(0, 6);
    if (lines.length === 0) continue;
    byPanel.set(globalOffset + localIndex, lines);
  }
  return byPanel;
}

// ---------------------------------------------------------------------------
// 布局
// ---------------------------------------------------------------------------

/** 旁白用字幕式布局，内心独白用右侧气泡，对白按形态默认布局 */
function layoutForKind(kind: DialogueKind, index: number, mode: ComicLetteringMode): DialogueLayout {
  if (kind === "narration") {
    return { x: 8, y: 82, width: 84, fontScale: 1 };
  }
  if (kind === "inner") {
    return { x: 54, y: Math.min(10 + index * 20, 66), width: 40, fontScale: 1 };
  }
  return defaultDialogueLayout(index, mode);
}

/** UI 侧类型切换/手动添加时的默认布局（导出别名） */
export function kindAwareLayout(
  kind: DialogueKind,
  index: number,
  mode: ComicLetteringMode,
): DialogueLayout {
  return layoutForKind(kind, index, mode);
}

/** 在提示语里匹配角色库名字（名字越长越优先，避免「小明/小」误配） */
function matchSpeaker(
  lead: string,
  characters: Array<{ id: string; name: string }>,
): { characterId: string; characterName: string } | null {
  const sorted = [...characters].sort((a, b) => b.name.length - a.name.length);
  for (const character of sorted) {
    if (character.name.length > 0 && lead.includes(character.name)) {
      return { characterId: character.id, characterName: character.name };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 确定性提取
// ---------------------------------------------------------------------------

export interface ExtractDialogueResult {
  panelsWithDialogue: number;
  totalDialogues: number;
  /** 旁白条数 */
  narrationCount: number;
  /** 内心独白条数 */
  innerCount: number;
  /** 是否走了 LLM 提取（false = AI 未配置/失败，引号扫描兜底） */
  aiUsed: boolean;
  /** LLM 之后仍为空、由确定性旁白兜底补写的分镜数 */
  fallbackFilled: number;
}

/** 截取一句用于兜底旁白（首句，≤40 字） */
function firstSentenceNarration(text: string): string {
  const match = /^[^。！？…!?]*[。！？…!?]?/.exec(text.trim());
  const sentence = (match?.[0] ?? text).trim();
  return sentence.length > 40 ? `${sentence.slice(0, 39)}…` : sentence;
}

/** 确定性兜底旁白（LLM 缺口时使用，保证每镜有文字） */
function fallbackNarration(panel: ComicPanel, chapter: ComicChapter): PanelDialogue {
  const slice = chapter.sourceContent
    .slice(panel.sourceStartIndex, panel.sourceEndIndex)
    .trim();
  const text =
    slice.length > 0 && panel.sourceEndIndex > panel.sourceStartIndex
      ? firstSentenceNarration(slice)
      : "（场景过渡）";
  return {
    id: generateId("dlg"),
    kind: "narration",
    characterName: "",
    text,
    sourceStartIndex: panel.sourceStartIndex,
    sourceEndIndex: panel.sourceStartIndex,
    layout: layoutForKind("narration", 0, "bubble"),
  };
}

/** 由 LLM 行构建台词记录；对白尽量回锚原文索引 */
function buildDialogueFromLine(
  panel: ComicPanel,
  chapter: ComicChapter,
  line: LlmLine,
  index: number,
  characters: ComicCharacter[],
): PanelDialogue {
  let start = panel.sourceStartIndex;
  let end = panel.sourceStartIndex;
  if (line.kind === "dialogue") {
    const slice = chapter.sourceContent.slice(panel.sourceStartIndex, panel.sourceEndIndex);
    const pos = slice.indexOf(line.text);
    if (pos >= 0) {
      start = panel.sourceStartIndex + pos;
      end = start + line.text.length;
    }
  }
  const matched = characters.find((character) => character.name === line.speakerName);
  return {
    id: generateId("dlg"),
    kind: line.kind,
    characterId: matched?.id,
    characterName: line.speakerName,
    text: line.text,
    sourceStartIndex: start,
    sourceEndIndex: end,
    layout: layoutForKind(line.kind, index, "bubble"),
  };
}

/**
 * 对章节全部分镜执行台词提取（覆盖 panel.dialogues）：
 * LLM 逐镜产出对白/旁白/内心独白（每镜含空镜至少 1 条）；
 * AI 未配置或失败时回落引号扫描；缺口由确定性旁白补写。
 * chapter.dialogueExtracted 置位，versions.dialogue 递增。
 */
export async function extractDialogues(
  chapter: ComicChapter,
  panels: ComicPanel[],
  options?: { letteringMode?: ComicLetteringMode },
): Promise<ExtractDialogueResult> {
  const rules = shotDensity.splitRules;
  const letteringMode = options?.letteringMode ?? "bubble";
  const characters = await listCharacters(chapter.projectId);
  let aiUsed = false;
  let fallbackFilled = 0;

  // 1) LLM 提取（分块；任一块失败则整体回落引号扫描）
  const llmLines = new Map<number, LlmLine[]>();
  try {
    for (let offset = 0; offset < panels.length; offset += LLM_CHUNK_SIZE) {
      const chunk = panels.slice(offset, offset + LLM_CHUNK_SIZE);
      const part = await extractChunkWithLlm(
        chunk,
        chapter,
        characters.map((character) => character.name),
        offset,
      );
      for (const [key, value] of part) llmLines.set(key, value);
    }
    aiUsed = panels.length > 0;
  } catch (error) {
    console.warn("[dialogue] LLM 提取失败，回落引号扫描：", describeAiError(error));
    llmLines.clear();
  }

  // 2) 落库
  let panelsWithDialogue = 0;
  let totalDialogues = 0;
  let narrationCount = 0;
  let innerCount = 0;

  for (const [panelIndex, panel] of panels.entries()) {
    const lines = llmLines.get(panelIndex);
    if (lines && lines.length > 0) {
      panel.dialogues = lines.map((line, i) =>
        buildDialogueFromLine(panel, chapter, line, i, characters),
      );
    } else if (aiUsed) {
      // LLM 覆盖了本章但漏了此镜：确定性旁白兜底
      panel.dialogues = [fallbackNarration(panel, chapter)];
      fallbackFilled += 1;
    } else {
      // AI 未配置/失败：引号扫描兜底（旧行为）
      const slice = chapter.sourceContent.slice(panel.sourceStartIndex, panel.sourceEndIndex);
      panel.dialogues = scanDialogues(slice, panel.sourceStartIndex, rules, characters).map(
        (dialogue) => ({ ...dialogue, kind: "dialogue" as const }),
      );
    }

    // 每镜必有文字：引号扫描兜底后仍为空的镜补旁白
    if (panel.dialogues.length === 0) {
      panel.dialogues = [fallbackNarration(panel, chapter)];
      fallbackFilled += 1;
    }

    // 按形态重排布局（对白走形态默认布局）
    panel.dialogues = panel.dialogues.map((dialogue, i) => ({
      ...dialogue,
      layout:
        dialogue.kind === "narration" || dialogue.kind === "inner"
          ? dialogue.layout ?? layoutForKind(dialogue.kind, i, letteringMode)
          : layoutForKind("dialogue", i, letteringMode),
    }));

    // 盖章：记录台词所基于的分镜/角色库版本，供待更新判定（规则第7条）
    panel.dialogueBasis = stageBasisSnapshot(chapter);
    panel.updatedAt = new Date().toISOString();
    await savePanel(panel);
    if (panel.dialogues.length > 0) panelsWithDialogue += 1;
    totalDialogues += panel.dialogues.length;
    narrationCount += panel.dialogues.filter((d) => d.kind === "narration").length;
    innerCount += panel.dialogues.filter((d) => d.kind === "inner").length;
  }

  chapter.dialogueExtracted = true;
  chapter.versions.dialogue += 1;
  chapter.updatedAt = new Date().toISOString();
  await saveChapter(chapter);
  return { panelsWithDialogue, totalDialogues, narrationCount, innerCount, aiUsed, fallbackFilled };
}

interface SplitRulesLike {
  dialogueOpenChars: string;
  dialogueCloseChars: string;
}

/** 扫描一段原文中的引号对并生成台词记录 */
export function scanDialogues(
  text: string,
  offsetBase: number,
  rules: SplitRulesLike,
  characters: Array<{ id: string; name: string }>,
): PanelDialogue[] {
  const dialogues: PanelDialogue[] = [];
  let hintStart = 0;
  let i = 0;

  while (i < text.length) {
    if (rules.dialogueOpenChars.includes(text[i] ?? "")) {
      let close = -1;
      for (let j = i + 1; j < text.length; j++) {
        if (rules.dialogueCloseChars.includes(text[j] ?? "")) {
          close = j;
          break;
        }
      }
      if (close < 0) break; // 引号未闭合：剩余文本不产出台词
      const inner = text.slice(i + 1, close).trim();
      if (inner.length > 0) {
        const lead = text.slice(hintStart, i);
        const speaker = matchSpeaker(lead, characters);
        dialogues.push({
          id: generateId("dlg"),
          characterId: speaker?.characterId,
          characterName: speaker?.characterName ?? "",
          text: inner,
          sourceStartIndex: offsetBase + i + 1,
          sourceEndIndex: offsetBase + close,
          layout: defaultDialogueLayout(dialogues.length, "bubble"),
        });
      }
      hintStart = close + 1;
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return dialogues;
}

// ---------------------------------------------------------------------------
// 台词呈现布局
// ---------------------------------------------------------------------------

/** 按台词呈现样式给出初始百分比布局（用户可拖拽覆盖） */
export function defaultDialogueLayout(index: number, mode: ComicLetteringMode): DialogueLayout {
  switch (mode) {
    case "caption":
      return { x: 8, y: 80, width: 84, fontScale: 1 };
    case "chat":
      return {
        x: index % 2 === 0 ? 8 : 54,
        y: Math.min(8 + index * 16, 68),
        width: 38,
        fontScale: 1,
      };
    case "none":
      return { x: 0, y: 0, width: 0, fontScale: 1 };
    case "bubble":
    default:
      return {
        x: 8 + (index % 2) * 34,
        y: Math.min(10 + index * 22, 68),
        width: 52,
        fontScale: 1,
      };
  }
}

// ---------------------------------------------------------------------------
// 手动编辑
// ---------------------------------------------------------------------------

/** 保存单条台词的手动编辑（文本/说话人/类型/布局）；文本改动只影响台词副本，不动原文 */
export async function updateDialogue(
  panel: ComicPanel,
  dialogueId: string,
  updates: Partial<Pick<PanelDialogue, "text" | "kind" | "characterId" | "characterName" | "layout" | "fontStyle">>,
): Promise<ComicPanel> {
  const next: ComicPanel = {
    ...panel,
    dialogues: panel.dialogues.map((dialogue) =>
      dialogue.id === dialogueId
        ? { ...dialogue, ...updates, id: dialogue.id }
        : dialogue,
    ),
    updatedAt: new Date().toISOString(),
  };
  await savePanel(next);
  return next;
}

/** 新增一条手动台词（无原文锚点；kind 决定默认布局） */
export async function addManualDialogue(
  panel: ComicPanel,
  mode: ComicLetteringMode,
  kind: DialogueKind = "dialogue",
): Promise<ComicPanel> {
  const dialogue: PanelDialogue = {
    id: generateId("dlg"),
    kind,
    characterName: "",
    text: "",
    sourceStartIndex: panel.sourceStartIndex,
    sourceEndIndex: panel.sourceStartIndex,
    layout: layoutForKind(kind, panel.dialogues.length, mode),
  };
  const next: ComicPanel = {
    ...panel,
    dialogues: [...panel.dialogues, dialogue],
    updatedAt: new Date().toISOString(),
  };
  await savePanel(next);
  return next;
}

/** 删除单条台词（含手动添加的） */
export async function deleteDialogue(panel: ComicPanel, dialogueId: string): Promise<ComicPanel> {
  const next: ComicPanel = {
    ...panel,
    dialogues: panel.dialogues.filter((dialogue) => dialogue.id !== dialogueId),
    updatedAt: new Date().toISOString(),
  };
  await savePanel(next);
  return next;
}
