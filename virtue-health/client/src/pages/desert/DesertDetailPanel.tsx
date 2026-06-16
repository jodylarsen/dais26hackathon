import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@databricks/appkit-ui/react';
import { useIsMobile } from '@databricks/appkit-ui/react';
import { Building2, TrendingUp, AlertCircle } from 'lucide-react';
import type { StateGap } from './types';

function PctBar({ value, label }: { value: number | null; label: string }) {
  const pct = value ?? 0;
  const color =
    pct >= 75 ? 'bg-green-500' : pct >= 50 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{value != null ? `${pct.toFixed(1)}%` : '—'}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const CONFIDENCE_COLOR: Record<string, string> = {
  high: 'bg-green-100 text-green-800 border-green-200',
  medium: 'bg-amber-100 text-amber-800 border-amber-200',
  low: 'bg-gray-100 text-gray-600 border-gray-200',
};

interface DesertDetailPanelProps {
  open: boolean;
  onClose: () => void;
  gap: StateGap | null;
}

export function DesertDetailPanel({ open, onClose, gap }: DesertDetailPanelProps) {
  const isMobile = useIsMobile();

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side={isMobile ? 'bottom' : 'right'} className="w-full sm:w-[420px] overflow-y-auto">
        {gap ? (
          <>
            <SheetHeader>
              <SheetTitle>{gap.state}</SheetTitle>
            </SheetHeader>

            <div className="mt-4 space-y-5">
              {/* Gap score */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Care gap score</span>
                <span
                  className="text-2xl font-bold"
                  style={{
                    color:
                      gap.gap_score > 100 ? '#7f1d1d'
                      : gap.gap_score > 50  ? '#ef4444'
                      : gap.gap_score > 25  ? '#f97316'
                      : '#16a34a',
                  }}
                >
                  {gap.gap_score.toFixed(1)}
                </span>
              </div>

              {/* Confidence badge */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Data confidence</span>
                <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${CONFIDENCE_COLOR[gap.confidence]}`}>
                  {gap.confidence.charAt(0).toUpperCase() + gap.confidence.slice(1)}
                </span>
              </div>

              {/* Supply vs demand */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-muted/40 rounded-lg p-3 text-center">
                  <Building2 className="h-4 w-4 mx-auto mb-1 text-muted-foreground" />
                  <div className="text-xl font-bold">{gap.facility_count.toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">Facilities (state)</div>
                </div>
                <div className="bg-muted/40 rounded-lg p-3 text-center">
                  <TrendingUp className="h-4 w-4 mx-auto mb-1 text-muted-foreground" />
                  <div className="text-xl font-bold">
                    {gap.demand_index != null ? gap.demand_index.toFixed(0) : '—'}
                  </div>
                  <div className="text-xs text-muted-foreground">Demand index</div>
                </div>
              </div>

              {/* Trust weight */}
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Avg trust score (gold model)</span>
                  <span className="font-medium">{(gap.avg_trust_weight * 10).toFixed(1)} / 10</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-blue-500"
                    style={{ width: `${gap.avg_trust_weight * 100}%` }}
                  />
                </div>
              </div>

              {/* NFHS-5 indicators */}
              {gap.demand_index != null && (
                <div className="space-y-3">
                  <div className="text-sm font-medium">NFHS-5 Indicators (state avg)</div>
                  <PctBar value={gap.avg_electricity} label="Electricity access" />
                  <PctBar value={gap.avg_water} label="Improved water source" />
                  <PctBar value={gap.avg_sanitation} label="Improved sanitation" />
                  <PctBar value={gap.avg_birth_reg} label="Birth registration" />
                  <p className="text-xs text-muted-foreground">
                    Averaged across NFHS-5 districts. Full breakdown on the Districts page.
                  </p>
                </div>
              )}

              {/* Districts covered */}
              {gap.district_count != null && (
                <div className="text-sm text-muted-foreground">
                  {gap.district_count} district{gap.district_count !== 1 ? 's' : ''} in NFHS-5 data
                </div>
              )}

              {/* Limitation note */}
              <div className="flex gap-2 text-xs text-muted-foreground bg-muted/30 rounded-md p-3">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" />
                <span>
                  Facility counts are state-level totals — district-level distribution within this
                  state is not yet resolved.
                </span>
              </div>
            </div>
          </>
        ) : (
          <SheetHeader>
            <SheetTitle>Select a state</SheetTitle>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  );
}
