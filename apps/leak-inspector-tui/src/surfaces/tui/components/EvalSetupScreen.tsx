/**
 * Interactive eval-setup wizard — the picker that replaces having to already
 * know the exact corpus path and type every flag by hand (`/eval <path> [limit]
 * [c=N] [--resume]`). Same field-list form pattern `ConfigScreen.tsx` already
 * establishes (↑/↓ row nav, ←/→ or Enter cycles/edits, no new UI paradigm, no
 * new dependency) — `l` launches instead of `s` saves.
 */

import { useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useStore } from 'zustand';
import { color, glyph } from '../theme';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { discoverCorpora, type CorpusInfo } from '../../../domain/corpusDiscovery';
import type { TuiEvalRequest } from '../evalRunner';
import type { TuiStore } from '../../../stores';

type SamplingMode = 'sequential' | 'random' | 'stratified';

interface Draft {
  corpusIdx: number;
  sampleAll: boolean;
  limit: number;
  samplingMode: SamplingMode;
  stratifyKey: string;
  mode: 'no_llm' | 'llm_assisted';
  dynamic: 'off' | 'selective' | 'aggressive';
  concurrency: number | undefined;
  resume: boolean;
  proceedUnvalidated: boolean;
}

type FieldType = 'cycle' | 'text' | 'number';
interface FieldRow {
  key: string;
  label: string;
  type: FieldType;
  options?: Array<{ value: string | boolean | number; label: string }>;
  get: (d: Draft) => string | number | boolean;
  set: (d: Draft, v: string | number | boolean) => Draft;
  placeholder?: string;
}

const MODE_OPTIONS = [
  { value: 'llm_assisted', label: 'llm_assisted' },
  { value: 'no_llm', label: 'no_llm' },
];
const DYNAMIC_OPTIONS = [
  { value: 'off', label: 'off' },
  { value: 'selective', label: 'selective' },
  { value: 'aggressive', label: 'aggressive' },
];
const SAMPLING_OPTIONS: Array<{ value: SamplingMode; label: string }> = [
  { value: 'sequential', label: 'Sequential (first N)' },
  { value: 'random', label: 'Random (seeded — reproducible)' },
  { value: 'stratified', label: 'Stratified (evenly by variant)' },
];
const ONOFF = [
  { value: false, label: 'off' },
  { value: true, label: 'on' },
];

function gateGlyph(gate: CorpusInfo['gate']): string {
  return gate.ok ? `${glyph.tick} validated` : `${glyph.cross} ${gate.reason ?? 'unvalidated'}`;
}

/** Field list depends on the current draft (corpus/sample-size/sampling-mode
 * gate which follow-on fields are even meaningful) — recomputed each render,
 * not a static array like ConfigScreen's (whose fields never hide each other). */
