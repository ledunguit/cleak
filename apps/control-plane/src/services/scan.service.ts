import { Injectable, Inject, OnModuleInit, Logger } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { firstValueFrom, Observable, ReplaySubject } from 'rxjs';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ScanEntity, ScanEventName, phaseForEvent, kindForEvent } from '@mcpvul/common';
import { CreateScanDto } from '@mcpvul/common/dto/scan.dto';
import { SCAN_QUEUE, ScanJobData } from './scan-queue';
import { ReportingService } from './reporting.service';
import { BuildDiscoveryService } from './build-discovery.service';
import { DynamicAnalyzerService, ScanOrchestratorService, StaticAnalyzerService } from './scan-orchestrator.service';
import { ScanWorkspaceService } from './scan-workspace.service';
import { RuntimeDiagnosticsService } from './runtime-diagnostics.service';
import { McpClientManager } from './mcp-client-manager.service';

@Injectable()
export class ScanService implements OnModuleInit {
  private readonly logger = new Logger(ScanService.name);
  private staticSvc: StaticAnalyzerService;
  private dynamicSvc: DynamicAnalyzerService;
  private eventStreams = new Map<string, ReplaySubject<any>>();
  private eventsHistory = new Map<string, any[]>();
  // Per-scan TTL timers so the in-memory event maps are freed after a scan ends
  // (they previously grew unbounded — one leaked entry per scan, forever).
  private cleanupTimers = new Map<string, NodeJS.Timeout>();
  private readonly streamTtlMs = Number(process.env.SCAN_STREAM_TTL_MS ?? 10 * 60 * 1000);

  constructor(
    @Inject('STATIC_ANALYZER_PACKAGE') private staticClient: ClientGrpc,
    @Inject('DYNAMIC_ANALYZER_PACKAGE') private dynamicClient: ClientGrpc,
    @InjectRepository(ScanEntity)
    private scanRepo: Repository<ScanEntity>,
    @InjectQueue(SCAN_QUEUE)
    private scanQueue: Queue,
    private reportingService: ReportingService,
    private buildDiscovery: BuildDiscoveryService,
    private scanOrchestrator: ScanOrchestratorService,
    private scanWorkspace: ScanWorkspaceService,
    private runtimeDiagnostics: RuntimeDiagnosticsService,
    private mcpClientManager: McpClientManager,
  ) {}

  async onModuleInit() {
    // Transport selection: MCP (real Model Context Protocol over Streamable HTTP)
    // or gRPC. The orchestrator/tool-registry are transport-agnostic, so this is
    // the single switch point. 'grpc'/'both' use the proven gRPC clients.
    const mode = (process.env.TRANSPORT_MODE || 'grpc').toLowerCase();
    if (mode === 'mcp') {
      this.logger.log('Transport: MCP (Streamable HTTP)');
      this.staticSvc = this.mcpClientManager.getStaticAdapter();
      this.dynamicSvc = this.mcpClientManager.getDynamicAdapter();
    } else {
      this.staticSvc = this.staticClient.getService<StaticAnalyzerService>('StaticAnalyzer');
      this.dynamicSvc = this.dynamicClient.getService<DynamicAnalyzerService>('DynamicAnalyzer');
    }
    await this.reconcileOrphanScans();
  }

  /**
   * On boot, fail any scan stuck in running/queued that has NO live BullMQ job —
   * e.g. the process died after the row was written but before/while the job ran
   * and the job is gone. Scans whose job is still active/waiting are left for
   * BullMQ to resume, so we never prematurely fail a recoverable scan.
   */
  private async reconcileOrphanScans() {
    try {
      const inflight = await this.scanRepo.find({
        where: { status: In(['running', 'queued']) },
        select: { scanId: true },
      });
      if (!inflight.length) return;
      const jobs = await this.scanQueue.getJobs(['active', 'waiting', 'delayed', 'paused', 'prioritized']);
      const live = new Set(jobs.map((j) => (j.data as any)?.scanId).filter(Boolean));
      const orphans = inflight.map((s) => s.scanId).filter((id) => !live.has(id));
      if (orphans.length) {
        await this.scanRepo.update(orphans, { status: 'failed', completedAt: new Date() });
        this.logger.warn(`[SCAN] reconciled ${orphans.length} orphaned scan(s) → failed on boot`);
      }
    } catch (err: any) {
      this.logger.error(`[SCAN] orphan reconcile failed: ${err?.message || err}`);
    }
  }

  async listScans() {
    const scans = await this.scanRepo.find({ order: { createdAt: 'DESC' } });
    return {
      scans: scans.map((s) => ({
        scanId: s.scanId,
        status: s.status,
        workspacePath: s.workspacePath,
        sourceWorkspacePath: (s.report as any)?.metadata?.sourceWorkspacePath,
        materializedWorkspacePath: (s.report as any)?.metadata?.materializedWorkspacePath,
        materializedWorkspaceId: (s.report as any)?.metadata?.materializedWorkspaceId,
        analysisMode: s.analysisMode,
        createdAt: s.createdAt.toISOString(),
        completedAt: s.completedAt?.toISOString(),
      })),
      total: scans.length,
    };
  }

