import { lazy, Suspense, useState } from 'react';
import { AlertCircle, Info } from 'lucide-react';
import { Skeleton } from '@databricks/appkit-ui/react';
import { DesertKpiBar } from './DesertKpiBar';
import { DesertControls } from './DesertControls';
import { DesertDetailPanel } from './DesertDetailPanel';
import { useStateGaps, useHeatmapPoints, useCapabilitySummary } from './useDesertData';
import type { StateGap } from './types';

// Lazy-load the map so the ~850 KB maplibre-gl chunk is only downloaded
// when the user visits /desert, not on initial app load.
const DesertMap = lazy(() =>
  import('./DesertMap').then((m) => ({ default: m.DesertMap })),
);

export function DesertPage() {
  const [capabilityFilter, setCapabilityFilter] = useState('');
  const [showConfidenceFilter, setShowConfidenceFilter] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [selectedGap, setSelectedGap] = useState<StateGap | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const { gaps, loading: gapsLoading, error: gapsError, syncing: gapsSyncing } = useStateGaps(capabilityFilter);
  const { points, loading: pointsLoading } = useHeatmapPoints(showHeatmap ? capabilityFilter : '__skip__');
  const { summary } = useCapabilitySummary();

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

      {gapsSyncing && !gapsError && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg border bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/40 dark:border-amber-800/50 dark:text-amber-300">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm">Data syncing… map will appear once the sync is complete.</span>
        </div>
      )}

      <DesertKpiBar gaps={gaps} loading={gapsLoading} />

      {/* Data limitation disclosure */}
      <div className="flex gap-2 text-xs rounded-md px-3 py-2 border bg-blue-50 border-blue-100 text-blue-800 dark:bg-blue-950/30 dark:border-blue-800/40 dark:text-blue-300">
        <Info className="h-4 w-4 shrink-0 mt-0.5 text-blue-500 dark:text-blue-400" />
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
        showHeatmap={showHeatmap}
        onToggleHeatmap={() => setShowHeatmap((v) => !v)}
        heatmapLoading={showHeatmap && pointsLoading}
      />

      {/* Map */}
      <div
        className="relative rounded-lg border border-border/60 shadow-sm overflow-hidden bg-card"
        style={{ height: 'calc(100vh - 400px)', minHeight: '420px' }}
      >
        {gapsLoading ? (
          <Skeleton className="w-full h-full rounded-none" />
        ) : (
          <Suspense fallback={<Skeleton className="w-full h-full rounded-none" />}>
            <DesertMap
              gaps={gaps}
              points={showHeatmap ? points : []}
              showHeatmap={showHeatmap}
              showConfidenceFilter={showConfidenceFilter}
              onStateSelect={handleStateSelect}
            />
          </Suspense>
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
