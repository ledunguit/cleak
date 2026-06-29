import { Module } from '@nestjs/common';
import { CParserService } from './services/c-parser.service';
import { FileIndexingService } from './services/file-indexing.service';
import { CandidateScanService } from './services/candidate-scan.service';
import { AstScanService } from './services/ast-scan.service';
import { CallGraphService } from './services/call-graph.service';
import { FunctionSummaryService } from './services/function-summary.service';
import { InterproceduralFlowService } from './services/interprocedural-flow.service';
import { PathConstraintsService } from './services/path-constraints.service';
import { OwnershipAnalysisService } from './services/ownership-analysis.service';
import { ScanBuildAdapterService } from './services/scan-build-adapter.service';

@Module({
  providers: [
    CParserService,
    FileIndexingService,
    CandidateScanService,
    AstScanService,
    CallGraphService,
    FunctionSummaryService,
    InterproceduralFlowService,
    PathConstraintsService,
    OwnershipAnalysisService,
    ScanBuildAdapterService,
  ],
})
export class StaticAnalyzerModule {}
