import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { color, glyph } from '../theme';
import type { Provider } from '../../../config';
import { configFilePath, type CleakConfig, type EndpointOverride } from '../../../domain/config-file';

type FieldType = 'cycle' | 'text' | 'secret' | 'number';

interface FieldDef {
  section: string;
  path: string;
  label: string;
  type: FieldType;
  scope: 'config' | 'endpoint';
  options?: Array<{ value: string | boolean; label: string }>;
  placeholder?: string;
}

const PROVIDER_OPTIONS = [
  { value: 'local', label: 'local gateway' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai-compat', label: 'OpenAI-compatible (custom)' },
];
const MODE_OPTIONS = [
  { value: 'llm_assisted', label: 'llm_assisted' },
  { value: 'no_llm', label: 'no_llm' },
];
const DYNAMIC_OPTIONS = [
  { value: 'off', label: 'off' },
  { value: 'selective', label: 'selective' },
  { value: 'aggressive', label: 'aggressive' },
];
const ONOFF = [
  { value: false, label: 'off' },
  { value: true, label: 'on' },
];
const SIDEBAR_POS = [
  { value: 'left', label: 'left' },
  { value: 'right', label: 'right' },
];
const RULE_OPTIONS = [
  { value: 'weighted', label: 'weighted' },
  { value: 'majority', label: 'majority' },
  { value: 'unanimous-to-flag', label: 'unanimous-to-flag' },
];

const FIELDS: FieldDef[] = [
  { section: 'Session defaults', path: 'defaultMode', label: 'Default analysis mode', type: 'cycle', scope: 'config', options: MODE_OPTIONS },
  { section: 'Session defaults', path: 'defaultDynamic', label: 'Default dynamic analysis', type: 'cycle', scope: 'config', options: DYNAMIC_OPTIONS },
  { section: 'Session defaults', path: 'autoShowReport', label: 'Auto-show report when a scan finishes', type: 'cycle', scope: 'config', options: ONOFF },

  { section: 'Provider', path: 'provider', label: 'LLM provider', type: 'cycle', scope: 'config', options: PROVIDER_OPTIONS },
  { section: 'Provider', path: 'baseUrl', label: 'Base URL', type: 'text', scope: 'endpoint', placeholder: '(env / default)' },
  { section: 'Provider', path: 'model', label: 'Model', type: 'text', scope: 'endpoint', placeholder: '(env / default)' },
  { section: 'Provider', path: 'apiKey', label: 'API key', type: 'secret', scope: 'endpoint', placeholder: '(env / default)' },

  { section: 'Analyzers', path: 'staticUrl', label: 'Static analyzer MCP URL', type: 'text', scope: 'config', placeholder: 'http://localhost:50061/mcp' },
  { section: 'Analyzers', path: 'dynamicUrl', label: 'Dynamic analyzer MCP URL', type: 'text', scope: 'config', placeholder: 'http://localhost:50062/mcp' },

  { section: 'Paths & output', path: 'hostRoot', label: 'Host root (Docker path mapping)', type: 'text', scope: 'config', placeholder: '(unset)' },
  { section: 'Paths & output', path: 'analyzerRoot', label: 'Analyzer root (e.g. /workspace)', type: 'text', scope: 'config', placeholder: '(unset)' },
  { section: 'Paths & output', path: 'resultsDir', label: 'Results directory', type: 'text', scope: 'config', placeholder: 'results' },
  { section: 'Paths & output', path: 'maxTurns', label: 'Agent max turns', type: 'number', scope: 'config', placeholder: '15' },

  { section: 'LLM tuning', path: 'llm.temperature', label: 'Temperature', type: 'number', scope: 'config', placeholder: '0' },
  { section: 'LLM tuning', path: 'llm.judgeTemperature', label: 'Judge temperature', type: 'number', scope: 'config', placeholder: '0' },
  { section: 'LLM tuning', path: 'llm.maxTokens', label: 'Max tokens', type: 'number', scope: 'config', placeholder: '4096' },
  { section: 'LLM tuning', path: 'llm.timeoutMs', label: 'Request timeout (ms)', type: 'number', scope: 'config', placeholder: '75000' },
  { section: 'LLM tuning', path: 'llm.idleTimeoutMs', label: 'Idle timeout (ms)', type: 'number', scope: 'config', placeholder: '75000' },
  { section: 'LLM tuning', path: 'llm.connectTimeoutMs', label: 'Connect timeout (ms)', type: 'number', scope: 'config', placeholder: '30000' },
  { section: 'LLM tuning', path: 'llm.retries', label: 'Retries', type: 'number', scope: 'config', placeholder: '2' },
  { section: 'LLM tuning', path: 'llm.jsonMode', label: 'JSON mode', type: 'cycle', scope: 'config', options: ONOFF },

  { section: 'Workflow', path: 'workflow.staticConcurrency', label: 'Static sub-agent concurrency', type: 'number', scope: 'config', placeholder: '3' },
  { section: 'Workflow', path: 'workflow.staticGroupSize', label: 'Static group size', type: 'number', scope: 'config', placeholder: '4' },
  { section: 'Workflow', path: 'workflow.judgeConcurrency', label: 'Judge concurrency', type: 'number', scope: 'config', placeholder: '3' },
  { section: 'Workflow', path: 'compaction.thresholdTokens', label: 'Compaction threshold (tokens)', type: 'number', scope: 'config', placeholder: '100000' },
  { section: 'Workflow', path: 'compaction.keepRecentTurns', label: 'Compaction keep-recent turns', type: 'number', scope: 'config', placeholder: '3' },

  { section: 'Consensus judge', path: 'consensus.n', label: 'Samples (n=1 → single-LLM)', type: 'number', scope: 'config', placeholder: '1' },
  { section: 'Consensus judge', path: 'consensus.rule', label: 'Rule', type: 'cycle', scope: 'config', options: RULE_OPTIONS },
  { section: 'Consensus judge', path: 'consensus.temperature', label: 'Sampling temperature', type: 'number', scope: 'config', placeholder: '0.7' },
  { section: 'Consensus judge', path: 'consensus.concurrency', label: 'Concurrency', type: 'number', scope: 'config', placeholder: '3' },

  { section: 'UI', path: 'fullscreen', label: 'Fullscreen mode', type: 'cycle', scope: 'config', options: ONOFF },
  { section: 'UI', path: 'sidebarPosition', label: 'Sidebar position', type: 'cycle', scope: 'config', options: SIDEBAR_POS },

  { section: 'Advanced', path: 'inContainer', label: 'Running inside container', type: 'cycle', scope: 'config', options: ONOFF },
  { section: 'Advanced', path: 'staticEnrich', label: 'Static enrichment (no_llm)', type: 'cycle', scope: 'config', options: ONOFF },
  { section: 'Advanced', path: 'workflow.discoveryConcurrency', label: 'Discovery concurrency', type: 'number', scope: 'config', placeholder: '8' },
  { section: 'Advanced', path: 'thresholds.borderlineLow', label: 'Borderline low threshold', type: 'number', scope: 'config', placeholder: '0.35' },
  { section: 'Advanced', path: 'thresholds.borderlineHigh', label: 'Borderline high threshold', type: 'number', scope: 'config', placeholder: '0.7' },

  { section: 'Baselines', path: 'baselines.clangBin', label: 'clang binary path', type: 'text', scope: 'config', placeholder: 'clang' },
  { section: 'Baselines', path: 'baselines.inferBin', label: 'infer binary path', type: 'text', scope: 'config', placeholder: 'infer' },
  { section: 'Baselines', path: 'eval.staticPathMap', label: 'Eval path map (from=to)', type: 'text', scope: 'config', placeholder: '(unset)' },
];

export const activeProvider = (d: CleakConfig): Provider => (d.provider ?? 'local') as Provider;

export function getEndpointField(draft: CleakConfig, provider: Provider, key: keyof EndpointOverride): string {
  return draft.endpoints?.[provider]?.[key] ?? '';
}

export function setEndpointField(
  draft: CleakConfig, provider: Provider, key: keyof EndpointOverride, value: string,
): CleakConfig {
  const endpoints = { ...(draft.endpoints ?? {}) };
  endpoints[provider] = { ...(endpoints[provider] ?? {}), [key]: value };
  return { ...draft, endpoints };
}

function getByPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setByPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const clone: any = { ...(obj as any) };
  let cur = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    cur[k] = cur[k] && typeof cur[k] === 'object' ? { ...cur[k] } : {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return clone;
}

function getValue(draft: CleakConfig, field: FieldDef): string | boolean | undefined {
  if (field.scope === 'endpoint') return getEndpointField(draft, activeProvider(draft), field.path as keyof EndpointOverride);
  return getByPath(draft, field.path);
}

function setValue(draft: CleakConfig, field: FieldDef, value: string | boolean | number | undefined): CleakConfig {
  if (field.scope === 'endpoint') return setEndpointField(draft, activeProvider(draft), field.path as keyof EndpointOverride, String(value ?? ''));
  return setByPath(draft, field.path, value);
}

function isDraftDirty(draft: CleakConfig, initial: CleakConfig): boolean {
  return JSON.stringify(draft) !== JSON.stringify(initial);
}

export function ConfigScreen({
  initial,
  onSave,
  onCancel,
}: {
  initial: CleakConfig;
  onSave: (cfg: CleakConfig) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<CleakConfig>({ ...initial });
  const [row, setRow] = useState(0);
  const [editing, setEditing] = useState(false);
  const [buffer, setBuffer] = useState('');
  const [saveFlash, setSaveFlash] = useState(false);
  const saveFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dirty = isDraftDirty(draft, initial);

  const flashSaved = () => {
    if (saveFlashTimer.current) clearTimeout(saveFlashTimer.current);
    setSaveFlash(true);
    saveFlashTimer.current = setTimeout(() => setSaveFlash(false), 2000);
  };
  useEffect(() => () => { if (saveFlashTimer.current) clearTimeout(saveFlashTimer.current); }, []);

  const cycle = (dir: 1 | -1) => {
    const field = FIELDS[row];
    if (field.type !== 'cycle' || !field.options) return;
    const cur = field.options.findIndex((o) => o.value === getValue(draft, field));
    const next = field.options[(cur + dir + field.options.length) % field.options.length];
    setDraft((d) => setValue(d, field, next.value));
  };

  const startEdit = () => {
    const v = getValue(draft, FIELDS[row]);
    setBuffer(v === undefined || v === false ? '' : String(v));
    setEditing(true);
  };
  const commitEdit = () => {
    const field = FIELDS[row];
    const t = buffer.trim();
    if (field.type === 'number') {
      const n = t === '' ? undefined : Number(t);
      if (n !== undefined && Number.isNaN(n)) return setEditing(false);
      setDraft((d) => setValue(d, field, n));
    } else {
      setDraft((d) => setValue(d, field, t === '' && field.scope === 'config' ? undefined : t));
    }
    setEditing(false);
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
    if (input === 's') { flashSaved(); return onSave(draft); }
    if (key.upArrow) return setRow((r) => (r - 1 + FIELDS.length) % FIELDS.length);
    if (key.downArrow) return setRow((r) => (r + 1) % FIELDS.length);
    const field = FIELDS[row];
    if (field.type === 'cycle') {
      if (key.leftArrow) cycle(-1);
      else if (key.rightArrow || key.return) cycle(1);
    } else if (key.return || input === 'e') {
      startEdit();
    }
  });

  const provider = activeProvider(draft);
  const termRows = process.stdout.rows ?? 30;

  // Flat row list (section headers + field rows) for viewport scrolling.
  const rows = useMemo(() => {
    const result: Array<{ kind: 'header'; label: string } | { kind: 'field'; idx: number }> = [];
    let lastSection = '';
    for (let i = 0; i < FIELDS.length; i++) {
      const f = FIELDS[i];
      if (f.section !== lastSection) {
        result.push({ kind: 'header', label: f.section });
        lastSection = f.section;
      }
      result.push({ kind: 'field', idx: i });
    }
    return result;
  }, []);

  const selectedFlatIdx = useMemo(() => {
    return rows.findIndex((r) => r.kind === 'field' && r.idx === row);
  }, [rows, row]);

  // Overhead: header(2) + footer border(2) = 4 lines.
  const viewportRows = Math.max(8, termRows - 4);
  const scrollOffset = Math.max(0, selectedFlatIdx - viewportRows + 2);
  const visibleRows = rows.slice(scrollOffset, scrollOffset + viewportRows);

  // ── Status indicator ──
  const StatusIndicator = () => {
    if (editing) return <><Text color={color.warning} bold> ▌ editing</Text></>;
    if (saveFlash) return <><Text color={color.success} bold> ✓ saved</Text></>;
    if (dirty) return <><Text color={color.warning}> ● draft</Text></>;
    return <><Text color={color.subtle}> · clean</Text></>;
  };

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* ── Sticky header ── */}
      <Box flexShrink={0} flexDirection="column">
        <Box>
          <Text color={color.accent} bold>{glyph.star} Settings</Text>
          <Text dimColor> — {FIELDS.length} fields across {new Set(FIELDS.map(f => f.section)).size} sections</Text>
        </Box>
        <Text dimColor>
          {glyph.arrowUp}{glyph.arrowDown} navigate {glyph.bullet} ←/→ change {glyph.bullet} Enter edit {glyph.bullet}{' '}
          <Text color={color.accent}>s</Text> save {glyph.bullet} <Text color={color.accent}>Esc</Text> cancel
        </Text>
      </Box>

      {/* ── Scrollable fields ── */}
      <Box flexGrow={1} flexDirection="column" marginTop={1} overflow="hidden">
        {visibleRows.map((r) => {
          if (r.kind === 'header') {
            return (
              <Text key={`h-${r.label}`} color={color.accent} bold>
                {' '}{r.label}
              </Text>
            );
          }
          const i = r.idx;
          const f = FIELDS[i];
          const selected = i === row;
          const isEditing = selected && editing;
          let shown: string;
          if (f.type === 'cycle') {
            const v = getValue(draft, f);
            shown = f.options?.find((o) => o.value === v)?.label ?? String(v ?? '');
          } else {
            const raw = isEditing ? buffer : (() => {
              const v = getValue(draft, f);
              return v === undefined || v === '' ? '' : String(v);
            })();
            shown = raw
              ? f.type === 'secret' && !isEditing
                ? '•'.repeat(Math.min(raw.length, 24))
                : raw
              : isEditing ? '' : f.placeholder ?? '';
          }
          const curVal = getValue(draft, f);
          const empty = f.type !== 'cycle' && (curVal === undefined || curVal === '') && !isEditing;
          return (
            <Text key={f.path + f.section}>
              <Text color={selected ? color.accent : color.subtle} bold={selected}>{selected ? ` ${glyph.pointer} ` : '   '}</Text>
              <Text color={selected ? undefined : color.subtle}>{f.label.padEnd(38)}</Text>
              <Text color={isEditing ? color.warning : empty ? color.subtle : selected ? color.accent : color.system} bold={selected && !empty}>
                {' '}{shown}{isEditing ? <Text color={color.warning}>▌</Text> : null}
              </Text>
            </Text>
          );
        })}
      </Box>

      {/* ── Sticky footer ── */}
      <Box flexShrink={0} flexDirection="column" marginTop={1} borderStyle="single" borderColor={color.subtle} paddingX={1}>
        <Box>
          <Text dimColor>{configFilePath()}</Text>
          <Text dimColor> {glyph.bullet} chmod 600</Text>
        </Box>
        <Box>
          <StatusIndicator />
          {provider === 'openai-compat' ? (
            <Text color={color.warning}> {glyph.bullet} openai-compat: baseUrl + model required</Text>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
