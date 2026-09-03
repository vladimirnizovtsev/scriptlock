import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: false,
  // No `banner`: a tsup banner is applied to every entry, which would put a
  // shebang (and, with it, mode 0755) on dist/index.js, the importable library
  // entry. Some bundlers and edge-runtime shims trip over that. The shebang
  // lives at the top of src/cli.ts instead, where esbuild preserves it and
  // marks only that one output executable.
  //
  // `sourcemap: true` is deliberate: the shipped code is a single bundle, so a
  // user-reported stack trace is unreadable without a map, and Node reads maps
  // only under --enable-source-maps. The maps embed `sourcesContent`, i.e. the
  // verbatim text of every file under src/, and they are inside `files: ["dist"]`
  // rather than the reviewed top-level allowlist. That is fine for an Apache-2.0
  // project with a public repository, but it means anything added to src/ ships
  // as readable source: never put anything in src/ that must not be published.
  //
  // Declarations are emitted by `tsc --emitDeclarationOnly` in the build script,
  // not by tsup's `dts` option: tsup bundles rollup-plugin-dts, which needs the
  // TypeScript JS API, and TypeScript 7 (the native compiler) does not ship one.
});
