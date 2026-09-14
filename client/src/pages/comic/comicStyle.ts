/**
 * 漫画画风选项（前端单一来源）
 *
 * value 与后端 server/src/services/comic/comicStylePrompt.ts 的内置画风 id 对应；
 * "custom" 表示用户在 customStyle 字段中自由描述画风，后端原样透传给生图 prompt。
 */

export const CUSTOM_STYLE_VALUE = "custom";

/** 自定义画风描述长度（前端收紧到 300 字，保证 stylePreset JSON 不超后端长度限制） */
export const CUSTOM_STYLE_MAX_LENGTH = 300;

export interface ComicStyleOption {
  value: string;
  label: string;
  desc: string;
}

export const COMIC_STYLE_OPTIONS: ComicStyleOption[] = [
  { value: "webtoon_color", label: "彩色韩漫", desc: "鲜艳配色，干净线条，主流条漫" },
  { value: "bl_manga", label: "彩色少女漫", desc: "柔和色调，精致五官，情感向" },
  { value: "shounen_bw", label: "黑白少年漫", desc: "粗犷墨线，动感构图，热血战斗" },
  { value: "ink_traditional", label: "水墨国风", desc: "毛笔笔触，淡彩晕染，古风仙侠" },
  { value: "chibi", label: "Q版萌漫", desc: "圆润可爱，夸张表情，轻松搞笑" },
  { value: "realistic", label: "写实风格", desc: "细腻光影，真实质感，悬疑现实" },
  { value: CUSTOM_STYLE_VALUE, label: "自定义画风", desc: "用自己的话描述想要的画面风格" },
];

/** 返回画风的可读标签；自定义画风返回固定名称，具体描述由调用方另行展示 */
export function getComicStyleLabel(style: string | null | undefined): string {
  return COMIC_STYLE_OPTIONS.find((o) => o.value === style)?.label ?? "彩色韩漫";
}
