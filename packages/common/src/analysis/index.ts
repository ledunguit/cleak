/**
 * Shared, framework-free analysis logic (report renderers + heuristic
 * root-cause/repair synthesis). Imported via the sub-path
 * `@mcpvul/common/analysis/...` — deliberately NOT re-exported from the
 * top-level barrel so the Vite UI never pulls in pdfkit.
 */
export * from './reporting';
export * from './heuristic-leak-analysis';
export * from './heuristic-judge';
export * from './judge-shared';
export * from './metrics';
