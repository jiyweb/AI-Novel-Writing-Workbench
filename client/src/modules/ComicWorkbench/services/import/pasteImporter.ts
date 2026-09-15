/**
 * 粘贴导入：格式清洗、字数校验（500-50000）、敏感词前置检测
 */
import { sensitiveWords } from "../configService";

export const PASTE_MIN_CHARS = 500;
export const PASTE_MAX_CHARS = 50000;

export class PasteImportError extends Error {
  code: "tooShort" | "tooLong" | "empty";
  constructor(code: PasteImportError["code"], message: string) {
    super(message);
    this.name = "PasteImportError";
    this.code = code;
  }
}

/** 清除粘贴携带的格式噪音：零宽字符、控制字符、行首缩进、连续空行 */
export function cleanPastedText(raw: string): string {
  return raw
    .replace(/\u200b-\u200f\u2028\u2029\ufeff/g, "")
    // eslint 禁用不了正则里的控制字符写法，改用显式范围
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^[\u3000 ]+/, "").replace(/[ \t\u3000]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function validatePastedText(text: string): void {
  const length = text.length;
  if (length === 0) {
    throw new PasteImportError("empty", "内容为空，请先粘贴小说原文。");
  }
  if (length < PASTE_MIN_CHARS) {
    throw new PasteImportError("tooShort", `当前 ${length} 字，至少需要 ${PASTE_MIN_CHARS} 字才能有效分镜。`);
  }
  if (length > PASTE_MAX_CHARS) {
    throw new PasteImportError("tooLong", `当前 ${length} 字，超出 ${PASTE_MAX_CHARS} 字上限，请分章节粘贴。`);
  }
}

/** 敏感词前置检测：返回命中的词（去重） */
export function detectSensitiveWords(text: string): string[] {
  const hits: string[] = [];
  for (const word of sensitiveWords.words) {
    if (word && text.includes(word) && !hits.includes(word)) {
      hits.push(word);
    }
  }
  return hits;
}
