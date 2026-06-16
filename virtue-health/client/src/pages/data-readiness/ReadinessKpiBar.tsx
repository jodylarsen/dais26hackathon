// Modeled verbatim on DesertKpiBar: file-private KpiCard (value: string | number,
// tabular-nums text-3xl font-bold) + a bar taking raw data + a single `loading` per source.
// KPI values are derived inline (the codebase convention — no useMemo).
import { Card, CardContent } from '@databricks/appkit-ui/react';
import type { IssueCounts } from './types';

function KpiCard({ label, value, sublabel }: {
  label: string; value: string | number; sublabel?: string;
}) {
  return (
    <Card className="shadow-sm border border-border/60">
      <CardContent className="p-4">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className="text-3xl font-bold tabular-nums text-foreground mt-1">{value}</div>
        {sublabel && <div className="text-xs text-muted-foreground mt-0.5">{sublabel}</div>}
      </CardContent>
    </Card>
  );
}

export function ReadinessKpiBar({
  profile, total, profileLoading,
  issueCounts, issuesLoading,
  flaggedTotal, recordsLoading,
}: {
  profile: { fillRate: number }[];
  total: number;
  profileLoading: boolean;
  issueCounts: IssueCounts | null;
  issuesLoading: boolean;
  flaggedTotal: number;
  recordsLoading: boolean;
}) {
  const completeness =
    profileLoading || total === 0 || profile.length === 0
      ? '—'
      : `${Math.round((profile.reduce((s, f) => s + f.fillRate, 0) / profile.length) * 100)}%`;

  const totalIssues = issuesLoading || !issueCounts ? '—' : issueCounts.total;
  const duplicateIds = issuesLoading || !issueCounts ? '—' : issueCounts.duplicate;
  const flagged = recordsLoading ? '—' : flaggedTotal;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiCard label="Field Completeness" value={completeness} sublabel="avg fill across fields" />
      <KpiCard label="Total Issues" value={totalIssues} sublabel="flagged rows" />
      <KpiCard label="Flagged (≥1 serious issue)" value={flagged} sublabel="dataset-wide" />
      <KpiCard label="Duplicate IDs" value={duplicateIds} sublabel="distinct ids" />
    </div>
  );
}
