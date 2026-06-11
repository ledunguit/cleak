import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import {
  BuildPlan,
  InvestigationActionRecord,
  InvestigationPlan,
  InvestigationPlanningRecord,
  LeakBundle,
  LeakEvidence,
  RepositoryManifest,
  ToolExecutionRecord,
  AgentLoopState,
  AgentDecision,
  AgentActionKind,
  LeakPatternType,
  MemoryLeakAnalysis,
  ToolCost,
  InvestigationVerdict,
  ToolKind,
  LeakRootCause,
  ControlFlowInfo,
  FindingStatus,
  ScanEventName,
  StaticLeakEvidence,
} from '@mcpvul/common';
import { CreateScanDto } from '@mcpvul/common/dto/scan.dto';
import {
  deriveDynamicFields,
  correlateEvidence,
  correlationRank,
} from '@mcpvul/common/analysis/dynamic-evidence';
import { CandidateManagerService } from './candidate-manager.service';
import { DynamicPlannerService } from './dynamic-planner.service';
import { InvestigationPlannerService } from './investigation-planner.service';
import { JudgeService } from './judge.service';
import { ReportingService } from './reporting.service';
import { ToolRegistryService, ToolRegistration } from './tool-registry.service';
import { mapWithLimit } from '../utils/concurrency';
import { existsSync, readFileSync } from 'fs';

// Bounded fan-out for independent gRPC/LLM calls (env-tunable).
const SCAN_CONCURRENCY = Math.max(1, Number(process.env.SCAN_CONCURRENCY ?? 4));
const JUDGE_CONCURRENCY = Math.max(1, Number(process.env.JUDGE_CONCURRENCY ?? 4));

export interface StaticAnalyzerService {
  indexFiles(data: any): any;
  candidateScan(data: any): any;
  astScan(data: any): any;
  callGraph(data: any): any;
  functionSummary(data: any): any;
  interproceduralFlow(data: any): any;
  pathConstraints(data: any): any;
  ownershipSummary(data: any): any;
  ownershipConventions(data: any): any;
  leakguardRun(data: any): any;
  leakguardGetReport(data: any): any;
}

export interface DynamicAnalyzerService {
  buildTarget(data: any): any;
  valgrindMemcheck(data: any): any;
  asanRun(data: any): any;
  lsanRun(data: any): any;
}

export interface OrchestratorDeps {
  staticSvc: StaticAnalyzerService;
  dynamicSvc: DynamicAnalyzerService;
  scanId: string;
  scanCreatedAt: string;
  dto: CreateScanDto;
  sourceWorkspacePath?: string;
  hostMaterializedWorkspacePath?: string;
  materializedWorkspaceId?: string;
  sourceType?: string;
  repositoryManifest?: RepositoryManifest;
  resolvedBuildCommand?: string;
  buildPlan: BuildPlan | null;
  requestedFormats: string[];
  emitEvent: (scanId: string, event: string, extra?: Record<string, any>) => void;
}

export interface OrchestratorResult {
  indexResult: any;
  bundles: LeakBundle[];
  report: Record<string, any>;
  toolExecutions: ToolExecutionRecord[];
  dynamicExecutionPlan: Record<string, unknown> | null;
  staticContext: Map<string, Record<string, any>>;
  investigationPlan: InvestigationPlan;
  planningTimeline: InvestigationPlanningRecord[];
  actionTimeline: InvestigationActionRecord[];
  agentDecisions: AgentDecision[];
  agentLoopState: AgentLoopState;
}

const TOOL_CATALOG: ToolCost[] = [
  { name: 'repo.index_files', phase: 'discovery', description: 'Index all C/C++ source files in the repository', typicalDurationMs: 2000, prerequisites: [], providesEvidenceFor: ['file_list', 'project_structure'] },
  { name: 'memory.candidate_scan', phase: 'discovery', description: 'Lexical scan for allocation sites (malloc, calloc, realloc, strdup, new)', typicalDurationMs: 500, prerequisites: ['repo.index_files'], providesEvidenceFor: ['allocation_sites', 'candidates'] },
  { name: 'memory.ast_scan', phase: 'static_analysis', description: 'AST-based structural analysis for memory leak patterns', typicalDurationMs: 3000, prerequisites: ['repo.index_files'], providesEvidenceFor: ['control_flow', 'pattern_matches'] },
  { name: 'memory.function_summary', phase: 'static_analysis', description: 'Function-level alloc/free balance analysis', typicalDurationMs: 1000, prerequisites: ['memory.candidate_scan'], providesEvidenceFor: ['alloc_free_balance', 'ownership'] },
  { name: 'memory.call_graph', phase: 'static_analysis', description: 'Call graph extraction for interprocedural tracing', typicalDurationMs: 4000, prerequisites: ['repo.index_files'], providesEvidenceFor: ['call_edges', 'reachability'] },
  { name: 'memory.path_constraints', phase: 'static_analysis', description: 'Path constraint analysis for conditional leaks', typicalDurationMs: 2000, prerequisites: ['memory.candidate_scan'], providesEvidenceFor: ['branch_conditions', 'feasible_paths'] },
  { name: 'memory.interprocedural_flow', phase: 'static_analysis', description: 'Interprocedural data flow analysis', typicalDurationMs: 5000, prerequisites: ['memory.call_graph'], providesEvidenceFor: ['data_flow', 'pointer_tracking'] },
  { name: 'memory.ownership_summary', phase: 'static_analysis', description: 'Ownership convention analysis', typicalDurationMs: 2000, prerequisites: ['memory.function_summary'], providesEvidenceFor: ['ownership_violations', 'conventions'] },
  { name: 'memory.leakguard_run', phase: 'deep_static', description: 'Run the project-level Clang Static Analyzer (scan-build)', typicalDurationMs: 60000, prerequisites: ['repo.index_files', 'build_command'], providesEvidenceFor: ['clang_analysis', 'csa_findings'] },
  { name: 'memory.leakguard_get_report', phase: 'deep_static', description: 'Retrieve LeakGuard analysis report', typicalDurationMs: 500, prerequisites: ['memory.leakguard_run'], providesEvidenceFor: ['leakguard_findings'] },
  { name: 'build_target', phase: 'dynamic_prep', description: 'Build the target project with sanitizer flags', typicalDurationMs: 30000, prerequisites: ['build_command'], providesEvidenceFor: ['binary'] },
  { name: 'asan.run', phase: 'dynamic', description: 'Run binary under AddressSanitizer', typicalDurationMs: 10000, prerequisites: ['build_target'], providesEvidenceFor: ['asan_findings', 'leak_reports'] },
  { name: 'lsan.run', phase: 'dynamic', description: 'Run binary under LeakSanitizer', typicalDurationMs: 10000, prerequisites: ['build_target'], providesEvidenceFor: ['lsan_findings', 'leak_summary'] },
  { name: 'valgrind.analyze_memcheck', phase: 'dynamic', description: 'Run Valgrind Memcheck for detailed leak analysis', typicalDurationMs: 30000, prerequisites: ['build_target'], providesEvidenceFor: ['valgrind_findings', 'detailed_leaks'] },
];

