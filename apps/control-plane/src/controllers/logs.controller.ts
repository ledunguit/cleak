import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { LogCollectorService } from '../services/log-collector.service';

@Controller('api')
export class LogsController {
  constructor(private readonly logCollector: LogCollectorService) {}

  @Get('scans/:id/logs')
  async getLogs(
    @Param('id') id: string,
    @Query('format') format: string,
    @Res() res: Response,
  ) {
    const logs = await this.logCollector.getLogs(id, format || 'text');
    res.setHeader('Content-Type', logs.contentType);
    res.send(logs.content);
  }

  @Get('scans/:id/logs/stream')
  async streamLogs(
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const subscription = this.logCollector.streamLogs(id).subscribe({
      next: (line) => res.write(`data: ${JSON.stringify(line)}\n\n`),
      error: () => res.end(),
      complete: () => res.end(),
    });

    res.on('close', () => subscription.unsubscribe());
  }
}
