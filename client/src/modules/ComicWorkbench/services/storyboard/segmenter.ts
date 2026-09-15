/**
 * 智能分镜 纯算法层：分句与密度分组
 *
 * 规则约束（comic-workbench-rule.md）：
 * - 原文零修改（第5条）：只计算字符索引区间，绝不返回改写后的文本
 * - 配置化（第6条）：所有阈值/字符集/词表来自 shotDensity.json，经参数注入，
 *   本文件禁止 import configService（保证 node --test 可直接运行）
 *
 * 本文件不依赖 db / React / JSON 配置，可独立单测。
 */
import type { ShotDensityLevelConfig, ShotDensityLevel, ShotSplitRulesConfig } from "../../types";

// ---------------------------------------------------------------------------
// 分句：把原文切成 叙述/对话 两类片段（含字符索引锚点）
// ---------------------------------------------------------------------------

export interface SourceSegment {
  /** 原文起始索引（含） */
  startIndex: number;
  /** 原文结束索引（不含） */
  endIndex: number;
  /** 原文切片（与 slice(startIndex, endIndex) 严格一致） */
  text: string;
  kind: "narration" | "dialogue";
}

interface RawSegment {
  start: number;
  end: number;
  kind: "narration" | "dialogue";
}

/** 消耗从 index 起连续的句子终止符（如「……」「！！」算一个终止） */
function consumeEndRun(text: string, index: number, endChars: string): number {
  let j = index;
  while (j < text.length && endChars.includes(text[j] ?? "")) j++;
  return j;
}

/** 判断 position 处是否以某个场景切换词开头 */
function matchSceneMarker(text: string, position: number, markers: string[]): string | null {
  for (const marker of markers) {
    if (marker.length > 0 && text.startsWith(marker, position)) return marker;
  }
  return null;
}

/**
 * 分句主入口。
 *
 * 单趟扫描：
 * 1. 叙述按 sentenceEndChars 断句（连续终止符合并为一处）；
 * 2. 引号内为对话段，dialogueSeparateFromNarration 时与叙述分镜；
 *    引号前的「引导语」若以从句符结尾（如「他说道：」）则并入对话段；
 * 3. sceneChangeForceSplit 时，句中出现场景切换词即强制断开。
 */
