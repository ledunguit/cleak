import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { CParserService, type FunctionInfo } from './c-parser.service';
import { ServerEventName } from '@cleak/common/mcp/server-events';
import type {
  FreedCrossFileEntry, UnfreedSinkParamEntry, FreedViaCallerEntry, UnfreedReturnOwnershipEntry,
} from '../types/mcp-responses';

/** Cap on how many parameter-forwarding hops `walkOwnershipChain` will follow
 * before giving up (Juliet's deepest chain, flow-variant 54, is 4 hops; the
 * file's own indirect-recursion detector already caps DFS depth at 5 — 8
 * leaves a comfortable margin without risking pathological walks on a real,
 * deeply-layered project). Hitting the cap degrades to "no correlation", never
 * to a false claim — see `walkOwnershipChain`'s `null` return. */
const MAX_OWNERSHIP_HOPS = 8;

@Injectable()
export class CallGraphService {
  private readonly logger = new Logger(CallGraphService.name);

  constructor(private readonly cParser: CParserService) {}

  // Resolves a call site to the RIGHT implementation when the receiver's
  // constructed class is known (Juliet virtual-dispatch shape, flow-variant
  // 81-82: `Base* obj = new Derived; obj->action();` — `obj`'s DECLARED type is
  // `Base`, but `action()` must resolve to `Derived::action`). Falls back to the
  // existing bare-name `fnIndex` lookup when there's no receiver, no tracked
  // construction, or no qualified match — same behavior as before this fix for
  // every non-method call and every method call whose class can't be resolved.
  private resolveCallee(
    enclosing: FunctionInfo,
    call: { name: string; receiver?: string },
    fnIndex: Map<string, { fn: FunctionInfo; file: string }>,
    qualifiedFnIndex: Map<string, { fn: FunctionInfo; file: string }>,
  ): { fn: FunctionInfo; file: string } | undefined {
    if (call.receiver) {
      // Last construction of this variable before falling back — Juliet's shape
      // constructs once, immediately before the call, so source-order "last
      // assignment of this name" already matches "the one live at this call site"
      // without needing real line-ordering/control-flow analysis.
      const constructed = [...enclosing.constructedTypes].reverse().find((c) => c.variable === call.receiver);
      if (constructed) {
        const qualified = qualifiedFnIndex.get(`${constructed.className}::${call.name}`);
        if (qualified) return qualified;
      }
    }
    return fnIndex.get(call.name);
  }

  // Parses each file concurrently (spread across the worker pool) but always
  // applies the per-file results back in the ORIGINAL `files` order — a
  // duplicate function name across files must still resolve to the same file
  // deterministically regardless of which worker finishes first.
  private async parseAll(files: string[]): Promise<{ file: string; functions: FunctionInfo[] }[]> {
    return Promise.all(
      files.map(async (file) => {
        try {
          const content = readFileSync(file, 'utf-8');
          const result = await this.cParser.parse(content, file);
          return { file, functions: result.functions };
        } catch {
          return { file, functions: [] as FunctionInfo[] };
        }
      }),
    );
  }

