import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { color, glyph } from '../theme';
import type { Provider } from '../../../config';
import type { UserPreferences, EndpointOverride } from '../preferences';

type FieldType = 'cycle' | 'text' | 'secret';

interface FieldDef {
  /** Preference key (scope 'pref') or endpoint key (scope 'endpoint'). */
  key: string;
  label: string;
  type: FieldType;
  scope: 'pref' | 'endpoint';
  options?: Array<{ value: string | boolean; label: string }>;
  placeholder?: string;
}

const PROVIDER_OPTIONS = [
  { value: 'local', label: 'local gateway' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai-compat', label: 'OpenAI-compatible (custom)' },
];

const FIELDS: FieldDef[] = [
  {
    key: 'defaultMode', label: 'Default analysis mode', type: 'cycle', scope: 'pref',
    options: [{ value: 'llm_assisted', label: 'llm_assisted' }, { value: 'no_llm', label: 'no_llm' }],
  },
  {
    key: 'defaultDynamic', label: 'Default dynamic analysis', type: 'cycle', scope: 'pref',
    options: [{ value: 'off', label: 'off' }, { value: 'selective', label: 'selective' }, { value: 'aggressive', label: 'aggressive' }],
  },
  {
    key: 'autoShowReport', label: 'Auto-show report when a scan finishes', type: 'cycle', scope: 'pref',
    options: [{ value: false, label: 'off' }, { value: true, label: 'on' }],
  },
  { key: 'defaultProvider', label: 'LLM provider', type: 'cycle', scope: 'pref', options: PROVIDER_OPTIONS },
  { key: 'baseUrl', label: 'Base URL', type: 'text', scope: 'endpoint', placeholder: '(env / default)' },
  { key: 'model', label: 'Model', type: 'text', scope: 'endpoint', placeholder: '(env / default)' },
  { key: 'apiKey', label: 'API key', type: 'secret', scope: 'endpoint', placeholder: '(env / default)' },
];

export const activeProvider = (d: UserPreferences): Provider => (d.defaultProvider ?? 'local') as Provider;

/** Read one per-provider endpoint override field ('' when unset). Pure — unit-tested. */
export function getEndpointField(draft: UserPreferences, provider: Provider, key: keyof EndpointOverride): string {
  return draft.endpoints?.[provider]?.[key] ?? '';
}

/** Set one per-provider endpoint override field, returning a new prefs object. Pure. */
export function setEndpointField(
  draft: UserPreferences,
  provider: Provider,
  key: keyof EndpointOverride,
  value: string,
): UserPreferences {
  const endpoints = { ...(draft.endpoints ?? {}) };
  endpoints[provider] = { ...(endpoints[provider] ?? {}), [key]: value };
  return { ...draft, endpoints };
}

function getValue(draft: UserPreferences, field: FieldDef): string | boolean {
  if (field.scope === 'endpoint') return getEndpointField(draft, activeProvider(draft), field.key as keyof EndpointOverride);
  return (draft as any)[field.key];
}

function setValue(draft: UserPreferences, field: FieldDef, value: string | boolean): UserPreferences {
  if (field.scope === 'endpoint') return setEndpointField(draft, activeProvider(draft), field.key as keyof EndpointOverride, value as string);
  return { ...draft, [field.key]: value };
}

/** A dedicated settings screen. Owns its keys while the 'config' view is active.
 * Cycle rows toggle with ←/→; text/secret rows open an inline editor with Enter. */
export function ConfigScreen({
  initial,
  onSave,
  onCancel,
}: {
  initial: UserPreferences;
  onSave: (prefs: UserPreferences) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<UserPreferences>({ ...initial });
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
    setBuffer(String(getValue(draft, FIELDS[row]) ?? ''));
    setEditing(true);
  };
  const commitEdit = () => {
    setDraft((d) => setValue(d, FIELDS[row], buffer.trim()));
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
          let shown: string;
          if (f.type === 'cycle') {
            const v = getValue(draft, f);
            shown = f.options?.find((o) => o.value === v)?.label ?? String(v);
          } else {
            const raw = isEditing ? buffer : String(getValue(draft, f) ?? '');
            shown = raw
              ? f.type === 'secret' && !isEditing
                ? '•'.repeat(Math.min(raw.length, 24))
                : raw
              : (isEditing ? '' : f.placeholder ?? '');
          }
          const empty = f.type !== 'cycle' && !getValue(draft, f) && !isEditing;
          return (
            <Text key={String(f.key)}>
              <Text color={selected ? color.accent : color.subtle}>{selected ? glyph.pointer : ' '} </Text>
              <Text color={selected ? undefined : color.subtle}>{f.label.padEnd(38)}</Text>
              <Text color={isEditing ? color.accent : empty ? color.subtle : selected ? color.accent : color.system} bold={selected && !empty}>
                {' '}
                {shown}
                {isEditing ? <Text color={color.accent}>▌</Text> : null}
              </Text>
            </Text>
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
          Saved to ~/.config/leak-inspector/prefs.json (chmod 600) {glyph.bullet} applies to new scans this session
        </Text>
      </Box>
    </Box>
  );
}
