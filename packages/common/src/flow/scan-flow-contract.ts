/**
 * Scan-flow contract — the SINGLE source of truth for the scan pipeline's
 * display phases and the stable event-name stream, shared by the control-plane
 * (emitter) and the leak-inspector-ui (realtime workflow nodes).
 *
 * MUST stay pure TypeScript: no NestJS / TypeORM / Node imports, so the Vite UI
 * can bundle it via the @mcpvul/common alias.
 *
 * The NestJS backend runs a DYNAMIC agentic loop (discovery → investigation loop
 * → judging/reporting), not the original Python linear 10-phase pipeline. We map
 * that loop onto stable DISPLAY phases below: INVESTIGATION is the hub that hosts
 * per-turn agent activity; LEAKGUARD / DYNAMIC / JUDGING are optional phases that
 * light up when their `*_started` event arrives (they happen inside the loop).
 */

// ── Canonical display phases (render + edge order) ──
export enum ScanPhase {
  SETUP = 'setup',
  PREFLIGHT = 'preflight',
  WORKSPACE = 'workspace',
  DISCOVERY = 'discovery',
  INVESTIGATION = 'investigation',
  LEAKGUARD = 'leakguard',
  DYNAMIC = 'dynamic',
  JUDGING = 'judging',
  REPORTING = 'reporting',
  REPORT = 'report',
}

export const SCAN_PHASE_ORDER: ScanPhase[] = [
  ScanPhase.SETUP,
  ScanPhase.PREFLIGHT,
  ScanPhase.WORKSPACE,
  ScanPhase.DISCOVERY,
  ScanPhase.INVESTIGATION,
  ScanPhase.LEAKGUARD,
  ScanPhase.DYNAMIC,
  ScanPhase.JUDGING,
  ScanPhase.REPORTING,
  ScanPhase.REPORT,
];

// ── Stable event names (backend emits these; frontend consumes them) ──
export enum ScanEventName {
  SCAN_CREATED = 'scan_created',

  PREFLIGHT_STARTED = 'preflight_started',
  PREFLIGHT_PASSED = 'preflight_passed',
  PREFLIGHT_FAILED = 'preflight_failed',

  WORKSPACE_STARTED = 'workspace_started',
  WORKSPACE_MATERIALIZED = 'workspace_materialized',
  BUILD_PLAN_SELECTED = 'build_plan_selected',
  WORKSPACE_FINISHED = 'workspace_finished',

  DISCOVERY_STARTED = 'discovery_started',
  CANDIDATES_SCANNING = 'candidates_scanning',
  DISCOVERY_FINISHED = 'discovery_finished',

  INVESTIGATION_STARTED = 'investigation_started',
  AGENT_TURN_STARTED = 'agent_turn_started',
  AGENT_TOOL_RESULT = 'agent_tool_result',
  AGENT_TURN_FINISHED = 'agent_turn_finished',
  INVESTIGATION_FINISHED = 'investigation_finished',

  LEAKGUARD_STARTED = 'leakguard_started',
  LEAKGUARD_FINISHED = 'leakguard_finished',

  DYNAMIC_STARTED = 'dynamic_started',
  DYNAMIC_BUILD_STARTED = 'dynamic_build_started',
  DYNAMIC_BINARY_BUILT = 'dynamic_binary_built',
  DYNAMIC_TOOL_RESULT = 'dynamic_tool_result',
  DYNAMIC_FINISHED = 'dynamic_finished',

  JUDGING_STARTED = 'judging_started',
  JUDGING_FINISHED = 'judging_finished',

  REPORTING_STARTED = 'reporting_started',
  REPORTING_FINISHED = 'reporting_finished',

  COMPLETED = 'completed',
  FAILED = 'failed',
}

export type ScanEventKind = 'phase_start' | 'phase_finish' | 'activity' | 'terminal';

