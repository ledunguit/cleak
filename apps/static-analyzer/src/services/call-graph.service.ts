import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import { CParserService, ControlFlowGraph, FunctionInfo } from './c-parser.service';
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
  constructor(private readonly cParser: CParserService) {}

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
    const allFunctions: Map<string, string> = new Map();
    const callEdges: { caller: string; callee: string; filePath: string; lineNumber: number; callee_file?: string }[] = [];
    const recursionCycles: string[][] = [];

    // First pass: collect all internal function names with their files. Also keep
    // the parsed FunctionInfo (first-definition-wins, same tie-break as
    // InterproceduralFlowService) — correlateOwnership() needs full function bodies,
    // not just the name→file map the rest of extract() uses.
    const functionToFile = new Map<string, string>();
    const fnIndex = new Map<string, { fn: FunctionInfo; file: string }>();
    const firstPass = await this.parseAll(files);
    for (const { file, functions } of firstPass) {
      for (const fn of functions) {
        allFunctions.set(fn.functionName, file);
        functionToFile.set(fn.functionName, file);
        if (!fnIndex.has(fn.functionName)) fnIndex.set(fn.functionName, { fn, file });
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

    const paramOwnership = this.correlateOwnership(secondPass, fnIndex);
    const returnOwnership = this.correlateReturnOwnership(secondPass, fnIndex);
    const ownershipCorrelations = {
      freedCrossFile: paramOwnership.freedCrossFile,
      unfreedSinkParams: paramOwnership.unfreedSinkParams,
      freedViaCaller: returnOwnership.freedViaCaller,
      unfreedReturnOwnership: returnOwnership.unfreedReturnOwnership,
    };

    // Third pass: detect recursion cycles (direct + indirect)
    for (const [fnName] of allFunctions) {
      const directRecursion = callEdges.filter(
        (e) => e.caller === fnName && e.callee === fnName,
      );
      if (directRecursion.length > 0) {
        recursionCycles.push([fnName]); // direct recursion
      }
    }

    // Indirect recursion: simple DFS limited to depth 5
    for (const [fnName] of allFunctions) {
      const visited = new Set<string>();
      const path: string[] = [fnName];
      visited.add(fnName);
      this.detectIndirectRecursion(fnName, fnName, callEdges, visited, path, recursionCycles, 5);
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
          const callee = fnIndex.get(call.name);
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
      const next = fnIndex.get(call.name);
      if (!next || visited.has(next.fn.functionName)) continue; // unresolved callee or cycle
      const nextParam = next.fn.parameters[idx];
      if (!nextParam?.isPointer) continue;
      if (hopsLeft <= 0) return null;
      const nextVisited = new Set(visited);
      nextVisited.add(next.fn.functionName);
      return this.walkOwnershipChain(next.fn, next.file, nextParam.name, fnIndex, nextVisited, hopsLeft - 1);
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

  private detectIndirectRecursion(
    startFn: string,
    currentFn: string,
    edges: { caller: string; callee: string }[],
    visited: Set<string>,
    path: string[],
    cycles: string[][],
    maxDepth: number,
  ) {
    if (path.length >= maxDepth) return;

    const outgoing = edges.filter((e) => e.caller === currentFn && e.callee !== currentFn);

    for (const edge of outgoing) {
      if (edge.callee === startFn && path.length > 1) {
        cycles.push([...path, startFn]);
        continue;
      }

      if (!visited.has(edge.callee)) {
        visited.add(edge.callee);
        path.push(edge.callee);
        this.detectIndirectRecursion(startFn, edge.callee, edges, visited, path, cycles, maxDepth);
        path.pop();
        visited.delete(edge.callee);
      }
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

    for (const allocFn of allocFuncs) {
      for (const freeFn of freeFuncs) {
        // Find functions that call allocFn AND freeFn (potential balanced alloc/free)
        const allocCallers = new Set(
          edges.filter((e) => e.callee === allocFn).map((e) => e.caller),
        );
        const freeCallers = new Set(
          edges.filter((e) => e.callee === freeFn).map((e) => e.caller),
        );
        const commonCallers = [...allocCallers].filter((c) => freeCallers.has(c));

        if (commonCallers.length > 0) {
          chains.push({ allocFunction: allocFn, freeFunction: freeFn, callers: commonCallers });
        }
      }
    }

    return chains;
  }
}