  async extract(rootPath: string, files: string[], extraAllocators?: string[], extraDeallocators?: string[]) {
    this.logger.log({ event: ServerEventName.CALL_GRAPH_STARTED, rootPath, fileCount: files.length }, 'call graph extraction started');
    const allFunctions: Map<string, string> = new Map();
    const callEdges: { caller: string; callee: string; filePath: string; lineNumber: number; callee_file?: string }[] = [];
    const recursionCycles: string[][] = [];

    // First pass: collect all internal function names with their files. Also keep
    // the parsed FunctionInfo (first-definition-wins, same tie-break as
    // InterproceduralFlowService) — correlateOwnership() needs full function bodies,
    // not just the name→file map the rest of extract() uses.
    const functionToFile = new Map<string, string>();
    const fnIndex = new Map<string, { fn: FunctionInfo; file: string }>();
    // Qualified index (`ClassName::method`) — resolves same-named methods across
    // DIFFERENT classes (virtual dispatch, Juliet 81-82) that would otherwise
    // collide in `fnIndex` on the bare name (first-definition-wins). See
    // `extractClassMembership`'s doc comment in extraction-helpers.ts.
    const qualifiedFnIndex = new Map<string, { fn: FunctionInfo; file: string }>();
    const firstPass = await this.parseAll(files);
    for (const { file, functions } of firstPass) {
      for (const fn of functions) {
        allFunctions.set(fn.functionName, file);
        functionToFile.set(fn.functionName, file);
        if (!fnIndex.has(fn.functionName)) fnIndex.set(fn.functionName, { fn, file });
        if (fn.className && !qualifiedFnIndex.has(`${fn.className}::${fn.functionName}`)) {
          qualifiedFnIndex.set(`${fn.className}::${fn.functionName}`, { fn, file });
        }
      }
    }

    // Second pass: build edges with CFG-aware analysis
    const calleeToCallers = new Map<string, string[]>();
    const secondPass = await this.parseAll(files);
    for (const { file, functions } of secondPass) {
      for (const fn of functions) {
        for (const call of fn.functionCalls) {
          // Only track calls to functions defined in this project (internal calls)
          const calleeFile = functionToFile.get(call.name);
          callEdges.push({
            caller: fn.functionName,
            callee: call.name,
            filePath: file,
            lineNumber: call.line,
            callee_file: calleeFile || undefined,
          });

          // Track for cycle detection
          if (calleeFile) {
            if (!calleeToCallers.has(call.name)) {
              calleeToCallers.set(call.name, []);
            }
            calleeToCallers.get(call.name)!.push(fn.functionName);
          }
        }
      }
    }

    const paramOwnership = this.correlateOwnership(secondPass, fnIndex, qualifiedFnIndex);
    const returnOwnership = this.correlateReturnOwnership(secondPass, fnIndex);
    // Out-param ownership (Juliet 43/62: `badSource(char *&data)` — callee
    // allocates, writes back through a reference parameter instead of `return`)
    // and RAII ownership (Juliet 83-84: ctor allocates a field, dtor frees it)
    // reuse the SAME freedViaCaller/unfreedReturnOwnership shape as return-value
    // ownership above — three different data-flow directions, one candidate
    // representation, so staticContext.ts needs no changes to consume them.
    const outParamOwnership = this.correlateOutParamOwnership(secondPass, fnIndex, qualifiedFnIndex);
    const raiiOwnership = this.correlateRaiiOwnership(secondPass);
    const ownershipCorrelations = {
      freedCrossFile: paramOwnership.freedCrossFile,
      unfreedSinkParams: paramOwnership.unfreedSinkParams,
      freedViaCaller: [...returnOwnership.freedViaCaller, ...outParamOwnership.freedViaCaller, ...raiiOwnership.freedViaCaller],
      unfreedReturnOwnership: [...returnOwnership.unfreedReturnOwnership, ...outParamOwnership.unfreedReturnOwnership],
    };

    // Third pass: detect recursion cycles (direct + indirect). Build a caller→callees
    // adjacency list ONCE in O(E) (callEdges order preserved) so the DFS below walks
    // each node's own adjacency instead of re-filtering the entire edge array per
    // expansion — the old `edges.filter(e => e.caller === currentFn)` inside the DFS
    // made the traversal O(N·E) over all start nodes.
    const callerToCallees = new Map<string, string[]>();
    for (const e of callEdges) {
      let callees = callerToCallees.get(e.caller);
      if (!callees) {
        callees = [];
        callerToCallees.set(e.caller, callees);
      }
      callees.push(e.callee);
    }

    for (const [fnName] of allFunctions) {
      const callees = callerToCallees.get(fnName);
      if (callees && callees.includes(fnName)) {
        recursionCycles.push([fnName]); // direct recursion
      }
    }

    // Indirect recursion: iterative DFS over the adjacency list, depth-capped at 5.
    for (const [fnName] of allFunctions) {
      this.detectIndirectRecursion(fnName, callerToCallees, recursionCycles, 5);
    }

    // Deduplicate cycles
    const uniqueCycles = new Set<string>();
    const dedupedCycles = recursionCycles.filter((cycle) => {
      const key = [...cycle].sort().join('->');
      if (uniqueCycles.has(key)) return false;
      uniqueCycles.add(key);
      return true;
    });

    const nodes = Array.from(allFunctions.entries()).map(([name, file]) => ({
      functionName: name,
      filePath: file,
    }));

    // Allocation-to-free reachability analysis
    const allocFreeChains = this.analyzeAllocFreeChains(files, callEdges, extraAllocators, extraDeallocators);

    this.logger.log(
      { event: ServerEventName.CALL_GRAPH_FINISHED, rootPath, nodeCount: nodes.length, edgeCount: callEdges.length },
      'call graph extraction finished',
    );
    return {
      edges: callEdges,
      nodes,
      recursionCycles: dedupedCycles,
      allocFreeChains,
      stats: {
        totalFunctions: nodes.length,
        totalEdges: callEdges.length,
        internalEdges: callEdges.filter((e) => e.callee_file).length,
        externalCalls: callEdges.filter((e) => !e.callee_file).length,
        recursionCycles: dedupedCycles.length,
      },
      ownershipCorrelations,
    };
  }