// ── Event → phase routing ──
export const EVENT_PHASE: Record<ScanEventName, ScanPhase> = {
  [ScanEventName.SCAN_CREATED]: ScanPhase.SETUP,

  [ScanEventName.PREFLIGHT_STARTED]: ScanPhase.PREFLIGHT,
  [ScanEventName.PREFLIGHT_PASSED]: ScanPhase.PREFLIGHT,
  [ScanEventName.PREFLIGHT_FAILED]: ScanPhase.PREFLIGHT,

  [ScanEventName.WORKSPACE_STARTED]: ScanPhase.WORKSPACE,
  [ScanEventName.WORKSPACE_MATERIALIZED]: ScanPhase.WORKSPACE,
  [ScanEventName.BUILD_PLAN_SELECTED]: ScanPhase.WORKSPACE,
  [ScanEventName.WORKSPACE_FINISHED]: ScanPhase.WORKSPACE,

  [ScanEventName.DISCOVERY_STARTED]: ScanPhase.DISCOVERY,
  [ScanEventName.CANDIDATES_SCANNING]: ScanPhase.DISCOVERY,
  [ScanEventName.DISCOVERY_FINISHED]: ScanPhase.DISCOVERY,

  [ScanEventName.INVESTIGATION_STARTED]: ScanPhase.INVESTIGATION,
  [ScanEventName.AGENT_TURN_STARTED]: ScanPhase.INVESTIGATION,
  [ScanEventName.AGENT_TOOL_RESULT]: ScanPhase.INVESTIGATION,
  [ScanEventName.AGENT_TURN_FINISHED]: ScanPhase.INVESTIGATION,
  [ScanEventName.INVESTIGATION_FINISHED]: ScanPhase.INVESTIGATION,

  [ScanEventName.LEAKGUARD_STARTED]: ScanPhase.LEAKGUARD,
  [ScanEventName.LEAKGUARD_FINISHED]: ScanPhase.LEAKGUARD,

  [ScanEventName.DYNAMIC_STARTED]: ScanPhase.DYNAMIC,
  [ScanEventName.DYNAMIC_BUILD_STARTED]: ScanPhase.DYNAMIC,
  [ScanEventName.DYNAMIC_BINARY_BUILT]: ScanPhase.DYNAMIC,
  [ScanEventName.DYNAMIC_TOOL_RESULT]: ScanPhase.DYNAMIC,
  [ScanEventName.DYNAMIC_FINISHED]: ScanPhase.DYNAMIC,

  [ScanEventName.JUDGING_STARTED]: ScanPhase.JUDGING,
  [ScanEventName.JUDGING_FINISHED]: ScanPhase.JUDGING,

  [ScanEventName.REPORTING_STARTED]: ScanPhase.REPORTING,
  [ScanEventName.REPORTING_FINISHED]: ScanPhase.REPORTING,

  [ScanEventName.COMPLETED]: ScanPhase.REPORT,
  [ScanEventName.FAILED]: ScanPhase.REPORT,
};

// ── Event → kind (drives generic node status transitions) ──
export const EVENT_KIND: Record<ScanEventName, ScanEventKind> = {
  [ScanEventName.SCAN_CREATED]: 'phase_start',

  [ScanEventName.PREFLIGHT_STARTED]: 'phase_start',
  [ScanEventName.PREFLIGHT_PASSED]: 'phase_finish',
  [ScanEventName.PREFLIGHT_FAILED]: 'terminal',

  [ScanEventName.WORKSPACE_STARTED]: 'phase_start',
  [ScanEventName.WORKSPACE_MATERIALIZED]: 'activity',
  [ScanEventName.BUILD_PLAN_SELECTED]: 'activity',
  [ScanEventName.WORKSPACE_FINISHED]: 'phase_finish',

  [ScanEventName.DISCOVERY_STARTED]: 'phase_start',
  [ScanEventName.CANDIDATES_SCANNING]: 'activity',
  [ScanEventName.DISCOVERY_FINISHED]: 'phase_finish',

  [ScanEventName.INVESTIGATION_STARTED]: 'phase_start',
  [ScanEventName.AGENT_TURN_STARTED]: 'activity',
  [ScanEventName.AGENT_TOOL_RESULT]: 'activity',
  [ScanEventName.AGENT_TURN_FINISHED]: 'activity',
  [ScanEventName.INVESTIGATION_FINISHED]: 'phase_finish',

  [ScanEventName.LEAKGUARD_STARTED]: 'phase_start',
  [ScanEventName.LEAKGUARD_FINISHED]: 'phase_finish',

  [ScanEventName.DYNAMIC_STARTED]: 'phase_start',
  [ScanEventName.DYNAMIC_BUILD_STARTED]: 'activity',
  [ScanEventName.DYNAMIC_BINARY_BUILT]: 'activity',
  [ScanEventName.DYNAMIC_TOOL_RESULT]: 'activity',
  [ScanEventName.DYNAMIC_FINISHED]: 'phase_finish',

  [ScanEventName.JUDGING_STARTED]: 'phase_start',
  [ScanEventName.JUDGING_FINISHED]: 'phase_finish',

  [ScanEventName.REPORTING_STARTED]: 'phase_start',
  [ScanEventName.REPORTING_FINISHED]: 'phase_finish',

  [ScanEventName.COMPLETED]: 'terminal',
  [ScanEventName.FAILED]: 'terminal',
};

