/**
 * TXT 文件导入：编码自动识别（UTF-8/GBK）、分片读取、轻量清洗
 * 原则：只做无损排版清理（去页码/多余空行），绝不改动文字内容。
 */

export const TXT_MAX_BYTES = 10 * 1024 * 1024; // 单文件上限 10MB
const CHUNK_BYTES = 1024 * 1024; // 1MB 分片读取，避免大文件一次性占内存

export interface TxtImportResult {
  content: string;
  encoding: "utf-8" | "utf-16" | "gbk";
  /** 清理阶段移除的页码/页眉类行数 */
  removedJunkLines: number;
  warnings: string[];
}

export class TxtImportError extends Error {
  code: "tooLarge" | "empty" | "readFailed";
  constructor(code: TxtImportError["code"], message: string) {
    super(message);
    this.name = "TxtImportError";
    this.code = code;
  }
}

/** 读取并解析 TXT 文件（入口） */
export async function importTxtFile(file: File): Promise<TxtImportResult> {
  if (file.size > TXT_MAX_BYTES) {
    throw new TxtImportError(
      "tooLarge",
      `文件 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过 10MB 上限，请拆分后导入。`,
    );
  }
  const buffer = await readInChunks(file);
  const { text, encoding } = decodeBuffer(buffer);
  const cleaned = cleanRawText(text);
  if (cleaned.content.trim().length === 0) {
    throw new TxtImportError("empty", "文件内容为空，或编码无法识别（已尝试 UTF-8 与 GBK）。");
  }
  return {
    content: cleaned.content,
    encoding,
    removedJunkLines: cleaned.removedJunkLines,
    warnings: encoding === "gbk" ? ["文件按 GBK 编码解码，如出现乱码请确认源文件编码。"] : [],
  };
}

/** 分片读取文件为 Uint8Array */
async function readInChunks(file: File): Promise<Uint8Array> {
  try {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    while (offset < file.size) {
      const slice = file.slice(offset, Math.min(offset + CHUNK_BYTES, file.size));
      const chunk = new Uint8Array(await slice.arrayBuffer());
      chunks.push(chunk);
      offset += chunk.byteLength;
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(total);
    let position = 0;
    for (const chunk of chunks) {
      merged.set(chunk, position);
      position += chunk.byteLength;
    }
    return merged;
  } catch {
    throw new TxtImportError("readFailed", "读取文件失败，请重试或更换文件。");
  }
}

/** BOM 优先 → UTF-8 严格解码 → GBK 回落 */
function decodeBuffer(buffer: Uint8Array): { text: string; encoding: TxtImportResult["encoding"] } {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(buffer), encoding: "utf-16" };
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(buffer), encoding: "utf-16" };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { text, encoding: "utf-8" };
  } catch {
    // 含非法 UTF-8 序列 → 按 GBK 解码（浏览器原生支持，无需第三方依赖）
    const text = new TextDecoder("gbk").decode(buffer);
    return { text, encoding: "gbk" };
  }
}

/**
 * 无损排版清理：
 * - 统一换行符
 * - 去除行尾空白与全角空格缩进（不改变段落结构）
 * - 删除独立页码行（如 "- 12 -"）
 * - 3 个以上连续空行压缩为 1 个空行
 */
export function cleanRawText(raw: string): { content: string; removedJunkLines: number } {
  const normalized = raw.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  let removedJunkLines = 0;
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.replace(/^[\u3000 ]+/, "").replace(/[ \t\u3000]+$/, "");
    if (/^([-—–~=~]*)\s*\d{1,4}\s*([-—–~=~]*)$/.test(trimmed)) {
      removedJunkLines++;
      continue;
    }
    kept.push(trimmed);
  }
  // 压缩连续空行
  const compressed: string[] = [];
  let blankRun = 0;
  for (const line of kept) {
    if (line.length === 0) {
      blankRun++;
      if (blankRun > 1) continue;
    } else {
      blankRun = 0;
    }
    compressed.push(line);
  }
  const content = compressed.join("\n").replace(/^\n+/, "").replace(/\n+$/, "\n");
  return { content, removedJunkLines };
}
