const LEGEND_ENTRIES = [
  { color: '#dcfce7', label: 'Low gap (0–25)' },
  { color: '#fef9c3', label: 'Moderate (25–50)' },
  { color: '#fed7aa', label: 'High (50–100)' },
  { color: '#ef4444', label: 'Severe (100+)' },
  { color: '#e5e7eb', label: 'No data' },
];

export function DesertLegend() {
  return (
    <div className="absolute bottom-6 left-3 bg-white/90 backdrop-blur-sm rounded-md p-2 text-xs shadow z-10 pointer-events-none">
      <div className="font-medium mb-1.5 text-foreground">Care Gap Score</div>
      <div className="flex flex-col gap-1">
        {LEGEND_ENTRIES.map(({ color, label }) => (
          <div key={label} className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm border border-black/10 shrink-0" style={{ background: color }} />
            <span className="text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 pt-2 border-t border-border/40">
        <div className="font-medium mb-1 text-foreground">Confidence</div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-orange-400 opacity-75" />
            <span className="text-muted-foreground">High (solid)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-orange-400 opacity-40" />
            <span className="text-muted-foreground">Low (faint)</span>
          </div>
        </div>
      </div>
    </div>
  );
}