// ── MCP tool name → phase (for tool sub-events that carry a `tool` field) ──
export const TOOL_PHASE: Record<string, ScanPhase> = {
  'repo.index_files': ScanPhase.DISCOVERY,
  'memory.candidate_scan': ScanPhase.DISCOVERY,
  'memory.ast_scan': ScanPhase.INVESTIGATION,
  'memory.call_graph': ScanPhase.INVESTIGATION,
  'memory.function_summary': ScanPhase.INVESTIGATION,
  'memory.path_constraints': ScanPhase.INVESTIGATION,
  'memory.interprocedural_flow': ScanPhase.INVESTIGATION,
  'memory.ownership_summary': ScanPhase.INVESTIGATION,
  'memory.ownership_conventions': ScanPhase.INVESTIGATION,
  'memory.leakguard_run': ScanPhase.LEAKGUARD,
  'memory.leakguard_get_report': ScanPhase.LEAKGUARD,
  'asan.run': ScanPhase.DYNAMIC,
  'lsan.run': ScanPhase.DYNAMIC,
  'valgrind.analyze_memcheck': ScanPhase.DYNAMIC,
};

export interface PhaseMeta {
  title: string;
  subtitle: string;
  /** Optional phases default to "skipped" and only activate when their phase_start event arrives. */
  optional: boolean;
}

export const PHASE_META: Record<ScanPhase, PhaseMeta> = {
  [ScanPhase.SETUP]: { title: 'Scan Request', subtitle: 'Workspace + options', optional: false },
  [ScanPhase.PREFLIGHT]: { title: 'Preflight', subtitle: 'Runtime checks', optional: true },
  [ScanPhase.WORKSPACE]: { title: 'Workspace', subtitle: 'Materialize + build plan', optional: false },
  [ScanPhase.DISCOVERY]: { title: 'Discovery', subtitle: 'Index + candidate scan', optional: false },
  [ScanPhase.INVESTIGATION]: { title: 'Investigation', subtitle: 'Agentic loop: static tools + decisions', optional: false },
  [ScanPhase.LEAKGUARD]: { title: 'LeakGuard', subtitle: 'Project-level static (Clang SA)', optional: true },
  [ScanPhase.DYNAMIC]: { title: 'Dynamic', subtitle: 'Build + sanitizers', optional: true },
  [ScanPhase.JUDGING]: { title: 'Judging', subtitle: 'Verdicts + confidence', optional: false },
  [ScanPhase.REPORTING]: { title: 'Reporting', subtitle: 'Build outputs', optional: false },
  [ScanPhase.REPORT]: { title: 'Report', subtitle: 'Overview + formats', optional: false },
};

/** Resolve the phase for an emitted event name (used by the backend envelope). */
export function phaseForEvent(name: string): ScanPhase | undefined {
  return EVENT_PHASE[name as ScanEventName];
}

/** Resolve the kind for an emitted event name. */
export function kindForEvent(name: string): ScanEventKind | undefined {
  return EVENT_KIND[name as ScanEventName];
}
