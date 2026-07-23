import { Box } from 'ink';
import ThemedText from '../../theme/ThemedText';
import { glyph } from '../../theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModeIndicatorProps {
  /** Whether a scan/investigation is actively running. */
  running: boolean;
  /** Whether the running process is paused. */
  paused: boolean;
  /**
   * Agent mode.
   * - `"llm_assisted"` → LLM badge (accent)
   * - anything else    → "Static" badge (subtle)
   */
  mode: string;
  /**
   * Permission-gating mode.
   * - `"auto"` → violet chip
   * - `"ask"`  → subtle chip (default)
   */
  permissionMode?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Compact status + mode indicator for the prompt area.
 *
 * Renders three labelled segments separated by dots:
 * ```
 * ◐ running · LLM · Auto
 * ⏸ paused  · LLM · Ask
 * ● idle    · Static · Ask
 * ```
 *
 * Uses `ThemedText` with semantic theme keys so every colour is resolved
 * through the theme system — no hardcoded hex values.
 */
export function ModeIndicator({
  running,
  paused,
  mode,
  permissionMode = 'ask',
}: ModeIndicatorProps) {
  // ── status ──────────────────────────────────────────────────────────
  const statusColor = paused ? 'warning' : running ? 'accent' : 'subtle';
  const statusLabel = paused ? 'paused' : running ? 'running' : 'idle';
  const statusChar = paused ? '⏸' : running ? glyph.running : '●';

  // ── mode ────────────────────────────────────────────────────────────
  const isLlm = mode === 'llm_assisted';
  const modeLabel = isLlm ? 'LLM' : 'Static';
  const modeColor = isLlm ? 'accent' : 'subtle';

  // ── permission ──────────────────────────────────────────────────────
  const isAuto = permissionMode === 'auto';
  const permLabel = isAuto ? 'Auto' : 'Ask';
  const permColor = isAuto ? 'violet' : 'subtle';

  return (
    <Box>
      <ThemedText color={statusColor}>
        {statusChar} {statusLabel}
      </ThemedText>
      <ThemedText dimColor>{glyph.bullet}</ThemedText>
      <ThemedText color={modeColor}>{modeLabel}</ThemedText>
      <ThemedText dimColor>{glyph.bullet}</ThemedText>
      <ThemedText color={permColor}>{permLabel}</ThemedText>
    </Box>
  );
}
