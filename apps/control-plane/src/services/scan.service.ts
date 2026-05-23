import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable, Subject } from 'rxjs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScanEntity, LeakEvidence } from '@mcpvul/common';
import { CreateScanDto } from '@mcpvul/common/dto/scan.dto';
import { CandidateManagerService } from './candidate-manager.service';
import { JudgeService } from './judge.service';
import { ReportingService } from './reporting.service';
import { DynamicPlannerService } from './dynamic-planner.service';

interface StaticAnalyzerService {
  indexFiles(data: any): any;
  candidateScan(data: any): any;
  astScan(data: any): any;
  leakguardRun(data: any): any;
}

interface DynamicAnalyzerService {
  buildTarget(data: any): any;
  valgrindMemcheck(data: any): any;
  asanRun(data: any): any;
  lsanRun(data: any): any;
}

@Injectable()
export class ScanService implements OnModuleInit {
  private readonly logger = new Logger(ScanService.name);
  private staticSvc: StaticAnalyzerService;
  private dynamicSvc: DynamicAnalyzerService;
  private eventStreams = new Map<string, Subject<any>>();

  constructor(
    @Inject('STATIC_ANALYZER_PACKAGE') private staticClient: ClientGrpc,
    @Inject('DYNAMIC_ANALYZER_PACKAGE') private dynamicClient: ClientGrpc,
    @InjectRepository(ScanEntity)
    private scanRepo: Repository<ScanEntity>,
    private candidateManager: CandidateManagerService,
    private judgeService: JudgeService,
    private reportingService: ReportingService,
    private dynamicPlanner: DynamicPlannerService,
  ) {}

  onModuleInit() {
    this.staticSvc = this.staticClient.getService<StaticAnalyzerService>('StaticAnalyzer');
    this.dynamicSvc = this.dynamicClient.getService<DynamicAnalyzerService>('DynamicAnalyzer');
  }

  async listScans() {
    const scans = await this.scanRepo.find({ order: { createdAt: 'DESC' } });
    return {
      scans: scans.map((s) => ({
        scanId: s.scanId,
        status: s.status,
        workspacePath: s.workspacePath,
        analysisMode: s.analysisMode,
        createdAt: s.createdAt.toISOString(),
        completedAt: s.completedAt?.toISOString(),
      })),
      total: scans.length,
    };
  }

