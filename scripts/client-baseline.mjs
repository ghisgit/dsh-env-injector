/**
 * The client module baseline: the modules the web shell seeds into its frozen
 * module table before any plugin bundle materializes.
 *
 * A bundle resolves every module request against that table (plus its own
 * package's `dsh.client.external` suppliers, which this plugin needs none of),
 * and an unknown request is a loud load failure in the browser. So the build
 * refuses a request outside this list, and the test suite re-asserts the same
 * claim against the shipped artifact — the two together are this package's
 * mirror of the composition's "missing supplier" rejection.
 *
 * Source of truth: the shell's platform seed table
 * (`dsh-web-frontend/dist/assets/index-*.js`, `PLATFORM_MODULES`).
 *
 * @module dsh-env-injector/scripts/client-baseline
 */

/** Every module specifier a browser half may request without declaring it. */
export const CLIENT_BASELINE = Object.freeze([
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-dockkit',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
])
