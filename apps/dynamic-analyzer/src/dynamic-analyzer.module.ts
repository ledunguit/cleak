import { Module } from '@nestjs/common';
import { BuildTargetService } from './services/build-target.service';
import { ValgrindService } from './services/valgrind.service';
import { AsanService } from './services/asan.service';
import { LsanService } from './services/lsan.service';
import { BinaryRunnerService } from './services/binary-runner.service';
import { ResultParserService } from './services/result-parser.service';
import { LeakBundleNormalizerService } from './services/leak-bundle-normalizer.service';
import { RunManagerService } from './services/run-manager.service';
import { CompareService } from './services/compare.service';

@Module({
  providers: [
    BuildTargetService,
    ValgrindService,
    AsanService,
    LsanService,
    BinaryRunnerService,
    ResultParserService,
    LeakBundleNormalizerService,
    RunManagerService,
    CompareService,
  ],
})
export class DynamicAnalyzerModule {}
