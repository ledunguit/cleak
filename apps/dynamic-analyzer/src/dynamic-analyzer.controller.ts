import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { BuildTargetService } from './services/build-target.service';
import { ValgrindService } from './services/valgrind.service';
import { AsanService } from './services/asan.service';
import { LsanService } from './services/lsan.service';
import { BinaryRunnerService } from './services/binary-runner.service';
import { CompareService } from './services/compare.service';
import { RunManagerService } from './services/run-manager.service';

@Controller()
export class DynamicAnalyzerController {
  constructor(
    @Inject(BuildTargetService) private readonly buildTargetSvc: BuildTargetService,
    @Inject(ValgrindService) private readonly valgrindSvc: ValgrindService,
    @Inject(AsanService) private readonly asanSvc: AsanService,
    @Inject(LsanService) private readonly lsanSvc: LsanService,
    @Inject(BinaryRunnerService) private readonly binaryRunnerSvc: BinaryRunnerService,
    @Inject(CompareService) private readonly compareSvc: CompareService,
    @Inject(RunManagerService) private readonly runManagerSvc: RunManagerService,
  ) {}

  @GrpcMethod('DynamicAnalyzer', 'BuildTarget')
  async buildTarget(data: { projectPath: string; buildCommand: string; timeoutSec?: number }) {
    return this.buildTargetSvc.build(data.projectPath, data.buildCommand, data.timeoutSec);
  }

  @GrpcMethod('DynamicAnalyzer', 'ValgrindMemcheck')
  async valgrindMemcheck(data: {
    binaryPath: string;
    args: string[];
    runId?: string;
    timeoutSec?: number;
  }) {
    return this.valgrindSvc.runMemcheck(data.binaryPath, data.args, data.runId, data.timeoutSec);
  }

  @GrpcMethod('DynamicAnalyzer', 'ValgrindGetReport')
  async valgrindGetReport(data: { runId: string }) {
    return this.valgrindSvc.getReport(data.runId);
  }

  @GrpcMethod('DynamicAnalyzer', 'ValgrindListFindings')
  async valgrindListFindings(data: {
    runId: string;
    severity?: string;
    functionName?: string;
  }) {
    return this.valgrindSvc.listFindings(data.runId, data.severity, data.functionName);
  }

  @GrpcMethod('DynamicAnalyzer', 'ValgrindCompareRuns')
  async valgrindCompareRuns(data: { runIdA: string; runIdB: string }) {
    return this.compareSvc.compareValgrindRuns(data.runIdA, data.runIdB);
  }

  @GrpcMethod('DynamicAnalyzer', 'AsanRun')
  async asanRun(data: {
    binaryPath: string;
    args: string[];
    timeoutSec?: number;
  }) {
    return this.asanSvc.run(data.binaryPath, data.args, data.timeoutSec);
  }

  @GrpcMethod('DynamicAnalyzer', 'LsanRun')
  async lsanRun(data: {
    binaryPath: string;
    args: string[];
    timeoutSec?: number;
  }) {
    return this.lsanSvc.run(data.binaryPath, data.args, data.timeoutSec);
  }

  @GrpcMethod('DynamicAnalyzer', 'RunBinary')
  async runBinary(data: {
    binaryPath: string;
    args: string[];
    timeoutSec?: number;
  }) {
    return this.binaryRunnerSvc.run(data.binaryPath, data.args, data.timeoutSec);
  }

  @GrpcMethod('DynamicAnalyzer', 'ListRuns')
  async listRuns(data: { tool?: string; limit?: number }) {
    return this.runManagerSvc.listRuns(data.tool, data.limit);
  }
}
