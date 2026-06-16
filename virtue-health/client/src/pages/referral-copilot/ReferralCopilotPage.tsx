import { MapPin, Search, Building2, ArrowRight, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@databricks/appkit-ui/react';

export function ReferralCopilotPage() {
  return (
    <div className="space-y-8 max-w-4xl">
      {/* Hero */}
      <div className="rounded-xl bg-gradient-to-br from-[#0B2026] to-[#1a3a44] p-6 text-white">
        <div className="flex items-center gap-2 mb-3">
          <ArrowRight className="h-5 w-5 text-[#f97316]" />
          <span className="text-sm font-medium text-white/70 uppercase tracking-widest">Track 3</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">Referral Copilot</h2>
        <p className="text-white/75 mt-1 text-sm max-w-xl">
          Given a patient location and care need, surface a ranked shortlist of facilities
          weighted by trust score, capability match, and geographic proximity.
        </p>
      </div>

      {/* Coming soon notice */}
      <div className="flex items-start gap-3 px-4 py-4 rounded-lg border border-[#f97316]/30 bg-[#f97316]/5 text-[#f97316]">
        <Info className="h-5 w-5 shrink-0 mt-0.5" />
        <div>
          <p className="font-medium text-sm">Under construction</p>
          <p className="text-sm text-[#f97316]/80 mt-0.5">
            Referral Copilot requires the Lakebase synced-tables to be online for sub-10ms
            geospatial lookups. The UI shell is ready — connect the backend once
            <code className="mx-1 bg-[#f97316]/10 px-1 py-0.5 rounded text-xs">facilities_live</code>
            reaches <code className="bg-[#f97316]/10 px-1 py-0.5 rounded text-xs">SYNCED_TABLE_ONLINE</code>.
          </p>
        </div>
      </div>

      {/* Planned capability cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          {
            icon: <MapPin className="h-5 w-5" />,
            title: 'Location Input',
            color: '#f97316',
            desc: 'Enter patient pin code or district. The copilot resolves GPS coordinates and searches within a configurable radius.',
          },
          {
            icon: <Search className="h-5 w-5" />,
            title: 'Capability Matching',
            color: '#0ea5e9',
            desc: 'Select the required care type — ICU, maternity, oncology, emergency, NICU, trauma. Only facilities with matching capability are surfaced.',
          },
          {
            icon: <Building2 className="h-5 w-5" />,
            title: 'Ranked Shortlist',
            color: '#10b981',
            desc: 'Results ranked by a composite score: trust weight × capability match ÷ distance. Top 10 returned with contact details and data confidence.',
          },
        ].map(({ icon, title, color, desc }) => (
          <Card key={title} className="shadow-sm border border-border/60 overflow-hidden">
            <div className="h-[3px]" style={{ background: `linear-gradient(90deg, ${color}, ${color}55)` }} />
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${color}15`, color }}>
                  {icon}
                </div>
                <span className="font-semibold text-foreground text-sm">{title}</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Data requirements */}
      <Card className="shadow-sm border border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Data Requirements</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Source</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Table</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody>
              {[
                { source: 'Facility registry', table: 'facilities_live', status: 'Pending sync', ok: false },
                { source: 'Pin code directory', table: 'india_post_pincode_directory_live', status: 'Pending sync', ok: false },
                { source: 'NFHS-5 indicators', table: 'nfhs_5_district_health_indicators_live', status: 'Online', ok: true },
                { source: 'Trust scores (gold)', table: 'gold.facility_trust_scores', status: 'Online', ok: true },
              ].map(({ source, table, status, ok }) => (
                <tr key={table} className="border-b last:border-0">
                  <td className="px-4 py-3 text-foreground font-medium">{source}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{table}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full ${ok ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                      {status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