@Injectable()
export class ScanOrchestratorService {
  private readonly logger = new Logger(ScanOrchestratorService.name);

  constructor(
    private readonly toolRegistry: ToolRegistryService,
    private readonly candidateManager: CandidateManagerService,
    private readonly judgeService: JudgeService,
    private readonly reportingService: ReportingService,
    private readonly dynamicPlanner: DynamicPlannerService,
    private readonly investigationPlanner: InvestigationPlannerService,
  ) {}

  async run(deps: OrchestratorDeps): Promise<OrchestratorResult> {
    const registry = this.toolRegistry.createRun();
    this.registerTools(registry, deps);

    const { dto, scanId, emitEvent } = deps;
    const startedAt = new Date().toISOString();

    // ── Initialize Agent Loop State ──
    const agentState: AgentLoopState = {
      scanId,
      phase: 'discovery',
      bundles: [],
      toolExecutions: [],
      focusBundleIds: [],
      actionsTaken: [],
      currentStrategy: 'agentic_discovery',
      llmContext: '',
      startedAt,
      maxInvestigationLoops: this.computeMaxLoops(dto),
      investigationCount: 0,
    };

    // ═══════════════════════════════════════════
    // PHASE 1: DISCOVERY — Index + Candidate Scan
    // ═══════════════════════════════════════════
    emitEvent(scanId, ScanEventName.DISCOVERY_STARTED, {
      workspacePath: dto.workspacePath,
      agentMode: dto.analysisMode || 'no_llm',
      toolCount: registry.listTools().length,
      maxLoops: agentState.maxInvestigationLoops,
    });
    const indexResult: any = await registry.invoke('repo.index_files', {
      rootPath: dto.workspacePath,
      fileLimit: dto.fileLimit,
    });
    agentState.phase = 'candidate_ranking';

    emitEvent(scanId, ScanEventName.CANDIDATES_SCANNING, { totalFiles: indexResult.totalCount });
    this.candidateManager.clear();
    const cFileCount = (indexResult.files || []).length;

    // Scan files concurrently (bounded) — each scan is an independent gRPC call.
    // Ingestion stays sequential over the ordered results so candidate ids/order
    // are deterministic regardless of which scan finished first.
    const scanResults = await mapWithLimit(indexResult.files || [], SCAN_CONCURRENCY, async (file) => {
      try {
        const csResult: any = await registry.invoke('memory.candidate_scan', { filePath: file, content: '' });
        return csResult.candidates || [];
      } catch (err: any) {
        this.logger.warn(`[ORCH] candidateScan failed for file=${file}: ${err.message}`);
        return [];
      }
    });
    for (const candidates of scanResults) {
      for (const c of candidates) {
        const hostFilePath = this.toHostPath(c.filePath || c.file_path || '', deps);
        this.candidateManager.ingest({
          id: c.id,
          function_name: c.functionName || c.function_name || '',
          file_path: hostFilePath,
          line_number: c.lineNumber ?? c.line_number ?? 0,
          allocation_site: c.allocationSite || c.allocation_site || '',
          allocation_type: c.allocationType || c.allocation_type || '',
          confidence: c.confidence || 'medium',
          context: c.context || '',
        });
      }
    }

    agentState.bundles = this.candidateManager.getAllBundles();
    emitEvent(scanId, ScanEventName.DISCOVERY_FINISHED, { totalCandidates: agentState.bundles.length, totalFiles: cFileCount });
    this.logger.log(`[ORCH] Discovery complete: ${agentState.bundles.length} candidates from ${cFileCount} files`);

    // ═══════════════════════════════════════════
    // PHASE 2: AGENTIC INVESTIGATION LOOP
    // ═══════════════════════════════════════════
    agentState.phase = 'investigation';
    const agentDecisions: AgentDecision[] = [];
    const staticContext = new Map<string, Record<string, any>>();
    let buildPlan = deps.buildPlan;

    const maxLoops = agentState.maxInvestigationLoops;
    const toolCatalog = TOOL_CATALOG;

    emitEvent(scanId, ScanEventName.INVESTIGATION_STARTED, { maxLoops });

    for (let turn = 0; turn < maxLoops; turn++) {
      const loopStart = Date.now();
      emitEvent(scanId, ScanEventName.AGENT_TURN_STARTED, { turn: turn + 1, maxLoops, bundlesRemaining: agentState.bundles.length });

      // ── Step A: LLM or heuristic decides next action ──
      const decision = await this.investigationPlanner.decideNextAction({
        state: agentState,
        bundles: agentState.bundles,
        buildPlan,
        toolCatalog,
        analysisMode: dto.analysisMode,
        dynamicMode: dto.dynamicMode,
      });

      agentState.currentStrategy = `turn_${turn + 1}: ${decision.actionKind}`;
      const actionKind = decision.actionKind as AgentActionKind;
      const targetBundleIds = decision.targetBundleIds?.length ? decision.targetBundleIds : agentState.bundles.map((b) => b.bundleId);

      const agentDecision: AgentDecision = {
        turn: turn + 1,
        actionKind,
        rationale: decision.rationale,
        strategySource: decision.strategySource,
        toolName: decision.toolName,
        targetBundleIds,
        args: decision.args,
        reasoning: decision.reasoning,
        decidedAt: new Date().toISOString(),
      };

      // ── Step B: Execute the decision ──
      let actionResult: string;
      try {
        switch (actionKind) {
          case AgentActionKind.RUN_STATIC_TOOL: {
            if (!decision.toolName) throw new Error('No tool specified');
            const targetBundles = this.resolveTargetBundles(agentState.bundles, targetBundleIds);

            for (const bundle of targetBundles) {
              const analyzerPath = this.toAnalyzerPath(bundle.candidate.file_path, deps);
              const ctxKey = bundle.bundleId;
              const snippet = this.readContextSnippet(bundle.candidate.file_path, bundle.candidate.line_number);

              let result: any;
              try {
                switch (decision.toolName) {
                  case 'memory.ast_scan':
                    result = await registry.invoke('memory.ast_scan', { filePath: analyzerPath, content: '' });
                    break;
                  case 'memory.call_graph':
                    result = await registry.invoke('memory.call_graph', { rootPath: dto.workspacePath, files: indexResult.files || [] });
                    break;
                  case 'memory.function_summary':
                    result = await registry.invoke('memory.function_summary', { filePath: analyzerPath, content: '', functionName: bundle.candidate.function_name });
                    break;
                  case 'memory.path_constraints':
                    result = await registry.invoke('memory.path_constraints', { filePath: analyzerPath, content: '', lineNumber: bundle.candidate.line_number });
                    break;
                  case 'memory.interprocedural_flow':
                    result = await registry.invoke('memory.interprocedural_flow', { rootPath: dto.workspacePath, functionName: bundle.candidate.function_name, files: indexResult.files || [] });
                    break;
                  case 'memory.ownership_summary':
                    result = await registry.invoke('memory.ownership_summary', { files: indexResult.files || [], rootPath: dto.workspacePath });
                    break;
                  default:
                    this.logger.warn(`Unknown static tool: ${decision.toolName}`);
                    continue;
                }
              } catch (toolErr: any) {
                this.logger.warn(`Tool ${decision.toolName} failed for bundle ${bundle.bundleId}: ${toolErr.message}`);
                continue;
              }

              const accumulatedCtx = staticContext.get(ctxKey) || {};
              if (decision.toolName === 'memory.path_constraints' && result) {
                accumulatedCtx.feasiblePaths = result.feasiblePaths || [];
                accumulatedCtx.constraints = result.constraints || [];
                if (Array.isArray(result.feasibleLeakPaths)) {
                  accumulatedCtx.feasibleLeakPaths = result.feasibleLeakPaths;
                  this.mergeBundleStaticEvidence(bundle, {
                    feasibleLeakPaths: result.feasibleLeakPaths,
                    earlyReturnCount: Number(result.earlyReturnCount ?? 0),
                  });
                }
              }
              if (decision.toolName === 'memory.function_summary' && result) {
                accumulatedCtx.hasExplicitFree = (result.frees?.length || 0) > 0;
                accumulatedCtx.allocations = result.allocations || [];
                accumulatedCtx.frees = result.frees || [];
                if (Array.isArray(result.pairs)) {
                  accumulatedCtx.allocFreePairs = result.pairs;
                  this.mergeBundleStaticEvidence(bundle, { allocFreePairs: result.pairs });
                }
              }
              if (decision.toolName === 'memory.ownership_summary' && result) {
                const match = (result.ownerships || []).find(
                  (o: any) => o.functionName === bundle.candidate.function_name,
                );
                if (match) {
                  accumulatedCtx.ownership = match;
                  if (match.summary) {
                    accumulatedCtx.ownershipSummary = match.summary;
                    this.mergeBundleStaticEvidence(bundle, { ownership: match.summary });
                  }
                }
              }
              if (decision.toolName === 'memory.call_graph' && result) {
                accumulatedCtx.callEdges = result.edges || [];
              }
              if (decision.toolName === 'memory.interprocedural_flow' && result) {
                accumulatedCtx.flowPaths = result.paths || [];
              }
              if (decision.toolName === 'memory.ast_scan' && result) {
                const summaries = result.functionSummaries || result.function_summaries || [];
                const fnSummary = summaries.find((s: any) => s.functionName === bundle.candidate.function_name);
                if (fnSummary) {
                  accumulatedCtx.earlyReturnCount = Number(fnSummary.earlyReturnCount ?? fnSummary.early_return_count ?? 0);
                  accumulatedCtx.leakyExitPaths = Number(fnSummary.leakyExitPaths ?? fnSummary.leaky_exit_paths ?? 0);
                  accumulatedCtx.loopsWithAllocations = Number(fnSummary.loopsWithAllocations ?? fnSummary.loops_with_allocations ?? 0);
                  accumulatedCtx.astHasLeakPatterns = Boolean(fnSummary.hasLeakPatterns ?? fnSummary.has_leak_patterns);
                }
                accumulatedCtx.astPatterns = (result.patterns || []).filter(
                  (p: any) => p.functionName === bundle.candidate.function_name,
                );
              }
              staticContext.set(ctxKey, accumulatedCtx);
              emitEvent(scanId, ScanEventName.AGENT_TOOL_RESULT, {
                tool: decision.toolName,
                bundleId: bundle.bundleId,
                function: bundle.candidate.function_name,
                resultKeys: Object.keys(result),
              });
            }

            actionResult = `Completed ${decision.toolName} on ${targetBundles.length} bundle(s)`;
            break;
          }

          case AgentActionKind.RUN_LEAKGUARD: {
            const buildCmd = buildPlan?.buildCommand || deps.resolvedBuildCommand;
            if (!buildCmd) {
              actionResult = 'Cannot run LeakGuard: no build command available';
              break;
            }

            emitEvent(scanId, ScanEventName.LEAKGUARD_STARTED, {});
            const lgResult: any = await registry.invoke('memory.leakguard_run', {
              projectPath: dto.workspacePath,
              buildCommand: buildCmd,
            });
            let lgFindings = 0;
            if (lgResult.success) {
              // Retrieve and attach LeakGuard findings as evidence (previously discarded).
              try {
                const lgReport: any = await registry.invoke('memory.leakguard_get_report', { runId: lgResult.runId });
                this.attachLeakguardEvidence(agentState.bundles, lgReport, lgResult.runId);
                lgFindings = (lgReport?.findings || []).length;
                actionResult = `LeakGuard completed: ${lgResult.runId} (${lgFindings} finding(s))`;
              } catch (lgErr: any) {
                actionResult = `LeakGuard ran (${lgResult.runId}) but report retrieval failed: ${lgErr.message}`;
              }
            } else {
              actionResult = `LeakGuard failed: ${lgResult.output?.slice(0, 100)}`;
            }
            // Always finish the LEAKGUARD phase so its node never hangs.
            emitEvent(scanId, ScanEventName.LEAKGUARD_FINISHED, { runId: lgResult.runId, findings: lgFindings });
            break;
          }

          case AgentActionKind.RUN_DYNAMIC: {
            if (!buildPlan?.buildCommand) {
              actionResult = 'Cannot run dynamic analysis: no build command';
              break;
            }

            emitEvent(scanId, ScanEventName.DYNAMIC_STARTED, { buildCommand: buildPlan.buildCommand });
            let totalFindings = 0;
            try {
              emitEvent(scanId, ScanEventName.DYNAMIC_BUILD_STARTED, { buildCommand: buildPlan.buildCommand });
              const buildResult: any = await registry.invoke('build_target', {
                projectPath: dto.workspacePath,
                buildCommand: buildPlan.buildCommand,
              });

              if (buildResult.success && buildResult.binaryPath) {
                const binaryPath = buildResult.binaryPath;
                emitEvent(scanId, ScanEventName.DYNAMIC_BINARY_BUILT, { binaryPath });

                // Choose sanitizers based on dynamicMode/dynamicToolPreference,
                // then run each independently so one failing doesn't abort the rest.
                const tools = this.selectDynamicTools(dto);
                const ran: string[] = [];
                for (const toolName of tools) {
                  try {
                    const dynResult: any = await registry.invoke(toolName, { binaryPath, args: [] });
                    const found = dynResult.findings?.length || 0;
                    if (found > 0) this.attachDynamicEvidence(agentState.bundles, dynResult, deps);
                    totalFindings += found;
                    ran.push(`${toolName}:${found}`);
                    emitEvent(scanId, ScanEventName.DYNAMIC_TOOL_RESULT, { tool: toolName, findings: found });
                  } catch (toolErr: any) {
                    this.logger.warn(`Dynamic tool ${toolName} failed: ${toolErr.message}`);
                    ran.push(`${toolName}:err`);
                  }
                }
                actionResult = totalFindings > 0
                  ? `Dynamic analysis found ${totalFindings} leak(s) [${ran.join(', ')}]`
                  : `Dynamic analysis completed: no leaks detected [${ran.join(', ')}]`;
              } else {
                actionResult = `Build failed: ${(buildResult.errors || []).slice(0, 2).join('; ')}`;
              }
            } catch (buildErr: any) {
              actionResult = `Dynamic analysis failed: ${buildErr.message}`;
            }
            // Always finish the DYNAMIC phase so its node never hangs.
            emitEvent(scanId, ScanEventName.DYNAMIC_FINISHED, { findings: totalFindings });
            break;
          }

          case AgentActionKind.JUDGE_BUNDLE: {
            const targetBundles = this.resolveTargetBundles(agentState.bundles, targetBundleIds);
            emitEvent(scanId, ScanEventName.JUDGING_STARTED, { bundleCount: targetBundles.length });
            await mapWithLimit(targetBundles, JUDGE_CONCURRENCY, async (bundle) => {
              const ctx = staticContext.get(bundle.bundleId) || {};
              const verdict = await this.judgeService.judgeBundle(bundle, ctx, dto.analysisMode);
              bundle.verdict = verdict;
              bundle.status = verdict.verdict === InvestigationVerdict.CONFIRMED_LEAK || verdict.verdict === InvestigationVerdict.LIKELY_LEAK
                ? FindingStatus.CONFIRMED
                : FindingStatus.DISMISSED;
              bundle.updatedAt = new Date().toISOString();
            });
            const confirmed = targetBundles.filter((b) => b.verdict?.verdict === 'confirmed_leak' || b.verdict?.verdict === 'likely_leak');
            actionResult = `Judged ${targetBundles.length} bundle(s): ${confirmed.length} confirmed/likely leak(s)`;
            emitEvent(scanId, ScanEventName.JUDGING_FINISHED, { judged: targetBundles.length, confirmed: confirmed.length });
            break;
          }

          case AgentActionKind.FINISH:
          case AgentActionKind.CHANGE_STRATEGY: {
            // Judge all remaining unresolved bundles
            const unresolved = agentState.bundles.filter((b) => !b.verdict);
            await mapWithLimit(unresolved, JUDGE_CONCURRENCY, async (bundle) => {
              const ctx = staticContext.get(bundle.bundleId) || {};
              const verdict = await this.judgeService.judgeBundle(bundle, ctx, dto.analysisMode);
              bundle.verdict = verdict;
              bundle.status = FindingStatus.DISMISSED;
              bundle.updatedAt = new Date().toISOString();
            });
            actionResult = `Finalized ${unresolved.length} remaining bundle(s)`;
            turn = maxLoops; // Break loop
            break;
          }

          default: {
            actionResult = `Unknown action kind: ${actionKind}`;
            break;
          }
        }
      } catch (err: any) {
        actionResult = `Action failed: ${err.message}`;
        this.logger.error(`[ORCH] Turn ${turn + 1} action failed: ${err.message}`);
      }

      agentDecision.resultSummary = actionResult;
      agentDecisions.push(agentDecision);
      agentState.actionsTaken.push(agentDecision);
      agentState.toolExecutions = registry.getExecutionRecords();

      emitEvent(scanId, ScanEventName.AGENT_TURN_FINISHED, {
        turn: turn + 1,
        actionKind,
        result: actionResult,
        durationMs: Date.now() - loopStart,
      });

      // Don't update bundles reference until we actually need to
      agentState.bundles = this.candidateManager.getAllBundles();
      if (agentState.bundles.length === 0) break;
    }

    emitEvent(scanId, ScanEventName.INVESTIGATION_FINISHED, {
      turns: agentState.actionsTaken.length,
    });

    // ═══════════════════════════════════════════
    // PHASE 3: FINAL JUDGING + REPORTING
    // ═══════════════════════════════════════════
    agentState.phase = 'judging';
    const bundles = this.candidateManager.getAllBundles();

    // Final judging pass for any bundles still pending
    emitEvent(scanId, ScanEventName.JUDGING_STARTED, { bundleCount: bundles.filter((b) => !b.verdict).length });
    await mapWithLimit(bundles.filter((b) => !b.verdict), JUDGE_CONCURRENCY, async (bundle) => {
      const ctx = staticContext.get(bundle.bundleId) || {};
      const verdict = await this.judgeService.judgeBundle(bundle, ctx, dto.analysisMode);
      bundle.verdict = verdict;
      bundle.updatedAt = new Date().toISOString();
    });
    emitEvent(scanId, ScanEventName.JUDGING_FINISHED, { total: bundles.length });

    emitEvent(scanId, ScanEventName.REPORTING_STARTED, { bundleCount: bundles.length });
    agentState.phase = 'reporting';

    // Build the investigation plan from what the agent actually did, so the
    // report/snapshot truthfully attributes the run to LLM vs heuristic and
    // shows the real tool sequence (instead of a null placeholder).
    const executedStaticTools: string[] = [];
    for (const decision of agentDecisions) {
      if (decision.actionKind === AgentActionKind.RUN_STATIC_TOOL && decision.toolName && !executedStaticTools.includes(decision.toolName)) {
        executedStaticTools.push(decision.toolName);
      }
    }
    const investigationPlan: InvestigationPlan = {
      strategySource: agentState.actionsTaken.some((a) => a.strategySource === 'llm') ? 'llm' : 'heuristic',
      focusBundleIds: bundles.map((b) => b.bundleId),
      staticToolSequence: executedStaticTools,
      runLeakguard: agentDecisions.some((d) => d.actionKind === AgentActionKind.RUN_LEAKGUARD),
      runDynamic: agentDecisions.some((d) => d.actionKind === AgentActionKind.RUN_DYNAMIC),
      dynamicToolPreference: dto.dynamicToolPreference || 'auto',
      bundleLimit: bundles.length,
      rationale: `Agentic scan (${dto.analysisMode || 'no_llm'}): ${agentState.actionsTaken.length} decisions, ${agentState.investigationCount} investigation loops`,
      notes: [],
    };

    const metadata: any = {
      scanId,
      workspacePath: dto.workspacePath,
      sourceWorkspacePath: deps.sourceWorkspacePath,
      materializedWorkspacePath: deps.hostMaterializedWorkspacePath,
      materializedWorkspaceId: deps.materializedWorkspaceId,
      analysisMode: dto.analysisMode || 'no_llm',
      dynamicMode: dto.dynamicMode || 'off',
      fileLimit: dto.fileLimit || 500,
      buildCommand: buildPlan?.buildCommand || dto.buildCommand,
      workspaceId: dto.workspaceId,
      repoId: dto.repoId,
      startedAt,
      completedAt: new Date().toISOString(),
      status: 'completed',
    };

    const report = this.reportingService.buildReport(bundles, metadata, {
      buildPlan,
      investigationPlan,
      planningTimeline: [],
      agentDecisions,
      agentLoopState: agentState,
    });

    // Terminal `completed` is owned by ScanService.createScan (after this returns),
    // so the orchestrator only signals that reporting finished — no duplicate terminal.
    emitEvent(scanId, ScanEventName.REPORTING_FINISHED, {
      bundleCount: bundles.length,
      confirmedLeaks: bundles.filter((b) => b.verdict?.verdict === 'confirmed_leak').length,
      likelyLeaks: bundles.filter((b) => b.verdict?.verdict === 'likely_leak').length,
    });

    agentState.phase = 'completed';

    this.logger.log(`[ORCH] Scan complete: ${bundles.length} bundles, ` +
      `${bundles.filter((b) => b.verdict?.verdict === 'confirmed_leak').length} confirmed, ` +
      `${bundles.filter((b) => b.verdict?.verdict === 'likely_leak').length} likely`);

    return {
      indexResult,
      bundles,
      report,
      toolExecutions: registry.getExecutionRecords(),
      dynamicExecutionPlan: null,
      staticContext,
      investigationPlan,
      planningTimeline: [],
      actionTimeline: [],
      agentDecisions,
      agentLoopState: agentState,
    };
  }

