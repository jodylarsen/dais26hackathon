// Bands key purely on heavy_score — matching §1 prose: 0 heavy → green,
// exactly 1 heavy (+2) → amber, 2+ heavy (+4) → red. `issue_score` is used
// only for ordering within a band, never for color.
// Uses inline-hex mechanism (matches DesertDetailPanel, dark-mode-legible).
export function scoreColor(heavyScore: number): string {
  if (heavyScore >= 4) return '#dc2626'; // red-600 — two+ serious problems
  if (heavyScore >= 2) return '#d97706'; // amber-600 — exactly one serious problem
  return '#16a34a';                      // green-600 — completeness gaps only
}