function buildFields(corpora: CorpusInfo[], draft: Draft): FieldRow[] {
  const selected = corpora[draft.corpusIdx];
  const fields: FieldRow[] = [
    {
      key: 'corpus',
      label: 'Corpus',
      type: 'cycle',
      options: corpora.map((c, i) => ({ value: i, label: `${c.name} (${c.caseCount} cases) — ${gateGlyph(c.gate)}` })),
      get: (d) => d.corpusIdx,
      set: (d, v) => ({ ...d, corpusIdx: Number(v) }),
    },
    {
      key: 'sampleAll',
      label: 'Sample size',
      type: 'cycle',
      options: [
        { value: true, label: 'All cases' },
        { value: false, label: 'N cases' },
      ],
      get: (d) => d.sampleAll,
      set: (d, v) => ({ ...d, sampleAll: Boolean(v) }),
    },
  ];
  if (!draft.sampleAll) {
    fields.push({
      key: 'limit',
      label: '  Sample count (N)',
      type: 'number',
      get: (d) => d.limit,
      set: (d, v) => ({ ...d, limit: Math.max(1, Number(v) || 1) }),
      placeholder: '50',
    });
    fields.push({
      key: 'samplingMode',
      label: '  Sampling mode',
      type: 'cycle',
      options: SAMPLING_OPTIONS,
      get: (d) => d.samplingMode,
      set: (d, v) => ({ ...d, samplingMode: v as SamplingMode }),
    });
    if (draft.samplingMode === 'stratified') {
      fields.push({
        key: 'stratifyKey',
        label: '    Stratify by (case field)',
        type: 'text',
        get: (d) => d.stratifyKey,
        set: (d, v) => ({ ...d, stratifyKey: String(v) }),
        placeholder: 'functionalVariant',
      });
    }
  }
  fields.push(
    { key: 'mode', label: 'Analysis mode', type: 'cycle', options: MODE_OPTIONS, get: (d) => d.mode, set: (d, v) => ({ ...d, mode: v as Draft['mode'] }) },
    { key: 'dynamic', label: 'Dynamic analysis', type: 'cycle', options: DYNAMIC_OPTIONS, get: (d) => d.dynamic, set: (d, v) => ({ ...d, dynamic: v as Draft['dynamic'] }) },
    {
      key: 'concurrency',
      label: 'Concurrency',
      type: 'number',
      get: (d) => d.concurrency ?? 0,
      set: (d, v) => ({ ...d, concurrency: Number(v) > 0 ? Number(v) : undefined }),
      placeholder: draft.mode === 'no_llm' ? '6 (default)' : '3 (default)',
    },
    { key: 'resume', label: 'Resume (reuse cached results)', type: 'cycle', options: ONOFF, get: (d) => d.resume, set: (d, v) => ({ ...d, resume: Boolean(v) }) },
  );
  if (selected && !selected.gate.ok) {
    fields.push({
      key: 'proceedUnvalidated',
      label: `${glyph.cross} Proceed UNVALIDATED (numbers not verified)`,
      type: 'cycle',
      options: ONOFF,
      get: (d) => d.proceedUnvalidated,
      set: (d, v) => ({ ...d, proceedUnvalidated: Boolean(v) }),
    });
  }
  return fields;
}

