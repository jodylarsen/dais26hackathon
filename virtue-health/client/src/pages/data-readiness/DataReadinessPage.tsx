import { useState } from 'react';
import {
  Card, CardContent, CardHeader, CardTitle, Badge,
} from '@databricks/appkit-ui/react';
import {
  AlertCircle, RefreshCw, Database, ShieldCheck,
} from 'lucide-react';
import { Button } from '@databricks/appkit-ui/react';
import { ReadinessKpiBar } from './ReadinessKpiBar';
import { ReadinessFieldProfile } from './ReadinessFieldProfile';
import { ReadinessIssueTabs } from './ReadinessIssueTabs';
import { ReadinessTopRecords } from './ReadinessTopRecords';
import { useReadinessProfile, useReadinessIssues, useTopRecords } from './useReadinessData';

// ── Enrichment roadmap data ───────────────────────────────────────────────────

type Impact = 'high' | 'medium';
type Status = 'available' | 'partial' | 'not-ingested';
type Connectivity = 'reachable' | 'needs-token' | 'unreachable';

interface Dataset {
  rank: number;
  name: string;
  source: string;
  access: string;
  impact: Impact;
  fixes: string[];
  summary: string;
  status: Status;
  connectivity: Connectivity;
  connectivityNote: string;
}

const DATASETS: Dataset[] = [
  {
    rank: 1, name: 'Health Facility Registry (HFR)', source: 'abdm.gov.in/hfr',
    access: 'ABDM API — register at sandbox.abdm.gov.in (ABDM_CLIENT_ID + ABDM_CLIENT_SECRET in .env)', impact: 'high',
    fixes: ['latitude', 'longitude', 'organization_type', 'name'],
    summary: 'Official 500K+ government registry. HFR_ID is the canonical dedup key; fills missing GPS and org type across all facility types.',
    status: 'not-ingested',
    connectivity: 'needs-token',
    connectivityNote: 'ABDM sandbox returns 403 — requires NHA client registration',
  },
  {
    rank: 2, name: 'India Post PIN Code Directory', source: 'api.postalpincode.in',
    access: 'Free JSON API — no token required. GET /pincode/{code} → State, District, Block', impact: 'high',
    fixes: ['state', 'address_city'],
    summary: 'Enrich existing pincode table with District/Block to validate the city↔district↔state chain. Flag records where state ≠ pincode-derived state. Replaces data.gov.in (requires Indian phone for registration).',
    status: 'partial',
    connectivity: 'reachable',
    connectivityNote: 'HTTP 200 — api.postalpincode.in/pincode/110001 confirmed (State, District, Block)',
  },
  {
    rank: 3, name: 'GeoNames Postal Codes', source: 'geonames.org/export/zip_codes.php',
    access: 'Free CSV — no token required (download.geonames.org/export/zip/IN.zip)', impact: 'high',
    fixes: ['latitude', 'longitude'],
    summary: 'Lat/lon centroid per India PIN code. Compute distance from facility GPS to PIN centroid — flag any record > 50 km as GPS_SUSPECT.',
    status: 'not-ingested',
    connectivity: 'reachable',
    connectivityNote: 'HTTP 200 — ~42K India pincodes, ready to ingest',
  },
  {
    rank: 4, name: 'OpenStreetMap (Overpass API)', source: 'overpass.openstreetmap.fr',
    access: 'Free live API — no token. Use mirror (primary overpass-api.de is rate-limited/504)', impact: 'high',
    fixes: ['latitude', 'longitude', 'name', 'capability'],
    summary: 'Dense healthcare coverage across India. Name-similarity match for dedup; GPS cross-validation; surfaces facilities missing from the registry.',
    status: 'not-ingested',
    connectivity: 'reachable',
    connectivityNote: 'HTTP 200 on openstreetmap.fr mirror — primary overpass-api.de returns 504',
  },
  {
    rank: 5, name: 'Overture Maps Places', source: 'overturemaps.org (S3)',
    access: 'Free public S3 — latest release 2026-05-20.0, ingest via read_files() in Databricks', impact: 'medium',
    fixes: ['latitude', 'longitude', 'organization_type', 'name'],
    summary: 'OSM + Meta + Microsoft + TomTom aggregated with healthcare category tags. Load directly as a Delta table from the public S3 release.',
    status: 'not-ingested',
    connectivity: 'reachable',
    connectivityNote: 'HTTP 200 — s3://overturemaps-us-west-2/release/2026-05-20.0/theme=places/type=place/',
  },
  {
    rank: 6, name: 'CGHS Empanelled Hospitals', source: 'cghs.gov.in',
    access: 'Free quarterly Excel download — requires browser (site times out from CI/cloud)', impact: 'medium',
    fixes: ['source_types', 'organization_type'],
    summary: '~5,000 Ministry of Health-verified private hospitals. Empanelment = active license. Matching facilities get cghs appended to source_types, boosting trust_weight.',
    status: 'not-ingested',
    connectivity: 'unreachable',
    connectivityNote: 'Connection timeout — download manually from cghs.gov.in via browser',
  },
  {
    rank: 7, name: 'MCA21 Company Registry', source: 'mca.gov.in / data.gov.in',
    access: 'Bulk export via data.gov.in API (DATA_GOV_IN_API_KEY in .env); mca.gov.in returns 403', impact: 'medium',
    fixes: ['name', 'address_city', 'state'],
    summary: 'Hospitals registered as companies/trusts with a unique CIN. Legal name dedup and registered address validates facility address fields.',
    status: 'not-ingested',
    connectivity: 'needs-token',
    connectivityNote: 'mca.gov.in returns 403; data.gov.in bulk export requires Indian phone for OTP',
  },
  {
    rank: 8, name: 'Wikidata SPARQL', source: 'query.wikidata.org',
    access: 'Free SPARQL endpoint — no token required (P625 for GPS, P131 for admin division)', impact: 'medium',
    fixes: ['latitude', 'longitude'],
    summary: '~2,500 named Indian hospitals with structured, community-verified GPS coordinates. Adversarial GPS check: flag if > 1 km from Wikidata for major hospitals.',
    status: 'not-ingested',
    connectivity: 'reachable',
    connectivityNote: 'HTTP 200 — confirmed GPS return (e.g. Nagarjuna Hospital lat=16.487, lon=80.684)',
  },
  {
    rank: 9, name: 'AERB Licensed Facilities', source: 'aerb.gov.in',
    access: 'Free search / PDF export — site reachable but no bulk API (manual download)', impact: 'medium',
    fixes: ['capability', 'source_types'],
    summary: '~12,000 hospitals licensed for X-ray, CT, MRI, and radiation therapy. Confirms radiology/oncology capability and adds aerb as a trust signal to source_types.',
    status: 'not-ingested',
    connectivity: 'reachable',
    connectivityNote: 'HTTP 200 — no bulk API; PDF/Excel export via browser',
  },
  {
    rank: 10, name: 'NHM HMIS Annual Reports', source: 'hmis.nhp.gov.in',
    access: 'Free Excel/PDF by state — DNS unreachable; use nhm.gov.in/index4.php as fallback', impact: 'medium',
    fixes: ['coverage completeness (per state)'],
    summary: 'State-level counts of DH/SDH/CHC/PHC/Sub-centres. Compare against table counts per state to compute a coverage gap % and surface under-registered states.',
    status: 'not-ingested',
    connectivity: 'unreachable',
    connectivityNote: 'DNS failure — try nhm.gov.in/index4.php?lang=1&level=2&sublinkid=1077 via browser',
  },
];

