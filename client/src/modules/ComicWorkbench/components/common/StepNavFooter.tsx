/**
 * 步骤页脚导航：上一步 / 下一步
 *
 * 由 ComicProjectPage 统一渲染在步骤面板下方。
 * 各步骤面板通过 useReportStepReady 上报「下一步是否可用」与提示文案
 * （面板持有业务数据，页面不重复查询），实现按步骤完成的流程引导。
 */
import { useEffect } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WORKBENCH_STEPS } from "../../stores/workbenchStore";
import type { WorkbenchStep } from "../../stores/workbenchStore";

/** 面板就绪状态上报：相关数据变化时通知页面更新页脚按钮可用性 */
export function useReportStepReady(
  onReadyChange: ((ready: boolean, hint?: string) => void) | undefined,
  ready: boolean,
  hint?: string,
) {
  useEffect(() => {
    onReadyChange?.(ready, hint);
  }, [onReadyChange, ready, hint]);
}

export function StepNavFooter(props: {
  step: WorkbenchStep;
  nextDisabled: boolean;
  hint?: string;
  onGoToStep: (step: WorkbenchStep) => void;
}) {
  const index = WORKBENCH_STEPS.findIndex((item) => item.id === props.step);
  const prev = index > 0 ? WORKBENCH_STEPS[index - 1] : undefined;
  const next =
    index >= 0 && index < WORKBENCH_STEPS.length - 1 ? WORKBENCH_STEPS[index + 1] : undefined;

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">{props.hint ?? ""}</p>
      <div className="flex shrink-0 items-center gap-2">
        {prev ? (
          <Button variant="ghost" size="sm" onClick={() => props.onGoToStep(prev.id)}>
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            上一步：{prev.label}
          </Button>
        ) : null}
        {next ? (
          <Button size="sm" disabled={props.nextDisabled} onClick={() => props.onGoToStep(next.id)}>
            下一步：{next.label}
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
