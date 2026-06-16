import type { ReactNode } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@databricks/appkit-ui/react';
import type {
  Duplicate, NullByteRecord, GeoContradiction, SourceMismatch,
  Issue, SparseField, IssueCounts, ListErrors, AnomalyAlert,
} from './types';

function safeStr(v: unknown, fallback = '—'): string {
  if (v == null) return fallback;
  if (typeof v === 'string') return v || fallback;
  if (Array.isArray(v)) return v.map(String).join(', ') || fallback;
  return JSON.stringify(v);
}
import { PctBar } from './PctBar';

function TabError() {
  return (
    <p className="text-sm text-muted-foreground py-4 text-center">
      Couldn't load this check — try Retry above.
    </p>
  );
}

function NoRows({ count }: { count: number | undefined }) {
  if (count !== undefined && count > 0) {
    return (
      <p className="text-sm text-amber-600 dark:text-amber-400 py-4 text-center">
        Count and detail list disagree — showing no detail rows.
      </p>
    );
  }
  return <p className="text-sm text-muted-foreground py-4 text-center">No rows to display.</p>;
}

function CleanMsg({ msg }: { msg: string }) {
  return <p className="text-sm text-emerald-600 dark:text-emerald-400 py-4 text-center">{msg}</p>;
}

function Skeletons() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
    </div>
  );
}