  // Correlates "caller passes an already-tracked heap allocation into callee
  // parameter i" across function/file boundaries - the one piece of evidence
  // missing from the rest of this file's name-to-file indexing. Narrow by design:
  // only fires when the argument is a bare identifier that IS one of the
  // caller's own `allocationVariables` (a real heap allocation site in this
  // case's file set), never for ordinary borrow-only parameters - that's what
  // keeps this from exploding into a candidate for every pointer parameter in
  // the corpus.
  //
  // Two extensions beyond the original 1-hop, bare-parameter design:
  //   - Multi-hop chains (Juliet flow-variant 51-54): the immediate callee may
  //     be a pure pass-through (forwards the pointer to yet another function
  //     without freeing or otherwise using it) - `walkOwnershipChain` follows
  //     the chain to its TERMINAL function (the one that frees, or the one
  //     that does neither forward nor free - the real sink) instead of
  //     mis-attributing the pass-through hop as the sink.
  //   - Container transport (Juliet flow-variant 72-74): the caller may insert
  //     the allocation into a vector/list/map and pass the CONTAINER (not the
  //     original variable) across the call - tracked via
  //     `containerCarriers`/`containerExtractions` (populated by
  //     function-info-extractor.ts), correlated the same way but keyed on the
  //     container's identity rather than the original variable's. Kept to a
  //     single hop by design (not chained through `walkOwnershipChain`) -
  //     narrower scope, lower risk, matches what the corpus actually exercises.
  private correlateOwnership(
    parsed: { file: string; functions: FunctionInfo[] }[],
    fnIndex: Map<string, { fn: FunctionInfo; file: string }>,
    qualifiedFnIndex: Map<string, { fn: FunctionInfo; file: string }>,
  ): { freedCrossFile: FreedCrossFileEntry[]; unfreedSinkParams: UnfreedSinkParamEntry[] } {
    const freedCrossFile: FreedCrossFileEntry[] = [];
    const unfreedRaw: UnfreedSinkParamEntry[] = [];

    for (const { file, functions } of parsed) {
      for (const caller of functions) {
        const callerAllocs = new Map(caller.allocationVariables.map((a) => [a.variable, a.line]));
        // container name -> the first tracked allocation carried into it. Only
        // needs ONE, not all - correlation just needs to know "some tracked
        // allocation flows through this container," not enumerate every one.
        const containerAllocs = new Map<string, { variable: string; line: number }>();
        for (const c of caller.containerCarriers) {
          if (callerAllocs.has(c.variable) && !containerAllocs.has(c.container)) {
            containerAllocs.set(c.container, { variable: c.variable, line: callerAllocs.get(c.variable)! });
          }
        }

        for (const call of caller.functionCalls) {
          const callee = this.resolveCallee(caller, call, fnIndex, qualifiedFnIndex);
          if (!callee || callee.fn === caller) continue; // unresolved or self-recursive - skip
          const args = call.args ?? [];
          for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (!arg) continue;

            if (callerAllocs.has(arg)) {
              const param = callee.fn.parameters[i];
              if (!param?.isPointer) continue;
              const result = this.walkOwnershipChain(
                callee.fn,
                callee.file,
                param.name,
                fnIndex,
                qualifiedFnIndex,
                new Set([caller.functionName, callee.fn.functionName]),
                MAX_OWNERSHIP_HOPS,
              );
              if (!result) continue; // hop cap hit or a cycle - degrade to no correlation
              if (result.freed) {
                freedCrossFile.push({
                  callerFunction: caller.functionName,
                  callerFile: file,
                  callerVariable: arg,
                  callerAllocLine: callerAllocs.get(arg)!,
                  calleeFunction: result.at.fn,
                  calleeFile: result.at.file,
                  calleeParam: result.at.param,
                });
              } else {
                unfreedRaw.push({
                  calleeFunction: result.sink.fn,
                  calleeFile: result.sink.file,
                  calleeParam: result.sink.param,
                  calleeSigLine: result.sink.sigLine,
                  callerFunction: caller.functionName,
                  callerFile: file,
                  callerVariable: arg,
                });
              }
            } else if (containerAllocs.has(arg)) {
              const carried = containerAllocs.get(arg)!;
              const param = callee.fn.parameters[i];
              if (!param) continue; // a container arg isn't isPointer - no gate on that here
              const extraction = callee.fn.containerExtractions.find((e) => e.container === param.name);
              if (!extraction) continue; // callee never reads the container - no evidence either way
              const freed = callee.fn.freedVariables.some((f) => f.variable === extraction.variable);
              if (freed) {
                freedCrossFile.push({
                  callerFunction: caller.functionName,
                  callerFile: file,
                  callerVariable: carried.variable,
                  callerAllocLine: carried.line,
                  calleeFunction: callee.fn.functionName,
                  calleeFile: callee.file,
                  calleeParam: extraction.variable,
                  kind: 'container',
                });
              } else {
                unfreedRaw.push({
                  calleeFunction: callee.fn.functionName,
                  calleeFile: callee.file,
                  calleeParam: extraction.variable,
                  calleeSigLine: extraction.line,
                  callerFunction: caller.functionName,
                  callerFile: file,
                  callerVariable: carried.variable,
                  kind: 'container',
                });
              }
            }
          }
        }
      }
    }

