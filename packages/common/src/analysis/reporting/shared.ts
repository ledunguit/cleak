/**
 * Shared helpers for report renderers — formatting, escaping, verdict-provenance
 * labels. No framework dependencies.
 */

// ── Escaping ────────────────────────────────────────────────────────────────

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeCsv(value: string | number): string {
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ── Verdict-provenance helpers (markdown + html), mirroring the TUI card ──

/** One line of judge provenance: the deciding tool plus, for a consensus verdict,
 *  its agreement %, how many samples matched the final verdict, and any override. */
export function judgeSummary(v: any): string {
  if (!v) return 'unknown';
  const tool = v.tool || 'unknown';
  if (Array.isArray(v.samples) && v.samples.length) {
    const total = v.samples.length;
    const agree = v.samples.filter((s: any) => s.verdict === v.verdict).length;
    return `${tool} (agreement ${((v.agreement ?? 0) * 100).toFixed(0)}%, ${agree}/${total} samples${v.overridden ? ', overridden' : ''})`;
  }
  return tool;
}

/** Human label for how a runtime leak correlated to its candidate. */
export function correlationText(method?: string): string {
  if (method === 'file_line_exact' || method === 'file_line_near' || method === 'function_match') return 'LINKED';
  if (method === 'file_only') return 'file-only';
  return 'unlinked';
}

const COVERAGE_TEXT: Record<string, string> = {
  exercised_leak: 'exercised — leak observed',
  exercised_clean: 'exercised — clean',
  not_exercised: 'not exercised',
  dynamic_off: 'dynamic off',
};

/** Honest dynamic-coverage label (what the runtime stage actually established). */
export function coverageText(cov?: string): string {
  return COVERAGE_TEXT[cov || 'dynamic_off'] || cov || 'dynamic off';
}

// ── Severity ────────────────────────────────────────────────────────────────

export function severityBadge(confidence: number): string {
  if (confidence >= 0.8) return 'Critical';
  if (confidence >= 0.6) return 'High';
  if (confidence >= 0.4) return 'Medium';
  return 'Low';
}

export function severityColor(confidence: number): string {
  if (confidence >= 0.8) return '#dc3545';
  if (confidence >= 0.6) return '#fd7e14';
  if (confidence >= 0.4) return '#ffc107';
  return '#6c757d';
}

export function verdictIcon(verdict: string): string {
  if (verdict === 'confirmed_leak') return '🔴';
  if (verdict === 'likely_leak') return '🟠';
  if (verdict === 'uncertain') return '🟡';
  return '🟢';
}
