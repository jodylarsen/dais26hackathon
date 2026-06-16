import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Button,
} from '@databricks/appkit-ui/react';
import { Layers } from 'lucide-react';
import type { CapabilitySummaryItem } from './types';

interface DesertControlsProps {
  capability: string;
  onCapabilityChange: (v: string) => void;
  summary: CapabilitySummaryItem[];
  showConfidenceFilter: boolean;
  onToggleConfidenceFilter: () => void;
}

export function DesertControls({
  capability,
  onCapabilityChange,
  summary,
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

      <Button
        variant={showConfidenceFilter ? 'default' : 'outline'}
        size="sm"
        onClick={onToggleConfidenceFilter}
        className="ml-auto text-xs"
      >
        High confidence only
      </Button>
    </div>
  );
}
