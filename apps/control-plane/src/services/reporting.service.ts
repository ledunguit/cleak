import { Injectable } from '@nestjs/common';
import { LeakReporting } from '@mcpvul/common/analysis/reporting';

/**
 * The report renderers live in the shared package (LeakReporting) so the
 * control plane and the leak-inspector-tui emit byte-identical reports.
 * ReportingService is a thin @Injectable wrapper that preserves DI + the
 * original method surface (buildReport / toJson / toMarkdown / toHtml /
 * toSnapshot / toCsv / toPdf) for existing call sites.
 */
@Injectable()
export class ReportingService extends LeakReporting {}
