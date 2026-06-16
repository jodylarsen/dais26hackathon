// Stub for @ast-grep/napi — used by appkit's type-generator in dev mode only.
// In production (static server), these code paths are never executed.
export const Lang = { TypeScript: 'TypeScript', Tsx: 'Tsx', JavaScript: 'JavaScript', Js: 'Js', Ts: 'Ts' };
export function parse() { return null; }
export function parseAsync() { return Promise.resolve(null); }
