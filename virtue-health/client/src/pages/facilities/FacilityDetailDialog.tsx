import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Badge,
  Skeleton,
  Separator,
} from '@databricks/appkit-ui/react';
import { Building2, MapPin, Zap, Link, AlertCircle } from 'lucide-react';

interface FacilityDetail {
  facility_id: number;
  name: string | null;
  description: string | null;
  organization_type: string | null;
  capability: string | null;
  capability_status: string | null;
  specialties: string | null;
  equipment: string | null;
  procedure: string | null;
  source_types: string | null;
  source_ids: string | null;
  address_city: string | null;
  state: string | null;
  address_country: string | null;
  latitude: string | null;
  longitude: string | null;
}

interface Props {
  facilityId: number | null;
  onClose: () => void;
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value || value.trim() === '') return null;
  return (
    <div>
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-0.5">{label}</p>
      <p className="text-sm text-foreground break-words">{value}</p>
    </div>
  );
}

function TagList({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value || value.trim() === '') return null;
  const tags = value.split(',').map((t) => t.trim()).filter(Boolean);
  if (tags.length === 0) return null;
  return (
    <div>
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1">{label}</p>
      <div className="flex flex-wrap gap-1">
        {tags.map((t) => (
          <Badge key={t} variant="secondary" className="text-xs font-normal">{t}</Badge>
        ))}
      </div>
    </div>
  );
}

export function FacilityDetailDialog({ facilityId, onClose }: Props) {
  const [facility, setFacility] = useState<FacilityDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (facilityId === null) { setFacility(null); return; }
    setLoading(true);
    setError(null);
    setFacility(null);
    fetch(`/api/facilities/${facilityId}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => setFacility(d.facility as FacilityDetail))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load facility'))
      .finally(() => setLoading(false));
  }, [facilityId]);

  const hasGps =
    facility?.latitude && facility.longitude &&
    facility.latitude.trim() !== '' && facility.longitude.trim() !== '';

  return (
    <Dialog open={facilityId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            <div className="h-7 w-7 rounded-md bg-[#FF3621]/10 flex items-center justify-center shrink-0">
              <Building2 className="h-4 w-4 text-[#FF3621]" />
            </div>
            <span className="truncate">
              {loading ? <Skeleton className="h-5 w-48 inline-block" /> : (facility?.name || '—')}
            </span>
          </DialogTitle>
        </DialogHeader>

        {error && (
          <div className="flex items-center gap-2 text-destructive bg-destructive/10 px-3 py-2 rounded-md text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {loading && (
          <div className="space-y-3 mt-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i}>
                <Skeleton className="h-3 w-20 mb-1" />
                <Skeleton className="h-4 w-full" />
              </div>
            ))}
          </div>
        )}

        {facility && !loading && (
          <div className="space-y-4 mt-1">
            {/* Identity */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Facility ID" value={String(facility.facility_id)} />
              <Field label="Organization Type" value={facility.organization_type} />
            </div>

            {facility.description && (
              <Field label="Description" value={facility.description} />
            )}

            <Separator />

            {/* Location */}
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <MapPin className="h-3.5 w-3.5 text-[#FF3621]" />
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Location</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="City" value={facility.address_city} />
                <Field label="State / Region" value={facility.state} />
                <Field label="Country" value={facility.address_country} />
                {hasGps && (
                  <div>
                    <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-0.5">GPS</p>
                    <p className="text-sm text-foreground font-mono">
                      {Number(facility.latitude).toFixed(4)}, {Number(facility.longitude).toFixed(4)}
                    </p>
                  </div>
                )}
              </div>
            </div>

            <Separator />

            {/* Capabilities */}
            {(facility.capability || facility.capability_status || facility.specialties || facility.equipment || facility.procedure) && (
              <>
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Zap className="h-3.5 w-3.5 text-amber-500" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Capabilities</span>
                  </div>
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Capability" value={facility.capability} />
                      <Field label="Status" value={facility.capability_status} />
                    </div>
                    <TagList label="Specialties" value={facility.specialties} />
                    <TagList label="Equipment" value={facility.equipment} />
                    <TagList label="Procedures" value={facility.procedure} />
                  </div>
                </div>
                <Separator />
              </>
            )}

            {/* Sources */}
            {(facility.source_types || facility.source_ids) && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Link className="h-3.5 w-3.5 text-blue-500" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Data Sources</span>
                </div>
                <div className="space-y-2">
                  <TagList label="Source Types" value={facility.source_types} />
                  <TagList label="Source IDs" value={facility.source_ids} />
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
