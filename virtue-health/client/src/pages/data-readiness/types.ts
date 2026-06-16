export interface FieldProfile {
  key: string;
  label: string;
  filled: number;
  fillRate: number; // 0–1 fraction
  critical: boolean;
}

export interface Duplicate {
  facility_id: number;
  dup_count: number;
  sample_name: string | null;
}

export interface NullByteRecord {
  facility_id: number;
  name: string | null;
  description: string | null;
  address_stateorregion: string | null;
}

export interface GeoContradiction {
  facility_id: number;
  name: string | null;
  address_city: string | null;
  address_stateorregion: string | null;
}

export interface SourceMismatch {
  facility_id: number;
  name: string | null;
  source_types: string | null;
  source_ids: string | null;
}

export interface Issue {
  facility_id: number;
  name: string | null;
  capability: string | null;
  address_stateorregion: string | null;
}

export interface SparseField {
  key: string;
  label: string;
  fillRate: number; // 0–1 fraction
}

export interface TopRecord {
  facility_id: number;
  name: string | null;
  address_city: string | null;
  address_stateorregion: string | null;
  capability: string | null;
  source_types: string | null;
  source_ids: string | null;
  issue_score: number;
  heavy_score: number;
}

export interface IssueCounts {
  duplicate: number;
  duplicateRows: number;
  nullByte: number;
  geo: number;
  sourceMismatch: number;
  contradiction: number;
  suspicious: number;
  total: number;
}

export interface ListErrors {
  duplicates: boolean;
  nullBytes: boolean;
  geoContradictions: boolean;
  sourceMismatch: boolean;
  contradictions: boolean;
  suspicious: boolean;
}
