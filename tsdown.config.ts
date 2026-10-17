import { readFileSync } from 'node:fs'
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'workbuddy-bridge'

/** Read the npm version once so the build injects it into src/core/version.ts. */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string

/** Build-time define map; `src/core/version.ts` reads `__DSH_WORKBUDDY_VERSION__`. */
const VERSION_DEFINE = { __DSH_WORKBUDDY_VERSION__: JSON.stringify(PACKAGE_VERSION) }

/**
 * Modules the host loader provides, kept out of the browser bundle. The
 * client's DSH imports are type-only today — they erase at build time, so the
 * emitted bundle only requires React. The list is the guardrail that keeps a
 * future value import `require`d from the host instead of inlined.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-locale/client',
] as const

export default [
  {
    /**
     * Six entries, three audiences:
     *   index       — the DeepSeek Harness plugin (needs the DSH peers)
     *   bin         — the status/doctor CLI the DSH plugin ships
     *   core        — the agent-agnostic library surface
     *   standalone  — the embeddable bridge
     *   cli         — the CLI implementation, a pure library (no side effects)
     *   run         — the `workbuddy-bridge` executable; always runs `main`
     *
     * `cli` and `run` are split on purpose: a bundled entry point cannot
     * reliably tell whether it is being executed or imported once the build
     * code-splits, so the decision is made by which file is the entry rather
     * than by a runtime check. See src/standalone/run.ts.
     *
     * Only `index`, `bin` and the client touch `@deepseek-ai/*`; the other
     * entries are why those peers are declared optional in package.json.
     */
    entry: {
      index: 'src/dsh/index.ts',
      bin: 'src/core/bin.ts',
      core: 'src/core/index.ts',
      standalone: 'src/standalone/index.ts',
      cli: 'src/standalone/cli.ts',
      run: 'src/standalone/run.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    define: VERSION_DEFINE,
    deps: {
      neverBundle: [
        '@earendil-works/pi-ai',
        '@deepseek-ai/schemastery',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-attachment',
        '@deepseek-ai/dsh-host-webserver',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-llm-pi-ai',
        '@deepseek-ai/dsh-settings',
      ],
    },
  },
  {
    entry: { client: 'src/dsh/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    clean: false,
    define: VERSION_DEFINE,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
