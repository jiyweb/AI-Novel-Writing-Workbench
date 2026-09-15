/**
 * 短剧内容包契约（re-export from adaptation 共享层）
 *
 * drama 内部代码继续从此路径 import，外部不感知迁移。
 * 其他改编模块请直接 import services/adaptation/contracts/sourceBundle。
 */
export type {
  SourceFactCategory,
  SourceRef,
  SourceBeat,
  SourceCharacter,
  SourceFact,
  SourceBundle,
} from "../../adaptation/contracts/sourceBundle";

/** drama 内部使用的内容源类型 */
export type DramaSourceType = "novel_import" | "original" | "text_import";
