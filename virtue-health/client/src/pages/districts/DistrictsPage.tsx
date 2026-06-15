import { useEffect, useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@databricks/appkit-ui/react';
import { AlertCircle, MapPin } from 'lucide-react';

interface District {
  district_name: string;
  state_ut: string;
  households_surveyed: number | null;
  hh_electricity_pct: number | null;
  hh_improved_water_pct: number | null;
  hh_use_improved_sanitation_pct: number | null;
  child_u5_whose_birth_was_civil_reg_pct: number | null;
}

interface DistrictsResponse {
  districts: District[];
  syncing?: boolean;
}

function pct(val: number | null): string {
  if (val === null || val === undefined) return '—';
  return `${val.toFixed(1)}%`;
}

function num(val: number | null): string {
  if (val === null || val === undefined) return '—';
  return val.toLocaleString();
}

function PctBar({ value }: { value: number | null }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  const clamped = Math.min(100, Math.max(0, value));
  const color =
    clamped >= 75
      ? 'bg-emerald-500'
      : clamped >= 50
        ? 'bg-amber-400'
        : 'bg-red-400';

  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${clamped}%` }} />
      </div>
      <span className="text-xs tabular-nums w-10 text-right">{pct(value)}</span>
    </div>
  );
}

export function DistrictsPage() {
  const [data, setData] = useState<DistrictsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState('');
  const [states, setStates] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/districts/states')
      .then((res) => res.json())
      .then((d: { states?: string[]; syncing?: boolean }) => {
        if (!cancelled && !d.syncing && d.states) setStates(d.states);
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); // eslint-disable-line react-hooks/set-state-in-effect
    setError(null);
    const params = new URLSearchParams();
    if (stateFilter) params.set('state', stateFilter);

    fetch(`/api/districts?${params.toString()}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<DistrictsResponse>;
      })
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load districts');
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [stateFilter]);

  const isSyncing = data?.syncing === true;

  const handleStateChange = (value: string) => {
    setStateFilter(value === '_all' ? '' : value);
  };

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h2 className="text-2xl font-bold text-foreground">District Health Indicators</h2>
        <p className="text-muted-foreground mt-1">
          NFHS-5 district-level health and infrastructure indicators across India.
        </p>
      </div>

      {/* State filter */}
      <div className="flex items-center gap-3">
        <Select onValueChange={handleStateChange} value={stateFilter || '_all'}>
          <SelectTrigger className="w-64">
            <SelectValue placeholder="All states" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All states & UTs</SelectItem>
            {states.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!loading && data && data.districts && (
          <span className="text-sm text-muted-foreground">
            {data.districts.length} district{data.districts.length !== 1 ? 's' : ''}
          </span>
        )}
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
            NFHS data is being synced. District indicators will appear once the sync completes.
          </span>
        </div>
      )}

      <Card className="shadow-sm border border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">NFHS-5 District Health Data</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Key: Electricity / Improved Water / Sanitation / Civil Birth Registration
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">
                    District
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell whitespace-nowrap">
                    State / UT
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden lg:table-cell whitespace-nowrap">
                    HH Surveyed
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">
                    Electricity
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell whitespace-nowrap">
                    Improved Water
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell whitespace-nowrap">
                    Sanitation
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden xl:table-cell whitespace-nowrap">
                    Birth Reg.
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 12 }, (_, i) => (
                      <tr key={`skel-${i}`} className="border-b last:border-0">
                        <td className="px-4 py-3">
                          <Skeleton className="h-4 w-32" />
                        </td>
                        <td className="px-4 py-3 hidden sm:table-cell">
                          <Skeleton className="h-4 w-28" />
                        </td>
                        <td className="px-4 py-3 hidden lg:table-cell">
                          <Skeleton className="h-4 w-20" />
                        </td>
                        <td className="px-4 py-3">
                          <Skeleton className="h-4 w-24" />
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <Skeleton className="h-4 w-24" />
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <Skeleton className="h-4 w-24" />
                        </td>
                        <td className="px-4 py-3 hidden xl:table-cell">
                          <Skeleton className="h-4 w-24" />
                        </td>
                      </tr>
                    ))
                  : (data?.districts ?? []).map((d) => (
                      <tr
                        key={`${d.district_name}-${d.state_ut}`}
                        className="border-b last:border-0 hover:bg-muted/20 transition-colors"
                      >
                        <td className="px-4 py-3 font-medium text-foreground">
                          <div className="flex items-center gap-1.5">
                            <MapPin className="h-3.5 w-3.5 text-[#FF3621] shrink-0" />
                            <span>{d.district_name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                          {d.state_ut}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell tabular-nums">
                          {num(d.households_surveyed)}
                        </td>
                        <td className="px-4 py-3">
                          <PctBar value={d.hh_electricity_pct} />
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <PctBar value={d.hh_improved_water_pct} />
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <PctBar value={d.hh_use_improved_sanitation_pct} />
                        </td>
                        <td className="px-4 py-3 hidden xl:table-cell">
                          <PctBar value={d.child_u5_whose_birth_was_civil_reg_pct} />
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>

            {!loading && (data?.districts?.length ?? 0) === 0 && !isSyncing && (
              <div className="text-center py-12 text-muted-foreground">
                <MapPin className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p>No district data found.</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

