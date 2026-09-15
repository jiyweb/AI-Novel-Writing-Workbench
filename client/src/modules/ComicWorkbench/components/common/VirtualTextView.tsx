/**
 * 原文虚拟滚动视图
 *
 * 规则约束（第10条）：长文本必须虚拟滚动。
 * 按段落切分并用 @tanstack/react-virtual 渲染；
 * 支持以字符索引区间（分镜锚点）高亮对应段落。
 */
import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";

export interface VirtualTextViewProps {
  content: string;
  /** 高亮的原文区间列表 [start, end)，来自分镜锚点 */
  highlightRanges?: Array<{ start: number; end: number; tone?: "active" | "idle" }>;
  /** 区间变更时滚动到对应位置 */
  scrollIntoRange?: { start: number; end: number } | null;
  className?: string;
}

interface Paragraph {
  start: number;
  end: number;
  text: string;
}

/** 将原文按换行切段并记录每段的字符区间（原文零修改，仅读取） */
function splitParagraphs(content: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let cursor = 0;
  for (const line of content.split("\n")) {
    const start = cursor;
    const end = cursor + line.length;
    if (line.length > 0) {
      paragraphs.push({ start, end, text: line });
    }
    cursor = end + 1; // +1 为换行符
  }
  return paragraphs;
}

export function VirtualTextView(props: VirtualTextViewProps) {
  const { content, highlightRanges, scrollIntoRange, className } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const paragraphs = useMemo(() => splitParagraphs(content), [content]);

  const virtualizer = useVirtualizer({
    count: paragraphs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 84,
    overscan: 8,
    getItemKey: (index) => paragraphs[index]?.start ?? index,
  });

  // 分镜选中时滚动到对应段落
  useEffect(() => {
    if (!scrollIntoRange) return;
    const index = paragraphs.findIndex(
      (p) => p.start <= scrollIntoRange.start && p.end >= scrollIntoRange.start,
    );
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: "center" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollIntoRange?.start, scrollIntoRange?.end]);

  const toneClasses = useMemo(() => {
    const map = new Map<number, "active" | "idle">();
    for (const range of highlightRanges ?? []) {
      for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs[i];
        if (p.end <= range.start || p.start >= range.end) continue;
        if (range.tone === "active" || map.get(i) !== "active") {
          map.set(i, range.tone ?? "idle");
        }
      }
    }
    return map;
  }, [highlightRanges, paragraphs]);

  return (
    <div ref={scrollRef} className={cn("h-full overflow-y-auto", className)}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const paragraph = paragraphs[item.index];
          const tone = toneClasses.get(item.index);
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${item.start}px)`,
              }}
              className={cn(
                "px-3 py-2 text-sm leading-relaxed",
                tone === "active" && "rounded-md bg-primary/15",
                tone === "idle" && "bg-primary/5",
              )}
            >
              <span className="mr-2 select-none text-xs text-muted-foreground/60">
                {item.index + 1}
              </span>
              {paragraph?.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
