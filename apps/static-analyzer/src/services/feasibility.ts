/**
 * Z3-backed leak-path feasibility. A heuristic CFG marks a variable "leaked" on an
 * exit path whenever it is allocated-before and not-freed-before that exit (by line),
 * which OVER-REPORTS: e.g. an early `if (p == NULL) return;` looks like a leak of `p`,
 * but on that path `p` is NULL — there is nothing to leak. We model the path as a
 * conjunction of its branch GUARDS (with polarity) plus "the leaked pointer is LIVE"
 * (`p != 0`) and ask Z3 whether that is satisfiable. UNSAT ⇒ the path can't actually
 * leak ⇒ drop it.
 *
 * NODE-ONLY: z3-solver is a WASM module whose worker/Atomics path HANGS under Bun. So
 * the whole module is guarded — under Bun (the test harness / TUI) `leakFeasible`
 * returns 'unknown' and the caller keeps the heuristic verdict. In production the
 * analyzer runs under Node (the container), where Z3 is active.
 */

const RUNTIME_OK = typeof (globalThis as { Bun?: unknown }).Bun === 'undefined';

// z3-solver is a WASM module with a hard 2 GiB (wasm32) heap that only GROWS. On a
// large real-project function it OOMs — and the abort fires from a WASM pthread as
// an UNCAUGHT exception that would crash the whole analyzer. We cannot try/catch it,
// so we defend in depth:
//   • size-guard: skip Z3 on oversized path formulas (cheap pre-filter);
//   • safety net (installZ3Guard): a process-level handler that recognises the Z3
//     OOM abort, DISABLES Z3 for the rest of the process, and SWALLOWS it — one bad
//     input degrades feasibility to 'unknown' (heuristic kept) instead of taking the
//     service down. A WASM OOM also corrupts the worker, so disabling is mandatory.
// 'unknown' is the same safe fallback used when Z3 is unavailable (e.g. under Bun).
const MAX_GUARDS = Number(process.env.Z3_MAX_GUARDS || 24);
const MAX_GUARD_CHARS = Number(process.env.Z3_MAX_GUARD_CHARS || 1500);
// Per-check wall-clock budget (ms). The size-guard stops OOM, but a small-yet-hard
// formula can make Z3 SPIN (99% CPU, no progress) with no time bound — stalling the
// whole run. Z3's own 'timeout' param makes check() return 'unknown' when it expires.
const Z3_TIMEOUT_MS = Number(process.env.Z3_TIMEOUT_MS || 1500);
// PROACTIVE OOM ceiling. The z3-solver WASM heap only GROWS toward a FATAL 2 GiB cap:
// emscripten's abort() unwinds and KILLS the process — an uncaughtException handler
// CANNOT save it (it still dies after the handler runs). The only defence is to stop
// using Z3 BEFORE the heap nears 2 GiB. `process.memoryUsage().arrayBuffers` counts
// the WASM linear memory, so we disable Z3 once it crosses this watermark.
const Z3_MEM_LIMIT_BYTES = Number(process.env.Z3_MEM_LIMIT_MB || 1600) * 1024 * 1024;

export interface Guard {
  /** Raw C boolean expression text of the branch condition (e.g. "p == NULL"). */
  condition: string;
  /** True when the FALSE branch was taken to reach the exit (else-branch / skipped if). */
  negated: boolean;
}

export type Feasibility = 'feasible' | 'infeasible' | 'unknown';

// ── A tiny recursive-descent parser for the practical C boolean subset ────────────
// Grammar (precedence low→high): or → and → not → cmp → primary.
// Supported: || && ! == != < > <= >= ( ) identifiers NULL integer-literals, and bare
// truthiness (`p` ⇒ p != 0, `!p` ⇒ p == 0). Anything else ⇒ the whole guard is
// untranslatable and is dropped (conservative: a dropped guard only ever makes a path
// MORE satisfiable, so we never call a real leak infeasible by mistake).

