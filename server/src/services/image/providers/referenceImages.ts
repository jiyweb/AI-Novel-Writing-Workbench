import fs from "fs/promises";
import path from "path";

import type { ImageProviderGenerateInput } from "../types";

/** 参考图统一转成可直接放进 JSON 请求体的字符串（data URL 或远程 URL）。 */

function inferMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

async function readFileAsDataUrl(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const mimeType = inferMimeType(filePath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x || 1;
}

/** "1024x1536" -> "2:3"；无法解析时回退 undefined。 */
export function pixelSizeToAspectRatio(size: string): string | undefined {
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) {
    return undefined;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

/**
 * 汇总本次请求的参考图：本地文件转 data URL，远程 URL 原样保留。
 * 本地文件优先（与 multipart 路径保持一致），远程 URL 追加在后。
 * maxCount 控制单请求参考图上限，超出时截断，避免请求体过大。
 */
export async function collectReferenceImages(
  input: ImageProviderGenerateInput,
  maxCount = 10,
): Promise<string[]> {
  const collected: string[] = [];
  const localPaths = input.refImagePaths ?? [];
  const remoteUrls = (input.refImages ?? []).filter((value) => /^https?:\/\//i.test(value));

  for (const filePath of localPaths) {
    if (collected.length >= maxCount) {
      break;
    }
    collected.push(await readFileAsDataUrl(filePath));
  }
  for (const url of remoteUrls) {
    if (collected.length >= maxCount) {
      break;
    }
    collected.push(url);
  }
  return collected;
}
