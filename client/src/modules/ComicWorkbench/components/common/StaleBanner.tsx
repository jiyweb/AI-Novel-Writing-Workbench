/**
 * 待更新横幅：上游内容变化后的统一提示条 + 一键同步入口。
 * 上游修改不静默改写下游（规则第7条），由用户在此显式触发同步。
 */
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function StaleBanner(props: {
  text: string;
  actionLabel: string;
  onAction: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-500/10 px-3 py-2">
      <span className="text-xs text-amber-700 dark:text-amber-400">{props.text}</span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 border-amber-500/40 px-2.5 text-xs text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
        disabled={props.busy || props.disabled}
        onClick={props.onAction}
      >
        {props.busy ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
        )}
        {props.actionLabel}
      </Button>
    </div>
  );
}
