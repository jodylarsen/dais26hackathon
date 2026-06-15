import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import ReactMap, { Source, Layer } from 'react-map-gl/maplibre';
import type { MapLayerMouseEvent, MapRef } from 'react-map-gl/maplibre';
import type { HeatmapPoint, StateGap } from './types';
import { DesertLegend } from './DesertLegend';

// Normalize a state name to a lowercase alphanumeric key for fuzzy matching.
// Replaces "&" with "and", strips punctuation, lowercases.
function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

interface GeoJsonFeature {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
}

interface GeoJsonCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

interface DesertMapProps {
  points: HeatmapPoint[];
  gaps: StateGap[];
  showHeatmap: boolean;
  showChoropleth: boolean;
  showConfidenceFilter: boolean;
  onStateSelect: (gap: StateGap) => void;
}

const INDIA_CENTER = { longitude: 82.5, latitude: 22.0, zoom: 4 } as const;
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

export function DesertMap({
  points,
  gaps,
  showHeatmap,
  showChoropleth,
  showConfidenceFilter,
  onStateSelect,
}: DesertMapProps) {
  const mapRef = useRef<MapRef>(null);
  const [stateGeoJson, setStateGeoJson] = useState<GeoJsonCollection | null>(null);
  const [geoJsonError, setGeoJsonError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/india-states.geojson')
      .then((r) => {
        if (!r.ok) throw new Error(`GeoJSON fetch failed: ${r.status}`);
        return r.json() as Promise<GeoJsonCollection>;
      })
      .then((data) => { if (!cancelled) setStateGeoJson(data); })
      .catch(() => { if (!cancelled) setGeoJsonError(true); });
    return () => { cancelled = true; };
  }, []);

  // Build a lookup map from normalized state name to gap data
  const gapLookup = useMemo(() => {
    const m = new Map<string, StateGap>();
    for (const g of gaps) m.set(normalizeKey(g.state), g);
    return m;
  }, [gaps]);

  // Enrich GeoJSON features with gap data
  const enrichedGeoJson = useMemo((): GeoJsonCollection | null => {
    if (!stateGeoJson) return null;
    return {
      ...stateGeoJson,
      features: stateGeoJson.features.map((f) => {
        const name = (f.properties?.state_name as string) ?? '';
        const gap = gapLookup.get(normalizeKey(name));
        return {
          ...f,
          properties: {
            ...f.properties,
            gap_score: gap?.gap_score ?? null,
            confidence: gap?.confidence ?? 'low',
            facility_count: gap?.facility_count ?? 0,
            state_name_db: gap?.state ?? null,
          },
        };
      }),
    };
  }, [stateGeoJson, gapLookup]);

  // Build GeoJSON for heatmap layer
  const heatmapGeoJson = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: points.map((p) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [p.longitude, p.latitude] },
        properties: { trust_weight: p.trust_weight },
      })),
    }),
    [points],
  );

  const handleClick = useCallback(
    (e: MapLayerMouseEvent) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const name = (feature.properties?.state_name as string) ?? '';
      const gap = gapLookup.get(normalizeKey(name));
      if (gap) onStateSelect(gap);
    },
    [gapLookup, onStateSelect],
  );

  const confidenceOpacity = showConfidenceFilter
    ? (['match', ['get', 'confidence'], 'high', 0.80, 'medium', 0.40, 0.10] as unknown as number)
    : 0.65;

  return (
    <div className="relative w-full h-full rounded-lg overflow-hidden">
      <ReactMap
        ref={mapRef}
        initialViewState={INDIA_CENTER}
        mapStyle={MAP_STYLE}
        style={{ width: '100%', height: '100%' }}
        interactiveLayerIds={showChoropleth ? ['state-fill'] : []}
        onClick={handleClick}
        cursor="default"
        attributionControl={{ compact: true }}
      >
        {/* Choropleth layers */}
        {showChoropleth && enrichedGeoJson && (
          <Source id="states" type="geojson" data={enrichedGeoJson}>
            <Layer
              id="state-fill"
              type="fill"
              paint={{
                'fill-color': [
                  'case',
                  ['==', ['get', 'gap_score'], null],
                  '#e5e7eb',
                  [
                    'interpolate',
                    ['linear'],
                    ['get', 'gap_score'],
                    0, '#dcfce7',
                    25, '#fef9c3',
                    50, '#fed7aa',
                    100, '#ef4444',
                    500, '#7f1d1d',
                  ],
                ],
                'fill-opacity': confidenceOpacity,
              }}
            />
            <Layer
              id="state-line"
              type="line"
              paint={{
                'line-color': '#94a3b8',
                'line-width': 0.8,
              }}
            />
          </Source>
        )}

        {/* Heatmap layer */}
        {showHeatmap && points.length > 0 && (
          <Source id="facilities" type="geojson" data={heatmapGeoJson}>
            <Layer
              id="facility-heatmap"
              type="heatmap"
              paint={{
                'heatmap-weight': ['get', 'trust_weight'],
                'heatmap-intensity': [
                  'interpolate', ['linear'], ['zoom'],
                  4, 0.6,
                  8, 2.0,
                ],
                'heatmap-radius': [
                  'interpolate', ['linear'], ['zoom'],
                  4, 12,
                  8, 35,
                ],
                'heatmap-opacity': 0.65,
                'heatmap-color': [
                  'interpolate',
                  ['linear'],
                  ['heatmap-density'],
                  0,   'rgba(0,0,0,0)',
                  0.2, '#3b82f6',
                  0.5, '#22c55e',
                  0.8, '#eab308',
                  1.0, '#ef4444',
                ],
              }}
            />
          </Source>
        )}
      </ReactMap>

      <DesertLegend />

      {geoJsonError && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-destructive/90 text-white text-xs px-3 py-1.5 rounded-full shadow">
          Could not load India state boundaries
        </div>
      )}

      {showHeatmap && points.length > 0 && (
        <div className="absolute top-3 right-3 bg-white/90 backdrop-blur-sm text-xs px-2 py-1 rounded shadow pointer-events-none">
          <span className="font-medium">{points.length.toLocaleString()}</span> facilities mapped
        </div>
      )}
    </div>
  );
}