const STATUS_LABEL: Record<Status, string> = {
  available: 'In DB', partial: 'Partial', 'not-ingested': 'Not Ingested',
};
const STATUS_VARIANT: Record<Status, 'default' | 'secondary' | 'outline'> = {
  available: 'default', partial: 'secondary', 'not-ingested': 'outline',
};
const CONNECTIVITY_LABEL: Record<Connectivity, string> = {
  reachable: '✓ Reachable', 'needs-token': '⚿ Needs Token', unreachable: '✗ Unreachable',
};
const CONNECTIVITY_CLASS: Record<Connectivity, string> = {
  reachable: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-400 dark:border-green-800/40',
  'needs-token': 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800/40',
  unreachable: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-800/40',
};

const ACTIONS = [
  { step: 1, action: 'Ingest HFR bulk export', detail: 'Join on name + state → assign HFR_IDs, fill missing lat/lon, standardize organization_type to HFR taxonomy.' },
  { step: 2, action: 'Load GeoNames pincode centroids', detail: 'For each facility with a pincode, compute haversine distance to centroid. Write GPS_SUSPECT flag for outliers > 50 km.' },
  { step: 3, action: 'Enrich India Post with taluk/tehsil', detail: 'Pull full pincode directory from data.gov.in; validate city↔district↔state chain and flag mismatches.' },
  { step: 4, action: 'Run OSM Overpass harvest', detail: 'Download all healthcare amenities for India bounding box; fuzzy-name match for dedup and missing GPS fill.' },
  { step: 5, action: 'Import CGHS + AERB lists', detail: 'Append cghs and aerb to source_types for matching facilities; raises trust_weight in Desert Planner gap scores.' },
];

