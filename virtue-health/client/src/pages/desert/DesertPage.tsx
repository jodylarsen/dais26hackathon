import { useState } from 'react';
import { AlertCircle, Info } from 'lucide-react';
import { Skeleton } from '@databricks/appkit-ui/react';
import { DesertKpiBar } from './DesertKpiBar';
import { DesertControls } from './DesertControls';
import { DesertMap } from './DesertMap';
import { DesertDetailPanel } from './DesertDetailPanel';
import { useStateGaps, useCapabilitySummary } from './useDesertData';
import type { StateGap } from './types';

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
        <div className="flex items-center gap-2 text-amber-700 bg-amber-50 border border-amber-200 px-4 py-3 rounded-lg">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm">Data syncing… map will appear once the sync is complete.</span>
        </div>
      )}

      <DesertKpiBar gaps={gaps} loading={gapsLoading} />

      {/* Data limitation disclosure */}
      <div className="flex gap-2 text-xs text-muted-foreground bg-blue-50 border border-blue-100 rounded-md px-3 py-2">
        <Info className="h-4 w-4 shrink-0 mt-0.5 text-blue-500" />
        <span>
          Facility counts are aggregated at the state level. Gap scores reflect state-wide
          supply vs. demand and do not resolve within-state distribution. Click any state
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

      {/* Gap score bar chart */}
      <div className="relative rounded-lg border border-border/60 shadow-sm overflow-hidden bg-white"
           style={{ height: 'calc(100vh - 380px)', minHeight: '400px' }}>
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