  async createScan(dto: CreateScanDto) {
    const scanId = crypto.randomUUID();
    this.emitEvent(scanId, { event: 'scan_created', scanId });

    // Save scan entity
    const scan = this.scanRepo.create({
      scanId,
      workspacePath: dto.workspacePath,
      analysisMode: dto.analysisMode || 'no_llm',
      dynamicMode: dto.dynamicMode || 'off',
      fileLimit: dto.fileLimit || 500,
      buildCommand: dto.buildCommand,
      workspaceId: dto.workspaceId,
      repoId: dto.repoId,
      dynamicToolPreference: dto.dynamicToolPreference,
      dynamicBinaryPath: dto.dynamicBinaryPath,
      dynamicArgs: dto.dynamicArgs,
      dynamicTimeoutSec: dto.dynamicTimeoutSec,
      status: 'running',
    });
    await this.scanRepo.save(scan);

    try {
      // Phase 1: Index files via static-analyzer gRPC
      this.emitEvent(scanId, { event: 'indexing_files', workspacePath: dto.workspacePath });
      const indexResult: any = await firstValueFrom(
        this.staticSvc.indexFiles({ rootPath: dto.workspacePath, fileLimit: dto.fileLimit }),
      );

      // Phase 2: Candidate scan each file
      this.emitEvent(scanId, { event: 'scanning_candidates', totalFiles: indexResult.totalCount });
      this.candidateManager.clear();

      for (const file of (indexResult.files || []).slice(0, 10)) {
        // Limit to 10 files for now
        try {
          const csResult: any = await firstValueFrom(
            this.staticSvc.candidateScan({ filePath: file, content: '' }),
          );
          for (const c of csResult.candidates || []) {
            this.candidateManager.ingest({
              id: c.id,
              function_name: c.functionName || c.function_name || '',
              file_path: c.filePath || c.file_path || '',
              line_number: c.lineNumber ?? c.line_number ?? 0,
              allocation_site: c.allocationSite || c.allocation_site || '',
              allocation_type: c.allocationType || c.allocation_type || '',
              confidence: c.confidence || 'medium',
              context: c.context || '',
            });
          }
        } catch {
          // skip errors on individual files
        }
      }

      const bundles = this.candidateManager.getAllBundles();
      this.logger.log(`[SCAN] Post-candidate phase: bundles=${bundles.length}, buildCmd=${dto.buildCommand}, dynMode=${dto.dynamicMode}`);

      // Phase 2.5: Dynamic analysis (if enabled)
      if (dto.buildCommand && dto.dynamicMode && dto.dynamicMode !== 'off') {
        console.log('[SCAN] Entering dynamic analysis phase');
        this.emitEvent(scanId, { event: 'dynamic_analysis_started', mode: dto.dynamicMode });

        // Build target first
        try {
          this.logger.log('Building target via gRPC...');
          this.emitEvent(scanId, { event: 'building_target', command: dto.buildCommand });
          const buildResult: any = await firstValueFrom(
            this.dynamicSvc.buildTarget({
              projectPath: dto.workspacePath,
              buildCommand: dto.buildCommand,
              timeoutSec: dto.dynamicTimeoutSec || 300,
            }),
          );
          this.logger.log(`buildResult: success=${buildResult.success}, binaryPath=${buildResult.binaryPath}`);

          const binaryPath = buildResult.binaryPath || dto.dynamicBinaryPath;

          if (buildResult.success && binaryPath) {
            // Create dynamic analysis plan
            const preference = (dto.dynamicToolPreference as string) || 'auto';
            this.logger.log(`createPlan: bundles=${bundles.length}, mode=${dto.dynamicMode}, preference=${preference}, binaryPath=${binaryPath}`);
            const plan = this.dynamicPlanner.createPlan(
              bundles,
              dto.dynamicMode as any,
              preference as any,
              binaryPath,
              dto.dynamicArgs,
            );
            this.logger.log(`Plan targets: ${plan.targets.length} (${plan.targets.map(t => t.tool).join(', ') || 'none'})`);

            if (plan.targets.length === 0) {
              this.logger.warn('No dynamic targets to execute');
            }

            // Execute each target in priority order
            for (const target of plan.targets) {
              this.emitEvent(scanId, { event: 'dynamic_analysis_target', tool: target.tool });

              try {
                let dynResult: any;

                if (target.tool === 'valgrind.analyze_memcheck' || target.tool === 'valgrind.run') {
                  this.logger.log(`Calling valgrindMemcheck gRPC: binaryPath=${target.binaryPath}`);
                  dynResult = await firstValueFrom(
                    this.dynamicSvc.valgrindMemcheck({
                      binaryPath: target.binaryPath,
                      args: target.args,
                      timeoutSec: dto.dynamicTimeoutSec || 120,
                    }),
                  );
                } else if (target.tool === 'asan.run') {
                  dynResult = await firstValueFrom(
                    this.dynamicSvc.asanRun({
                      binaryPath: target.binaryPath,
                      args: target.args,
                      timeoutSec: dto.dynamicTimeoutSec || 120,
                    }),
                  );
                } else if (target.tool === 'lsan.run') {
                  dynResult = await firstValueFrom(
                    this.dynamicSvc.lsanRun({
                      binaryPath: target.binaryPath,
                      args: target.args,
                      timeoutSec: dto.dynamicTimeoutSec || 120,
                    }),
                  );
                }

                // Normalize and attach evidence to matching bundles
                this.logger.log(`valgrindMemcheck result: success=${dynResult?.success}, findings=${dynResult?.findings?.length || 0}`);
                if (dynResult?.findings) {
                  this.logger.log(`[SCAN] Dynamic findings: ${dynResult.findings.length} finding(s), matched evidence to ${bundles.length} bundle(s)`);
                  this.logger.log(`Finding #1: filePath=${dynResult.findings[0]?.filePath}, line=${dynResult.findings[0]?.lineNumber}, func=${dynResult.findings[0]?.functionName}`);
                  this.logger.log(`Candidate: file_path=${bundles[0]?.candidate?.file_path}, line=${bundles[0]?.candidate?.line_number}`);
                  for (const finding of dynResult.findings) {
                    const toolKind = finding.tool === 'asan' ? 'asan' as any
                      : finding.tool === 'lsan' ? 'lsan' as any
                      : 'valgrind' as any;

                    // gRPC proto-loader converts snake_case → camelCase with keepCase:false
                    const locFile = finding.filePath || finding.file_path || finding.location?.file || '';
                    const locLine = finding.lineNumber ?? finding.line_number ?? finding.location?.line ?? 0;

                    const evidence: LeakEvidence = {
                      tool: toolKind,
                      runId: dynResult.runId || dynResult.run_id || '',
                      function_name: finding.functionName || finding.function_name || finding.location?.function || '',
                      file_path: locFile,
                      line_number: locLine,
                      bytes_lost: Number(finding.bytesLost ?? finding.bytes_lost ?? finding.aux?.leak?.bytes ?? finding.aux?.size ?? 0),
                      blocks_lost: Number(finding.blocksLost ?? finding.blocks_lost ?? finding.aux?.leak?.blocks ?? 0),
                      severity: finding.severity || 'medium',
                      stack_trace: finding.stackTrace || finding.stack_trace || (finding.stack || []).map((s: any) =>
                        `${s.function} at ${s.file}:${s.line}`
                      ).join('\n'),
                      raw_output: finding.message || finding.rawOutput || finding.raw_output || '',
                    };

                    // Match to an existing bundle by file/function proximity
                    let matched = false;
                    for (const bundle of bundles) {
                      if (evidence.file_path && bundle.candidate.file_path &&
                          bundle.candidate.file_path.endsWith(evidence.file_path) &&
                          Math.abs(evidence.line_number - bundle.candidate.line_number) <= 10) {
                        bundle.evidence.push(evidence);
                        bundle.updatedAt = new Date().toISOString();
                        matched = true;
                        break;
                      }
                    }
                    this.logger.log(`[SCAN] Evidence match: ${evidence.file_path} -> ${bundles[0]?.candidate?.file_path || 'unknown'} (${matched ? 'matched' : 'fallback'})`);
                    if (!matched && bundles.length > 0) {
                      const related = bundles.filter(b =>
                        evidence.file_path && b.candidate.file_path &&
                        b.candidate.file_path.endsWith(evidence.file_path)
                      );
                      if (related.length > 0) {
                        related[0].evidence.push(evidence);
                        related[0].updatedAt = new Date().toISOString();
                      }
                    }
                  }
                }
              } catch (err: any) {
                this.logger.error(`Dynamic target ${target.tool} failed: ${err.message}`);
              }
            }
          }
        } catch (err: any) {
          // build failed, continue with static analysis only
          this.logger.error(`Dynamic analysis build failed: ${err.message}`);
          this.emitEvent(scanId, { event: 'dynamic_analysis_failed', error: err.message });
        }
      }

      // Phase 3: Judge bundles (with dynamic evidence now attached)
      this.emitEvent(scanId, { event: 'judging', bundleCount: bundles.length });
      const verdicts = this.judgeService.judgeBundles(bundles);
      for (const [id, verdict] of verdicts) {
        const bundle = this.candidateManager.getBundle(id);
        if (bundle) {
          bundle.verdict = verdict;
        }
      }

      // Phase 4: Build report
      const metadata = {
        scanId,
        workspacePath: dto.workspacePath,
        analysisMode: (dto.analysisMode || 'no_llm') as any,
        dynamicMode: (dto.dynamicMode || 'off') as any,
        fileLimit: dto.fileLimit || 500,
        buildCommand: dto.buildCommand,
        workspaceId: dto.workspaceId,
        repoId: dto.repoId,
        startedAt: scan.createdAt.toISOString(),
        completedAt: new Date().toISOString(),
        status: 'completed' as any,
      };

      const report = this.reportingService.buildReport(bundles, metadata);

      // Update scan entity
      await this.scanRepo.update(scanId, {
        status: 'completed',
        report: report as any,
        summary: report.summary as any,
        completedAt: new Date(),
      });

      this.emitEvent(scanId, { event: 'completed', scanId });

      return {
        scanId,
        filesIndexed: indexResult.totalCount,
        candidatesFound: bundles.length,
        summary: report.summary,
      };
    } catch (err: any) {
      await this.scanRepo.update(scanId, {
        status: 'failed',
        completedAt: new Date(),
      });

      this.emitEvent(scanId, { event: 'failed', error: err.message });

      return {
        scanId,
        status: 'failed',
        error: err.message,
      };
    }
  }

