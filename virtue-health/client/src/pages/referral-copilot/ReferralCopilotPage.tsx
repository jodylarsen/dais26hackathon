import { useEffect, useState } from 'react';
import { MapPin, Search, Building2, ArrowRight, AlertCircle, Phone, Globe } from 'lucide-react';
import {
  Card, CardContent, CardHeader, CardTitle, Badge, Skeleton,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Button,
} from '@databricks/appkit-ui/react';

interface ReferralResult {
  facility_id: number;
  name: string | null;
  city: string | null;
  state: string | null;
  cap_score: number | null;
  cap_level: string | null;
  beds: number | null;
  number_of_doctors: number | null;
  phone: string | null;
  website: string | null;
}

const CAPABILITIES: { label: string; value: string }[] = [
  { label: 'ICU',        value: 'icu' },
  { label: 'Emergency',  value: 'emergency' },
  { label: 'Maternity',  value: 'maternity' },
  { label: 'Oncology',   value: 'oncology' },
  { label: 'Trauma',     value: 'trauma' },
  { label: 'NICU',       value: 'nicu' },
  { label: 'Cardiology', value: 'cardiology' },
  { label: 'Surgery',    value: 'surgery' },
];

const LEVEL_CLASS: Record<string, string> = {
  high:   'bg-green-100 text-green-800 border-green-200',
  medium: 'bg-amber-100 text-amber-800 border-amber-200',
  low:    'bg-red-100 text-red-800 border-red-200',
};

function CapBar({ score }: { score: number | null }) {
  const pct = score != null ? Math.min(100, score) : 0;
  const color = pct >= 70 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-400' : 'bg-red-400';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground w-8 text-right">
        {score != null ? score.toFixed(0) : '—'}
      </span>
    </div>
  );
}

export function ReferralCopilotPage() {
  const [states, setStates] = useState<string[]>([]);
  const [statesLoading, setStatesLoading] = useState(true);

  const [selectedState, setSelectedState] = useState('');
  const [selectedCap, setSelectedCap] = useState('');
  const [results, setResults] = useState<ReferralResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/referral/states')
      .then(r => r.json())
      .then(d => setStates(d.states ?? []))
      .catch(() => {})
      .finally(() => setStatesLoading(false));
  }, []);

  function handleSearch() {
    if (!selectedState || !selectedCap) return;
    setSearching(true);
    setSearchError(null);
    setResults(null);
    const params = new URLSearchParams({ state: selectedState, capability: selectedCap });
    fetch(`/api/referral/search?${params}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => setResults(d.results ?? []))
      .catch(e => setSearchError(e instanceof Error ? e.message : 'Search failed'))
      .finally(() => setSearching(false));
  }

  const canSearch = selectedState && selectedCap && !searching;

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Hero */}
      <div className="rounded-xl bg-gradient-to-br from-[#0B2026] to-[#1a3a44] p-6 text-white">
        <div className="flex items-center gap-2 mb-3">
          <ArrowRight className="h-5 w-5 text-[#f97316]" />
          <span className="text-sm font-medium text-white/70 uppercase tracking-widest">Track 3</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">Referral Copilot</h2>
        <p className="text-white/75 mt-1 text-sm max-w-xl">
          Select a state and required care type to surface the top-ranked facilities by capability score.
        </p>
      </div>

      {/* Search panel */}
      <Card className="shadow-sm border border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Search className="h-4 w-4 text-[#FF3621]" />
            Find a Facility
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row gap-3 items-end">
            <div className="flex-1 space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">State</p>
              <Select onValueChange={setSelectedState} value={selectedState || '_none'} disabled={statesLoading}>
                <SelectTrigger>
                  <SelectValue placeholder={statesLoading ? 'Loading states…' : 'Select state'} />
                </SelectTrigger>
                <SelectContent>
                  {states.map(s => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Care Type</p>
              <Select onValueChange={setSelectedCap} value={selectedCap || '_none'}>
                <SelectTrigger>
                  <SelectValue placeholder="Select capability" />
                </SelectTrigger>
                <SelectContent>
                  {CAPABILITIES.map(c => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleSearch} disabled={!canSearch} className="shrink-0">
              <Search className="h-4 w-4 mr-1.5" />
              Search
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Error */}
      {searchError && (
        <div className="flex items-center gap-2 text-destructive bg-destructive/10 px-4 py-3 rounded-lg text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {searchError}
        </div>
      )}

      {/* Loading skeletons */}
      {searching && (
        <Card className="shadow-sm border border-border/60">
          <CardContent className="pt-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex gap-4 items-center">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {results !== null && !searching && (
        <Card className="shadow-sm border border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="h-4 w-4 text-[#FF3621]" />
              {results.length === 0
                ? 'No facilities found'
                : `${results.length} facilit${results.length === 1 ? 'y' : 'ies'} — ranked by ${CAPABILITIES.find(c => c.value === selectedCap)?.label ?? ''} score`}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {results.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-sm">
                <MapPin className="h-7 w-7 mx-auto mb-2 opacity-30" />
                No facilities with {selectedCap} data found in {selectedState}.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/30">
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">#</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Facility</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">Location</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground w-36">Cap Score</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">Level</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden lg:table-cell">Beds / Doctors</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden xl:table-cell">Contact</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r, idx) => (
                      <tr key={r.facility_id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3 text-muted-foreground tabular-nums font-medium">{idx + 1}</td>
                        <td className="px-4 py-3 font-medium text-foreground max-w-[200px]">
                          <span className="truncate block">{r.name ?? '—'}</span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                          {[r.city, r.state].filter(Boolean).join(', ') || '—'}
                        </td>
                        <td className="px-4 py-3">
                          <CapBar score={r.cap_score} />
                        </td>
                        <td className="px-4 py-3 hidden sm:table-cell">
                          {r.cap_level ? (
                            <Badge variant="outline" className={`text-xs capitalize ${LEVEL_CLASS[r.cap_level.toLowerCase()] ?? 'bg-muted text-muted-foreground border-border'}`}>
                              {r.cap_level}
                            </Badge>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground text-xs hidden lg:table-cell">
                          {r.beds != null ? `${r.beds} beds` : '—'}{r.number_of_doctors != null ? ` · ${r.number_of_doctors} dr` : ''}
                        </td>
                        <td className="px-4 py-3 hidden xl:table-cell">
                          <div className="flex items-center gap-2">
                            {r.phone && (
                              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Phone className="h-3 w-3 shrink-0" />
                                <span className="truncate max-w-[100px]">{r.phone}</span>
                              </span>
                            )}
                            {r.website && (
                              <a
                                href={r.website.startsWith('http') ? r.website : `https://${r.website}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-blue-500 hover:text-blue-600"
                              >
                                <Globe className="h-3.5 w-3.5" />
                              </a>
                            )}
                            {!r.phone && !r.website && <span className="text-muted-foreground text-xs">—</span>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Empty state before search */}
      {results === null && !searching && !searchError && (
        <div className="text-center py-14 text-muted-foreground">
          <Search className="h-8 w-8 mx-auto mb-3 opacity-25" />
          <p className="text-sm">Select a state and care type, then click Search.</p>
          <p className="text-xs mt-1 opacity-60">Results ranked by capability score from the gold scoring layer.</p>
        </div>
      )}
    </div>
  );
}
