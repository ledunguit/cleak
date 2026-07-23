/**
 * Opt-in toggle for fullscreen environment layout mode.
 *
 * `isFullscreenEnvEnabled()` controls whether layout primitives should
 * consume the full terminal viewport. Initially returns `false` — the
 * StackLayout works inline without fullscreen assumptions.
 *
 * Fullscreen mode will be enabled in a follow-up (Task 8) via a
 * useStdoutDimensions hook that sets a flag when terminal space is ample.
 */

export function isFullscreenEnvEnabled(): boolean {
  return true;
}
