import {
  createContext,
  useContext,
  useId,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from 'react';
import * as RechartsPrimitive from 'recharts';
import { cn } from '@/lib/utils';

export type ChartConfig = Record<
  string,
  {
    label?: ReactNode;
    icon?: ComponentType;
    color?: string;
  }
>;

type ChartContextValue = { config: ChartConfig };

const ChartContext = createContext<ChartContextValue | null>(null);

function useChart() {
  const context = useContext(ChartContext);
  if (!context) {
    throw new Error('useChart must be used within a <ChartContainer />');
  }
  return context;
}

export function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: ComponentProps<'div'> & {
  config: ChartConfig;
  children: ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children'];
}) {
  const uniqueId = useId();
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, '')}`;
  const colorVars = Object.entries(config)
    .filter(([, value]) => value.color)
    .map(([key, value]) => `--color-${key}:${value.color};`)
    .join('');

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        className={cn('flex aspect-video justify-center text-xs [&_.recharts-cartesian-grid-horizontal_line]:stroke-border/50', className)}
        {...props}
      >
        <style>{`[data-chart="${chartId}"]{${colorVars}}`}</style>
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = RechartsPrimitive.Tooltip;

export function ChartTooltipContent({
  active,
  payload,
  className,
  label,
  hideLabel = false,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string; dataKey?: string }>;
  className?: string;
  label?: string;
  hideLabel?: boolean;
}) {
  const { config } = useChart();
  if (!active || !payload?.length) return null;

  return (
    <div className={cn('grid min-w-32 items-start gap-1.5 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl', className)}>
      {hideLabel ? null : <div className="font-medium">{label}</div>}
      <div className="grid gap-1.5">
        {payload.map((item) => {
          const key = String(item.dataKey ?? item.name ?? 'value');
          const itemConfig = config[key];
          return (
            <div key={key} className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{itemConfig?.label ?? item.name}</span>
              <span className="font-mono font-medium tabular-nums text-foreground">{item.value}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