  private computeMaxLoops(dto: CreateScanDto): number {
    if (dto.analysisMode === 'llm_assisted') return 15;
    return 10;
  }

  /**
   * Register all available MCP tools with the tool registry.
   */
  private registerTools(registry: ReturnType<typeof this.toolRegistry.createRun>, deps: OrchestratorDeps) {
    const { staticSvc } = deps;

    registry.register({
      name: 'repo.index_files',
      phase: 'discovery',
      description: 'Index all C/C++ source files recursively from root path',
      typicalDurationMs: 2000,
      prerequisites: [],
      providesEvidenceFor: ['file_list'],
      async execute(args: { rootPath: string; fileLimit?: number; excludePatterns?: string[] }) {
        return firstValueFrom(staticSvc.indexFiles(args));
      },
    });

    registry.register({
      name: 'memory.candidate_scan',
      phase: 'discovery',
      description: 'Scan a file for allocation sites (malloc, calloc, realloc, strdup, new)',
      typicalDurationMs: 500,
      prerequisites: ['repo.index_files'],
      providesEvidenceFor: ['allocation_sites'],
      async execute(args: { filePath: string; content: string }) {
        return firstValueFrom(staticSvc.candidateScan(args));
      },
    });

    registry.register({
      name: 'memory.ast_scan',
      phase: 'static_analysis',
      description: 'AST-based structural analysis for memory leak patterns',
      typicalDurationMs: 3000,
      prerequisites: ['repo.index_files'],
      providesEvidenceFor: ['control_flow', 'pattern_matches'],
      async execute(args: { filePath: string; content: string }) {
        return firstValueFrom(staticSvc.astScan(args));
      },
    });

    registry.register({
      name: 'memory.call_graph',
      phase: 'static_analysis',
      description: 'Extract call graph edges and nodes',
      typicalDurationMs: 4000,
      prerequisites: ['repo.index_files'],
      providesEvidenceFor: ['call_edges'],
      async execute(args: { rootPath: string; files: string[] }) {
        return firstValueFrom(staticSvc.callGraph(args));
      },
    });

    registry.register({
      name: 'memory.function_summary',
      phase: 'static_analysis',
      description: 'Summarize a function: alloc/free balance, local vars, calls',
      typicalDurationMs: 1000,
      prerequisites: ['memory.candidate_scan'],
      providesEvidenceFor: ['alloc_free_balance'],
      async execute(args: { filePath: string; content: string; functionName: string }) {
        return firstValueFrom(staticSvc.functionSummary(args));
      },
    });

    registry.register({
      name: 'memory.path_constraints',
      phase: 'static_analysis',
      description: 'Analyze path constraints and feasible paths around an allocation',
      typicalDurationMs: 2000,
      prerequisites: ['memory.candidate_scan'],
      providesEvidenceFor: ['branch_conditions', 'feasible_paths'],
      async execute(args: { filePath: string; content: string; lineNumber: number }) {
        return firstValueFrom(staticSvc.pathConstraints(args));
      },
    });

    registry.register({
      name: 'memory.interprocedural_flow',
      phase: 'static_analysis',
      description: 'Interprocedural data flow tracing for a function',
      typicalDurationMs: 5000,
      prerequisites: ['memory.call_graph'],
      providesEvidenceFor: ['data_flow'],
      async execute(args: { rootPath: string; functionName: string; files: string[] }) {
        return firstValueFrom(staticSvc.interproceduralFlow(args));
      },
    });

    registry.register({
      name: 'memory.ownership_summary',
      phase: 'static_analysis',
      description: 'Summarize ownership conventions across files',
      typicalDurationMs: 2000,
      prerequisites: ['memory.function_summary'],
      providesEvidenceFor: ['ownership_violations'],
      async execute(args: { files: string[]; rootPath: string }) {
        return firstValueFrom(staticSvc.ownershipSummary(args));
      },
    });

    registry.register({
      name: 'memory.leakguard_run',
      phase: 'deep_static',
      description: 'Run the project-level Clang Static Analyzer (scan-build)',
      typicalDurationMs: 60000,
      prerequisites: ['repo.index_files', 'build_command'],
      providesEvidenceFor: ['clang_analysis'],
      async execute(args: { projectPath: string; buildCommand: string; timeoutSec?: number }) {
        return firstValueFrom(staticSvc.leakguardRun(args));
      },
    });

    registry.register({
      name: 'memory.leakguard_get_report',
      phase: 'deep_static',
      description: 'Retrieve LeakGuard analysis findings',
      typicalDurationMs: 500,
      prerequisites: ['memory.leakguard_run'],
      providesEvidenceFor: ['leakguard_findings'],
      async execute(args: { runId: string }) {
        return firstValueFrom(staticSvc.leakguardGetReport(args));
      },
    });

    // ── Dynamic tools (registered via gRPC) ──
    const { dynamicSvc } = deps;
    if (dynamicSvc) {
      registry.register({
        name: 'build_target',
        phase: 'dynamic_prep',
        description: 'Build the project with sanitizer-instrumented compiler flags',
        typicalDurationMs: 30000,
        prerequisites: ['build_command'],
        providesEvidenceFor: ['binary'],
        async execute(args: { projectPath: string; buildCommand: string; timeoutSec?: number }) {
          return firstValueFrom(dynamicSvc.buildTarget(args));
        },
      });

      registry.register({
        name: 'asan.run',
        phase: 'dynamic',
        description: 'Run the binary under AddressSanitizer for leak detection',
        typicalDurationMs: 10000,
        prerequisites: ['build_target'],
        providesEvidenceFor: ['asan_findings'],
        async execute(args: { binaryPath: string; args: string[]; timeoutSec?: number }) {
          return firstValueFrom(dynamicSvc.asanRun(args));
        },
      });

      registry.register({
        name: 'lsan.run',
        phase: 'dynamic',
        description: 'Run the binary under LeakSanitizer',
        typicalDurationMs: 10000,
        prerequisites: ['build_target'],
        providesEvidenceFor: ['lsan_findings'],
        async execute(args: { binaryPath: string; args: string[]; timeoutSec?: number }) {
          return firstValueFrom(dynamicSvc.lsanRun(args));
        },
      });

      registry.register({
        name: 'valgrind.analyze_memcheck',
        phase: 'dynamic',
        description: 'Run Valgrind Memcheck for detailed leak analysis',
        typicalDurationMs: 30000,
        prerequisites: ['build_target'],
        providesEvidenceFor: ['valgrind_findings', 'detailed_leaks'],
        async execute(args: { binaryPath: string; args: string[]; runId?: string; timeoutSec?: number }) {
          return firstValueFrom(dynamicSvc.valgrindMemcheck(args));
        },
      });
    }
  }