    // One synthetic-candidate-worthy entry per sink parameter, regardless of how
    // many callers pass an allocation into it.
    const seen = new Set<string>();
    const unfreedSinkParams = unfreedRaw.filter((e) => {
      const key = `${e.calleeFile} ${e.calleeFunction} ${e.calleeParam}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { freedCrossFile, unfreedSinkParams };
  }

  // Follows a pointer PARAMETER forward through a chain of pass-through calls
  // (flow-variant 51-54: A allocates -> passes to B -> B forwards to C -> ... ),
  // stopping at the first function that either frees it (a real free, at any
  // hop) or does not forward it further (the true terminal sink - NOT the
  // first hop, which may just be a pass-through helper). `visited` guards
  // against cycles/mutual recursion; `hopsLeft` bounds the walk so a
  // real-world project's deep call graphs can't spin forever - hitting either
  // guard returns null (no correlation), never a false claim.
  private walkOwnershipChain(
    fn: FunctionInfo,
    file: string,
    paramName: string,
    fnIndex: Map<string, { fn: FunctionInfo; file: string }>,
    qualifiedFnIndex: Map<string, { fn: FunctionInfo; file: string }>,
    visited: Set<string>,
    hopsLeft: number,
  ):
    | { freed: true; at: { fn: string; file: string; param: string } }
    | { freed: false; sink: { fn: string; file: string; param: string; sigLine: number } }
    | null {
    if (fn.freedVariables.some((f) => f.variable === paramName)) {
      return { freed: true, at: { fn: fn.functionName, file, param: paramName } };
    }
    for (const call of fn.functionCalls) {
      const idx = (call.args ?? []).indexOf(paramName);
      if (idx === -1) continue;
      const next = this.resolveCallee(fn, call, fnIndex, qualifiedFnIndex);
      if (!next || visited.has(next.fn.functionName)) continue; // unresolved callee or cycle
      const nextParam = next.fn.parameters[idx];
      if (!nextParam?.isPointer) continue;
      if (hopsLeft <= 0) return null;
      const nextVisited = new Set(visited);
      nextVisited.add(next.fn.functionName);
      return this.walkOwnershipChain(next.fn, next.file, nextParam.name, fnIndex, qualifiedFnIndex, nextVisited, hopsLeft - 1);
    }
    // No forwarding call found and not freed here -> this function IS the sink.
    return { freed: false, sink: { fn: fn.functionName, file, param: paramName, sigLine: fn.lineNumber } };
  }

  // The MIRROR of correlateOwnership() for the opposite data-flow direction
  // (Juliet flow-variant 42-45/61-68): a callee ALLOCATES and RETURNS a
  // pointer, and the caller assigns it to a local variable (`data =
  // badSource(data);`, captured by FunctionInfo.assignedCalls) - either
  // freeing it (exonerates the callee's own allocation-site candidate, which
  // both same-file and cross-file heuristic-leak-analysis.ts logic would
  // otherwise misjudge - see freedViaCaller) or dropping it (the dispatcher
  // itself is the real, currently-uncandidated flaw - see
  // unfreedReturnOwnership). Self-contained, same FunctionInfo-field-only
  // approach as inferOwnershipSummary in ownership-analysis.service.ts -
  // deliberately re-implemented inline here rather than cross-service, to stay
  // consistent with correlateOwnership()'s own self-contained style.
  private correlateReturnOwnership(
    parsed: { file: string; functions: FunctionInfo[] }[],
    fnIndex: Map<string, { fn: FunctionInfo; file: string }>,
  ): { freedViaCaller: FreedViaCallerEntry[]; unfreedReturnOwnership: UnfreedReturnOwnershipEntry[] } {
    const freedViaCaller: FreedViaCallerEntry[] = [];
    const unfreedRaw: UnfreedReturnOwnershipEntry[] = [];

    for (const { file, functions } of parsed) {
      for (const caller of functions) {
        for (const assigned of caller.assignedCalls) {
          const callee = fnIndex.get(assigned.callName);
          if (!callee || callee.fn === caller) continue;
          const returnedAlloc = callee.fn.allocationVariables.find(
            (a) =>
              !callee.fn.freedVariables.some((f) => f.variable === a.variable) &&
              callee.fn.returnStatements.some((r) => r.text.includes(a.variable)),
          );
          if (!returnedAlloc) continue; // callee isn't a return-ownership carrier
          const freedByCaller = caller.freedVariables.some((f) => f.variable === assigned.variable);
          if (freedByCaller) {
            freedViaCaller.push({
              calleeFunction: callee.fn.functionName,
              calleeFile: callee.file,
              variable: returnedAlloc.variable,
              callerFunction: caller.functionName,
              callerFile: file,
            });
          } else {
            unfreedRaw.push({
              callerFunction: caller.functionName,
              callerFile: file,
              callerVariable: assigned.variable,
              callerAssignLine: assigned.line,
              calleeFunction: callee.fn.functionName,
              calleeFile: callee.file,
            });
          }
        }
      }
    }

    // One synthesized-dispatcher-candidate entry per (file, function, variable,
    // line) - the same dispatcher calling the same allocate-and-return callee
    // from the same assignment site should not duplicate.
    const seen = new Set<string>();
    const unfreedReturnOwnership = unfreedRaw.filter((e) => {
      const key = `${e.callerFile} ${e.callerFunction} ${e.callerVariable} ${e.callerAssignLine}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { freedViaCaller, unfreedReturnOwnership };
  }

  // A THIRD data-flow direction, distinct from both correlateOwnership()
  // (caller allocates, passes an ALREADY-allocated pointer INTO the callee) and
  // correlateReturnOwnership() (callee allocates and hands it back via
  // `return`): Juliet flow-variant 43/62 — `badSource(char *&data)` — the
  // callee allocates and writes back through a REFERENCE-OUTPUT parameter; the
  // caller passes an uninitialized/don't-care variable IN and receives the
  // allocation OUT through the same argument. Verified against the real case
  // (`char_calloc_43`): `isPointer` is already correctly `true` for `char *
  // &data` (tree-sitter's `pointer_declarator` wraps `reference_declarator`),
  // so the gap isn't extraction — it's that correlateOwnership()'s gate
  // (`callerAllocs.has(arg)`, i.e. "caller already allocated this") can never
  // fire here, since the caller has NOT allocated anything before the call.
  // Confirmed root cause: with no correlation at all, `goodB2GSource`'s
  // allocation got the exact same generic same-function verdict as
  // `badSource`'s, from `heuristic-leak-analysis.ts`'s same-function-only free
  // check — both looked identical from that vantage point.
  private correlateOutParamOwnership(
    parsed: { file: string; functions: FunctionInfo[] }[],
    fnIndex: Map<string, { fn: FunctionInfo; file: string }>,
    qualifiedFnIndex: Map<string, { fn: FunctionInfo; file: string }>,
  ): { freedViaCaller: FreedViaCallerEntry[]; unfreedReturnOwnership: UnfreedReturnOwnershipEntry[] } {
    const freedViaCaller: FreedViaCallerEntry[] = [];
    const unfreedRaw: UnfreedReturnOwnershipEntry[] = [];

    for (const { file, functions } of parsed) {
      for (const caller of functions) {
        const callerAllocs = new Set(caller.allocationVariables.map((a) => a.variable));
        for (const call of caller.functionCalls) {
          const callee = this.resolveCallee(caller, call, fnIndex, qualifiedFnIndex);
          if (!callee || callee.fn === caller) continue;
          const args = call.args ?? [];
          for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            // Bare identifier, and NOT already the caller's own allocation —
            // that direction is correlateOwnership()'s, not this one.
            if (!arg || callerAllocs.has(arg)) continue;
            const param = callee.fn.parameters[i];
            if (!param?.isPointer) continue;
            const outAlloc = callee.fn.allocationVariables.find(
              (a) => a.variable === param.name && !callee.fn.freedVariables.some((f) => f.variable === param.name),
            );
            if (!outAlloc) continue; // callee doesn't allocate-and-leave-unfreed through this param
            const freedByCaller = caller.freedVariables.some((f) => f.variable === arg);
            if (freedByCaller) {
              freedViaCaller.push({
                calleeFunction: callee.fn.functionName,
                calleeFile: callee.file,
                variable: outAlloc.variable,
                callerFunction: caller.functionName,
                callerFile: file,
              });
            } else {
              unfreedRaw.push({
                callerFunction: caller.functionName,
                callerFile: file,
                callerVariable: arg,
                callerAssignLine: call.line,
                calleeFunction: callee.fn.functionName,
                calleeFile: callee.file,
              });
            }
          }
        }
      }
    }

    const seen = new Set<string>();
    const unfreedReturnOwnership = unfreedRaw.filter((e) => {
      const key = `${e.callerFile} ${e.callerFunction} ${e.callerVariable} ${e.callerAssignLine}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { freedViaCaller, unfreedReturnOwnership };
  }

  // RAII (Juliet flow-variant 83-84): a class's CONSTRUCTOR allocates a field,
  // its DESTRUCTOR frees it — two different functions entirely, so the existing
  // same-function-only free check (heuristic-leak-analysis.ts's
  // `hasFreeOfVar`/`findEnclosingFunction`) can never see the destructor's free
  // as satisfying the constructor's allocation, misjudging every correctly-
  // cleaned-up case as a leak. Only handles the exoneration direction
  // (freedViaCaller) — when NO destructor free is found, the constructor's own
  // allocation-site candidate (already produced by ordinary candidateScan,
  // unlike return-ownership's dispatcher which needs a synthesized candidate)
  // is left exactly as-is: no new candidate to synthesize, so no change to FN
  // behavior, only to the false-positive rate.
  private correlateRaiiOwnership(
    parsed: { file: string; functions: FunctionInfo[] }[],
  ): { freedViaCaller: FreedViaCallerEntry[] } {
    const freedViaCaller: FreedViaCallerEntry[] = [];
    const ctors = parsed.flatMap(({ file, functions }) =>
      functions.filter((fn) => fn.memberKind === 'ctor').map((fn) => ({ fn, file })),
    );
    const dtors = parsed.flatMap(({ file, functions }) =>
      functions.filter((fn) => fn.memberKind === 'dtor').map((fn) => ({ fn, file })),
    );

    for (const { fn: ctor, file } of ctors) {
      const dtor = dtors.find((d) => d.fn.className && d.fn.className === ctor.className);
      if (!dtor) continue;
      for (const alloc of ctor.allocationVariables) {
        if (ctor.freedVariables.some((f) => f.variable === alloc.variable)) continue; // freed within the ctor itself
        if (dtor.fn.freedVariables.some((f) => f.variable === alloc.variable)) {
          freedViaCaller.push({
            calleeFunction: ctor.functionName,
            calleeFile: file,
            variable: alloc.variable,
            callerFunction: dtor.fn.functionName,
            callerFile: dtor.file,
          });
        }
      }
    }

    return { freedViaCaller };
  }

  /**
   * Indirect-recursion detector: finds, for each start function, cycles reachable
   * within `maxDepth` hops and pushes each as `[...path, startFn]`. Iterative DFS
   * over the prebuilt adjacency list — the old version re-scanned the whole edge
   * array (`edges.filter(e => e.caller === currentFn)`) at every expansion, i.e.
   * O(N·E) across all starts; this walks only each node's own adjacency, O(V+E)
   * across all starts (bounded by maxDepth). Cycle set, order and shape are
   * byte-identical: the adjacency preserves callEdges order and the explicit stack
   * mirrors the previous recursive backtracking (path/visited unwind on pop).
   */
  private detectIndirectRecursion(
    startFn: string,
    adjacency: Map<string, string[]>,
    cycles: string[][],
    maxDepth: number,
  ) {
    const visited = new Set<string>([startFn]);
    const path: string[] = [startFn];
    // Frames carry the node and the next adjacency index to expand; a frame is
    // popped once its out-degree is exhausted, unwinding path/visited like the
    // recursion's post-order `path.pop(); visited.delete(callee)`.
    const stack: { node: string; next: number }[] = [{ node: startFn, next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const callees = adjacency.get(frame.node);
      if (!callees || frame.next >= callees.length) {
        stack.pop();
        if (stack.length > 0) {
          path.pop();
          visited.delete(frame.node);
        }
        continue;
      }
      const callee = callees[frame.next++];
      if (callee === frame.node) continue; // self-edge — the old filter dropped e.callee === currentFn
      if (callee === startFn && path.length > 1) {
        cycles.push([...path, startFn]);
        continue;
      }
      if (visited.has(callee)) continue;
      // Recursion returned at entry once path.length reached maxDepth; a child
      // explored only when it would still be within the bound. Skipping the push
      // is equivalent (add-then-immediately-return left no lasting state).
      if (path.length + 1 >= maxDepth) continue;
      visited.add(callee);
      path.push(callee);
      stack.push({ node: callee, next: 0 });
    }
  }

  private analyzeAllocFreeChains(
    files: string[],
    edges: { caller: string; callee: string }[],
    extraAllocators?: string[],
    extraDeallocators?: string[],
  ): { allocFunction: string; freeFunction: string; callers: string[] }[] {
    const chains: { allocFunction: string; freeFunction: string; callers: string[] }[] = [];
    const safe = (xs?: string[]) => (xs || []).filter((s) => /^[A-Za-z_]\w*$/.test(s));
    const allocFuncs = ['malloc', 'calloc', 'realloc', 'strdup', ...safe(extraAllocators)];
    const freeFuncs = ['free', 'xfree', ...safe(extraDeallocators)];

    // callee → callers built ONCE in O(E); the old version re-filtered the full
    // edge array per (allocFn, freeFn) pair — O(A·F·E). Insertion order preserved
    // so each Set's caller order (and the resulting chains) is unchanged.
    const callersByCallee = new Map<string, string[]>();
    for (const e of edges) {
      let callers = callersByCallee.get(e.callee);
      if (!callers) {
        callers = [];
        callersByCallee.set(e.callee, callers);
      }
      callers.push(e.caller);
    }

    for (const allocFn of allocFuncs) {
      for (const freeFn of freeFuncs) {
        const allocCallers = new Set(callersByCallee.get(allocFn) ?? []);
        const freeCallers = new Set(callersByCallee.get(freeFn) ?? []);
        const commonCallers = [...allocCallers].filter((c) => freeCallers.has(c));

        if (commonCallers.length > 0) {
          chains.push({ allocFunction: allocFn, freeFunction: freeFn, callers: commonCallers });
        }
      }
    }

    return chains;
  }
}
