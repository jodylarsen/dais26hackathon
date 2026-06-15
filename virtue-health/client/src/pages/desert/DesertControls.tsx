import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Button,
} from '@databricks/appkit-ui/react';
import { Layers, Thermometer, Map } from 'lucide-react';
import type { CapabilitySummaryItem } from './types';

interface DesertControlsProps {
  capability: string;
  onCapabilityChange: (v: string) => void;
  summary: CapabilitySummaryItem[];
  showHeatmap: boolean;
  onToggleHeatmap: () => void;
  showChoropleth: boolean;
  onToggleChoropleth: () => void;
  showConfidenceFilter: boolean;
  onToggleConfidenceFilter: () => void;
}

export function DesertControls({
  capability,
  onCapabilityChange,
  summary,
  showHeatmap,
  onToggleHeatmap,
  showChoropleth,
  onToggleChoropleth,
  showConfidenceFilter,
  onToggleConfidenceFilter,
}: DesertControlsProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground shrink-0">
        <Layers className="h-4 w-4" />
        <span>Filters:</span>
      </div>

      <Select
        value={capability || '_all'}
        onValueChange={(v) => onCapabilityChange(v === '_all' ? '' : v)}
      >
        <SelectTrigger className="w-48">
          <SelectValue placeholder="All capabilities" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="_all">All capabilities</SelectItem>
          {summary.map((s) => (
            <SelectItem key={s.capability} value={s.capability}>
              {s.capability}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex items-center gap-2 ml-auto flex-wrap">
        <Button
          variant={showChoropleth ? 'default' : 'outline'}
          size="sm"
          onClick={onToggleChoropleth}
          className="gap-1.5"
        >
          <Map className="h-3.5 w-3.5" />
          Gap map
        </Button>
        <Button
          variant={showHeatmap ? 'default' : 'outline'}
          size="sm"
          onClick={onToggleHeatmap}
          className="gap-1.5"
        >
          <Thermometer className="h-3.5 w-3.5" />
          Supply density
        </Button>
        <Button
          variant={showConfidenceFilter ? 'default' : 'outline'}
          size="sm"
          onClick={onToggleConfidenceFilter}
          className="text-xs"
        >
          High confidence only
        </Button>
      </div>
    </div>
  );
}
