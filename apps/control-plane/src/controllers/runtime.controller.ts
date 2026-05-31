import { Controller, Get } from '@nestjs/common';
import { Public } from '../decorators/public.decorator';
import { RuntimeDiagnosticsService } from '../services/runtime-diagnostics.service';

@Controller('api/runtime')
export class RuntimeController {
  constructor(private readonly runtimeDiagnostics: RuntimeDiagnosticsService) {}

  @Get('preflight')
  @Public()
  async getPreflight() {
    return this.runtimeDiagnostics.getPreflightReport();
  }
}
