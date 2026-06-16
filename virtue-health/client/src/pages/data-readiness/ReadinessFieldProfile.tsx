import { Card, CardContent, CardHeader, CardTitle, Badge, Skeleton } from '@databricks/appkit-ui/react';
import type { FieldProfile } from './types';
import { PctBar } from './PctBar';

export function ReadinessFieldProfile({
  profile, total, loading,
}: {
  profile: FieldProfile[];
  total: number;
  loading: boolean;
}) {
  const isEmpty = !loading && total === 0;
  const sorted = [...profile].sort((a, b) => a.fillRate - b.fillRate);

  return (
    <Card className="shadow-sm border border-border/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Field Completeness</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : isEmpty ? (
          <p className="text-sm text-muted-foreground">
            No data to profile — the <code>facilities</code> table returned 0 rows.
          </p>
        ) : (
          <div className="space-y-2.5">
            {sorted.map(f => (
              <div key={f.key}>
                <div className="flex items-center gap-1.5 mb-1">
                  <span className={`text-xs ${f.critical ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                    {f.label}
                  </span>
                  {f.critical && (
                    <Badge variant="secondary" className="text-xs font-normal px-1 py-0 h-4">
                      Critical
                    </Badge>
                  )}
                </div>
                <PctBar value={f.fillRate} />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
