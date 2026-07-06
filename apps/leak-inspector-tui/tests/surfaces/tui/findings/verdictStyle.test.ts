import { describe, expect, test } from 'bun:test';
import { bestCorrelation, samplesSparkline, confidenceMeter, coverageBadge, judgeChip, correlationLabel } from '../../../../src/surfaces/tui/findings/verdictStyle';

describe('bestCorrelation', () => {
  test('any LINKED method wins over file-only', () => {
    const r = bestCorrelation([{ correlationMethod: 'file_only' }, { correlationMethod: 'file_line_exact' }]);
    expect(r?.label).toBe('LINKED');
  });
  test('file-only when no decisive link', () => {
    expect(bestCorrelation([{ correlationMethod: 'file_only' }])?.label).toBe('file-only');
  });
  test('unlinked when evidence has no usable method', () => {
    expect(bestCorrelation([{ correlationMethod: undefined }])?.label).toBe('unlinked');
  });
  test('null when there is no runtime evidence (blank cell)', () => {
    expect(bestCorrelation([])).toBeNull();
  });
});

describe('samplesSparkline', () => {
  test('fills boxes for samples matching the final verdict', () => {
    const samples = [{ verdict: 'confirmed_leak' }, { verdict: 'confirmed_leak' }, { verdict: 'likely_leak' }];
    expect(samplesSparkline(samples, 'confirmed_leak')).toBe('▣▣▢ 2/3');
  });
  test('empty string when no samples (heuristic-only)', () => {
    expect(samplesSparkline([], 'confirmed_leak')).toBe('');
  });
});

describe('confidenceMeter', () => {
  test('fills cells proportionally and stays fixed-width', () => {
    expect(confidenceMeter(0.9)).toBe('▰▰▰▰▱');
    expect(confidenceMeter(1)).toBe('▰▰▰▰▰');
    expect(confidenceMeter(0)).toBe('▱▱▱▱▱');
    expect(confidenceMeter(0.5).length).toBe(5);
  });
  test('clamps out-of-range + non-finite', () => {
    expect(confidenceMeter(2)).toBe('▰▰▰▰▰');
    expect(confidenceMeter(NaN)).toBe('▱▱▱▱▱');
  });
});

describe('badges', () => {
  test('coverage maps to a short chip + color', () => {
    expect(coverageBadge('exercised_leak').label).toBe('leak');
    expect(coverageBadge('exercised_clean').label).toBe('clean');
    expect(coverageBadge(undefined).label).toBe('dyn-off');
  });
  test('judge chip names the deciding tool', () => {
    expect(judgeChip('consensus').label).toBe('consensus');
    expect(judgeChip(undefined).label).toBe('—');
  });
  test('correlationLabel flags decisive links', () => {
    expect(correlationLabel('function_match').label).toBe('LINKED');
    expect(correlationLabel('file_only').label).toBe('file-only');
  });
});
