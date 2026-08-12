/**
 * tsdown config for the annotation plugin 2.0: the browser bundle (same
 * closure-factory shape as DSH client plugins) plus the Node half (the
 * cordis plugin body with the agent/pre-step splitter). Externals resolve
 * through the web loader's module table for the client; the Node half keeps
 * @deepseek-ai peers external exactly like other host plugins.
 */
import { defineConfig } from 'tsdown'

/** Plugin id: must equal the package name (the loader keys factories by it). */
const ID = '@dsh-external/dsh-annotation'

/** Module-table words the browser bundle may require (platform seed + injected client modules). */
const MODULE_TABLE = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-ui-slash/client',
  '@deepseek-ai/dsh-client-locale/client',
]

export default defineConfig([
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.tsx' },
    // Browser bundle lands at the repo root (the loader URL for this plugin is
    // /plugins/@dsh-external/dsh-annotation/client.js).
    outDir: '.',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: MODULE_TABLE,
    // tsdown auto-externalizes package dependencies; anything NOT in the loader
    // module table must inline instead. No opinion for table entries, bundle
    // everything else.
    noExternal: (id: string) => (MODULE_TABLE.includes(id) ? undefined : true),
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
  {
    name: `${ID}/node`,
    entry: { index: 'src/node/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    dts: true,
    clean: false,
    // Host-side peers resolve from the profile's module fallback at runtime,
    // exactly like other host plugins (distill et al.).
    external: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
    ],
  },
])
