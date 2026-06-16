import { useState } from 'react';
import { AlertCircle, Info } from 'lucide-react';
import { Skeleton } from '@databricks/appkit-ui/react';
import { DesertKpiBar } from './DesertKpiBar';
import { DesertControls } from './DesertControls';
import { DesertMap } from './DesertMap';
import { DesertDetailPanel } from './DesertDetailPanel';
import { useStateGaps, useCapabilitySummary } from './useDesertData';
import type { StateGap } from './types';

const GAP_LEGEND = [
  { label: '< 10', desc: 'Low', color: '#86efac' },
  { label: '10–25', desc: 'Moderate', color: '#fbbf24' },
  { label: '25–50', desc: 'High', color: '#f97316' },
  { label: '50–100', desc: 'Severe', color: '#ef4444' },
  { label: '100+', desc: 'Critical', color: '#7f1d1d' },
];

export function DesertPage() {
  const [capabilityFilter, setCapabilityFilter] = useState('');
  const [showConfidenceFilter, setShowConfidenceFilter] = useState(false);
  const [selectedGap, setSelectedGap] = useState<StateGap | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const { gaps, loading: gapsLoading, error: gapsError, syncing: gapsSyncing } = useStateGaps(capabilityFilter);
  const { summary } = useCapabilitySummary();

  const isSyncing = gapsSyncing;

  function handleStateSelect(gap: StateGap) {
    setSelectedGap(gap);
    setPanelOpen(true);
  }

  return (
    <div className="flex flex-col gap-5 h-full">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Medical Desert Planner</h2>
        <p className="text-muted-foreground mt-1">
          Where are the highest-risk care gaps in India — and how confident are we those gaps are real?
        </p>
      </div>

      {gapsError && (
        <div className="flex items-center gap-2 text-destructive bg-destructive/10 px-4 py-3 rounded-lg">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm">{gapsError}</span>
        </div>
      )}

      {isSyncing && !gapsError && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg border bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/40 dark:border-amber-800/50 dark:text-amber-300">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm">Data syncing… chart will appear once the sync is complete.</span>
        </div>
      )}

      <DesertKpiBar gaps={gaps} loading={gapsLoading} />

      {/* Data limitation disclosure */}
      <div className="flex gap-2 text-xs rounded-md px-3 py-2 border bg-blue-50 border-blue-100 text-blue-800 dark:bg-blue-950/30 dark:border-blue-800/40 dark:text-blue-300">
        <Info className="h-4 w-4 shrink-0 mt-0.5 text-blue-500 dark:text-blue-400" />
        <span>
          Facility counts are aggregated at the state level. Gap scores reflect state-wide
          supply vs. demand and do not resolve within-state distribution. Click any bar
          for details.
        </span>
      </div>

      <DesertControls
        capability={capabilityFilter}
        onCapabilityChange={setCapabilityFilter}
        summary={summary}
        showConfidenceFilter={showConfidenceFilter}
        onToggleConfidenceFilter={() => setShowConfidenceFilter((v) => !v)}
      />

      {/* Gap score legend */}
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-xs text-muted-foreground mr-1">Gap score:</span>
        {GAP_LEGEND.map(({ label, desc, color }) => (
          <div key={label} className="flex items-center gap-1 text-xs">
            <div className="w-3 h-3 rounded-sm shrink-0" style={{ background: color }} />
            <span className="text-muted-foreground">{label}</span>
            <span className="font-medium text-foreground">{desc}</span>
            {label !== '100+' && <span className="text-border mx-0.5">·</span>}
          </div>
        ))}
      </div>

      {/* Gap score bar chart */}
      <div className="relative rounded-lg border border-border/60 shadow-sm overflow-hidden bg-card"
           style={{ height: 'calc(100vh - 430px)', minHeight: '400px' }}>
        {gapsLoading ? (
          <Skeleton className="w-full h-full rounded-none" />
        ) : (
          <DesertMap
            gaps={gaps}
            showConfidenceFilter={showConfidenceFilter}
            onStateSelect={handleStateSelect}
          />
        )}
      </div>

      <DesertDetailPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        gap={selectedGap}
      />
    </div>
  );
}