// ── Page component ────────────────────────────────────────────────────────────

export function DataReadinessPage() {
  // reloadKey drives in-page Retry — bumping it re-runs all three hooks.
  const [reloadKey, setReloadKey] = useState(0);
  const retry = () => setReloadKey(k => k + 1);

  const { profile, total, loading: profileLoading, error: profileError, syncing: profileSyncing } =
    useReadinessProfile(reloadKey);
  const {
    duplicates, nullBytes, geoContradictions, sourceMismatch, contradictions, suspicious,
    anomalyAlerts, sparseFields, issueCounts, listErrors, loading: issuesLoading, error: issuesError, syncing: issuesSyncing,
  } = useReadinessIssues(reloadKey);
  const { records, flaggedTotal, loading: recordsLoading, error: recordsError, syncing: recordsSyncing } =
    useTopRecords(reloadKey);

  const isSyncing = profileSyncing || issuesSyncing || recordsSyncing;
  const anyError = profileError || issuesError || recordsError;
  const isEmptyTable = !profileLoading && !profileSyncing && !profileError && total === 0;

  return (
    <div className="space-y-6 max-w-7xl">
      {/* Header — verbatim sibling markup (always visible) */}
      <div>
        <h2 className="text-2xl font-bold text-foreground">Data Readiness Desk</h2>
        <p className="text-muted-foreground mt-1">
          What needs to be fixed before this dataset can be trusted for planning?
        </p>
      </div>

      {/* AC6 disclosure — always visible */}
      <div className="flex gap-2 text-xs rounded-md px-3 py-2 border bg-blue-50 border-blue-100 text-blue-800 dark:bg-blue-950/30 dark:border-blue-800/40 dark:text-blue-300">
        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-blue-500 dark:text-blue-400" />
        <span>
          Profiling the plain <code>facilities</code> table — the data the app actually serves.
          The remediated <code>facilities_live</code> table may differ.
        </span>
      </div>

      {/* Error banner with Retry — coexists with any KPIs that loaded */}
      {anyError && (
        <div className="flex items-center justify-between gap-3 text-destructive bg-destructive/10 px-4 py-3 rounded-lg">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span className="text-sm">
              {profileError ? "Couldn't load the field profile. " : ''}
              {issuesError ? "Couldn't load issue checks. " : ''}
              {recordsError ? "Couldn't load top records. " : ''}
              The data warehouse may be starting up — retry in a few seconds.
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={retry} className="shrink-0">
            <RefreshCw className="h-4 w-4 mr-1.5" /> Retry
          </Button>
        </div>
      )}

      {/* Syncing banner */}
      {isSyncing && !anyError && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg border bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/40 dark:border-amber-800/50 dark:text-amber-300">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm">Data syncing… readiness metrics will appear once complete.</span>
        </div>
      )}

      {isEmptyTable ? (
        <div className="rounded-lg border border-border/60 bg-card p-8 text-center text-muted-foreground">
          No rows found in the <code>facilities</code> table. The query succeeded but returned 0 rows.
          Check the table name and warehouse.
        </div>
      ) : (
        <>
          <ReadinessKpiBar
            profile={profile} total={total} profileLoading={profileLoading}
            issueCounts={issueCounts} issuesLoading={issuesLoading}
            flaggedTotal={flaggedTotal} recordsLoading={recordsLoading}
          />

          <div className="grid grid-cols-1 md:grid-cols-[2fr_3fr] gap-5">
            <ReadinessFieldProfile profile={profile} total={total} loading={profileLoading} />
            <ReadinessIssueTabs
              duplicates={duplicates} nullBytes={nullBytes}
              geoContradictions={geoContradictions} sourceMismatch={sourceMismatch}
              contradictions={contradictions} suspicious={suspicious}
              anomalyAlerts={anomalyAlerts} sparseFields={sparseFields}
              issueCounts={issueCounts} listErrors={listErrors}
              issuesError={issuesError} loading={issuesLoading}
            />
          </div>

          <ReadinessTopRecords records={records} loading={recordsLoading} />
        </>
      )}

      {/* Enrichment roadmap */}
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-1">
          Enrichment Roadmap — 10 Free Datasets
        </h3>
        <p className="text-xs text-muted-foreground mb-3">
          Connectivity tested 2026-06-16 · 6 reachable · 2 need a token · 2 unreachable from cloud
        </p>
        <div className="space-y-2">
          {DATASETS.map((ds) => (
            <Card key={ds.rank} className="shadow-sm border border-border/60">
              <CardContent className="py-3 px-4">
                <div className="flex items-start gap-3">
                  <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0 text-xs font-bold text-muted-foreground mt-0.5">
                    {ds.rank}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div>
                        <span className="font-semibold text-sm text-foreground">{ds.name}</span>
                        <span className="text-xs text-muted-foreground ml-2">{ds.source}</span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                        <Badge
                          variant={ds.impact === 'high' ? 'destructive' : 'secondary'}
                          className="text-xs"
                        >
                          {ds.impact === 'high' ? 'High Impact' : 'Medium'}
                        </Badge>
                        <Badge variant={STATUS_VARIANT[ds.status]} className="text-xs">
                          {STATUS_LABEL[ds.status]}
                        </Badge>
                        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${CONNECTIVITY_CLASS[ds.connectivity]}`}>
                          {CONNECTIVITY_LABEL[ds.connectivity]}
                        </span>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{ds.summary}</p>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {ds.fixes.map((f) => (
                        <span key={f} className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                          {f}
                        </span>
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground/60 mt-1.5 italic">{ds.access}</p>
                    <p className="text-[10px] font-mono mt-0.5 text-muted-foreground/50">{ds.connectivityNote}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Priority action plan */}
      <Card className="shadow-sm border border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-[#FF3621]" />
            Priority Action Plan
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {ACTIONS.map(({ step, action, detail }) => (
            <div key={step} className="flex items-start gap-3">
              <div className="h-6 w-6 rounded-full bg-[#FF3621]/10 text-[#FF3621] flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                {step}
              </div>
              <div>
                <div className="text-sm font-medium text-foreground">{action}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{detail}</div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Source note */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground border border-border/40 rounded-lg px-4 py-3 bg-muted/20">
        <Database className="h-3.5 w-3.5 shrink-0 text-[#FF3621]" />
        <span>
          Quality scores computed live from{' '}
          <code className="bg-muted px-1 py-0.5 rounded text-[10px]">
            dais27hack.virtue_foundation_dataset_silver.facilities
          </code>{' '}
          · 5-component trust scores pre-computed in{' '}
          <code className="bg-muted px-1 py-0.5 rounded text-[10px]">
            workspace.gold_virtue_foundation_dataset.facility_trust_scores
          </code>{' '}
          via Databricks SQL Warehouse.
        </span>
      </div>
    </div>
  );
}
