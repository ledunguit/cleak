import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { color, glyph } from '../theme';
import type { Provider } from '../../../config';
import { configFilePath, type CleakConfig, type EndpointOverride } from '../../../domain/config-file';

type FieldType = 'cycle' | 'text' | 'secret' | 'number';

interface FieldDef {
  /** Section header this field is grouped under. */
  section: string;
  /** Dot-path into CleakConfig (scope 'config') or the endpoint leaf key (scope 'endpoint'). */
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
const RULE_OPTIONS = [
  { value: 'weighted', label: 'weighted' },
  { value: 'majority', label: 'majority' },
  { value: 'unanimous-to-flag', label: 'unanimous-to-flag' },
];

// Every RunConfig knob, grouped. Endpoint rows bind to the active provider.
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
];

export const activeProvider = (d: CleakConfig): Provider => (d.provider ?? 'local') as Provider;

/** Read one per-provider endpoint override field ('' when unset). Pure — unit-tested. */
export function getEndpointField(draft: CleakConfig, provider: Provider, key: keyof EndpointOverride): string {
  return draft.endpoints?.[provider]?.[key] ?? '';
}

/** Set one per-provider endpoint override field, returning a new config object. Pure. */
export function setEndpointField(
  draft: CleakConfig,
  provider: Provider,
  key: keyof EndpointOverride,
  value: string,
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

/** A dedicated settings screen over the full CleakConfig. Cycle rows toggle with
 * ←/→; text/secret/number rows open an inline editor with Enter. */
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
      if (n !== undefined && Number.isNaN(n)) return setEditing(false); // reject non-numeric, keep old
      setDraft((d) => setValue(d, field, n));
    } else {
      setDraft((d) => setValue(d, field, t === '' && field.scope === 'config' ? undefined : t));
    }
    setEditing(false);
  };

  useInput((input, key) => {
    if (editing) {
      if (key.return) return commitEdit();
      if (key.escape) return setEditing(false); // cancel edit, keep old value
      if (key.backspace || key.delete) return setBuffer((b) => b.slice(0, -1));
      if (input && !key.ctrl && !key.meta && !key.tab) setBuffer((b) => b + input);
      return;
    }
    if (key.escape) return onCancel();
    if (input === 's') return onSave(draft);
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
  let lastSection = '';

  return (
    <Box flexDirection="column">
      <Text color={color.accent} bold>
        {glyph.star} Settings
      </Text>
      <Text dimColor>
        {glyph.arrowUp}/{glyph.arrowDown} row {glyph.bullet} ←/→ cycle {glyph.bullet} Enter edit/change {glyph.bullet} s save {glyph.bullet} Esc {editing ? 'cancel edit' : 'cancel'}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {FIELDS.map((f, i) => {
          const selected = i === row;
          const isEditing = selected && editing;
          const header = f.section !== lastSection ? f.section : '';
          lastSection = f.section;
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
              : isEditing
                ? ''
                : f.placeholder ?? '';
          }
          const curVal = getValue(draft, f);
          const empty = f.type !== 'cycle' && (curVal === undefined || curVal === '') && !isEditing;
          return (
            <Box flexDirection="column" key={f.path + f.section}>
              {header ? (
                <Text color={color.subtle} bold>
                  {' '}
                  {header}
                </Text>
              ) : null}
              <Text>
                <Text color={selected ? color.accent : color.subtle}>{selected ? glyph.pointer : ' '} </Text>
                <Text color={selected ? undefined : color.subtle}>{f.label.padEnd(38)}</Text>
                <Text color={isEditing ? color.accent : empty ? color.subtle : selected ? color.accent : color.system} bold={selected && !empty}>
                  {' '}
                  {shown}
                  {isEditing ? <Text color={color.accent}>▌</Text> : null}
                </Text>
              </Text>
            </Box>
          );
        })}
      </Box>
      {provider === 'openai-compat' ? (
        <Box marginTop={1}>
          <Text color={color.warning}>
            {glyph.bullet} OpenAI-compatible: Base URL + Model required (any OpenAI-style /chat/completions endpoint)
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>
          Saved to {configFilePath()} (chmod 600) {glyph.bullet} env still overrides the file {glyph.bullet} applies to new scans this session
        </Text>
      </Box>
    </Box>
  );
}
