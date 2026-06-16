import { useEffect, useMemo, useRef, useState } from 'react';
import MapGL, { Source, Layer } from 'react-map-gl/maplibre';
import type { MapLayerMouseEvent, MapRef } from 'react-map-gl/maplibre';
import { DesertLegend } from './DesertLegend';
import type { StateGap, HeatmapPoint } from './types';

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const INITIAL_VIEW = { longitude: 82.5, latitude: 22.0, zoom: 4 };

const normalizeKey = (s: unknown) => (s == null ? '' : String(s)).toLowerCase().replace(/[^a-z0-9]/g, '');

interface GeoJsonFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: unknown;
}

interface GeoJsonCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

interface DesertMapProps {
  gaps: StateGap[];
  points: HeatmapPoint[];
  showHeatmap: boolean;
  showConfidenceFilter: boolean;
  onStateSelect: (gap: StateGap) => void;
}

export function DesertMap({
  gaps,
  points,
  showHeatmap,
  showConfidenceFilter,
  onStateSelect,
}: DesertMapProps) {
  const mapRef = useRef<MapRef>(null);
  const [stateGeoJson, setStateGeoJson] = useState<GeoJsonCollection | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/india-states.geojson')
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setStateGeoJson(d as GeoJsonCollection); });
    return () => { cancelled = true; };
  }, []);

  const filteredGaps = useMemo(
    () => showConfidenceFilter ? gaps.filter((g) => g.confidence === 'high') : gaps,
    [gaps, showConfidenceFilter],
  );

  const enriched = useMemo(() => {
    if (!stateGeoJson) return null;
    const lookup = new Map(filteredGaps.map((g) => [normalizeKey(g.state), g]));
    return {
      ...stateGeoJson,
      features: stateGeoJson.features.map((f) => {
        const name = String(f.properties?.state_name ?? '');
        const gap = lookup.get(normalizeKey(name));
        return {
          ...f,
          properties: {
            ...f.properties,
            gap_score: gap?.gap_score ?? null,
            confidence: gap?.confidence ?? 'low',
            facility_count: gap?.facility_count ?? 0,
            state_matched: name,
          },
        };
      }),
    };
  }, [stateGeoJson, filteredGaps]);

  const heatmapGeoJson = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: points.map((p) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [p.longitude, p.latitude] },
      properties: { trust_weight: p.trust_weight },
    })),
  }), [points]);

  const handleClick = (e: MapLayerMouseEvent) => {
    const feature = e.features?.[0];
    if (!feature) return;
    const name = String(feature.properties?.state_name ?? '');
    const gap = filteredGaps.find((g) => normalizeKey(g.state) === normalizeKey(name));
    if (gap) onStateSelect(gap);
  };

  return (
    <div className="relative w-full h-full">
      <MapGL
        ref={mapRef}
        initialViewState={INITIAL_VIEW}
        mapStyle={MAP_STYLE}
        interactiveLayerIds={['state-fill']}
        onClick={handleClick}
        style={{ width: '100%', height: '100%' }}
      >
        {enriched && (
          <Source id="states" type="geojson" data={enriched}>
            {/* State choropleth fill */}
            <Layer
              id="state-fill"
              type="fill"
              paint={{
                'fill-color': [
                  'case',
                  ['==', ['get', 'gap_score'], null], '#e5e7eb',
                  ['interpolate', ['linear'], ['get', 'gap_score'],
                    0, '#86efac',
                    10, '#fbbf24',
                    25, '#f97316',
                    50, '#ef4444',
                    100, '#7f1d1d',
                  ],
                ],
                'fill-opacity': [
                  'match', ['get', 'confidence'],
                  'high', 0.78,
                  'medium', 0.52,
                  0.20,
                ],
              }}
            />
            {/* State outline */}
            <Layer
              id="state-line"
              type="line"
              paint={{
                'line-color': '#94a3b8',
                'line-width': 0.6,
              }}
            />
          </Source>
        )}

        {/* Facility heatmap layer */}
        {showHeatmap && points.length > 0 && (
          <Source id="heatmap" type="geojson" data={heatmapGeoJson}>
            <Layer
              id="facility-heat"
              type="heatmap"
              paint={{
                'heatmap-weight': ['get', 'trust_weight'],
                'heatmap-intensity': 0.6,
                'heatmap-radius': 14,
                'heatmap-opacity': 0.55,
                'heatmap-color': [
                  'interpolate', ['linear'], ['heatmap-density'],
                  0, 'rgba(0,0,0,0)',
                  0.2, '#ffffb2',
                  0.5, '#fd8d3c',
                  0.8, '#f03b20',
                  1, '#bd0026',
                ],
              }}
            />
          </Source>
        )}

        <DesertLegend />
      </MapGL>
    </div>
  );
}
