import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/** Mirror the build-time define from tsdown.config.ts so tests see the same version. */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string

export default defineConfig({
  define: {
    __DSH_WORKBUDDY_VERSION__: JSON.stringify(PACKAGE_VERSION),
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    /**
     * Vitest's 5s default is too tight for the two fixtures that build a real
     * on-disk pi-ai tree: `pi-ai-dual-instance.spec.ts` copies the whole
     * package plus five dependency trees into a temp directory, which costs
     * ~8.5s on Windows against ~1s on macOS. The work is I/O-bound and
     * correct; the default was simply measuring the platform, not the code.
     */
    testTimeout: 30_000,
  },
})
