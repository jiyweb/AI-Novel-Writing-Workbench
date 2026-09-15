/**
 * 台词服务：确定性提取（不走大模型）+ 气泡布局
 *
 * 提取规则（确定性算法，见计划 P5）：
 * - 在每个分镜的原文区间内扫描引号对（字符集来自 shotDensity.json splitRules）；
 * - 引号前的一段文字作为「提示语」，在其中匹配角色库姓名确定说话人；
 *   未匹配到的说话人留空，由用户手动补充；
 * - 台词文本取引号内原文（零修改：索引始终锚定 sourceContent）。
 *
 * 手动编辑（改字/拖拽位置/字号）是用户产物，重新提取会整体覆盖。
 */
import { generateId, saveChapter, savePanel } from "../db/comicDb";
import { listCharacters } from "../db/comicDb";
import { shotDensity } from "./configService";
import {
  stageBasisSnapshot,
  type ComicChapter,
  type ComicLetteringMode,
  type ComicPanel,
  type DialogueLayout,
  type PanelDialogue,
} from "../types";

// ---------------------------------------------------------------------------
// 确定性提取
// ---------------------------------------------------------------------------

export interface ExtractDialogueResult {
  panelsWithDialogue: number;
  totalDialogues: number;
}

/**
 * 对章节全部分镜执行确定性台词提取（覆盖 panel.dialogues）。
 * chapter.dialogueExtracted 置位，versions.dialogue 递增。
 */
export async function extractDialogues(
  chapter: ComicChapter,
  panels: ComicPanel[],
): Promise<ExtractDialogueResult> {
  const rules = shotDensity.splitRules;
  const characters = await listCharacters(chapter.projectId);
  let panelsWithDialogue = 0;
  let totalDialogues = 0;

  for (const panel of panels) {
    const slice = chapter.sourceContent.slice(panel.sourceStartIndex, panel.sourceEndIndex);
    const dialogues = scanDialogues(slice, panel.sourceStartIndex, rules, characters);
    panel.dialogues = dialogues;
    // 盖章：记录台词所基于的分镜/角色库版本，供待更新判定（规则第7条）
    panel.dialogueBasis = stageBasisSnapshot(chapter);
    panel.updatedAt = new Date().toISOString();
    await savePanel(panel);
    if (dialogues.length > 0) panelsWithDialogue += 1;
    totalDialogues += dialogues.length;
  }

  chapter.dialogueExtracted = true;
  chapter.versions.dialogue += 1;
  chapter.updatedAt = new Date().toISOString();
  await saveChapter(chapter);
  return { panelsWithDialogue, totalDialogues };
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

/** 保存单条台词的手动编辑（文本/说话人/布局）；文本改动只影响台词副本，不动原文 */
export async function updateDialogue(
  panel: ComicPanel,
  dialogueId: string,
  updates: Partial<Pick<PanelDialogue, "text" | "characterId" | "characterName" | "layout" | "fontStyle">>,
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

/** 新增一条手动台词（无原文锚点，用于补画外音/旁白） */
export async function addManualDialogue(
  panel: ComicPanel,
  mode: ComicLetteringMode,
): Promise<ComicPanel> {
  const dialogue: PanelDialogue = {
    id: generateId("dlg"),
    characterName: "",
    text: "",
    sourceStartIndex: panel.sourceStartIndex,
    sourceEndIndex: panel.sourceStartIndex,
    layout: defaultDialogueLayout(panel.dialogues.length, mode),
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
