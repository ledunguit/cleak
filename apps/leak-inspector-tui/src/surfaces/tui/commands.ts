/**
 * Slash-command registry — DATA only (name, summary, choice options). Drives the
 * typeahead suggestions and the select overlays for choice-commands; the App
 * owns execution (it has the store/exit/overlay context). Commands with a fixed
 * option set use `kind: 'select'` so the App shows a picker instead of making the
 * user type the argument.
 */

export interface CommandOption {
  label: string;
  value: string;
  description?: string;
}

export interface CommandSpec {
  name: string;
  summary: string;
  usage?: string;
  kind: 'action' | 'select';
  /** For `kind: 'select'` — the choices presented in the overlay. */
  options?: CommandOption[];
  multi?: boolean;
}

export const COMMANDS: CommandSpec[] = [
  { name: '/scan', summary: 'investigate a C/C++ repo', usage: '/scan <repo-path>', kind: 'action' },
  {
    name: '/mode',
    summary: 'analysis mode',
    kind: 'select',
    options: [
      { label: 'llm_assisted', value: 'llm_assisted', description: 'agentic investigation (LLM drives MCP tools)' },
      { label: 'no_llm', value: 'no_llm', description: 'deterministic heuristic only (no LLM)' },
    ],
  },
  {
    name: '/dynamic',
    summary: 'dynamic analysis mode',
    kind: 'select',
    options: [
      { label: 'off', value: 'off', description: 'static analysis only' },
      { label: 'selective', value: 'selective', description: 'agent runs sanitizers/valgrind when useful' },
      { label: 'aggressive', value: 'aggressive', description: 'always attempt a dynamic run' },
    ],
  },
  { name: '/report', summary: 'view a past scan (pick a finding)', usage: '/report [scanId]', kind: 'action' },
  { name: '/metrics', summary: 'show metrics for a scan', usage: '/metrics [scanId]', kind: 'action' },
  { name: '/scans', summary: 'list recent scans', kind: 'action' },
  { name: '/preflight', summary: 'check analyzer connectivity', kind: 'action' },
  { name: '/tools', summary: 'list available MCP tools', kind: 'action' },
  { name: '/quit', summary: 'exit', kind: 'action' },
];

/** Commands whose names start with the typed token (after `/`), for the suggestion list. */
export function matchCommands(input: string): CommandSpec[] {
  const token = input.replace(/^\//, '').toLowerCase().split(/\s+/)[0] ?? '';
  if (!token) return COMMANDS;
  return COMMANDS.filter((c) => c.name.slice(1).toLowerCase().startsWith(token));
}

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}