function Cap({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground mb-2">{children}</p>;
}

const SEVERITY_CLASS: Record<string, string> = {
  HIGH:   'bg-red-100 text-red-800 border-red-200',
  MEDIUM: 'bg-amber-100 text-amber-800 border-amber-200',
  LOW:    'bg-blue-100 text-blue-800 border-blue-200',
};

export function ReadinessIssueTabs({
  duplicates, nullBytes, geoContradictions, sourceMismatch, contradictions, suspicious,
  anomalyAlerts, sparseFields, issueCounts, listErrors, issuesError, loading,
}: {
  duplicates: Duplicate[];
  nullBytes: NullByteRecord[];
  geoContradictions: GeoContradiction[];
  sourceMismatch: SourceMismatch[];
  contradictions: Issue[];
  suspicious: Issue[];
  anomalyAlerts: AnomalyAlert[];
  sparseFields: SparseField[];
  issueCounts: IssueCounts | null;
  listErrors: ListErrors | null;
  issuesError: string | null;
  loading: boolean;
}) {
  const c = issueCounts;
  const badge = (n: number | undefined) => (n !== undefined ? n : '…');

  return (
    <Card className="shadow-sm border border-border/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Issue Detection</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {issuesError ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            Couldn't load issue checks. Use Retry above.
          </p>
        ) : (
          <Tabs defaultValue="duplicates">
            {/* Seven-tab strip: flex-wrap overrides fixed-height default to prevent clipping. */}
            <TabsList className="flex flex-wrap h-auto gap-1 mb-3">
              <TabsTrigger value="duplicates">Duplicates ({badge(c?.duplicate)})</TabsTrigger>
              <TabsTrigger value="nullbytes">Null Bytes ({badge(c?.nullByte)})</TabsTrigger>
              <TabsTrigger value="geo">Geo ({badge(c?.geo)})</TabsTrigger>
              <TabsTrigger value="srcmismatch">Src Mismatch ({badge(c?.sourceMismatch)})</TabsTrigger>
              <TabsTrigger value="contradictions">Contradictions ({badge(c?.contradiction)})</TabsTrigger>
              <TabsTrigger value="suspicious">Suspicious ({badge(c?.suspicious)})</TabsTrigger>
              <TabsTrigger value="sparse">Sparse Fields</TabsTrigger>
              <TabsTrigger value="anomalies">Anomaly Alerts ({loading ? '…' : anomalyAlerts.length})</TabsTrigger>
            </TabsList>

            {/* AC2 — Duplicates */}
            <TabsContent value="duplicates">
              {loading ? <Skeletons /> : listErrors?.duplicates ? <TabError /> :
               duplicates.length === 0 ? (
                 c?.duplicate === 0
                   ? <CleanMsg msg="No duplicate facility IDs found — clean on this check." />
                   : <NoRows count={c?.duplicate} />
               ) : (
                 <>
                   <Cap>
                     Same <code>facility_id</code> appears more than once. Showing first 200 duplicated IDs.
                     NULL facility_id rows appear under critical-field completeness, not here.
                   </Cap>
                   <table className="w-full text-xs">
                     <thead><tr className="border-b border-border/60 text-left">
                       <th className="pb-1.5 pr-3 font-medium text-muted-foreground">ID</th>
                       <th className="pb-1.5 pr-3 font-medium text-muted-foreground">Sample Name</th>
                       <th className="pb-1.5 font-medium text-muted-foreground">Count</th>
                     </tr></thead>
                     <tbody>
                       {duplicates.map(r => (
                         <tr key={r.facility_id} className="border-b border-border/40 last:border-0">
                           <td className="py-1 pr-3 tabular-nums text-muted-foreground">{r.facility_id}</td>
                           <td className="py-1 pr-3 text-foreground">{safeStr(r.sample_name)}</td>
                           <td className="py-1 tabular-nums font-medium">{r.dup_count}</td>
                         </tr>
                       ))}
                     </tbody>
                   </table>
                 </>
               )}
            </TabsContent>

            {/* AC3 — Null Bytes */}
            <TabsContent value="nullbytes">
              {loading ? <Skeletons /> : listErrors?.nullBytes ? <TabError /> :
               nullBytes.length === 0 ? (
                 c?.nullByte === 0
                   ? <CleanMsg msg="No null-byte corruption found — clean on this check." />
                   : <NoRows count={c?.nullByte} />
               ) : (
                 <>
                   <Cap>Rows containing a NUL byte (0x00) in <code>name</code> or <code>description</code> — corrupt text. Showing first 200.</Cap>
                   <table className="w-full text-xs">
                     <thead><tr className="border-b border-border/60 text-left">
                       <th className="pb-1.5 pr-3 font-medium text-muted-foreground">ID</th>
                       <th className="pb-1.5 pr-3 font-medium text-muted-foreground">Name</th>
                       <th className="pb-1.5 font-medium text-muted-foreground">State</th>
                     </tr></thead>
                     <tbody>
                       {nullBytes.map(r => (
                         <tr key={r.facility_id} className="border-b border-border/40 last:border-0">
                           <td className="py-1 pr-3 tabular-nums text-muted-foreground">{r.facility_id}</td>
                           <td className="py-1 pr-3 text-foreground max-w-[200px] truncate">{safeStr(r.name)}</td>
                           <td className="py-1 text-muted-foreground">{safeStr(r.state)}</td>
                         </tr>
                       ))}
                     </tbody>
                   </table>
                 </>
               )}
            </TabsContent>

            {/* AC4 — Geo Contradictions */}
            <TabsContent value="geo">
              {loading ? <Skeletons /> : listErrors?.geoContradictions ? <TabError /> :
               geoContradictions.length === 0 ? (
                 c?.geo === 0
                   ? <CleanMsg msg="No geo contradictions found — clean on this check." />
                   : <NoRows count={c?.geo} />
               ) : (
                 <>
                   <Cap>City is populated but latitude/longitude is missing or a (0,0) placeholder. Showing first 200.</Cap>
                   <table className="w-full text-xs">
                     <thead><tr className="border-b border-border/60 text-left">
                       <th className="pb-1.5 pr-3 font-medium text-muted-foreground">Name</th>
                       <th className="pb-1.5 pr-3 font-medium text-muted-foreground">City</th>
                       <th className="pb-1.5 font-medium text-muted-foreground">State</th>
                     </tr></thead>
                     <tbody>
                       {geoContradictions.map(r => (
                         <tr key={r.facility_id} className="border-b border-border/40 last:border-0">
                           <td className="py-1 pr-3 text-foreground max-w-[160px] truncate">{safeStr(r.name)}</td>
                           <td className="py-1 pr-3 text-muted-foreground">{safeStr(r.address_city)}</td>
                           <td className="py-1 text-muted-foreground">{safeStr(r.state)}</td>
                         </tr>
                       ))}
                     </tbody>
                   </table>
                 </>
               )}
            </TabsContent>

            {/* AC5 — Source Mismatch */}
            <TabsContent value="srcmismatch">
              {loading ? <Skeletons /> : listErrors?.sourceMismatch ? <TabError /> :
               sourceMismatch.length === 0 ? (
                 c?.sourceMismatch === 0
                   ? <CleanMsg msg="No source count mismatches found — clean on this check." />
                   : <NoRows count={c?.sourceMismatch} />
               ) : (
                 <>
                   <Cap>
                     <code>source_types</code> element count ≠ <code>source_ids</code> element count
                     (comma-delimited; empty = 0 elements). Showing first 200.
                   </Cap>
                   <table className="w-full text-xs">
                     <thead><tr className="border-b border-border/60 text-left">
                       <th className="pb-1.5 pr-3 font-medium text-muted-foreground">Name</th>
                       <th className="pb-1.5 pr-3 font-medium text-muted-foreground">Source Types</th>
                       <th className="pb-1.5 font-medium text-muted-foreground">Source IDs</th>
                     </tr></thead>
                     <tbody>
                       {sourceMismatch.map(r => (
                         <tr key={r.facility_id} className="border-b border-border/40 last:border-0">
                           <td className="py-1 pr-3 text-foreground max-w-[140px] truncate">{safeStr(r.name)}</td>
                           <td className="py-1 pr-3 text-muted-foreground max-w-[120px] truncate">{safeStr(r.source_types)}</td>
                           <td className="py-1 text-muted-foreground max-w-[120px] truncate">{safeStr(r.source_ids)}</td>
                         </tr>
                       ))}
                     </tbody>
                   </table>
                 </>
               )}
            </TabsContent>

            {/* Contradictions (value-add) */}
            <TabsContent value="contradictions">
              {loading ? <Skeletons /> : listErrors?.contradictions ? <TabError /> :
               contradictions.length === 0 ? (
                 c?.contradiction === 0
                   ? <CleanMsg msg="No capability contradictions found — clean on this check." />
                   : <NoRows count={c?.contradiction} />
               ) : (
                 <>
                   <Cap>Capability claimed with no equipment or specialties data. Showing first 200.</Cap>
                   <table className="w-full text-xs">
                     <thead><tr className="border-b border-border/60 text-left">
                       <th className="pb-1.5 pr-3 font-medium text-muted-foreground">Name</th>
                       <th className="pb-1.5 pr-3 font-medium text-muted-foreground">Capability</th>
                       <th className="pb-1.5 font-medium text-muted-foreground">State</th>
                     </tr></thead>
                     <tbody>
                       {contradictions.map(r => (
                         <tr key={r.facility_id} className="border-b border-border/40 last:border-0">
                           <td className="py-1 pr-3 text-foreground max-w-[160px] truncate">{safeStr(r.name)}</td>
                           <td className="py-1 pr-3 text-muted-foreground max-w-[130px] truncate">{safeStr(r.capability)}</td>
                           <td className="py-1 text-muted-foreground">{safeStr(r.state)}</td>
                         </tr>
                       ))}
                     </tbody>
                   </table>
                 </>
               )}
            </TabsContent>

            {/* Suspicious (value-add, HEAVY signal) */}
            <TabsContent value="suspicious">
              {loading ? <Skeletons /> : listErrors?.suspicious ? <TabError /> :
               suspicious.length === 0 ? (
                 c?.suspicious === 0
                   ? <CleanMsg msg="No suspicious records found — clean on this check." />
                   : <NoRows count={c?.suspicious} />
               ) : (
                 <>
                   <Cap>
                     Capability claimed with no source evidence. Showing first 200.
                     These rows count as a serious/heavy signal and are included in the Flagged KPI.
                   </Cap>
                   <table className="w-full text-xs">
                     <thead><tr className="border-b border-border/60 text-left">
                       <th className="pb-1.5 pr-3 font-medium text-muted-foreground">Name</th>
                       <th className="pb-1.5 pr-3 font-medium text-muted-foreground">Capability</th>
                       <th className="pb-1.5 font-medium text-muted-foreground">State</th>
                     </tr></thead>
                     <tbody>
                       {suspicious.map(r => (
                         <tr key={r.facility_id} className="border-b border-border/40 last:border-0">
                           <td className="py-1 pr-3 text-foreground max-w-[160px] truncate">{safeStr(r.name)}</td>
                           <td className="py-1 pr-3 text-muted-foreground max-w-[130px] truncate">{safeStr(r.capability)}</td>
                           <td className="py-1 text-muted-foreground">{safeStr(r.state)}</td>
                         </tr>
                       ))}
                     </tbody>
                   </table>
                 </>
               )}
            </TabsContent>

            {/* Sparse Fields */}
            <TabsContent value="sparse">
              {loading ? <Skeletons /> : sparseFields.length === 0 ? (
                <CleanMsg msg="All profiled columns are ≥50% filled." />
              ) : (
                <>
                  <Cap>
                    Columns below 50% fill rate. Note: Latitude/Longitude sparsity here is the same
                    root cause as the Geo Contradictions tab — not a separate problem.
                  </Cap>
                  <div className="space-y-2.5">
                    {sparseFields.map(f => (
                      <div key={f.key}>
                        <div className="text-xs text-muted-foreground mb-1">{f.label}</div>
                        <PctBar value={f.fillRate} />
                      </div>
                    ))}
                  </div>
                </>
              )}
            </TabsContent>
            {/* Anomaly Alerts (gold layer) */}
            <TabsContent value="anomalies">
              {loading ? <Skeletons /> : anomalyAlerts.length === 0 ? (
                <CleanMsg msg="No anomaly alerts from the gold layer." />
              ) : (
                <>
                  <Cap>Facility-level anomalies detected by the gold scoring pipeline. HIGH severity alerts warrant immediate review.</Cap>
                  <table className="w-full text-xs">
                    <thead><tr className="border-b border-border/60 text-left">
                      <th className="pb-1.5 pr-3 font-medium text-muted-foreground">Facility</th>
                      <th className="pb-1.5 pr-3 font-medium text-muted-foreground">Alert Type</th>
                      <th className="pb-1.5 pr-3 font-medium text-muted-foreground">Severity</th>
                      <th className="pb-1.5 pr-3 font-medium text-muted-foreground">Description</th>
                      <th className="pb-1.5 font-medium text-muted-foreground">Date</th>
                    </tr></thead>
                    <tbody>
                      {anomalyAlerts.map((a, i) => (
                        <tr key={`${a.facility_id}-${i}`} className="border-b border-border/40 last:border-0">
                          <td className="py-1.5 pr-3 text-foreground max-w-[140px] truncate">{safeStr(a.facility_name)}</td>
                          <td className="py-1.5 pr-3 text-muted-foreground max-w-[100px] truncate">{safeStr(a.alert_type)}</td>
                          <td className="py-1.5 pr-3">
                            {a.severity ? (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${SEVERITY_CLASS[a.severity.toUpperCase()] ?? 'bg-muted text-muted-foreground border-border'}`}>
                                {a.severity}
                              </span>
                            ) : '—'}
                          </td>
                          <td className="py-1.5 pr-3 text-muted-foreground max-w-[200px] truncate">{safeStr(a.description)}</td>
                          <td className="py-1.5 text-muted-foreground whitespace-nowrap">{safeStr(a.detected_date)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
}