type Tok = { t: 'op' | 'id' | 'num' | 'lp' | 'rp'; v: string };

function lex(s: string): Tok[] | null {
  const toks: Tok[] = [];
  const re = /\s*(\|\||&&|==|!=|<=|>=|<|>|!|\(|\)|[A-Za-z_]\w*|0[xX][0-9a-fA-F]+|\d+)/y;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) {
      if (/^\s*$/.test(s.slice(i))) break;
      return null; // an unsupported token (e.g. arithmetic, ->, field access) → bail
    }
    const v = m[1];
    i = re.lastIndex;
    if (v === '(') toks.push({ t: 'lp', v });
    else if (v === ')') toks.push({ t: 'rp', v });
    else if (/^(\|\||&&|==|!=|<=|>=|<|>|!)$/.test(v)) toks.push({ t: 'op', v });
    else if (/^\d/.test(v)) toks.push({ t: 'num', v });
    else toks.push({ t: 'id', v });
  }
  return toks;
}

/** Build a Z3 Bool from a C boolean expression, or null if untranslatable. */
export function translateCondition(c: any, expr: string, intOf: (n: string) => any): any | null {
  const toks = lex(expr);
  if (!toks || toks.length === 0) return null;
  let p = 0;
  const peek = () => toks[p];
  const eat = () => toks[p++];

  // Coerce an integer/identifier term to a Z3 Int (NULL → 0).
  const term = (): any | null => {
    const tk = peek();
    if (!tk) return null;
    if (tk.t === 'num') {
      eat();
      return c.Int.val(parseInt(tk.v, tk.v.startsWith('0x') || tk.v.startsWith('0X') ? 16 : 10));
    }
    if (tk.t === 'id') {
      eat();
      if (tk.v === 'NULL') return c.Int.val(0);
      return intOf(tk.v);
    }
    return null; // a parenthesised sub-expr is a Bool, handled in primary()
  };

  const orExpr = (): any | null => chain('||', andExpr, (a, b) => c.Or(a, b));
  function chain(op: string, sub: () => any | null, combine: (a: any, b: any) => any): any | null {
    let left = sub();
    if (left == null) return null;
    while (peek()?.t === 'op' && peek()!.v === op) {
      eat();
      const right = sub();
      if (right == null) return null;
      left = combine(left, right);
    }
    return left;
  }
  function andExpr(): any | null {
    return chain('&&', notExpr, (a, b) => c.And(a, b));
  }
  function notExpr(): any | null {
    if (peek()?.t === 'op' && peek()!.v === '!') {
      eat();
      const inner = notExpr();
      return inner == null ? null : c.Not(inner);
    }
    return cmp();
  }
  function cmp(): any | null {
    // Try a comparison "A <op> B"; else bare truthiness of a term.
    const start = p;
    const a = term();
    if (a != null) {
      const op = peek();
      if (op?.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(op.v)) {
        eat();
        const b = term();
        if (b == null) return null;
        switch (op.v) {
          case '==': return a.eq(b);
          case '!=': return a.neq(b);
          case '<': return a.lt(b);
          case '>': return a.gt(b);
          case '<=': return a.le(b);
          case '>=': return a.ge(b);
        }
      }
      // bare truthiness: `p` ⇒ p != 0
      return a.neq(c.Int.val(0));
    }
    // not a term → maybe a parenthesised boolean
    p = start;
    return primary();
  }
  function primary(): any | null {
    if (peek()?.t === 'lp') {
      eat();
      const e = orExpr();
      if (peek()?.t === 'rp') eat();
      return e;
    }
    return null;
  }

  const result = orExpr();
  return p === toks.length ? result : null; // leftover tokens ⇒ untranslatable
}

// ── Z3 context (lazy, node-only) + crash safety net ───────────────────────────────
let apiPromise: Promise<{ Context: (n: string) => any } | null> | null = null;
let ctx: any = null;
let z3Disabled = false;

