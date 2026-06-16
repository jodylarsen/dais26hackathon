import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle, Skeleton } from '@databricks/appkit-ui/react';
import { Building2, MapPin, Map, Users, AlertCircle, Database, BarChart3, Activity, Share2 } from 'lucide-react';

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
  accent?: string;
}

function KpiCard({ title, value, description, icon, loading, accent = '#FF3621' }: KpiCardProps) {
  return (
    <Card className="shadow-sm border border-border/60 overflow-hidden">
      <div className="h-[3px]" style={{ background: `linear-gradient(90deg, ${accent}, ${accent}55)` }} />
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 pt-3">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${accent}15`, color: accent }}>
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

export function OverviewPage() {
  const navigate = useNavigate();
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

  return (
    <div className="space-y-8 max-w-5xl">
      {/* Hero */}
      <div className="rounded-xl bg-gradient-to-br from-[#0B2026] to-[#1a3a44] p-6 text-white">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="h-5 w-5 text-[#FF3621]" />
          <span className="text-sm font-medium text-white/70 uppercase tracking-widest">India Healthcare</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">Healthcare at a Glance</h2>
        <p className="text-white/75 mt-1 text-sm max-w-xl">
          Facility registry and NFHS-5 district health indicators across all states and union territories.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-destructive bg-destructive/10 px-4 py-3 rounded-lg">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Total Facilities"
          value={summary?.totalFacilities != null ? summary.totalFacilities.toLocaleString() : '—'}
          description="Healthcare facilities indexed"
          icon={<Building2 className="h-4 w-4" />}
          loading={loading}
          accent="#FF3621"
        />
        <KpiCard
          title="States Covered"
          value={summary?.statesCovered ?? '—'}
          description="States and union territories"
          icon={<Map className="h-4 w-4" />}
          loading={loading}
          accent="#0ea5e9"
        />
        <KpiCard
          title="Districts Covered"
          value={summary?.districtsCovered ?? '—'}
          description="From NFHS-5 health indicators"
          icon={<MapPin className="h-4 w-4" />}
          loading={loading}
          accent="#8b5cf6"
        />
        <KpiCard
          title="Avg Sex Ratio"
          value={summary?.avgSexRatio != null ? summary.avgSexRatio.toLocaleString() : '—'}
          description="Females per 1,000 males"
          icon={<Users className="h-4 w-4" />}
          loading={loading}
          accent="#10b981"
        />
      </div>

      {/* Data sources */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          {
            icon: <Building2 className="h-5 w-5" />,
            title: 'Facilities',
            color: '#FF3621',
            href: '/facilities',
            desc: 'Searchable registry of healthcare facilities across India. Filter by state or search by name and city.',
          },
          {
            icon: <MapPin className="h-5 w-5" />,
            title: 'Districts',
            color: '#8b5cf6',
            href: '/districts',
            desc: 'NFHS-5 district health indicators: electricity, improved water, sanitation, and civil birth registration.',
          },
          {
            icon: <BarChart3 className="h-5 w-5" />,
            title: 'Desert Planner',
            color: '#f97316',
            href: '/desert',
            desc: 'Identifies highest-risk care gaps by comparing state facility supply against NFHS-5 demand indices.',
          },
          {
            icon: <Database className="h-5 w-5" />,
            title: 'Data Readiness',
            color: '#6366f1',
            href: '/data-readiness',
            desc: 'Live data quality scores for the facilities table plus a prioritized enrichment roadmap across 10 free India datasets.',
          },
          {
            icon: <Share2 className="h-5 w-5" />,
            title: 'Referral Copilot',
            color: '#06b6d4',
            href: '/referral-copilot',
            desc: 'AI-assisted patient referral routing: finds the best-fit facility by capability, proximity, and trust score with step-by-step guidance.',
          },
        ].map(({ icon, title, color, href, desc }) => (
          <Card
            key={title}
            className="shadow-sm border border-border/60 overflow-hidden cursor-pointer transition-shadow hover:shadow-md"
            onClick={() => navigate(href)}
          >
            <div className="h-[3px]" style={{ background: `linear-gradient(90deg, ${color}, ${color}55)` }} />
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${color}15`, color }}>
                  {icon}
                </div>
                <span className="font-semibold text-foreground text-sm">{title}</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Data source note */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground border border-border/40 rounded-lg px-4 py-3 bg-muted/20">
        <Database className="h-3.5 w-3.5 shrink-0 text-[#FF3621]" />
        <span>
          Powered by <span className="font-medium text-foreground">Databricks SQL Warehouse</span> querying{' '}
          <code className="bg-muted px-1 py-0.5 rounded text-[10px]">dais27hack.virtue_foundation_dataset_silver</code>{' '}
          in Unity Catalog — live data, no caching on overview metrics.
        </span>
      </div>
    </div>
  );
}
