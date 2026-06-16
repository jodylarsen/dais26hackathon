export interface StateGap {
  state: string;
  facility_count: number;
  avg_trust_weight: number;
  source_type_variants: number;
  demand_index: number | null;
  district_count: number | null;
  supply_score: number;
  gap_score: number;
  confidence: 'high' | 'medium' | 'low';
  avg_electricity: number | null;
  avg_water: number | null;
  avg_sanitation: number | null;
  avg_birth_reg: number | null;
}

export interface HeatmapPoint {
  facility_id: number;
  latitude: number;
  longitude: number;
  trust_weight: number;
  capability: string | null;
  address_stateorregion: string | null;
}

export interface CapabilitySummaryItem {
  capability: string;
  facility_count: number;
  avg_trust_weight: number;
  state_count: number;
}

export interface StateGapsResponse {
  gaps: StateGap[];
  syncing?: boolean;
}

export interface HeatmapPointsResponse {
  points: HeatmapPoint[];
  syncing?: boolean;
}

export interface CapabilitySummaryResponse {
  summary: CapabilitySummaryItem[];
  syncing?: boolean;
}
