import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  ResponsiveContainer,
} from 'recharts';
import type { StateGap } from './types';

interface DesertMapProps {
  gaps: StateGap[];
  showConfidenceFilter: boolean;
  onStateSelect: (gap: StateGap) => void;
  // kept for API compat — unused without map
  points?: unknown[];
  showHeatmap?: boolean;
  showChoropleth?: boolean;
}

function gapColor(score: number): string {
  if (score >= 100) return '#7f1d1d';
  if (score >= 50)  return '#ef4444';
  if (score >= 25)  return '#f97316';
  if (score >= 10)  return '#fbbf24';
  return '#86efac';
}

export function DesertMap({
  gaps,
  showConfidenceFilter,
  onStateSelect,
}: DesertMapProps) {
  const data = useMemo(() => {
    let list = [...gaps].sort((a, b) => b.gap_score - a.gap_score).slice(0, 25);
    if (showConfidenceFilter) list = list.filter((g) => g.confidence === 'high');
    return list;
  }, [gaps, showConfidenceFilter]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No states match the current filters.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 32, bottom: 4, left: 120 }}
        onClick={(e: unknown) => {
          const ev = e as { activePayload?: Array<{ payload?: StateGap }> } | undefined;
          const state = ev?.activePayload?.[0]?.payload;
          if (state) onStateSelect(state);
        }}
        style={{ cursor: 'pointer' }}
      >
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis
          type="number"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11 }}
          label={{ value: 'Gap Score (higher = more underserved)', position: 'insideBottomRight', offset: -4, fontSize: 11 }}
        />
        <YAxis
          type="category"
          dataKey="state"
          width={116}
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          formatter={(v) => [Number(v).toFixed(1), 'Gap Score']}
          labelFormatter={(label) => `State: ${label}`}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const g = payload[0].payload as StateGap;
            return (
              <div className="bg-white border border-border rounded-lg shadow-lg p-3 text-xs space-y-1">
                <div className="font-semibold text-sm">{g.state}</div>
                <div>Gap score: <span className="font-medium">{g.gap_score.toFixed(1)}</span></div>
                <div>Facilities: <span className="font-medium">{g.facility_count.toLocaleString()}</span></div>
                <div>Demand index: <span className="font-medium">{g.demand_index?.toFixed(1) ?? 'N/A'}</span></div>
                <div>Confidence: <span className="font-medium capitalize">{g.confidence}</span></div>
                <div className="text-muted-foreground pt-1">Click to see details</div>
              </div>
            );
          }}
        />
        <Bar dataKey="gap_score" radius={[0, 3, 3, 0]}>
          {data.map((g) => (
            <Cell key={g.state} fill={gapColor(g.gap_score)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
