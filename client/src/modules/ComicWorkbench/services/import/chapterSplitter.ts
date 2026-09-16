/**
 * 导入预处理：章节切分 + 非正文块识别 + 噪音清理（纯算法层）
 *
 * 规则约束：
 * - 原文零修改（第5条）：本服务在「导入落库前」运行，产出的章节正文即为
 *   此后只读的原文；前言/作者话等非正文块不删除、不丢字，单独存入
 *   chapter.annotations 并默认跳过分镜，避免生成大量空白分镜。
 * - 配置化（第6条）：全部规则来自 config/chapterPatterns.json，经参数注入，
 *   本文件禁止 import configService（保证 node --test 可直接运行）。
 */
import type { ChapterAnnotation, ChapterPatternsConfig } from "../../types";

// ---------------------------------------------------------------------------
// 产物类型
// ---------------------------------------------------------------------------

export interface SplitChapter {
  /** 章节标题：优先用识别到的标题行，其次回落到文件名 */
  title: string;
  /** 章节正文（清洗后，不含非正文块） */
  content: string;
  /** 识别出的非正文块（前言/作者的话等），已从正文移出 */
  annotations: ChapterAnnotation[];
}

export interface ImportCleanReport {
  /** 切分出的章节数 */
  chapterCount: number;
  /** 非正文块数量（前言/导语/作者的话等） */
  annotationCount: number;
  /** 删除的广告/推广行数 */
  junkLineCount: number;
  /** 删除的纯装饰分隔线行数 */
  separatorLineCount: number;
  /** 清除的不可见字符个数 */
  invisibleCharCount: number;
  /** 识别到的章节号行数 */
  headingLineCount: number;
}

export interface SplitResult {
  chapters: SplitChapter[];
  report: ImportCleanReport;
}

// ---------------------------------------------------------------------------
// 预编译规则集
// ---------------------------------------------------------------------------

interface CompiledRules {
  chapterHeadings: RegExp[];
  storyHeadings: RegExp[];
  frontMatterHeadings: RegExp[];
  authorNoteHeadings: RegExp[];
  pureNumber: RegExp;
  junkLines: RegExp[];
  separatorLine: RegExp;
  invisibleChars: RegExp;
  patterns: ChapterPatternsConfig;
}

export function compileChapterRules(patterns: ChapterPatternsConfig): CompiledRules {
  const build = (list: string[]) =>
    list.map((source) => new RegExp(source, "i"));
  return {
    chapterHeadings: build(patterns.chapterHeadingPatterns),
    storyHeadings: build(patterns.storyHeadingPatterns),
    frontMatterHeadings: build(patterns.frontMatterHeadingPatterns),
    authorNoteHeadings: build(patterns.authorNoteHeadingPatterns),
    pureNumber: new RegExp(patterns.pureNumberHeadingPattern),
    junkLines: build(patterns.junkLinePatterns),
    separatorLine: new RegExp(patterns.separatorLinePattern),
    invisibleChars: new RegExp(patterns.invisibleCharPattern, "g"),
    patterns,
  };
}

// ---------------------------------------------------------------------------
// 行分类
// ---------------------------------------------------------------------------

type LineKind =
  | { type: "chapter"; title: string }
  | { type: "frontMatter"; title: string }
  | { type: "authorNote"; title: string }
  | { type: "normal" };

/** 标题行是否允许出现：无句读、长度受限、上文收束（非行中断句中） */
function isTitleShaped(line: string, rules: CompiledRules): boolean {
  const { patterns } = rules;
  if (line.length === 0 || line.length > patterns.headingMaxChars) return false;
  for (const ch of patterns.headingPunctuationForbidden) {
    if (line.includes(ch)) return false;
  }
  return true;
}

/**
 * 判断标题行后缀（章号关键词之后的部分）是否成立：
 * - 章号关键词后有分隔符（空格/：/·/—/、等）→ 后缀 ≤ headingTitleMaxChars；
 * - 无分隔符直接接文字（如「第十二章的内容让我震惊」）→ 后缀 ≤
 *   headingTightTitleMaxChars，且不得以虚词开头（正文续写的典型特征）。
 */