  /**
   * Choose which dynamic sanitizers to run based on the requested dynamic mode
   * and tool preference. A concrete preference wins; otherwise 'aggressive'
   * runs all three and 'selective' (the default) runs the ASan+LSan combo.
   */
  private selectDynamicTools(dto: CreateScanDto): string[] {
    const prefMap: Record<string, string> = {
      valgrind: 'valgrind.analyze_memcheck',
      lsan: 'lsan.run',
      asan: 'asan.run',
    };
    const pref = dto.dynamicToolPreference || 'auto';
    if (pref !== 'auto' && prefMap[pref]) return [prefMap[pref]];
    if (dto.dynamicMode === 'aggressive') return ['asan.run', 'lsan.run', 'valgrind.analyze_memcheck'];
    return ['asan.run', 'lsan.run'];
  }

  private toHostPath(filePath: string, deps: OrchestratorDeps): string {
    const analyzerRoot = deps.dto.workspacePath;
    const hostRoot = deps.hostMaterializedWorkspacePath || deps.repositoryManifest?.materializedPath;
    if (!filePath || !analyzerRoot || !hostRoot) return filePath;
    return filePath.startsWith(analyzerRoot)
      ? `${hostRoot}${filePath.slice(analyzerRoot.length)}`
      : filePath;
  }

