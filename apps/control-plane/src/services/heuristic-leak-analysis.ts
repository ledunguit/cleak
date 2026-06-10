/**
 * Moved into the shared package so the control plane and the leak-inspector-tui
 * run byte-identical heuristic analysis. This re-export preserves the original
 * import path for existing call sites.
 */
export * from '@mcpvul/common/analysis/heuristic-leak-analysis';