function isChapterKeywordSuffixValid(
  matched: string,
  rest: string,
  rules: CompiledRules,
): boolean {
  const restTrimmed = rest.replace(/^[\s\u3000]+/, "");
  if (restTrimmed.length === 0) return true;
  // 章号关键词本身以分隔符结尾（如「12、」「第一章 」）视为已分隔
  const separatorAtEndOfMatch = /[、．.：:－—–\-\s\u3000·・]$/.test(matched);
  const separated =
    separatorAtEndOfMatch || /^[\s\u3000：:·・—－\-–(（\[【「『、．]/.test(rest);
  if (!separated) {
    const tight = rules.patterns.headingTightTitleMaxChars;
    const forbiddenStarts = rules.patterns.headingTightTitleForbiddenStarts;
    if (restTrimmed.length > tight) return false;
    if (forbiddenStarts.includes(restTrimmed[0] ?? "")) return false;
  } else if (restTrimmed.length > rules.patterns.headingTitleMaxChars) {
    return false;
  }
  return isTitleShaped(restTrimmed, rules);
}

/** 单行分类（正文行返回 normal） */
export function classifyLine(
  line: string,
  context: { prevLine: string; atFileStart: boolean },
  rules: CompiledRules,
): LineKind {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { type: "normal" };
  const { patterns } = rules;

  // 前言/导语/作者的话等块标题（短行限定）
  if (trimmed.length <= patterns.frontMatterHeadingMaxChars) {
    const titleShaped = isTitleShaped(trimmed, rules);
    if (titleShaped) {
      for (const re of rules.frontMatterHeadings) {
        if (re.test(trimmed)) return { type: "frontMatter", title: trimmed };
      }
      for (const re of rules.authorNoteHeadings) {
        if (re.test(trimmed)) return { type: "authorNote", title: trimmed };
      }
    }
  }

  // 剧情性特殊章名（序章/楔子/番外等）：整行短且无句读
  if (isTitleShaped(trimmed, rules)) {
    for (const re of rules.storyHeadings) {
      if (re.test(trimmed) && trimmed.length <= patterns.headingTightTitleMaxChars) {
        return { type: "chapter", title: trimmed };
      }
    }
  }

  // 章节号标题：第X章 / 第十二回 / Chapter 1 / 12、标题。
  // 前缀（第X章/12、）本身可能含「、」等合法分隔符，因此只校验标题后缀的句读。
  if (trimmed.length <= patterns.headingMaxChars) {
    for (const re of rules.chapterHeadings) {
      const match = re.exec(trimmed);
      if (!match) continue;
      const rest = trimmed.slice(match[0].length);
      if (!isChapterKeywordSuffixValid(match[0], rest, rules)) continue;
      return { type: "chapter", title: trimmed };
    }
  }

  // 纯数字章节号（如单独一行「12」）：行必须足够短，且前后文收束
  if (
    trimmed.length <= patterns.pureNumberMaxChars &&
    rules.pureNumber.test(trimmed) &&
    (context.atFileStart || context.prevLine.trim().length === 0)
  ) {
    return { type: "chapter", title: trimmed };
  }

  return { type: "normal" };
}

// ---------------------------------------------------------------------------
// 主入口：切分
// ---------------------------------------------------------------------------

/** 全量空行折叠为单个空行 */
function collapseBlankLines(lines: string[]): string[] {
  const result: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.length === 0) {
      blankRun++;
      if (blankRun > 1) continue;
    } else {
      blankRun = 0;
    }
    result.push(line);
  }
  return result;
}

function joinLines(lines: string[]): string {
  return collapseBlankLines(lines).join("\n").replace(/^\n+/, "").replace(/\n+$/, "").trim();
}

/**
 * 把整本/整段原文切分为章节列表：
 * 1. 清除不可见字符 → 删除广告推广行与纯装饰分隔线；
 * 2. 逐行识别章节号/非正文块标题；
 * 3. 非正文块整体移入 annotations（超长防误判：超过 frontMatterMaxChars 视为正文）；
 * 4. 无任何章节号时整体作为单章返回（行为与旧版一致）。
 */
