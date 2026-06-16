import { useEffect, useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Button,
  Badge,
  Skeleton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@databricks/appkit-ui/react';
import { Search, ChevronLeft, ChevronRight, AlertCircle, Building2 } from 'lucide-react';
import { FacilityDetailDialog } from './FacilityDetailDialog';

interface Facility {
  facility_id: number;
  name: string;
  organization_type: string;
  address_city: string;
  state: string;
  address_country: string;
}

interface FacilitiesResponse {
  facilities: Facility[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  syncing?: boolean;
}

export function FacilitiesPage() {
  const [data, setData] = useState<FacilitiesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [page, setPage] = useState(1);
  const [states, setStates] = useState<string[]>([]);
  const [selectedFacilityId, setSelectedFacilityId] = useState<number | null>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Load states for filter dropdown
  useEffect(() => {
    let cancelled = false;
    fetch('/api/facilities/states')
      .then((res) => res.json())
      .then((d: { states?: string[]; syncing?: boolean }) => {
        if (!cancelled && !d.syncing && d.states) setStates(d.states);
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, []);

  // Load facilities data
  useEffect(() => {
    let cancelled = false;
    setLoading(true); // eslint-disable-line react-hooks/set-state-in-effect
    setError(null);
    const params = new URLSearchParams();
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (stateFilter) params.set('state', stateFilter);
    params.set('page', String(page));

    fetch(`/api/facilities?${params.toString()}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<FacilitiesResponse>;
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
          setError(err instanceof Error ? err.message : 'Failed to load facilities');
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [debouncedSearch, stateFilter, page]);

  const isSyncing = data?.syncing === true;

  const handleStateChange = (value: string) => {
    setStateFilter(value === '_all' ? '' : value);
    setPage(1);
  };

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Healthcare Facilities</h2>
        <p className="text-muted-foreground mt-1">
          Browse and search the healthcare facility registry across India.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search by name or city..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select onValueChange={handleStateChange} value={stateFilter || '_all'}>
          <SelectTrigger className="w-full sm:w-56">
            <SelectValue placeholder="All states" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All states</SelectItem>
            {states.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-destructive bg-destructive/10 px-4 py-3 rounded-lg">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {isSyncing && !error && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg border bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/40 dark:border-amber-800/50 dark:text-amber-300">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm">
            Facilities data is being synced. This page will show data once the sync completes.
          </span>
        </div>
      )}

      <Card className="shadow-sm border border-border/60">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base">
            {loading ? (
              <Skeleton className="h-5 w-32" />
            ) : data ? (
              `${data.total != null ? data.total.toLocaleString() : '—'} facilities`
            ) : (
              'Facilities'
            )}
          </CardTitle>
          {!loading && data && data.totalPages > 1 && (
            <span className="text-sm text-muted-foreground">
              Page {data.page} of {data.totalPages}
            </span>
          )}
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">
                    Type
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">City</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">
                    State
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 10 }, (_, i) => (
                      <tr key={`skel-${i}`} className="border-b last:border-0">
                        <td className="px-4 py-3">
                          <Skeleton className="h-4 w-48" />
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <Skeleton className="h-4 w-24" />
                        </td>
                        <td className="px-4 py-3">
                          <Skeleton className="h-4 w-28" />
                        </td>
                        <td className="px-4 py-3 hidden sm:table-cell">
                          <Skeleton className="h-4 w-32" />
                        </td>
                      </tr>
                    ))
                  : (data?.facilities ?? []).map((f) => (
                      <tr
                        key={f.facility_id}
                        className="border-b last:border-0 hover:bg-muted/20 transition-colors cursor-pointer"
                        onClick={() => setSelectedFacilityId(f.facility_id)}
                      >
                        <td className="px-4 py-3 font-medium text-foreground max-w-xs">
                          <div className="flex items-center gap-2">
                            <Building2 className="h-4 w-4 text-[#FF3621] shrink-0" />
                            <span className="truncate">{f.name || '—'}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          {f.organization_type ? (
                            <Badge variant="secondary" className="text-xs font-normal">
                              {f.organization_type}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {f.address_city || '—'}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                          {f.state || '—'}
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>

            {!loading && (data?.facilities?.length ?? 0) === 0 && !isSyncing && (
              <div className="text-center py-12 text-muted-foreground">
                <Building2 className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p>No facilities found matching your filters.</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <FacilityDetailDialog
        facilityId={selectedFacilityId}
        onClose={() => setSelectedFacilityId(null)}
      />

      {/* Pagination */}
      {!loading && data && data.totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <span className="text-sm text-muted-foreground px-2">
            {page} / {data.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
            disabled={page === data.totalPages}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
