import * as React from "react";
import { cn } from "@/lib/utils";

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  max?: number;
}

export function Progress({ value = 0, max = 100, className, ...props }: ProgressProps) {
  const clampedValue = Number.isFinite(value) ? Math.min(Math.max(value, 0), max) : 0;
  const ratio = max > 0 ? (clampedValue / max) * 100 : 0;

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clampedValue)}
      aria-valuemin={0}
      aria-valuemax={max}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-slate-200", className)}
      {...props}
    >
      <div
        className="h-full bg-slate-900 transition-all duration-300 ease-out"
        style={{ width: `${Math.max(0, Math.min(ratio, 100))}%` }}
      />
    </div>
  );
}