export function EvalSetupScreen({
  store,
  launchEval,
  onCancel,
}: {
  store: TuiStore;
  launchEval: (req: TuiEvalRequest) => boolean;
  onCancel: () => void;
}) {
  const snapMode = useStore(store, (s) => s.mode);
  const snapDynamic = useStore(store, (s) => s.dynamic);
  const { rows: termRows } = useTerminalSize();
  const corpora = useMemo(() => discoverCorpora(), []);

  const [draft, setDraft] = useState<Draft>({
    corpusIdx: 0,
    sampleAll: true,
    limit: 50,
    samplingMode: 'sequential',
    stratifyKey: 'functionalVariant',
    mode: snapMode,
    dynamic: snapDynamic,
    concurrency: undefined,
    resume: false,
    proceedUnvalidated: false,
  });
  const [row, setRow] = useState(0);
  const [editing, setEditing] = useState(false);
  const [buffer, setBuffer] = useState('');
  const [errorFlash, setErrorFlash] = useState<string | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fields = useMemo(() => buildFields(corpora, draft), [corpora, draft]);
  const clampedRow = Math.min(row, Math.max(0, fields.length - 1));
  const selectedCorpus = corpora[draft.corpusIdx];

  const flashError = (msg: string) => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setErrorFlash(msg);
    errorTimer.current = setTimeout(() => setErrorFlash(null), 3000);
  };

  const cycle = (dir: 1 | -1) => {
    const field = fields[clampedRow];
    if (field.type !== 'cycle' || !field.options) return;
    const cur = field.options.findIndex((o) => o.value === field.get(draft));
    const next = field.options[(cur + dir + field.options.length) % field.options.length];
    setDraft((d) => field.set(d, next.value));
  };

  const startEdit = () => {
    const field = fields[clampedRow];
    const v = field.get(draft);
    setBuffer(v === undefined ? '' : String(v));
    setEditing(true);
  };
  const commitEdit = () => {
    const field = fields[clampedRow];
    setDraft((d) => field.set(d, buffer.trim()));
    setEditing(false);
  };

  const launch = () => {
    if (corpora.length === 0) return;
    if (selectedCorpus && !selectedCorpus.gate.ok && !draft.proceedUnvalidated) {
      flashError(`corpus is unvalidated — toggle "Proceed UNVALIDATED" on to run anyway`);
      return;
    }
    const req: TuiEvalRequest = {
      corpus: selectedCorpus.dir,
      mode: draft.mode,
      dynamic: draft.dynamic,
      limit: draft.sampleAll ? undefined : draft.limit,
      concurrency: draft.concurrency,
      resume: draft.resume,
      ...(!draft.sampleAll && draft.samplingMode === 'random' ? { randomSeed: Math.floor(Math.random() * 1e9) } : {}),
      ...(!draft.sampleAll && draft.samplingMode === 'stratified' ? { stratify: draft.stratifyKey } : {}),
      ...(!selectedCorpus.gate.ok && draft.proceedUnvalidated ? { allowUnvalidated: true } : {}),
    };
    launchEval(req);
  };

  useInput((input, key) => {
    if (editing) {
      if (key.return) return commitEdit();
      if (key.escape) return setEditing(false);
      if (key.backspace || key.delete) return setBuffer((b) => b.slice(0, -1));
      if (input && !key.ctrl && !key.meta && !key.tab) setBuffer((b) => b + input);
      return;
    }
    if (key.escape) return onCancel();
    if (input === 'l') return launch();
    if (corpora.length === 0) return;
    if (key.upArrow) return setRow((r) => (r - 1 + fields.length) % fields.length);
    if (key.downArrow) return setRow((r) => (r + 1) % fields.length);
    const field = fields[clampedRow];
    if (!field) return;
    if (field.type === 'cycle') {
      if (key.leftArrow) cycle(-1);
      else if (key.rightArrow || key.return) cycle(1);
    } else if (key.return || input === 'e') {
      startEdit();
    }
  });

  if (corpora.length === 0) {
    return (
      <Box flexDirection="column" width="100%" height="100%" paddingX={1}>
        <Text color={color.accent} bold>{glyph.star} Eval setup</Text>
        <Text color={color.warning}>No corpora found under demo/ — see docs/DATASETS.md to ingest one first.</Text>
        <Text dimColor>Esc to go back.</Text>
      </Box>
    );
  }

  const viewportRows = Math.max(6, termRows - 10);
  const scrollOffset = Math.max(0, clampedRow - viewportRows + 2);
  const visibleFields = fields.slice(scrollOffset, scrollOffset + viewportRows);

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Box flexShrink={0} flexDirection="column">
        <Box>
          <Text color={color.accent} bold>{glyph.star} Eval setup</Text>
          <Text dimColor> — configure a corpus evaluation run</Text>
        </Box>
        <Text dimColor>
          {glyph.arrowUp}{glyph.arrowDown} navigate {glyph.bullet} ←/→ change {glyph.bullet} Enter edit {glyph.bullet}{' '}
          <Text color={color.accent}>l</Text> launch {glyph.bullet} <Text color={color.accent}>Esc</Text> cancel
        </Text>
      </Box>

      <Box flexGrow={1} flexDirection="column" marginTop={1} overflow="hidden">
        {visibleFields.map((f) => {
          const i = fields.indexOf(f);
          const selected = i === clampedRow;
          const isEditing = selected && editing;
          let shown: string;
          if (f.type === 'cycle') {
            const v = f.get(draft);
            shown = f.options?.find((o) => o.value === v)?.label ?? String(v ?? '');
          } else {
            const raw = isEditing ? buffer : String(f.get(draft) ?? '');
            shown = raw || (isEditing ? '' : f.placeholder ?? '');
          }
          return (
            <Text key={f.key}>
              <Text color={selected ? color.accent : color.subtle} bold={selected}>{selected ? ` ${glyph.pointer} ` : '   '}</Text>
              <Text color={selected ? undefined : color.subtle}>{f.label.padEnd(42)}</Text>
              <Text color={isEditing ? color.warning : selected ? color.accent : color.system} bold={selected}>
                {' '}{shown}{isEditing ? <Text color={color.warning}>▌</Text> : null}
              </Text>
            </Text>
          );
        })}
      </Box>

      <Box flexShrink={0} flexDirection="column" marginTop={1} borderStyle="single" borderColor={color.subtle} paddingX={1}>
        {errorFlash ? (
          <Text color={color.error}>{glyph.cross} {errorFlash}</Text>
        ) : selectedCorpus && !selectedCorpus.gate.ok ? (
          <Text color={color.warning}>{glyph.cross} {selectedCorpus.name}: {selectedCorpus.gate.reason}</Text>
        ) : (
          <Text dimColor>{corpora.length} corpora discovered under demo/</Text>
        )}
      </Box>
    </Box>
  );
}
