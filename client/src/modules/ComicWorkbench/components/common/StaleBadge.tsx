/**
 * 待更新徽标：该镜内容基于旧版本上游生成，建议同步（规则第7条数据流单向）
 */
import { Badge } from "@/components/ui/badge";

export function StaleBadge(props: { label?: string }) {
  return (
    <Badge
      variant="outline"
      className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400"
    >
      {props.label ?? "待更新"}
    </Badge>
  );
}