export function splitIntoChapters(
  raw: string,
  patterns: ChapterPatternsConfig,
  fallbackTitle: string,
): SplitResult {
  const rules = compileChapterRules(patterns);
  const report: ImportCleanReport = {
    chapterCount: 0,
    annotationCount: 0,
    junkLineCount: 0,
    separatorLineCount: 0,
    invisibleCharCount: 0,
    headingLineCount: 0,
  };

  // 1) 不可见字符清理（正文中的零宽字符会干扰引号/句读判断）
  const cleanedWhole = raw.replace(rules.invisibleChars, (match) => {
    report.invisibleCharCount += match.length;
    return "";
  });

  const lines = cleanedWhole.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim());

  // 2) 行级噪音：广告推广行 / 纯装饰分隔线
  const contentLines: string[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      contentLines.push(line);
      continue;
    }
    if (rules.separatorLine.test(line)) {
      report.separatorLineCount++;
      continue;
    }
    if (
      line.length <= rules.patterns.junkLineMaxChars &&
      rules.junkLines.some((re) => re.test(line))
    ) {
      report.junkLineCount++;
      continue;
    }
    contentLines.push(line);
  }

  // 3) 逐行分类
  interface Classified {
    line: string;
    kind: LineKind;
    isBlank: boolean;
  }
  let nonBlankSeen = 0;
  const classified: Classified[] = contentLines.map((line, i) => {
    const prevLine = i > 0 ? contentLines[i - 1] ?? "" : "";
    const kind =
      line.length === 0
        ? ({ type: "normal" } as LineKind)
        : classifyLine(
            line,
            { prevLine, atFileStart: nonBlankSeen === 0 },
            rules,
          );
    if (line.trim().length > 0) nonBlankSeen++;
    return { line, kind, isBlank: line.length === 0 };
  });

  // 4) 组块：按标题行切块；非正文块持续到下一个任意标题
  interface Block {
    kind: "chapter" | "frontMatter" | "authorNote" | "lead";
    title: string;
    lines: string[];
  }
  const blocks: Block[] = [];
  let current: Block = { kind: "lead", title: fallbackTitle, lines: [] };

  const pushCurrent = () => {
    if (current.lines.some((line) => line.trim().length > 0) || current.kind !== "lead") {
      blocks.push(current);
    }
  };

  for (const item of classified) {
    const kind = item.kind;
    if (kind.type === "chapter") {
      pushCurrent();
      report.headingLineCount++;
      current = { kind: "chapter", title: kind.title, lines: [] };
      continue;
    }
    if (kind.type === "frontMatter" || kind.type === "authorNote") {
      pushCurrent();
      current = { kind: kind.type, title: kind.title, lines: [] };
      continue;
    }
    current.lines.push(item.line);
  }
  pushCurrent();

  // 5) lead 块（第一个章节号之前的内容）：
  //    - 短内容（书名/站点名等）视为 frontMatter 注记；
  //    - 长内容视为正文第一章（无章节号的整本书就是这一条路径）。
  const chapters: SplitChapter[] = [];
  let annotationSeq = 0;
  const makeAnnotation = (
    kind: ChapterAnnotation["kind"],
    title: string,
    content: string,
  ): ChapterAnnotation => {
    annotationSeq++;
    report.annotationCount++;
    return { id: `ann_${annotationSeq}`, kind, title, content };
  };

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    if (!block) continue;
    const content = joinLines(block.lines);

    if (block.kind === "lead") {
      if (content.length === 0) continue;
      if (content.length <= rules.patterns.frontMatterMaxChars) {
        // 书首杂项（书名/站点信息/未标注的前言），跳过分镜但保留原文
        const annotation = makeAnnotation("frontMatter", "书首信息", content);
        const last = chapters[chapters.length - 1];
        if (last) {
          last.annotations.push(annotation);
        } else {
          chapters.push({ title: fallbackTitle, content: "", annotations: [annotation] });
        }
        continue;
      }
      chapters.push({ title: fallbackTitle, content, annotations: [] });
      continue;
    }

    if (block.kind === "frontMatter" || block.kind === "authorNote") {
      // 防误判：块超长视为正文章节（标题仍是识别到的标题行）
      if (content.length > rules.patterns.frontMatterMaxChars) {
        chapters.push({ title: block.title, content, annotations: [] });
        continue;
      }
      if (content.length === 0) continue;
      const annotation = makeAnnotation(block.kind, block.title, content);
      const last = chapters[chapters.length - 1];
      if (last) {
        last.annotations.push(annotation);
      } else {
        chapters.push({ title: fallbackTitle, content: "", annotations: [annotation] });
      }
      continue;
    }

    // 正文章节：跳过空章节（连续标题行）
    if (content.length === 0) continue;
    chapters.push({ title: block.title, content, annotations: [] });
  }

  // 6) 收束：
  //    - 有正文章节 → 占位空章的注记并入第一章；
  //    - 全部被识别为非正文/无内容 → 整体回落为单章（绝不丢内容）。
  const withContent = chapters.filter((chapter) => chapter.content.length > 0);
  let result: SplitChapter[];
  if (withContent.length > 0) {
    for (const chapter of chapters) {
      if (chapter.content.length > 0 || chapter.annotations.length === 0) continue;
      // 占位章的注记（书首信息/前言）按时间顺序插到最前
      const target = withContent[0];
      if (target) target.annotations = [...chapter.annotations, ...target.annotations];
    }
    result = withContent;
  } else {
    result = [{ title: fallbackTitle, content: joinLines(contentLines), annotations: [] }];
  }

  report.chapterCount = result.length;
  return { chapters: result, report };
}
