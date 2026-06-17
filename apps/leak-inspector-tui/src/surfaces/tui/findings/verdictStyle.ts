/**
 * Shared verdict icon/color map — lifted out of App.tsx so the findings table, the
 * verdict-detail card, and the legacy log path all render verdicts identically.
 */
import { color } from '../theme';
import type { FindingEvidenceView } from './findingView';

const VERDICT_STYLE: Record<string, { icon: string; color: string }> = {
  confirmed_leak: { icon: '🔴', color: color.error },
  likely_leak: { icon: '🟠', color: color.warning },
  uncertain: { icon: '🟡', color: color.warning },
  likely_false_positive: { icon: '🟢', color: color.success },
  false_positive: { icon: '🟢', color: color.success },
};

export function verdictStyle(verdict: string): { icon: string; color: string } {
  return VERDICT_STYLE[verdict] ?? { icon: '⚪', color: color.subtle };
}

/** A short chip for the dynamic coverage status (table cell + card badge). */
export function coverageBadge(cov?: string): { label: string; color: string } {
  switch (cov) {
    case 'exercised_leak':
      return { label: 'leak', color: color.error };
    case 'exercised_clean':
      return { label: 'clean', color: color.success };
    case 'not_exercised':
      return { label: 'not-run', color: color.subtle };
    default:
      return { label: 'dyn-off', color: color.subtle };
  }
}

/** A short chip for which judge produced the verdict. */
export function judgeChip(tool?: string): { label: string; color: string } {
  switch (tool) {
    case 'consensus':
      return { label: 'consensus', color: color.accent };
    case 'llm':
      return { label: 'llm', color: color.system };
    case 'heuristic':
      return { label: 'heuristic', color: color.subtle };
    default:
      return { label: tool || '—', color: color.subtle };
  }
}

/** How a runtime leak correlated to this candidate — LINKED (decisive) vs file-only (weak). */
export function correlationLabel(method?: string): { label: string; color: string } {
  if (method === 'file_line_exact' || method === 'file_line_near' || method === 'function_match')
    return { label: 'LINKED', color: color.error };
  if (method === 'file_only') return { label: 'file-only', color: color.warning };
  return { label: 'unlinked', color: color.subtle };
}

const LINKED_METHODS = new Set(['file_line_exact', 'file_line_near', 'function_match']);

/**
 * The strongest correlation across a finding's runtime evidence, for the table's
 * one-glance chip: any LINKED beats any file-only beats unlinked. Returns null when
 * there is no runtime evidence at all (column left blank).
 */
export function bestCorrelation(evidence: Pick<FindingEvidenceView, 'correlationMethod'>[]): { label: string; color: string } | null {
  if (!evidence.length) return null;
  const methods = evidence.map((e) => e.correlationMethod);
  if (methods.some((m) => m && LINKED_METHODS.has(m))) return correlationLabel('file_line_exact');
  if (methods.some((m) => m === 'file_only')) return correlationLabel('file_only');
  return correlationLabel(undefined);
}

/**
 * Consensus self-consistency at a glance: filled boxes for samples that matched the
 * final verdict, hollow for the dissenters, e.g. `▣▣▣▢▢ 3/5`. Empty string when
 * there are no recorded samples (heuristic-only verdicts).
 */
export function samplesSparkline(samples: { verdict: string }[], finalVerdict: string): string {
  const total = samples.length;
  if (!total) return '';
  const agree = samples.filter((s) => s.verdict === finalVerdict).length;
  return '▣'.repeat(agree) + '▢'.repeat(Math.max(0, total - agree)) + ` ${agree}/${total}`;
}
