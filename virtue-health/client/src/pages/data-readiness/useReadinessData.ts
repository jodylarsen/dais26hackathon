import { useEffect, useState } from 'react';
import type {
  FieldProfile, Duplicate, NullByteRecord, GeoContradiction,
  SourceMismatch, Issue, SparseField, TopRecord, IssueCounts, ListErrors, AnomalyAlert,
} from './types';

export function useReadinessProfile(reloadKey: number) {
  const [profile, setProfile] = useState<FieldProfile[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/readiness/profile')
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then(data => {
        if (cancelled) return;
        // Mirrors useDesertData: syncing guard kept intentionally (inert today, graceful later).
        if (data.syncing) { setSyncing(true); setLoading(false); return; }
        setSyncing(false);
        setProfile(data.profile ?? []);
        setTotal(data.total ?? 0);
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load profile'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  return { profile, total, loading, error, syncing };
}

export function useReadinessIssues(reloadKey: number) {
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const [nullBytes, setNullBytes] = useState<NullByteRecord[]>([]);
  const [geoContradictions, setGeoContradictions] = useState<GeoContradiction[]>([]);
  const [sourceMismatch, setSourceMismatch] = useState<SourceMismatch[]>([]);
  const [contradictions, setContradictions] = useState<Issue[]>([]);
  const [suspicious, setSuspicious] = useState<Issue[]>([]);
  const [anomalyAlerts, setAnomalyAlerts] = useState<AnomalyAlert[]>([]);
  const [sparseFields, setSparseFields] = useState<SparseField[]>([]);
  const [issueCounts, setIssueCounts] = useState<IssueCounts | null>(null);
  const [listErrors, setListErrors] = useState<ListErrors | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/readiness/issues')
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then(data => {
        if (cancelled) return;
        if (data.syncing) { setSyncing(true); setLoading(false); return; }
        setSyncing(false);
        setDuplicates(data.duplicates ?? []);
        setNullBytes(data.nullBytes ?? []);
        setGeoContradictions(data.geoContradictions ?? []);
        setSourceMismatch(data.sourceMismatch ?? []);
        setContradictions(data.contradictions ?? []);
        setSuspicious(data.suspicious ?? []);
        setAnomalyAlerts(data.anomalyAlerts ?? []);
        setSparseFields(data.sparseFields ?? []);
        setIssueCounts(data.issueCounts ?? null);
        setListErrors(data.listErrors ?? null);
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load issues'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  return { duplicates, nullBytes, geoContradictions, sourceMismatch, contradictions, suspicious, anomalyAlerts, sparseFields, issueCounts, listErrors, loading, error, syncing };
}

export function useTopRecords(reloadKey: number) {
  const [records, setRecords] = useState<TopRecord[]>([]);
  const [flaggedTotal, setFlaggedTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/readiness/top-records')
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then(data => {
        if (cancelled) return;
        if (data.syncing) { setSyncing(true); setLoading(false); return; }
        setSyncing(false);
        setRecords(data.records ?? []);
        setFlaggedTotal(data.flaggedTotal ?? 0);
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load top records'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  return { records, flaggedTotal, loading, error, syncing };
}