  private toAnalyzerPath(filePath: string, deps: OrchestratorDeps): string {
    const analyzerRoot = deps.dto.workspacePath;
    const hostRoot = deps.hostMaterializedWorkspacePath || deps.repositoryManifest?.materializedPath;
    if (!filePath || !analyzerRoot || !hostRoot) return filePath;
    return filePath.startsWith(hostRoot)
      ? `${analyzerRoot}${filePath.slice(hostRoot.length)}`
      : filePath;
  }

  private readContextSnippet(filePath: string, lineNumber: number): string {
    if (!filePath || !lineNumber || !existsSync(filePath)) return '';
    try {
      const lines = readFileSync(filePath, 'utf-8').split('\n');
      const start = Math.max(0, lineNumber - 3);
      const end = Math.min(lines.length, lineNumber + 2);
      return lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join('\n');
    } catch {
      return '';
    }
  }

  private resolveTargetBundles(bundles: LeakBundle[], targetBundleIds: string[]): LeakBundle[] {
    const targeted = bundles.filter((bundle) => targetBundleIds.includes(bundle.bundleId));
    return targeted.length > 0 ? targeted : bundles;
  }

  private attachDynamicEvidence(bundles: LeakBundle[], dynResult: any, deps: OrchestratorDeps) {
    if (!dynResult?.findings) return;

    for (const finding of dynResult.findings) {
      const toolKind = finding.tool === 'asan' ? 'asan' as ToolKind
        : finding.tool === 'lsan' ? 'lsan' as ToolKind
        : 'valgrind' as ToolKind;
      const locFile = finding.filePath || finding.file_path || finding.location?.file || '';
      const locLine = finding.lineNumber ?? finding.line_number ?? finding.location?.line ?? 0;

      const evidence: LeakEvidence = {
        tool: toolKind,
        runId: dynResult.runId || dynResult.run_id || '',
        function_name: finding.functionName || finding.function_name || finding.location?.function || '',
        file_path: this.toHostPath(locFile, deps),
        line_number: locLine,
        bytes_lost: Number(finding.bytesLost ?? finding.bytes_lost ?? finding.aux?.leak?.bytes ?? finding.aux?.size ?? 0),
        blocks_lost: Number(finding.blocksLost ?? finding.blocks_lost ?? finding.aux?.leak?.blocks ?? 0),
        severity: finding.severity || 'medium',
        stack_trace: finding.stackTrace || finding.stack_trace || (finding.stack || []).map((s: any) =>
          `${s.function} at ${s.file}:${s.line}`
        ).join('\n'),
        raw_output: finding.message || finding.rawOutput || finding.raw_output || '',
      };

      // Enrich with leakKind / allocStack / allocSite / signature. The raw
      // Valgrind leak kind rides on `allocation_type` (proto field 11); ASan/LSan
      // carry it via the tool + message.
      const rawLeakKind =
        finding.allocationType ||
        finding.allocation_type ||
        finding.kind ||
        finding.aux?.leak?.kind ||
        '';
      const enriched = deriveDynamicFields(evidence, {
        rawLeakKind,
        rawStack: finding.stack,
      });

      this.attachEvidence(bundles, enriched);
    }
  }

