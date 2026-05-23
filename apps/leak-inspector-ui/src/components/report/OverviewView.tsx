import { Col, Descriptions, Empty, Row, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { buildVerdictCounts } from './reportFormat';
import type { FindingBase } from './reportFormat';
import { AppCard, AppMetricCard } from '../ui';

const { Text } = Typography;

interface PerToolStats {
  tool: string;
  calls: number;
  totalDurationMs: number;
  avgDurationMs: number;
  maxDurationMs: number;
}

interface PerformanceSummary {
  perTool?: Record<string, Omit<PerToolStats, 'tool'>>;
  [key: string]: unknown;
}

interface JudgeSummary {
  effectiveMode?: string;
  provider?: string;
  llmSuccessCount?: number;
  llmSkippedCount?: number;
  [key: string]: unknown;
}

interface SelectedScanShape {
  workspacePath?: string;
  analysisMode?: string;
  judgeSummary?: JudgeSummary;
  [key: string]: unknown;
}

interface ReportDataShape {
  repo_path?: string;
  findings?: FindingBase[];
  bundles?: FindingBase[];
  metadata?: { workspacePath?: string; analysisMode?: string; [key: string]: unknown };
  summary?: { totalCandidates?: number; [key: string]: unknown };
  performanceSummary?: PerformanceSummary;
  judgeSummary?: JudgeSummary;
  [key: string]: unknown;
}

const performanceColumns: ColumnsType<PerToolStats> = [
  {
    title: 'Tool',
    dataIndex: 'tool',
    key: 'tool',
    render: (text: string) => (
      <span style={{ overflowWrap: 'anywhere' }}>{text}</span>
    ),
  },
  { title: 'Calls', dataIndex: 'calls', key: 'calls' },
  {
    title: 'Total ms',
    dataIndex: 'totalDurationMs',
    key: 'totalDurationMs',
  },
  {
    title: 'Avg ms',
    dataIndex: 'avgDurationMs',
    key: 'avgDurationMs',
  },
  {
    title: 'Max ms',
    dataIndex: 'maxDurationMs',
    key: 'maxDurationMs',
  },
];

export interface OverviewViewProps {
  selectedScan?: SelectedScanShape | null;
  reportData?: ReportDataShape | null;
}

export function OverviewView({ selectedScan, reportData }: OverviewViewProps) {
  const findings: FindingBase[] = reportData?.findings || reportData?.bundles || [];
  const counts = buildVerdictCounts(findings);
  const performance: PerformanceSummary = reportData?.performanceSummary || {};
  const perTool: PerToolStats[] = Object.entries(performance.perTool || {})
    .sort((a, b) => b[1].totalDurationMs - a[1].totalDurationMs)
    .slice(0, 5)
    .map(([tool, stats]) => ({ key: tool, tool, ...stats }));
  const judgeSummary: JudgeSummary =
    reportData?.judgeSummary || selectedScan?.judgeSummary || {};
  const metadata = reportData?.metadata || {};
  const bundleCount = reportData?.summary?.totalCandidates ?? reportData?.bundles?.length ?? '-';
  const workspaceLabel = metadata.workspacePath || selectedScan?.workspacePath || 'n/a';
  const modeLabel = metadata.analysisMode || selectedScan?.analysisMode || 'n/a';

  return (
    <Row gutter={[16, 16]}>
      <Col span={24}>
        <Descriptions bordered size="small" column={{ xs: 1, sm: 2, xl: 4 }}>
          <Descriptions.Item label="Repository">
            <span style={{ overflowWrap: 'anywhere' }}>
              {workspaceLabel}
            </span>
          </Descriptions.Item>
          <Descriptions.Item label="Findings">
            {bundleCount}
          </Descriptions.Item>
          <Descriptions.Item label="Evidence">
            {reportData?.summary?.totalCandidates ?? '-'}
          </Descriptions.Item>
          <Descriptions.Item label="Mode">
            <span style={{ overflowWrap: 'anywhere' }}>
              {modeLabel}
            </span>
          </Descriptions.Item>
        </Descriptions>
      </Col>

      <Col xs={24} xl={12}>
        <AppCard size="small" title="Verdict Distribution">
          {Object.entries(counts).length ? (
            <Row gutter={[12, 12]}>
              {Object.entries(counts).map(([verdict, count]) => (
                <Col xs={24} sm={12} key={verdict}>
                  <AppMetricCard metric={verdict} value={count} />
                </Col>
              ))}
            </Row>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No findings loaded."
            />
          )}
        </AppCard>
      </Col>

      <Col xs={24} xl={12}>
        <AppCard size="small" title="Judge Summary">
          <Row gutter={[12, 12]}>
            <Col xs={24} sm={12}>
              <AppMetricCard
                metric="Effective mode"
                value={judgeSummary.effectiveMode || 'n/a'}
                valueStyle={{ fontSize: 18 }}
              />
            </Col>
            <Col xs={24} sm={12}>
              <AppMetricCard
                metric="Provider"
                value={judgeSummary.provider || 'heuristic'}
                valueStyle={{ fontSize: 18 }}
              />
            </Col>
            <Col xs={24} sm={12}>
              <AppMetricCard
                metric="LLM success"
                value={judgeSummary.llmSuccessCount ?? 0}
              />
            </Col>
            <Col xs={24} sm={12}>
              <AppMetricCard
                metric="LLM skipped"
                value={judgeSummary.llmSkippedCount ?? 0}
              />
            </Col>
          </Row>
        </AppCard>
      </Col>

      <Col span={24}>
        <AppCard size="small" title="Performance Hotspots">
          {perTool.length ? (
            <Table
              columns={performanceColumns}
              dataSource={perTool}
              size="small"
              pagination={false}
            />
          ) : (
            <Text type="secondary">
              Performance data will appear after loading a completed report.
            </Text>
          )}
        </AppCard>
      </Col>
    </Row>
  );
}
