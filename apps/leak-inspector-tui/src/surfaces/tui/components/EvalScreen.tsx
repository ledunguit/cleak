/**
 * Full-screen benchmark dashboard (the 'eval' view). Three tabs:
 *   Overview — live aggregate Precision/Recall/F1 + confusion + (on finish)
 *              per-variant breakdown, ECE, cost.
 *   Cases    — the live per-case list: status, current phase, TP/FP/FN.
 *   Detail   — the selected case's ground-truth vs findings comparison.
 * Owns its keys while view === 'eval'. Cases run in PARALLEL (see header
 * "N parallel"); the aggregate is summed live and finalized once at the end.
 */

import { useEffect, useMemo, useState } from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Box, Text, useInput } from 'ink';
import { color, glyph } from '../theme';
import { classifyFinding, isFlagged, type LabeledCase, type SnapshotFinding } from '../../../domain/evalScoring';
import type { TuiStore } from '../store';
import type { EvalUiState, EvalCaseUi } from '../store';

/** Color a steps.md log line by its leading marker (thinking / tool / result). */
function logLineColor(line: string): string | undefined {
  if (line.startsWith('> 💭') || line.includes('thinking:')) return color.system;
  if (line.startsWith('🔧')) return color.accent;
  if (line.startsWith('↳') || line.startsWith('```')) return color.subtle;
  if (line.startsWith('## ') || line.startsWith('# ')) return color.accent;
  return undefined;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const shortId = (id: string) => id.replace(/^CWE\d+_[A-Za-z]+_[A-Za-z]+__?/, '').replace(/_/g, ' ').trim() || id;
const elapsed = (from?: number, to?: number) => (from ? Math.round(((to ?? Date.now()) - from) / 1000) : 0);

interface Conf {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}
function aggregate(cases: EvalCaseUi[]): Conf {
  return cases.reduce(
    (a, c) => ({ tp: a.tp + c.tp, fp: a.fp + c.fp, fn: a.fn + c.fn, tn: a.tn + c.tn }),
    { tp: 0, fp: 0, fn: 0, tn: 0 },
  );
}
function prf(cm: Conf) {
  const precision = cm.tp + cm.fp > 0 ? cm.tp / (cm.tp + cm.fp) : 0;
  const recall = cm.tp + cm.fn > 0 ? cm.tp / (cm.tp + cm.fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const total = cm.tp + cm.fp + cm.fn + cm.tn;
  const accuracy = total > 0 ? (cm.tp + cm.tn) / total : 0;
  return { precision, recall, f1, accuracy };
}

const STATUS_GLYPH: Record<EvalCaseUi['status'], { ch: string; color: string }> = {
  pending: { ch: '○', color: color.subtle },
  running: { ch: '⟳', color: color.accent },
  ok: { ch: '✓', color: color.success },
  error: { ch: '✗', color: color.error },
  skipped: { ch: '⊘', color: color.warning },
};

export function EvalScreen({
  store,
  evalState,
  resultsDir,
}: {
  store: TuiStore;
  evalState: EvalUiState;
  resultsDir: string;
}) {
  // Tick so elapsed timers + running phases stay live between store updates.
  const [, force] = useState(0);
  useEffect(() => {
    if (!evalState.running) return;
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [evalState.running]);

  const selected =
    evalState.cases.find((c) => c.id === evalState.selectedId) ?? evalState.cases[evalState.cursor];

  // The selected case's investigation log (steps.md). Written when the case
  // finishes — read on demand, re-read when its status flips to done.
  const logLines = useMemo<string[]>(() => {
    if (evalState.tab !== 'detail' || !selected?.scanId) return [];
    const p = join(resultsDir, selected.scanId, 'steps.md');
    if (!existsSync(p)) return [];
    try {
      return readFileSync(p, 'utf-8').split('\n');
    } catch {
      return [];
    }
  }, [evalState.tab, selected?.scanId, selected?.status, resultsDir]);

  const logRows = Math.max(6, (process.stdout.rows ?? 30) - 20);
  const maxScroll = Math.max(0, logLines.length - logRows);
  const [logScroll, setLogScroll] = useState(0);
  // Reset the log scroll to the latest (tail) when the case changes.
  useEffect(() => setLogScroll(0), [selected?.id]);

  useInput((input, key) => {
    if (key.escape) {
      // First Esc while running = cancel (skip pending, abort in-flight, still
      // report what finished). Esc again (or when done) leaves the screen.
      if (evalState.running && !evalState.cancelling) return store.evalAbort();
      return store.evalExit();
    }
    if (key.tab) return store.evalCycleTab(key.shift ? -1 : 1);
    if (key.leftArrow) return store.evalCycleTab(-1);
    if (key.rightArrow) return store.evalCycleTab(1);
    if (input === '1') return store.evalSetTab('overview');
    if (input === '2') return store.evalSetTab('cases');
    if (input === '3') return store.evalSetTab('detail');
    if (evalState.tab === 'cases') {
      if (key.upArrow) return store.evalMove(-1);
      if (key.downArrow) return store.evalMove(1);
      if (key.return) return store.evalOpenDetail();
    } else if (evalState.tab === 'detail') {
      // Scroll the investigation log (offset from the tail; 0 = latest).
      if (key.upArrow) return setLogScroll((s) => Math.min(maxScroll, s + 1));
      if (key.downArrow) return setLogScroll((s) => Math.max(0, s - 1));
      if (key.pageUp) return setLogScroll((s) => Math.min(maxScroll, s + logRows));
      if (key.pageDown) return setLogScroll((s) => Math.max(0, s - logRows));
    }
  });

  return (
    <Box flexDirection="column">
      <Header s={evalState} />
      <TabBar tab={evalState.tab} />
      <Box flexDirection="column" marginTop={1}>
        {evalState.tab === 'overview' && <Overview s={evalState} />}
        {evalState.tab === 'cases' && <Cases s={evalState} />}
        {evalState.tab === 'detail' && (
          <Detail s={evalState} selected={selected} logLines={logLines} logRows={logRows} logScroll={logScroll} />
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Tab/←→ switch {glyph.bullet}{' '}
          {evalState.tab === 'detail' ? '↑/↓ scroll log' : '↑/↓ select · Enter detail'} {glyph.bullet} 1/2/3 tab{' '}
          {glyph.bullet} {evalState.running ? 'Esc cancel (keeps finished cases)' : 'Esc exit'}
        </Text>
      </Box>
    </Box>
  );
}

function Header({ s }: { s: EvalUiState }) {
  const secs = elapsed(s.startedAt, s.finishedAt);
  const errors = s.cases.filter((c) => c.status === 'error').length;
  const running = s.cases.filter((c) => c.status === 'running').length;
  const skipped = s.cases.filter((c) => c.status === 'skipped').length;
  const stateLabel = s.cancelling ? 'cancelling…' : s.running ? 'running' : 'done';
  const stateColor = s.cancelling ? color.warning : s.running ? color.accent : color.success;
  return (
    <Box flexDirection="column">
      <Text color={color.accent} bold>
        {glyph.star} EVAL {s.corpus}
      </Text>
      <Text dimColor>
        {s.mode} {glyph.bullet} dynamic {s.dynamic} {glyph.bullet} {s.done}/{s.total} {glyph.bullet} {s.concurrency} parallel{' '}
        {glyph.bullet} {running} running {glyph.bullet} {errors} err {glyph.bullet} {skipped} skipped {glyph.bullet} {secs}s{' '}
        {glyph.bullet} <Text color={stateColor}>{stateLabel}</Text>
      </Text>
    </Box>
  );
}

function TabBar({ tab }: { tab: EvalUiState['tab'] }) {
  const tabs: Array<[EvalUiState['tab'], string]> = [
    ['overview', 'Overview'],
    ['cases', 'Cases'],
    ['detail', 'Detail'],
  ];
  return (
    <Box marginTop={1}>
      <Text>
        {tabs.map(([key, label], i) => (
          <Text key={key}>
            {i > 0 ? <Text dimColor> | </Text> : null}
            <Text
              color={key === tab ? color.accent : color.subtle}
              bold={key === tab}
              underline={key === tab}
            >
              {label}
            </Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}

function Overview({ s }: { s: EvalUiState }) {
  const cm = aggregate(s.cases);
  const m = prf(cm);
  const byFunc = s.result?.byFunctionalVariant;
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={color.subtle}>Precision </Text>
        <Text bold>{pct(m.precision)}</Text>
        <Text color={color.subtle}> {glyph.bullet} Recall </Text>
        <Text bold>{pct(m.recall)}</Text>
        <Text color={color.subtle}> {glyph.bullet} F1 </Text>
        <Text bold color={color.accent}>{pct(m.f1)}</Text>
        <Text color={color.subtle}> {glyph.bullet} Acc </Text>
        <Text bold>{pct(m.accuracy)}</Text>
      </Text>
      <Text color={color.subtle}>
        Confusion: TP {cm.tp} {glyph.bullet} FP {cm.fp} {glyph.bullet} FN {cm.fn} {glyph.bullet} TN {cm.tn}
        {s.result ? <Text> {glyph.bullet} ECE {s.result.ece.toFixed(3)}</Text> : null}
      </Text>
      {s.result ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={color.subtle}>By functional variant (final):</Text>
          {Object.entries(byFunc ?? {}).slice(0, 12).map(([k, v]) => (
            <Text key={k}>
              {'  '}
              <Text color={color.system}>{k.padEnd(12)}</Text> P {pct(v.precision)} {glyph.bullet} R {pct(v.recall)}{' '}
              {glyph.bullet} F1 {pct(v.f1)}
            </Text>
          ))}
          <Text color={color.subtle}>
            cost: {s.result.cost.meanDurationMs}ms/case {glyph.bullet} {s.result.cost.totalTokens} tokens {glyph.bullet}{' '}
            artifacts in {s.outDir}
          </Text>
        </Box>
      ) : (
        <Text dimColor>(per-variant breakdown + calibration finalize when all cases complete)</Text>
      )}
    </Box>
  );
}

function caseLine(c: EvalCaseUi, selected: boolean) {
  const g = STATUS_GLYPH[c.status];
  const right =
    c.status === 'running'
      ? `${glyph.pointer} ${c.phase ?? 'starting'}  ${elapsed(c.startedAt)}s`
      : c.status === 'pending'
        ? 'pending'
        : c.status === 'skipped'
          ? 'skipped (cancelled)'
          : c.status === 'error'
            ? `error: ${(c.error ?? '').slice(0, 28)}`
            : `TP${c.tp} FP${c.fp} FN${c.fn}  ${Math.round((c.durationMs ?? 0) / 1000)}s`;
  return (
    <Text key={c.id}>
      <Text color={selected ? color.accent : color.subtle}>{selected ? glyph.pointer : ' '} </Text>
      <Text color={g.color}>{g.ch} </Text>
      <Text color={selected ? undefined : color.subtle}>{shortId(c.id).slice(0, 30).padEnd(30)}</Text>
      <Text color={c.status === 'error' ? color.error : color.system}> {right}</Text>
    </Text>
  );
}

function Cases({ s }: { s: EvalUiState }) {
  const rows = Math.max(5, (process.stdout.rows ?? 30) - 12);
  const n = s.cases.length;
  const start = Math.max(0, Math.min(Math.max(0, n - rows), s.cursor - Math.floor(rows / 2)));
  const window = s.cases.slice(start, start + rows);
  return (
    <Box flexDirection="column">
      {window.map((c) => caseLine(c, s.cases[s.cursor]?.id === c.id))}
      {n > rows ? (
        <Text dimColor>
          {'  '}showing {start + 1}–{Math.min(n, start + rows)} of {n}
        </Text>
      ) : null}
    </Box>
  );
}

function Detail({
  s,
  selected,
  logLines,
  logRows,
  logScroll,
}: {
  s: EvalUiState;
  selected?: EvalCaseUi;
  logLines: string[];
  logRows: number;
  logScroll: number;
}) {
  const c = selected;
  if (!c) return <Text dimColor>no case selected — go to Cases and press Enter</Text>;
  const labeled: LabeledCase = { id: c.id, repo_path: '', flaws: c.flaws ?? [], clean: c.clean ?? [] };
  const findings = c.findings ?? [];
  const m = prf({ tp: c.tp, fp: c.fp, fn: c.fn, tn: c.tn });
  const caught = findings.some((f) => classifyFinding(f, labeled) === 'bad' && isFlagged(f.verdict));

  const classify = (f: SnapshotFinding): { mark: string; col: string } => {
    const predicted = isFlagged(f.verdict);
    const actual = classifyFinding(f, labeled);
    if (actual === 'bad' && predicted) return { mark: 'TP', col: color.success };
    if (actual === 'good' && predicted) return { mark: 'FP', col: color.error };
    if (actual === 'bad' && !predicted) return { mark: 'FN', col: color.error };
    if (actual === 'good' && !predicted) return { mark: 'TN', col: color.subtle };
    return { mark: '—', col: color.subtle };
  };

  // Log window: offset from the tail (logScroll 0 = latest lines).
  const end = Math.max(0, logLines.length - logScroll);
  const start = Math.max(0, end - logRows);
  const win = logLines.slice(start, end);
  const w = Math.max(40, (process.stdout.columns ?? 100) - 2);

  return (
    <Box flexDirection="column">
      {/* compact summary so the log gets most of the screen */}
      <Text>
        <Text color={STATUS_GLYPH[c.status].color}>{STATUS_GLYPH[c.status].ch} </Text>
        <Text bold>{shortId(c.id)}</Text>
        <Text color={color.subtle}> {glyph.bullet} {c.status}{c.scanId ? ` ${glyph.bullet} ${c.scanId}` : ''}</Text>
      </Text>
      <Text color={color.subtle}>
        P {pct(m.precision)} {glyph.bullet} R {pct(m.recall)} {glyph.bullet} F1 {pct(m.f1)} {glyph.bullet} TP{c.tp} FP{c.fp}{' '}
        FN{c.fn} TN{c.tn} {glyph.bullet} flaw{' '}
        <Text color={caught ? color.success : color.error}>{caught ? 'caught' : 'missed'}</Text> {glyph.bullet} findings:{' '}
        {findings.map((f) => `${classify(f).mark} ${f.function ?? '?'}@${f.line ?? '?'}`).slice(0, 4).join('  ') || '(none)'}
      </Text>

      {/* investigation log (steps.md) */}
      <Box flexDirection="column" marginTop={1}>
        <Text color={color.system}>
          Investigation log {logLines.length ? <Text color={color.subtle}>(lines {start + 1}–{end} of {logLines.length} · ↑/↓ scroll)</Text> : null}
        </Text>
        {logLines.length === 0 ? (
          <Text dimColor>
            {'  '}
            {c.status === 'running'
              ? '(log is written when the case finishes — watch the phase in Cases)'
              : c.scanId
                ? '(no steps.md — no_llm mode keeps no agent log; see /report)'
                : '(case has not run yet)'}
          </Text>
        ) : (
          win.map((line, i) => (
            <Text key={start + i} color={logLineColor(line)}>
              {(line || ' ').slice(0, w)}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
