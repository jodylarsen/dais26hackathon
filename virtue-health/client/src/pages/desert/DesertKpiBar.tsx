import { Card, CardContent, CardHeader, CardTitle, Skeleton } from '@databricks/appkit-ui/react';
import { AlertTriangle, TrendingUp, Building2, ShieldAlert } from 'lucide-react';
import type { StateGap } from './types';

interface KpiCardProps {
  title: string;
  value: string | number;
  description: string;
  icon: React.ReactNode;
  loading: boolean;
  accent: string;
}

function KpiCard({ title, value, description, icon, loading, accent }: KpiCardProps) {
  return (
    <Card className="shadow-sm border border-border/60 overflow-hidden">
      <div className="h-[3px]" style={{ background: `linear-gradient(90deg, ${accent}, ${accent}55)` }} />
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 pt-3">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${accent}18`, color: accent }}>
          {icon}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-9 w-24 mt-1" />
        ) : (
          <div className="text-3xl font-bold text-foreground tabular-nums">{value}</div>
        )}
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </CardContent>
    </Card>
  );
}

interface DesertKpiBarProps {
  gaps: StateGap[];
  loading: boolean;
}

export function DesertKpiBar({ gaps, loading }: DesertKpiBarProps) {
  const desertCount = gaps.filter((g) => g.gap_score > 50).length;
  const highDemandCount = gaps.filter((g) => (g.demand_index ?? 0) > 60).length;
  const uncoveredCount = gaps.filter((g) => g.facility_count === 0).length;
  const avgGap =
    gaps.length > 0
      ? (gaps.reduce((s, g) => s + g.gap_score, 0) / gaps.length).toFixed(1)
      : '—';

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <KpiCard
        title="Medical Deserts"
        value={loading ? '—' : desertCount}
        description="States with gap score > 50"
        icon={<AlertTriangle className="h-4 w-4" />}
        loading={loading}
        accent="#ef4444"
      />
      <KpiCard
        title="High Demand"
        value={loading ? '—' : highDemandCount}
        description="States with demand index > 60"
        icon={<TrendingUp className="h-4 w-4" />}
        loading={loading}
        accent="#f59e0b"
      />
      <KpiCard
        title="No Facilities"
        value={loading ? '—' : uncoveredCount}
        description="States with zero facilities indexed"
        icon={<Building2 className="h-4 w-4" />}
        loading={loading}
        accent="#6366f1"
      />
      <KpiCard
        title="Avg Gap Score"
        value={loading ? '—' : avgGap}
        description="National average care gap"
        icon={<ShieldAlert className="h-4 w-4" />}
        loading={loading}
        accent="#0ea5e9"
      />
    </div>
  );
}
