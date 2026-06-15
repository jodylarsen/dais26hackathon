import { useEffect, useState } from 'react';
import type {
  StateGap,
  HeatmapPoint,
  CapabilitySummaryItem,
  StateGapsResponse,
  HeatmapPointsResponse,
  CapabilitySummaryResponse,
} from './types';

export function useStateGaps(capability: string) {
  const [gaps, setGaps] = useState<StateGap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (capability) params.set('capability', capability);

    fetch(`/api/desert/state-gaps?${params.toString()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<StateGapsResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        if (data.syncing) { setSyncing(true); setLoading(false); return; }
        setSyncing(false);
        setGaps(data.gaps ?? []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load state gaps');
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [capability]);

  return { gaps, loading, error, syncing };
}

export function useHeatmapPoints(capability: string) {
  const [points, setPoints] = useState<HeatmapPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (capability) params.set('capability', capability);

    fetch(`/api/desert/heatmap-points?${params.toString()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<HeatmapPointsResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        if (data.syncing) { setSyncing(true); setLoading(false); return; }
        setSyncing(false);
        setPoints(data.points ?? []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load heatmap points');
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [capability]);

  return { points, loading, error, syncing };
}

export function useCapabilitySummary() {
  const [summary, setSummary] = useState<CapabilitySummaryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/desert/capability-summary')
      .then((r) => r.json() as Promise<CapabilitySummaryResponse>)
      .then((data) => {
        if (cancelled) return;
        if (data.syncing) { setSyncing(true); setLoading(false); return; }
        setSyncing(false);
        setSummary(data.summary ?? []);
        setLoading(false);
      })
      .catch(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, []);

  return { summary, loading, syncing };
}
