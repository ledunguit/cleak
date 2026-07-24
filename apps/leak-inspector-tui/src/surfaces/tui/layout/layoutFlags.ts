/**
 * Opt-in toggle for fullscreen layout mode.
 *
 * `isFullscreenEnvEnabled()` controls whether layout primitives should
 * consume the full terminal viewport. Defaults to `false` — the StackLayout
 * works inline without full-clear, avoiding flicker.
 */

export function isFullscreenEnvEnabled(configFullscreen?: boolean): boolean {
  return configFullscreen === true;
}