export function segmentSourceText(content: string, rules: ShotSplitRulesConfig): SourceSegment[] {
  const raw: RawSegment[] = [];
  const separateDialogue = rules.dialogueSeparateFromNarration;

  let segStart = 0;
  let kind: RawSegment["kind"] = "narration";
  let i = 0;

  const flush = (end: number) => {
    if (end > segStart) {
      raw.push({ start: segStart, end, kind });
    }
  };

  while (i < content.length) {
    const ch = content[i] ?? "";
    if (kind === "narration") {
      if (separateDialogue && rules.dialogueOpenChars.includes(ch)) {
        // 引导语以从句符结尾（「他说道：」）→ 并入对话段；否则作为独立叙述段冲刷
        const hasLeadIn = i > segStart && rules.clauseBreakChars.includes(content[i - 1] ?? "");
        if (hasLeadIn) {
          kind = "dialogue";
        } else {
          flush(i);
          segStart = i;
          kind = "dialogue";
        }
        continue;
      }
      if (rules.sentenceEndChars.includes(ch)) {
        const end = consumeEndRun(content, i, rules.sentenceEndChars);
        flush(end);
        segStart = end;
        i = end;
        continue;
      }
      if (
        rules.sceneChangeForceSplit &&
        i > segStart &&
        matchSceneMarker(content, i, rules.sceneChangeMarkers)
      ) {
        flush(i);
        segStart = i;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    // 对话段：找到第一个引号闭合符
    if (rules.dialogueCloseChars.includes(ch)) {
      const end = consumeEndRun(content, i + 1, rules.sentenceEndChars);
      flush(end);
      segStart = end;
      kind = "narration";
      i = end;
      continue;
    }
    i += 1;
  }
  flush(content.length);

  return finalizeSegments(content, raw, rules);
}

/**
 * 尺寸修正：
 * - 超过 maxPanelChars 的叙述段按 clauseBreakChars 均匀强拆（对话段保持原子性）；
 * - minPanelChars 不在分句层合并——短句合并由密度分组按句数完成，
 *   在此合并会吞掉场景切换边界并干扰密度粒度；
 * - 丢弃纯空白片段（无法承载画面，也不参与原文锚点统计）。
 */
function finalizeSegments(
  content: string,
  raw: RawSegment[],
  rules: ShotSplitRulesConfig,
): SourceSegment[] {
  const expanded: RawSegment[] = [];
  for (const seg of raw) {
    const length = seg.end - seg.start;
    if (seg.kind === "narration" && length > rules.maxPanelChars) {
      expanded.push(...splitOversize(content, seg, rules));
    } else {
      expanded.push(seg);
    }
  }

  return expanded
    .map((seg) => ({
      startIndex: seg.start,
      endIndex: seg.end,
      text: content.slice(seg.start, seg.end),
      kind: seg.kind,
    }))
    .filter((seg) => seg.text.trim().length > 0);
}

/** 超长叙述段：按从句符把长度切成尽量均匀的多段 */
function splitOversize(
  content: string,
  seg: RawSegment,
  rules: ShotSplitRulesConfig,
): RawSegment[] {
  const pieces: RawSegment[] = [];
  let start = seg.start;
  const total = seg.end - seg.start;
  const pieceCount = Math.ceil(total / rules.maxPanelChars);

  for (let piece = 1; piece < pieceCount; piece++) {
    const target = start + Math.ceil(total / pieceCount);
    const limit = Math.min(seg.end, start + rules.maxPanelChars);
    // 在 (start, limit] 内找离 target 最近的从句符作为断点
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let j = start + 1; j <= limit; j++) {
      if (rules.clauseBreakChars.includes(content[j - 1] ?? "")) {
        const distance = Math.abs(j - target);
        if (distance < bestDistance) {
          best = j;
          bestDistance = distance;
        }
      }
    }
    const cut = best > start ? best : limit;
    if (cut >= seg.end) break;
    pieces.push({ start, end: cut, kind: "narration" });
    start = cut;
  }
  pieces.push({ start, end: seg.end, kind: "narration" });
  return pieces;
}

// ---------------------------------------------------------------------------
// 分组：按密度档位把片段合并成「镜」
// ---------------------------------------------------------------------------

export interface DensityGroupingParams {
  levels: ShotDensityLevelConfig[];
  globalLevel: ShotDensityLevel;
  dynamic: { enabled: boolean; climaxKeywords: string[]; dialogueBoost: boolean };
  /** 场景切换词表：下一片段以场景词开头时为硬边界（无视最少句数收组） */
  sceneChangeMarkers: string[];
}

/** 动态密度下片段是否为「高强度」点（高潮词命中 / 对话段） */
function isHotSegment(
  segment: SourceSegment,
  dynamic: DensityGroupingParams["dynamic"],
): boolean {
  if (dynamic.enabled && dynamic.climaxKeywords.some((word) => segment.text.includes(word))) {
    return true;
  }
  return dynamic.dialogueBoost && segment.kind === "dialogue";
}

/** 片段是否以场景切换词开头 */
function startsWithSceneMarker(
  segment: SourceSegment,
  markers: string[],
): boolean {
  return markers.some((marker) => marker.length > 0 && segment.text.startsWith(marker));
}

/**
 * 把片段序列按密度分组，返回每组包含的片段下标与应用档位。
 *
 * 规则：
 * - 组内句数达到档位 maxSentences 即收组；
 * - 达到 minSentences 且下一片段是对话段/高潮段时提前收组（软边界）；
 * - 下一片段以场景切换词开头时立即收组（硬边界，无视最少句数）；
 * - 动态密度开启时，组内出现「高强度」片段 → 该组用更紧一档的上下限；
 * - 末尾余量仅并入仍是基础档位的最后一组（不并入已收紧的组）。
 */
export function groupSegmentsIntoPanels(
  segments: SourceSegment[],
  params: DensityGroupingParams,
): Array<{ segmentIndexes: number[]; levelApplied: ShotDensityLevel }> {
  const { levels, globalLevel, dynamic, sceneChangeMarkers } = params;
  const globalIndex = Math.max(
    0,
    levels.findIndex((level) => level.id === globalLevel),
  );
  const base = levels[globalIndex] ?? levels[0];
  const tighter = levels[Math.max(0, globalIndex - 1)] ?? base;

  const groups: Array<{ segmentIndexes: number[]; levelApplied: ShotDensityLevel }> = [];
  let current: number[] = [];
  let hot = false;

  const closeCurrent = () => {
    if (current.length === 0) return;
    groups.push({ segmentIndexes: current, levelApplied: hot ? tighter.id : base.id });
    current = [];
    hot = false;
  };

  for (let k = 0; k < segments.length; k++) {
    const segment = segments[k];
    if (!segment) continue;
    current.push(k);
    if (!hot && isHotSegment(segment, dynamic)) hot = true;

    const next = segments[k + 1];
    if (!next) break;

    // 硬边界：场景切换词开头的片段必然开新镜
    if (startsWithSceneMarker(next, sceneChangeMarkers)) {
      closeCurrent();
      continue;
    }

    const effective = hot && dynamic.enabled ? tighter : base;
    const nextIsSoftBoundary =
      next.kind === "dialogue" ||
      (dynamic.enabled && dynamic.climaxKeywords.some((word) => next.text.includes(word)));

    if (current.length >= effective.maxSentences) {
      closeCurrent();
      continue;
    }
    if (current.length >= effective.minSentences && nextIsSoftBoundary) {
      closeCurrent();
    }
  }
  if (current.length > 0) {
    closeCurrent();
  }
  return groups;
}

// ---------------------------------------------------------------------------
// 手动拆分：在指定文本内寻找拆分点
// ---------------------------------------------------------------------------

/**
 * 在面板文本中寻找拆分偏移（相对面板文本起点）：
 * 优先句末符离中点最近处，其次从句符，最后取中点。
 * 拆分后两半都不得低于 minPanelChars；文本过短返回 null。
 */
export function findSplitOffset(text: string, rules: ShotSplitRulesConfig): number | null {
  const min = rules.minPanelChars;
  const valid = (offset: number) => offset >= min && text.length - offset >= min;
  if (text.length < min * 2) return null;
  const middle = Math.floor(text.length / 2);

  // 句末候选：位置 j 满足 text[j-1] 是终止符且 text[j] 不是（即终止串刚结束）
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let j = min; j < text.length; j++) {
    if (!rules.sentenceEndChars.includes(text[j - 1] ?? "")) continue;
    if (rules.sentenceEndChars.includes(text[j] ?? "")) continue;
    if (!valid(j)) continue;
    const distance = Math.abs(j - middle);
    if (distance < bestDistance) {
      best = j;
      bestDistance = distance;
    }
  }
  if (best > 0) return best;

  // 从句候选
  best = -1;
  bestDistance = Number.POSITIVE_INFINITY;
  for (let j = min; j < text.length; j++) {
    if (!rules.clauseBreakChars.includes(text[j - 1] ?? "")) continue;
    if (!valid(j)) continue;
    const distance = Math.abs(j - middle);
    if (distance < bestDistance) {
      best = j;
      bestDistance = distance;
    }
  }
  if (best > 0) return best;

  return valid(middle) ? middle : null;
}
