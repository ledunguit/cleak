/**
 * Baseline adapters — run an EXTERNAL leak detector over a corpus case and
 * normalize its output to `SnapshotFinding[]`, the exact shape `scoreCase`
 * consumes. That is the architectural key to a FAIR comparison: our system and
 * every baseline differ only in the `SnapshotFinding[]` producer; the
 * ground-truth scoring (`scoreCase`), the confusion matrix, and every metric are
 * computed by identical code on the identical corpus. A baseline thus cannot be
 * advantaged or disadvantaged by a different scoring convention.
 */

import type { SnapshotFinding, LabeledCase } from '../evalScoring';

export interface BaselineAdapter {
  /** Stable identifier used as the row label in the comparison table. */
  name: string;
  /** Probe whether the tool is runnable in this environment (binary present, etc.).
   * Adapters whose tool is absent are SKIPPED and clearly labeled — never faked. */
  available(): Promise<boolean>;
  /**
   * Run the tool over one case directory and return its leak findings normalized
   * to `SnapshotFinding[]`. `caseDir` is the absolute path to the case's sources;
   * `c` carries the build command and metadata. Should not throw for an ordinary
   * tool failure — return `[]` (scored as all-miss) so one bad case can't abort a
   * whole comparison run.
   */
  run(caseDir: string, c: LabeledCase): Promise<SnapshotFinding[]>;
}