  /**
   * Attach LeakGuard (Clang Static Analyzer) report findings as evidence.
   * Previously leakguard_run output was logged and discarded; now its findings
   * feed the judge like any other tool.
   */
  private attachLeakguardEvidence(bundles: LeakBundle[], report: any, runId: string) {
    const findings = report?.findings || [];
    for (const finding of findings) {
      const rawFile = finding.filePath || finding.file_path || '';
      // The adapter already strips the projectPath prefix, so paths arrive
      // relative to the project root; tolerate a stray leading ./ just in case.
      const relFile = String(rawFile).replace(/^\.\//, '');
      const evidence: LeakEvidence = {
        tool: ToolKind.LEAKGUARD,
        runId: runId || '',
        function_name: finding.functionName || finding.function_name || '',
        file_path: relFile,
        line_number: Number(finding.lineNumber ?? finding.line_number ?? 0),
        bytes_lost: 0,
        blocks_lost: 0,
        severity: finding.severity || finding.confidence || 'medium',
        stack_trace: '',
        raw_output: finding.context || finding.allocationSite || finding.allocation_site || '',
      };
      this.attachEvidence(bundles, evidence);
    }
  }

  /**
   * Match one piece of evidence to the best bundle (same file, nearby line) and
   * attach it. Shared by dynamic (ASan/LSan/Valgrind) and LeakGuard evidence.
   */
  /** Merge a partial into a bundle's typed staticEvidence, creating it if absent. */
  private mergeBundleStaticEvidence(bundle: LeakBundle, partial: Partial<StaticLeakEvidence>): void {
    const cur: StaticLeakEvidence = bundle.staticEvidence ?? {
      allocFreePairs: [],
      feasibleLeakPaths: [],
      earlyReturnCount: 0,
      leakyExitPaths: 0,
    };
    bundle.staticEvidence = { ...cur, ...partial };
  }

  private attachEvidence(bundles: LeakBundle[], evidence: LeakEvidence): boolean {
    // Pick the bundle whose candidate best correlates with this finding's
    // allocation site (exact line > near > function match > same file). The
    // chosen bundle gets the evidence stamped with how it was matched, so the
    // judge/heuristic can weight a runtime leak LINKED to this candidate far
    // more than one that merely lives in the same file.
    let best: { bundle: LeakBundle; method: ReturnType<typeof correlateEvidence> } | null = null;
    for (const bundle of bundles) {
      const corr = correlateEvidence(evidence, bundle.candidate);
      if (correlationRank(corr.correlationMethod) === 0) continue;
      if (!best || correlationRank(corr.correlationMethod) > correlationRank(best.method.correlationMethod)) {
        best = { bundle, method: corr };
      }
    }

    if (!best) return false;
    best.bundle.evidence.push({
      ...evidence,
      correlatedToCandidate: best.method.correlatedToCandidate,
      correlationMethod: best.method.correlationMethod,
      correlationDistanceLines: best.method.correlationDistanceLines,
    });
    best.bundle.updatedAt = new Date().toISOString();
    return true;
  }
}
