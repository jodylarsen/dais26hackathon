// Mirrors DistrictsPage.PctBar: same color triple + thresholds, same inline-style
// width mechanism (Tailwind JIT can't generate arbitrary runtime widths).
// `value` is a 0–1 fraction; converted to percent internally.
export function PctBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    pct >= 75 ? 'bg-emerald-500'
    : pct >= 50 ? 'bg-amber-400'
    : 'bg-red-400';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground w-9 text-right">{pct}%</span>
    </div>
  );
}
