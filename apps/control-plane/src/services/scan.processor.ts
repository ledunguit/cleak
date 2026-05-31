import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ScanService } from './scan.service';
import { SCAN_QUEUE, ScanJobData } from './scan-queue';

export { SCAN_QUEUE } from './scan-queue';

/**
 * In-process BullMQ worker that runs detached scan pipelines. Concurrency is
 * capped (SCAN_MAX_CONCURRENCY) so the LLM gateway is never overwhelmed.
 * Runs in the same process as the API so ScanService's in-memory SSE streams
 * receive the events emitted during the run.
 */
@Processor(SCAN_QUEUE, { concurrency: Number(process.env.SCAN_MAX_CONCURRENCY ?? 2) })
export class ScanProcessor extends WorkerHost {
  private readonly logger = new Logger(ScanProcessor.name);

  constructor(private readonly scanService: ScanService) {
    super();
  }

  async process(job: Job<ScanJobData>): Promise<void> {
    this.logger.log(`[QUEUE] picking up scan ${job.data.scanId} (job ${job.id})`);
    // runScanPipeline owns its own try/catch + finalize, so it never throws;
    // the BullMQ job is marked complete once the pipeline has settled (the scan
    // result lives in the DB row + terminal SSE event).
    await this.scanService.runScanPipeline(job.data);
  }
}
