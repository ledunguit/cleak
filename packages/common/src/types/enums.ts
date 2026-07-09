// ── Core Enums ──

export enum LeakConfidence {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

export enum InvestigationVerdict {
  CONFIRMED_LEAK = 'confirmed_leak',
  LIKELY_LEAK = 'likely_leak',
  UNCERTAIN = 'uncertain',
  LIKELY_FALSE_POSITIVE = 'likely_false_positive',
  FALSE_POSITIVE = 'false_positive',
}

export enum ToolKind {
  VALGRIND = 'valgrind',
  ASAN = 'asan',
  LSAN = 'lsan',
  SCAN_BUILD = 'scan_build',
  HEURISTIC = 'heuristic',
  LLM = 'llm',
  /** A multi-sample LLM verdict combined by the consensus judge (self-consistency). */
  CONSENSUS = 'consensus',
}

export enum AnalysisMode {
  NO_LLM = 'no_llm',
  LLM_ASSISTED = 'llm_assisted',
}

/**
 * Calibrated dynamic leak taxonomy. Mirrors Valgrind's leak kinds plus a
 * generic ASan/LSan bucket, so the judge can weight `definitely_lost` as
 * near-decisive while treating `still_reachable` as likely-benign instead of
 * giving every runtime finding the same flat credit.
 */
export enum DynamicLeakKind {
  DEFINITELY_LOST = 'definitely_lost',
  INDIRECTLY_LOST = 'indirectly_lost',
  POSSIBLY_LOST = 'possibly_lost',
  STILL_REACHABLE = 'still_reachable',
  ASAN_LEAK = 'asan_leak',
  OTHER = 'other',
}

export enum DynamicMode {
  OFF = 'off',
  SELECTIVE = 'selective',
  AGGRESSIVE = 'aggressive',
}

export enum DynamicToolPreference {
  AUTO = 'auto',
  VALGRIND = 'valgrind',
  LSAN = 'lsan',
  ASAN = 'asan',
}

export enum ReportFormat {
  JSON = 'json',
  MARKDOWN = 'markdown',
  HTML = 'html',
  PDF = 'pdf',
  SNAPSHOT = 'snapshot',
}

export enum FindingStatus {
  PENDING = 'pending',
  INVESTIGATING = 'investigating',
  CONFIRMED = 'confirmed',
  DISMISSED = 'dismissed',
}

export enum ScanStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum LeakPatternType {
  EARLY_RETURN = 'early_return',
  CONDITIONAL_LEAK = 'conditional_leak',
  LOOP_ACCUMULATE = 'loop_accumulate',
  DOUBLE_FREE = 'double_free',
  USE_AFTER_FREE = 'use_after_free',
  STRDUP_LEAK = 'strdup_leak',
  STRUCT_FIELD_LEAK = 'struct_field_leak',
  REALLOC_MISHANDLE = 'realloc_mishandle',
  MISSING_NULL_CHECK = 'missing_null_check',
  INTERPROCEDURAL_LEAK = 'interprocedural_leak',
  ARRAY_LEAK = 'array_leak',
  CUSTOM_ALLOCATOR_LEAK = 'custom_allocator_leak',
  UNKNOWN = 'unknown',
}

export enum AgentActionKind {
  RUN_STATIC_TOOL = 'run_static_tool',
  RUN_SCAN_BUILD = 'run_scan_build',
  RUN_DYNAMIC = 'run_dynamic',
  JUDGE_BUNDLE = 'judge_bundle',
  REQUEST_MORE_EVIDENCE = 'request_more_evidence',
  DEEP_INVESTIGATE = 'deep_investigate',
  CHANGE_STRATEGY = 'change_strategy',
  FINISH = 'finish',
}
