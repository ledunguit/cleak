import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Res,
  Sse,
} from '@nestjs/common';
import { Response } from 'express';
import { Observable } from 'rxjs';
import { ScanService } from '../services/scan.service';
import { CreateScanDto } from '@mcpvul/common/dto/scan.dto';
import { Public } from '../decorators/public.decorator';

@Controller('api')
export class ScanController {
  constructor(private readonly scanService: ScanService) {}

  @Get('scans')
  async listScans() {
    return this.scanService.listScans();
  }

  @Post('scans')
  async createScan(@Body() dto: CreateScanDto) {
    console.log('CreateScan body:', JSON.stringify(dto));
    return this.scanService.createScan(dto);
  }

  @Get('scans/:id')
  async getScan(@Param('id') id: string) {
    return this.scanService.getScan(id);
  }

  @Delete('scans/:id')
  async deleteScan(@Param('id') id: string) {
    return this.scanService.deleteScan(id);
  }

  @Post('scans/:id/cancel')
  async cancelScan(@Param('id') id: string) {
    return this.scanService.cancelScan(id);
  }

  @Get('scans/:id/events')
  @Sse()
  @Public()
  streamEvents(@Param('id') id: string): Observable<MessageEvent> {
    return this.scanService.streamEvents(id);
  }

  @Post('scans/purge-terminal')
  async purgeTerminalScans() {
    return this.scanService.purgeTerminalScans();
  }

  @Get('scans/:id/events/history')
  async getEventsHistory(@Param('id') id: string) {
    const events = this.scanService.getEventsHistory(id);
    return { events };
  }

  @Get('scans/:id/report')
  async getReport(
    @Param('id') id: string,
    @Query('format') format: string,
    @Res() res: Response,
  ) {
    const report = await this.scanService.getReport(id, format || 'json');
    res.setHeader('Content-Type', report.contentType);
    if (format === 'pdf') {
      res.setHeader('Content-Disposition', `inline; filename="${id}.pdf"`);
    }
    res.send(report.content);
  }
}
