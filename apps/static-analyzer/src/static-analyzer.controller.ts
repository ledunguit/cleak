import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { FileIndexingService } from './services/file-indexing.service';
import { CandidateScanService } from './services/candidate-scan.service';
import { AstScanService } from './services/ast-scan.service';
import { CallGraphService } from './services/call-graph.service';
import { FunctionSummaryService } from './services/function-summary.service';
import { InterproceduralFlowService } from './services/interprocedural-flow.service';
import { PathConstraintsService } from './services/path-constraints.service';
import { OwnershipAnalysisService } from './services/ownership-analysis.service';
import { LeakGuardAdapterService } from './services/leakguard-adapter.service';

@Controller()
export class StaticAnalyzerController {
  constructor(
    private readonly fileIndexingSvc: FileIndexingService,
    @Inject(CandidateScanService) private readonly candidateScanSvc: CandidateScanService,
    @Inject(AstScanService) private readonly astScanSvc: AstScanService,
    @Inject(CallGraphService) private readonly callGraphSvc: CallGraphService,
    @Inject(FunctionSummaryService) private readonly functionSummarySvc: FunctionSummaryService,
    @Inject(InterproceduralFlowService) private readonly interproceduralFlowSvc: InterproceduralFlowService,
    @Inject(PathConstraintsService) private readonly pathConstraintsSvc: PathConstraintsService,
    @Inject(OwnershipAnalysisService) private readonly ownershipAnalysisSvc: OwnershipAnalysisService,
    @Inject(LeakGuardAdapterService) private readonly leakGuardAdapterSvc: LeakGuardAdapterService,
  ) {}

  @GrpcMethod('StaticAnalyzer', 'IndexFiles')
  async indexFiles(data: { rootPath: string; fileLimit?: number; excludePatterns?: string[] }) {
    return this.fileIndexingSvc.indexFiles(data.rootPath, data.fileLimit, data.excludePatterns);
  }

  @GrpcMethod('StaticAnalyzer', 'CandidateScan')
  async handleCandidateScan(data: { filePath: string; content: string }) {
    return this.candidateScanSvc.scan(data.filePath, data.content);
  }

  @GrpcMethod('StaticAnalyzer', 'AstScan')
  async handleAstScan(data: { filePath: string; content: string }) {
    return this.astScanSvc.parse(data.filePath, data.content);
  }

  @GrpcMethod('StaticAnalyzer', 'CallGraph')
  async handleCallGraph(data: { rootPath: string; files: string[] }) {
    return this.callGraphSvc.extract(data.rootPath, data.files);
  }

  @GrpcMethod('StaticAnalyzer', 'FunctionSummary')
  async handleFunctionSummary(data: { filePath: string; content: string; functionName: string }) {
    return this.functionSummarySvc.summarize(data.filePath, data.content, data.functionName);
  }

  @GrpcMethod('StaticAnalyzer', 'InterproceduralFlow')
  async handleInterproceduralFlow(data: { rootPath: string; functionName: string; files: string[] }) {
    return this.interproceduralFlowSvc.analyze(data.rootPath, data.functionName, data.files);
  }

  @GrpcMethod('StaticAnalyzer', 'PathConstraints')
  async handlePathConstraints(data: { filePath: string; content: string; lineNumber: number }) {
    return this.pathConstraintsSvc.analyze(data.filePath, data.content, data.lineNumber);
  }

  @GrpcMethod('StaticAnalyzer', 'OwnershipSummary')
  async ownershipSummary(data: { files: string[]; rootPath: string }) {
    return this.ownershipAnalysisSvc.summarize(data.files, data.rootPath);
  }

  @GrpcMethod('StaticAnalyzer', 'OwnershipConventions')
  async ownershipConventions(data: { content: string; filePath: string }) {
    return this.ownershipAnalysisSvc.conventions(data.content, data.filePath);
  }

  @GrpcMethod('StaticAnalyzer', 'LeakguardRun')
  async leakguardRun(data: { projectPath: string; buildCommand: string; timeoutSec?: number }) {
    return this.leakGuardAdapterSvc.run(data.projectPath, data.buildCommand, data.timeoutSec);
  }

  @GrpcMethod('StaticAnalyzer', 'LeakguardGetReport')
  async leakguardGetReport(data: { runId: string }) {
    return this.leakGuardAdapterSvc.getReport(data.runId);
  }
}
