/**
 * 导出服务：单张 PNG 下载、条漫长图 canvas 拼接（含台词合成）、ZIP 打包
 *
 * 条漫长图按分镜顺序纵向拼接（镜间留白），可把台词按步骤五的
 * 百分比布局合成到画面上（气泡/字幕/聊天框样式随形态适配）。
 * 布局渲染与 DialogueStage 预览保持同一套约定（384px 基准字号）。
 *
 * 成图优先取本地 Blob；仅有 remoteUrl 的图尝试直接加载，失败则跳过该镜。
 */
import { getImageBlob, getImageRecord } from "../../db/comicDb";
import { buildZip, type ZipEntry } from "./zipWriter";
import { defaultDialogueLayout } from "../dialogueService";
import type { ComicFormConfig, ComicLetteringMode, ComicPanel } from "../../types";

/** DialogueStage 预览的基准宽度（max-w-sm ≈ 384px），字号换算与之一致 */
const STAGE_BASE_WIDTH = 384;
/** 条漫相邻两镜的间隔（像素） */
const STRIP_GAP = 12;
/** 气泡内边距（基准像素，随条漫宽度缩放） */
const BUBBLE_PADDING = 6;

// ---------------------------------------------------------------------------
// 图片收集
// ---------------------------------------------------------------------------

export interface PanelImage {
  panel: ComicPanel;
  /** 本地图优先；remoteUrl 兜底加载失败时为 null */
  blob: Blob | null;
  remoteUrl?: string;
}

/** 收集分镜成图（Blob / remoteUrl），未生成的分镜返回 null 并跳过 */
export async function collectPanelImages(panels: ComicPanel[]): Promise<PanelImage[]> {
  const result: PanelImage[] = [];
  for (const panel of panels) {
    const imageId = panel.generation.imageId;
    if (!imageId) continue;
    const blob = (await getImageBlob(imageId)) ?? null;
    let remoteUrl: string | undefined;
    if (!blob) {
      const record = await getImageRecord(imageId);
      remoteUrl = record?.remoteUrl;
      if (!remoteUrl) continue;
    }
    result.push({ panel, blob, remoteUrl });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 条漫长图渲染（含台词合成）
// ---------------------------------------------------------------------------

export interface StripRenderOptions {
  /** 是否把台词合成到画面（none 形态不参与） */
  includeDialogues: boolean;
}

/**
 * 把一个章节的分镜纵向拼成条漫长图并返回 PNG Blob。
 * 没有任何成图时返回 null。
 */
export async function renderChapterStrip(
  panels: ComicPanel[],
  form: ComicFormConfig,
  options: StripRenderOptions,
): Promise<Blob | null> {
  const letteringMode = form.letteringMode;
  const images = await collectPanelImages(panels);
  if (images.length === 0) return null;

  const stripWidth = form.referencePixel.width;
  const loaded: Array<{ image: PanelImage; element: HTMLImageElement; drawHeight: number }> = [];
  for (const image of images) {
    const element = await loadPanelElement(image);
    if (!element) continue;
    const drawHeight = Math.round((element.naturalHeight / element.naturalWidth) * stripWidth);
    loaded.push({ image, element, drawHeight });
  }
  if (loaded.length === 0) return null;

  const totalHeight = loaded.reduce((sum, item) => sum + item.drawHeight + STRIP_GAP, 0) - STRIP_GAP;
  const canvas = document.createElement("canvas");
  canvas.width = stripWidth;
  canvas.height = totalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("当前浏览器不支持 Canvas 渲染，无法拼接条漫");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, stripWidth, totalHeight);

  let y = 0;
  for (const item of loaded) {
    ctx.drawImage(item.element, 0, y, stripWidth, item.drawHeight);
    if (options.includeDialogues && letteringMode !== "none") {
      drawDialogues(ctx, item.image.panel, letteringMode, stripWidth, y, item.drawHeight);
    }
    y += item.drawHeight + STRIP_GAP;
  }

  return await canvasToBlob(canvas);
}

function loadPanelElement(image: PanelImage): Promise<HTMLImageElement | null> {
  if (image.blob) {
    const url = URL.createObjectURL(image.blob);
    return loadImageElement(url).finally(() => URL.revokeObjectURL(url));
  }
  // remoteUrl 兜底：尝试匿名跨域加载，失败则放弃该镜
  return loadImageElement(image.remoteUrl ?? "", true);
}

function loadImageElement(src: string, anonymous = false): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!src) {
      resolve(null);
      return;
    }
    const element = new Image();
    if (anonymous) element.crossOrigin = "anonymous";
    element.onload = () => resolve(element);
    element.onerror = () => resolve(null);
    element.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("条漫导出失败：Canvas 转 PNG 未返回数据"));
    }, "image/png");
  });
}

// ---------------------------------------------------------------------------
// 台词合成（与 DialogueStage 预览同一套布局约定）
// ---------------------------------------------------------------------------

function drawDialogues(
  ctx: CanvasRenderingContext2D,
  panel: ComicPanel,
  letteringMode: ComicLetteringMode,
  stripWidth: number,
  offsetY: number,
  drawHeight: number,
): void {
  const scale = stripWidth / STAGE_BASE_WIDTH;
  panel.dialogues.forEach((dialogue, index) => {
    if (!dialogue.text) return;
    const layout = dialogue.layout ?? defaultDialogueLayout(index, letteringMode);
    const fontSize = 13 * scale * layout.fontScale;
    const padding = BUBBLE_PADDING * scale;
    const boxWidth = (layout.width / 100) * stripWidth;
    const x = (layout.x / 100) * stripWidth;
    const y = offsetY + (layout.y / 100) * drawHeight;
    const isCaption = letteringMode === "caption";

    ctx.font = `${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    const maxTextWidth = boxWidth - padding * 2;
    const lines = wrapText(ctx, dialogue.text, maxTextWidth);
    const lineHeight = fontSize * 1.35;
    const boxHeight = lines.length * lineHeight + padding * 2;

    // 背景
    ctx.save();
    roundRectPath(ctx, x, y, boxWidth, boxHeight, (isCaption ? 4 : 12) * scale);
    if (isCaption) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
      ctx.fill();
    } else {
      ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
      ctx.fill();
      ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
      ctx.lineWidth = 1 * scale;
      ctx.stroke();
    }
    ctx.restore();

    // 文字
    ctx.fillStyle = isCaption ? "#ffffff" : "#1f2937";
    ctx.textBaseline = "top";
    if (isCaption) ctx.textAlign = "center";
    lines.forEach((line, lineIndex) => {
      const lineY = y + padding + lineIndex * lineHeight;
      if (isCaption) {
        ctx.fillText(line, x + boxWidth / 2, lineY);
      } else {
        ctx.fillText(line, x + padding, lineY);
      }
    });
    ctx.textAlign = "left";
  });
}

/** 中文逐字换行（尊重手动换行符） */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const char of paragraph) {
      const candidate = current + char;
      if (current.length > 0 && ctx.measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = char;
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

/** 触发浏览器下载（ZIP/PNG 通用） */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** ZIP 打包：ZIP 内路径 → 数据 */
export function packZip(entries: ZipEntry[]): Blob {
  return buildZip(entries);
}