  async getScan(id: string) {
    const scan = await this.scanRepo.findOneBy({ scanId: id });
    if (!scan) return null;
    return {
      scanId: scan.scanId,
      status: scan.status,
      workspacePath: scan.workspacePath,
      analysisMode: scan.analysisMode,
      report: scan.report,
      summary: scan.summary,
      createdAt: scan.createdAt.toISOString(),
      completedAt: scan.completedAt?.toISOString(),
    };
  }

  async deleteScan(id: string) {
    await this.scanRepo.delete(id);
    return { success: true };
  }

  async cancelScan(id: string) {
    await this.scanRepo.update(id, { status: 'cancelled', completedAt: new Date() });
    return { success: true };
  }

  streamEvents(id: string): Observable<any> {
    let subject = this.eventStreams.get(id);
    if (!subject) {
      subject = new Subject<any>();
      this.eventStreams.set(id, subject);
    }
    return subject.asObservable();
  }

  async getReport(id: string, format: string) {
    const scan = await this.scanRepo.findOneBy({ scanId: id });
    if (!scan || !scan.report) {
      return { content: '{}', contentType: 'application/json' };
    }

    const report = scan.report;

    switch (format) {
      case 'markdown':
        return {
          content: this.reportingService.toMarkdown(report as any),
          contentType: 'text/markdown',
        };
      case 'html':
        return {
          content: this.reportingService.toHtml(report as any),
          contentType: 'text/html',
        };
      default:
        return {
          content: JSON.stringify(report, null, 2),
          contentType: 'application/json',
        };
    }
  }

  private emitEvent(scanId: string, data: any) {
    const subject = this.eventStreams.get(scanId);
    if (subject) {
      subject.next({ data });
    }
  }
}
