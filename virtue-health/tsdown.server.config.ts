import { defineConfig } from 'tsdown';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

// Packages that require native platform binaries — cannot be bundled
// for cross-platform (macOS build → Linux deploy).
const nativePrefixes = [
  'lightningcss', 'fsevents',
  'vite', '@vitejs', 'rollup', 'esbuild',
  'typescript', 'tsx', 'tsdown',
];

export default defineConfig({
  entry: 'server/server.ts',
  noExternal: /.*/,
  minify: true,
  // Redirect @ast-grep/napi to a no-op stub: appkit imports it statically
  // for dev-only type generation; in production these paths are never executed.
  alias: {
    '@ast-grep/napi': resolve('./server/stubs/ast-grep-napi.js'),
  },
  external: (id) => {
    const bare = id.replace(/^node:/, '');
    if (nodeBuiltins.has(id) || nodeBuiltins.has(bare)) return true;
    return nativePrefixes.some((p) => id === p || id.startsWith(p + '/'));
  },
  tsconfig: 'tsconfig.server.json',
  outExtensions: () => ({
    js: '.js',
  }),
});