/** True when the error is a z3-solver WASM OOM/abort (vs an unrelated bug). */
function isZ3Abort(err: unknown): boolean {
  const s = `${(err as { message?: string })?.message ?? ''}\n${(err as { stack?: string })?.stack ?? ''}`;
  return s.includes('z3-built') || s.includes('Cannot enlarge memory') || s.includes('Aborted(');
}

// Install ONCE (node only). The WASM OOM surfaces as an uncaught exception on the
// main thread; recognise it, disable Z3 for the rest of the process, and swallow —
// so the analyzer survives. Anything else is re-raised unchanged.
let guardInstalled = false;
function installZ3Guard(): void {
  if (guardInstalled || !RUNTIME_OK || typeof process === 'undefined') return;
  guardInstalled = true;
  process.on('uncaughtException', (err) => {
    if (!isZ3Abort(err)) throw err;
    if (!z3Disabled) process.stderr.write('⚠ Z3 path-feasibility OOM — disabled for this process (heuristic kept)\n');
    z3Disabled = true;
  });
}

async function getContext(): Promise<any | null> {
  if (!RUNTIME_OK || z3Disabled) return null;
  installZ3Guard();
  if (!apiPromise) {
    apiPromise = (async () => {
      const { init } = await import('z3-solver');
      return (await init()) as { Context: (n: string) => any };
    })().catch(() => null);
  }
  const api = await apiPromise;
  if (!api) return null;
  if (!ctx) ctx = api.Context('leak');
  return ctx;
}

/**
 * Is a leak of `liveVar` feasible on a path with these branch guards?
 * 'infeasible' ⇒ UNSAT (`liveVar != 0` contradicts the guards) ⇒ drop the path.
 * 'unknown' ⇒ Z3 unavailable (Bun) or a solver error ⇒ caller keeps the heuristic.
 */
export async function leakFeasible(liveVar: string, guards: Guard[]): Promise<Feasibility> {
  if (z3Disabled) return 'unknown'; // a prior OOM/limit took Z3 down → heuristic for the rest
  // Proactive OOM ceiling: stop BEFORE the fatal 2 GiB wasm heap (emscripten abort is
  // unrecoverable). Once the WASM heap nears the watermark, disable Z3 for good.
  if (RUNTIME_OK && process.memoryUsage().arrayBuffers > Z3_MEM_LIMIT_BYTES) {
    if (!z3Disabled) process.stderr.write('⚠ Z3 path-feasibility near the WASM heap ceiling — disabled (heuristic kept)\n');
    z3Disabled = true;
    return 'unknown';
  }
  // Size-guard: a pathological function (many branch guards) builds an SMT formula
  // big enough to OOM Z3's 2 GiB wasm heap. Skip it and keep the heuristic ('unknown').
  if (guards.length > MAX_GUARDS) return 'unknown';
  let guardChars = 0;
  for (const g of guards) guardChars += g.condition.length;
  if (guardChars > MAX_GUARD_CHARS) return 'unknown';

  const c = await getContext();
  if (!c) return 'unknown';
  try {
    const solver = new c.Solver();
    solver.set('timeout', Z3_TIMEOUT_MS); // bound solve time → 'unknown' on a hard formula
    const env = new Map<string, any>();
    const intOf = (n: string) => {
      if (!env.has(n)) env.set(n, c.Int.const(n));
      return env.get(n);
    };
    solver.add(intOf(liveVar).neq(c.Int.val(0))); // the leaked pointer is live on this path
    for (const g of guards) {
      const e = translateCondition(c, g.condition, intOf);
      if (e == null) continue; // untranslatable guard → omit (conservative)
      solver.add(g.negated ? c.Not(e) : e);
    }
    const r = await solver.check();
    return r === 'unsat' ? 'infeasible' : r === 'sat' ? 'feasible' : 'unknown';
  } catch {
    return 'unknown';
  }
}
