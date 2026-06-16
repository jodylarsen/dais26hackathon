import { Card, CardContent, CardHeader, CardTitle, Skeleton } from '@databricks/appkit-ui/react';
import type { TopRecord } from './types';
import { scoreColor } from './scoreColor';

function safeStr(v: unknown, fallback = '—'): string {
  if (v == null) return fallback;
  if (typeof v === 'string') return v || fallback;
  if (Array.isArray(v)) return v.map(String).join(', ') || fallback;
  return JSON.stringify(v);
}

export function ReadinessTopRecords({
  records, loading,
}: {
  records: TopRecord[];
  loading: boolean;
}) {
  return (
    <Card className="shadow-sm border border-border/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Top 50 Records for Human Review</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        ) : records.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No records currently flagged for review — all facilities pass the heavy-signal checks
            (null-byte, geo, source-mismatch, contradiction, suspicious).
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground mb-3">
              Ranked by serious-issue signals first, then completeness gaps. Rows may repeat where{' '}
              <code>facility_id</code> is duplicated — see the Duplicates tab.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/60 text-left">
                    <th className="pb-2 pr-3 font-medium text-muted-foreground">Name</th>
                    <th className="pb-2 pr-3 font-medium text-muted-foreground">State</th>
                    <th className="pb-2 pr-3 font-medium text-muted-foreground">Score</th>
                    <th className="pb-2 pr-3 font-medium text-muted-foreground">Capability</th>
                    <th className="pb-2 font-medium text-muted-foreground">Source Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map(rec => {
                    const srcRaw = String(rec.source_types ?? '').trim();
                    const srcDisplay = srcRaw || 'None';
                    const srcIsNone = !srcRaw;
                    return (
                      <tr
                        key={`${rec.facility_id}-${rec.name ?? ''}-${rec.address_city ?? ''}`}
                        className="border-b border-border/40 last:border-0"
                      >
                        <td className="py-1.5 pr-3 max-w-[180px] truncate text-foreground">
                          {safeStr(rec.name)}
                        </td>
                        <td className="py-1.5 pr-3 text-muted-foreground">
                          {safeStr(rec.state)}
                        </td>
                        <td className="py-1.5 pr-3">
                          <span className="font-semibold" style={{ color: scoreColor(rec.heavy_score) }}>
                            {rec.issue_score}
                          </span>
                        </td>
                        <td className="py-1.5 pr-3 max-w-[140px] truncate text-muted-foreground">
                          {safeStr(rec.capability)}
                        </td>
                        <td className="py-1.5">
                          {srcIsNone ? (
                            <span style={{ color: '#dc2626' }}>None</span>
                          ) : (
                            <span className="text-muted-foreground truncate max-w-[120px] block">
                              {srcDisplay}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
