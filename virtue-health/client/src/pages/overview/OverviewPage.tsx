import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, Skeleton } from '@databricks/appkit-ui/react';
import { Building2, MapPin, Map, Users, AlertCircle } from 'lucide-react';

interface SummaryData {
  totalFacilities: number;
  statesCovered: number;
  districtsCovered: number;
  avgSexRatio: number | null;
  syncing?: boolean;
}

interface KpiCardProps {
  title: string;
  value: string | number;
  description: string;
  icon: React.ReactNode;
  loading: boolean;
}

function KpiCard({ title, value, description, icon, loading }: KpiCardProps) {
  return (
    <Card className="shadow-sm border border-border/60">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <div className="h-8 w-8 rounded-md bg-[#FF3621]/10 flex items-center justify-center text-[#FF3621]">
          {icon}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-24 mt-1" />
        ) : (
          <div className="text-3xl font-bold text-foreground">{value}</div>
        )}
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/summary')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<SummaryData>;
      })
      .then(setSummary)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load summary'))
      .finally(() => setLoading(false));
  }, []);

  const isSyncing = summary?.syncing === true;

  return (
    <div className="space-y-8 max-w-5xl">
      <div>
        <h2 className="text-2xl font-bold text-foreground">India Healthcare Overview</h2>
        <p className="text-muted-foreground mt-1">
          Summary of healthcare facilities and district health indicators across India.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-destructive bg-destructive/10 px-4 py-3 rounded-lg">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {isSyncing && !error && (
        <div className="flex items-center gap-2 text-amber-700 bg-amber-50 border border-amber-200 px-4 py-3 rounded-lg">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm">
            Data syncing… KPIs will appear once the sync is complete.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Total Facilities"
          value={summary?.totalFacilities != null ? summary.totalFacilities.toLocaleString() : '—'}
          description="Healthcare facilities indexed"
          icon={<Building2 className="h-4 w-4" />}
          loading={loading}
        />
        <KpiCard
          title="States Covered"
          value={summary?.statesCovered ?? '—'}
          description="States and union territories"
          icon={<Map className="h-4 w-4" />}
          loading={loading}
        />
        <KpiCard
          title="Districts Covered"
          value={summary?.districtsCovered ?? '—'}
          description="From NFHS-5 health indicators"
          icon={<MapPin className="h-4 w-4" />}
          loading={loading}
        />
        <KpiCard
          title="Avg Sex Ratio"
          value={
            summary?.avgSexRatio != null
              ? `${summary.avgSexRatio.toLocaleString()}`
              : '—'
          }
          description="Females per 1,000 males"
          icon={<Users className="h-4 w-4" />}
          loading={loading}
        />
      </div>

      <Card className="shadow-sm border border-border/60">
        <CardHeader>
          <CardTitle className="text-base">About This App</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Virtue Health</span> is an India
            healthcare data explorer built for DAIS 2026 on Databricks. It combines facility
            registry data with the National Family Health Survey (NFHS-5) district indicators.
          </p>
          <ul className="space-y-1 list-disc list-inside">
            <li>
              <span className="font-medium text-foreground">Facilities</span> — searchable registry
              of healthcare facilities across India, synced from Unity Catalog via Lakebase
            </li>
            <li>
              <span className="font-medium text-foreground">Districts</span> — NFHS-5 district
              health indicators: electricity, water, sanitation, and civil registration coverage
            </li>
          </ul>
          <p className="text-xs">
            Data powered by Databricks Lakebase (PostgreSQL) with Synced Tables from Unity Catalog.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