  async createScan(dto: CreateScanDto) {
    const scanId = crypto.randomUUID();
    const scanStartedAt = new Date().toISOString();
    this.emitEvent(scanId, ScanEventName.SCAN_CREATED, { scanId });

    if (this.runtimeDiagnostics.isPreflightEnforced()) {
      this.emitEvent(scanId, ScanEventName.PREFLIGHT_STARTED, {});
      const preflight = await this.runtimeDiagnostics.getBlockingIssues();
      if (!preflight.ok) {
        const scan = this.scanRepo.create({
          scanId,
          // Preflight fails before materialization, so the source path may be
          // unresolved for a repo-id scan — keep the NOT NULL column populated.
          workspacePath: dto.workspacePath || (dto.repoId ? `repo:${dto.repoId}` : 'unresolved'),
          analysisMode: dto.analysisMode || process.env.DEFAULT_ANALYSIS_MODE || 'llm_assisted',
          dynamicMode: dto.dynamicMode || 'off',
          fileLimit: dto.fileLimit || 500,
          buildCommand: dto.buildCommand?.trim() || undefined,
          workspaceId: dto.workspaceId,
          repoId: dto.repoId,
          dynamicToolPreference: dto.dynamicToolPreference,
          dynamicBinaryPath: dto.dynamicBinaryPath,
          dynamicArgs: dto.dynamicArgs,
          dynamicTimeoutSec: dto.dynamicTimeoutSec,
          status: 'failed',
          completedAt: new Date(),
          report: {
            metadata: {
              scanId,
              workspacePath: dto.workspacePath,
              analysisMode: dto.analysisMode || process.env.DEFAULT_ANALYSIS_MODE || 'llm_assisted',
              dynamicMode: dto.dynamicMode || 'off',
              fileLimit: dto.fileLimit || 500,
              status: 'failed',
              startedAt: scanStartedAt,
              completedAt: new Date().toISOString(),
            },
            summary: {
              totalCandidates: 0,
              confirmedLeaks: 0,
              likelyLeaks: 0,
              falsePositives: 0,
              totalBytesLost: 0,
              toolsUsed: [],
              durationSec: 0,
            },
            bundles: [],
            preflightReport: preflight.report,
          } as any,
        });
        await this.scanRepo.save(scan);

        const remediation = preflight.blockingChecks.map((check) => `${check.name}: ${check.detail}`).join('\n');
        this.emitEvent(scanId, ScanEventName.PREFLIGHT_FAILED, {
          error_category: 'runtime_preflight_failed',
          remediation,
          blocking_checks: preflight.blockingChecks,
        });
        this.emitEvent(scanId, ScanEventName.FAILED, {
          error: 'Runtime preflight failed. The scan stack is not ready.',
          error_category: 'runtime_preflight_failed',
          remediation,
        });
        this.scheduleStreamCleanup(scanId);

        return {
          scanId,
          status: 'failed',
          error: 'Runtime preflight failed. The scan stack is not ready.',
          error_category: 'runtime_preflight_failed',
          remediation,
          preflight_report: preflight.report,
        };
      }

      this.emitEvent(scanId, ScanEventName.PREFLIGHT_PASSED, {
        checks: preflight.report.checks.length,
      });
    }

    this.emitEvent(scanId, ScanEventName.WORKSPACE_STARTED, {});
    const materialized = await this.scanWorkspace.materializeForScan({
      scanId,
      workspacePath: dto.workspacePath,
      workspaceId: dto.workspaceId,
      repoId: dto.repoId,
      sourceType: dto.sourceType,
    });
    const executionDto: CreateScanDto = {
      ...dto,
      workspacePath: materialized.analyzerVisiblePath,
    };
    this.emitEvent(scanId, ScanEventName.WORKSPACE_MATERIALIZED, {
      sourcePath: materialized.sourcePath,
      materializedPath: materialized.materializedPath,
      analyzerVisiblePath: materialized.analyzerVisiblePath,
      materializedWorkspaceId: materialized.materializedWorkspaceId,
      sourceType: materialized.sourceType,
    });

    const buildPlan = !dto.buildCommand || !dto.buildCommand.trim()
      ? await this.buildDiscovery.discover({
          workspaceId: dto.workspaceId,
          repoId: dto.repoId,
          workspacePath: materialized.materializedPath,
          repositoryManifest: materialized.manifest,
          preferLlm: dto.analysisMode === 'llm_assisted',
        })
      : null;
    const resolvedBuildCommand = dto.buildCommand?.trim() || buildPlan?.buildCommand;
    const requestedFormats = dto.reportFormats?.length
      ? dto.reportFormats
      : ['json', 'markdown', 'html', 'snapshot', 'pdf'];

    // Save scan entity. When the scan targets a repo by id (no explicit
    // workspacePath in the request), fall back to the resolved source path from
    // materialization so the NOT NULL workspacePath column is always populated.
    const scan = this.scanRepo.create({
      scanId,
      workspacePath: dto.workspacePath || materialized.sourcePath || materialized.analyzerVisiblePath,
      analysisMode: dto.analysisMode || process.env.DEFAULT_ANALYSIS_MODE || 'llm_assisted',
      dynamicMode: dto.dynamicMode || 'off',
      fileLimit: dto.fileLimit || 500,
      buildCommand: resolvedBuildCommand,
      workspaceId: dto.workspaceId,
      repoId: dto.repoId,
      dynamicToolPreference: dto.dynamicToolPreference,
      dynamicBinaryPath: dto.dynamicBinaryPath,
      dynamicArgs: dto.dynamicArgs,
      dynamicTimeoutSec: dto.dynamicTimeoutSec,
      status: 'queued',
    });
    await this.scanRepo.save(scan);

    // Detach the heavy pipeline onto the BullMQ worker and return immediately —
    // the HTTP request is never held open for the (minutes-long) scan. The client
    // follows progress via SSE (GET /:id/events) + the /events/history poll, and
    // loads the report on the terminal event. The UI already works this way.
    await this.scanQueue.add(
      'run',
      {
        scanId,
        scanStartedAt,
        executionDto,
        materialized,
        resolvedBuildCommand,
        buildPlan,
        requestedFormats,
      } as ScanJobData,
      {
        attempts: Number(process.env.SCAN_JOB_ATTEMPTS ?? 1),
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    return { scanId, status: 'queued' as const };
  }

  /**
   * The heavy scan pipeline, run DETACHED on the BullMQ worker (ScanProcessor).
   * Owns its own try/catch + finalize so it never throws back to the worker:
   * success → completed row + COMPLETED event; failure → failed row + FAILED
   * event; finally → schedule SSE stream cleanup. Idempotent enough to re-run if
   * BullMQ recovers a stalled job after a restart.
   */
  async runScanPipeline(data: ScanJobData): Promise<void> {
    const { scanId, scanStartedAt, executionDto, materialized, resolvedBuildCommand, requestedFormats } = data;
    const buildPlan = data.buildPlan as any;
    try {
      if (buildPlan) {
        this.emitEvent(scanId, ScanEventName.BUILD_PLAN_SELECTED, {
          buildSystem: buildPlan.buildSystem,
          buildCommand: buildPlan.buildCommand,
          strategy: buildPlan.strategy,
        });
      }
      this.emitEvent(scanId, ScanEventName.WORKSPACE_FINISHED, {});

      const orchestration = await this.scanOrchestrator.run({
        staticSvc: this.staticSvc,
        dynamicSvc: this.dynamicSvc,
        scanId,
        scanCreatedAt: scanStartedAt,
        dto: executionDto,
        sourceWorkspacePath: materialized.sourcePath,
        hostMaterializedWorkspacePath: materialized.materializedPath,
        materializedWorkspaceId: materialized.materializedWorkspaceId,
        sourceType: materialized.sourceType,
        repositoryManifest: materialized.manifest as any,
        resolvedBuildCommand,
        buildPlan,
        requestedFormats,
        emitEvent: this.emitEvent.bind(this),
      });

      await this.scanRepo.update(scanId, {
        status: 'completed',
        report: {
          ...(orchestration.report as any),
          repositoryManifest: materialized.manifest,
        } as any,
        summary: orchestration.report.summary as any,
        completedAt: new Date(),
      });

      this.emitEvent(scanId, ScanEventName.COMPLETED, { scanId });
    } catch (err: any) {
      this.logger.error(`[SCAN] pipeline failed for ${scanId}: ${err?.message || err}`);
      try {
        await this.scanRepo.update(scanId, { status: 'failed', completedAt: new Date() });
        this.emitEvent(scanId, ScanEventName.FAILED, { error: err?.message || String(err) });
      } catch (finalizeErr: any) {
        this.logger.error(`[SCAN] finalize-failed for ${scanId}: ${finalizeErr?.message || finalizeErr}`);
      }
    } finally {
      this.scheduleStreamCleanup(scanId);
    }
  }

  async getScan(id: string) {
    const scan = await this.scanRepo.findOneBy({ scanId: id });
    if (!scan) return null;
    return {
      scanId: scan.scanId,
      status: scan.status,
      workspacePath: scan.workspacePath,
      sourceWorkspacePath: (scan.report as any)?.metadata?.sourceWorkspacePath,
      materializedWorkspacePath: (scan.report as any)?.metadata?.materializedWorkspacePath,
      materializedWorkspaceId: (scan.report as any)?.metadata?.materializedWorkspaceId,
      analysisMode: scan.analysisMode,
      buildCommand: scan.buildCommand,
      dynamicMode: scan.dynamicMode,
      dynamicToolPreference: scan.dynamicToolPreference,
      report: scan.report,
      summary: scan.summary,
      createdAt: scan.createdAt.toISOString(),
      completedAt: scan.completedAt?.toISOString(),
    };
  }

  async deleteScan(id: string) {
    await this.scanRepo.delete(id);
    this.scanWorkspace.cleanupForScan(id);
    this.disposeStream(id);
    return { success: true };
  }

  async purgeTerminalScans(): Promise<{ deleted_scan_ids: string[] }> {
    const terminalStates = ['completed', 'failed', 'cancelled'];
    const toDelete = await this.scanRepo.find({
      where: { status: In(terminalStates) },
      select: { scanId: true },
    });
    const ids = toDelete.map((s) => s.scanId);
    if (ids.length > 0) {
      await this.scanRepo.delete(ids);
      for (const id of ids) {
        this.scanWorkspace.cleanupForScan(id);
        this.disposeStream(id);
      }
    }
    return { deleted_scan_ids: ids };
  }

  async cancelScan(id: string) {
    await this.scanRepo.update(id, { status: 'cancelled', completedAt: new Date() });
    return { success: true };
  }

  streamEvents(id: string): Observable<any> {
    let subject = this.eventStreams.get(id);
    if (!subject) {
      subject = new ReplaySubject<any>(100);
      this.eventStreams.set(id, subject);
    }
    return subject.asObservable();
  }

  getEventsHistory(id: string): any[] {
    return this.eventsHistory.get(id) || [];
  }

  /**
   * Free a scan's in-memory event stream + history after a TTL once it has
   * reached a terminal state. The delay lets late SSE subscribers and the 3s
   * /events/history poll drain the final events; the full report stays in the DB.
   */
  private scheduleStreamCleanup(scanId: string) {
    const existing = this.cleanupTimers.get(scanId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.eventStreams.get(scanId)?.complete();
      this.eventStreams.delete(scanId);
      this.eventsHistory.delete(scanId);
      this.cleanupTimers.delete(scanId);
    }, this.streamTtlMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.cleanupTimers.set(scanId, timer);
  }

  /** Drop any in-memory stream state + pending cleanup timer for a scan. */
  private disposeStream(scanId: string) {
    const timer = this.cleanupTimers.get(scanId);
    if (timer) clearTimeout(timer);
    this.cleanupTimers.delete(scanId);
    this.eventStreams.get(scanId)?.complete();
    this.eventStreams.delete(scanId);
    this.eventsHistory.delete(scanId);
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
      case 'snapshot':
        return {
          content: this.reportingService.toSnapshot(report as any),
          contentType: 'application/json',
        };
      case 'pdf':
        return {
          content: this.reportingService.toPdf(report as any),
          contentType: 'application/pdf',
        };
      
      case 'csv':
        return {
          content: this.reportingService.toCsv(report as any),
          contentType: 'text/csv',
        };

default:
        return {
          content: JSON.stringify(report, null, 2),
          contentType: 'application/json',
        };
    }
  }

  private makeEvent(scanId: string, event: string, extra: Record<string, any> = {}): any {
    const eventId = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    // phase + kind come from the shared flow contract (single source of truth).
    const phase = phaseForEvent(event);
    const kind = kindForEvent(event);

    // Keep a stable top-level `type` for terminal handling in the store/UI
    // (TERMINAL_STATES keys off 'completed'/'failed'); everything else is 'task_updated'.
    const type =
      event === ScanEventName.COMPLETED
        ? 'completed'
        : event === ScanEventName.FAILED || event === ScanEventName.PREFLIGHT_FAILED
          ? 'failed'
          : event === ScanEventName.SCAN_CREATED
            ? 'scan_created'
            : 'task_updated';

    return {
      event_id: eventId,
      eventId,
      scanId,
      scan_id: scanId,
      timestamp,
      type,
      phase,
      kind,
      message: event,
      ...extra,
    };
  }

  private emitEvent(scanId: string, event: string, extra: Record<string, any> = {}) {
    const payload = this.makeEvent(scanId, event, extra);
    let subject = this.eventStreams.get(scanId);
    if (!subject) {
      subject = new ReplaySubject<any>(100);
      this.eventStreams.set(scanId, subject);
    }
    subject.next({ data: payload });

    // Store in history for REST queries
    if (!this.eventsHistory.has(scanId)) {
      this.eventsHistory.set(scanId, []);
    }
    this.eventsHistory.get(scanId)!.push(payload);
  }
}
