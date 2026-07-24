/**
 * Opt-in toggle for fullscreen environment layout mode.
 *
 * `isFullscreenEnvEnabled()` controls whether layout primitives should
 * consume the full terminal viewport. Enabled by setting `CLEAK_FULLSCREEN=1`
 * in the environment. Defaults to `false` — the StackLayout works inline
 * without full-clear, avoiding flicker.
 */

export function isFullscreenEnvEnabled(): boolean {
  return process.env.CLEAK_FULLSCREEN === '1';
}
