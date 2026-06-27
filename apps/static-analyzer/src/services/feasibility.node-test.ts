/**
 * Z3 leak-path feasibility tests. RUN UNDER NODE, not bun:
 *
 *     cd apps/static-analyzer && node src/services/feasibility.node-test.ts
 *
 * (z3-solver's WASM worker hangs under Bun, so this can't live in the `bun test`
 * suite; `leakFeasible` is guarded to return 'unknown' under Bun. The container runs
 * Node, so production uses Z3.)
 */
import { leakFeasible, translateCondition, type Guard } from './feasibility.ts';

const cases: [string, Guard[], string][] = [
  // The dominant heuristic over-report: an early `if (p == NULL) return;` is NOT a leak
  // of p — on that path p is NULL. Z3: (p != 0) ∧ (p == 0) = UNSAT.
  ['p == NULL guard', [{ condition: 'p == NULL', negated: false }], 'infeasible'],
  ['!p guard', [{ condition: '!p', negated: false }], 'infeasible'],
  ['NULL == p (reversed)', [{ condition: 'NULL == p', negated: false }], 'infeasible'],
  ['negated p!=NULL ⇒ p==0', [{ condition: 'p != NULL', negated: true }], 'infeasible'],
  ['compound n>0 && p==NULL', [{ condition: 'n > 0 && p == NULL', negated: false }], 'infeasible'],
  // Real leaks / conservative keeps:
  ['unrelated guard err', [{ condition: 'err', negated: false }], 'feasible'],
  ['p != NULL (still live)', [{ condition: 'p != NULL', negated: false }], 'feasible'],
  ['disjunction p==NULL || x>5', [{ condition: 'p == NULL || x > 5', negated: false }], 'feasible'],
  ['untranslatable obj->f==NULL (dropped)', [{ condition: 'obj->field == NULL', negated: false }], 'feasible'],
  ['no guards', [], 'feasible'],
  // Size-guard: >40 guards skips Z3 (a giant real-project function would OOM the
  // 2 GiB wasm heap) and degrades to 'unknown' — verified BEFORE any solver call.
  ['oversized guard set (size-guard)', Array.from({ length: 41 }, () => ({ condition: 'err', negated: false })), 'unknown'],
];

let ok = 0;
for (const [name, guards, want] of cases) {
  const got = await leakFeasible('p', guards);
  const pass = got === want;
  if (pass) ok++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} => ${got} (want ${want})`);
}
// translateCondition must reject arithmetic/field access (so a dropped guard never
// makes a real leak look infeasible).
const sentinel = { Int: { const: () => ({}), val: () => ({}) } } as any;
const untranslatable = translateCondition(sentinel, 'a + b', () => ({})) === null;
console.log(`${untranslatable ? 'PASS' : 'FAIL'}  arithmetic 'a + b' is untranslatable`);
if (untranslatable) ok++;

const total = cases.length + 1;
console.log(`\n${ok}/${total} passed`);
process.exit(ok === total ? 0 : 1);
