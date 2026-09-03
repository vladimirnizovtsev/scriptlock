import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: false,
  banner: ({ format }) => (format === 'esm' ? { js: '#!/usr/bin/env node' } : {}),
  // The banner is applied to every entry; cli.ts is the one that needs the shebang
  // and index.ts tolerates it.
  //
  // Declarations are emitted by `tsc --emitDeclarationOnly` in the build script,
  // not by tsup's `dts` option: tsup bundles rollup-plugin-dts, which needs the
  // TypeScript JS API, and TypeScript 7 (the native compiler) does not ship one.
});
