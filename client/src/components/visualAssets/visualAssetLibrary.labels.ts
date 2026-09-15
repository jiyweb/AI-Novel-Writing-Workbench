import type {
  VisualAssetKind,
  VisualAssetOrigin,
  VisualAssetScopeKind,
  VisualAssetSourceDomain,
} from "@ai-novel/shared/types/visualAsset";

const KIND_LABELS: Record<VisualAssetKind, string> = {
  character: "角色形象",
  cover: "小说封面",
  illustration: "插图",
  drama_character_sheet: "短剧角色设定",
  drama_shot_keyframe: "短剧镜头关键帧",
};

const SOURCE_LABELS: Record<VisualAssetSourceDomain, string> = {
  image_asset: "图片创作",
  drama: "短剧创作",
};

const ORIGIN_LABELS: Record<VisualAssetOrigin, string> = {
  generated: "AI 生成",
  uploaded: "已上传",
  imported: "已导入",
  unknown: "来源待确认",
};

const SCOPE_LABELS: Record<VisualAssetScopeKind, string> = {
  global: "全部作品",
  novel: "小说",
  book_analysis: "拆书分析",
  drama_project: "短剧项目",
};

export function getVisualAssetKindLabel(kind: VisualAssetKind) {
  return KIND_LABELS[kind];
}

export function getVisualAssetSourceLabel(source: VisualAssetSourceDomain) {
  return SOURCE_LABELS[source];
}

export function getVisualAssetOriginLabel(origin: VisualAssetOrigin) {
  return ORIGIN_LABELS[origin];
}

export function getVisualAssetScopeLabel(kind: VisualAssetScopeKind) {
  return SCOPE_LABELS[kind];
}

export function formatVisualAssetDate(createdAt: string) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return "日期未记录";
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", year: "numeric" }).format(date);
}
