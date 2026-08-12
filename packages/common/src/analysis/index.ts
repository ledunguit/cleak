/**
 * Shared, framework-free analysis logic (report renderers + heuristic
 * root-cause/repair synthesis). Imported via the sub-path
 * `@cleak/common/analysis/...` — deliberately NOT re-exported from the
 * top-level barrel so the heavy renderer stack stays out of the root bundle.
 */
export * from './reporting';
export * from './heuristic-leak-analysis';
export * from './heuristic-judge';
export * from './judge-shared';
export * from './metrics';
