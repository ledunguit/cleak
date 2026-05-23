import { useState } from 'react';
import { Button, Empty, Flex, Segmented, Space, Tabs, Typography } from 'antd';

import { FindingsView } from '@/components/report/FindingsView';
import { OverviewView } from '@/components/report/OverviewView';
import { AppCard } from '@/components/ui';
import type { ScanDetail, StructuredReport } from '@/types';

const { Paragraph } = Typography;

interface ReportControlsCardProps {
  selectedScan: ScanDetail | null;
  reportData: StructuredReport | null;
  reportText: string;
  onReloadStructured: () => void;
  onLoadReport: (format: string) => void;
  onOpenHtml: () => void;
}

export function ReportControlsCard({
  selectedScan,
  reportData,
  reportText,
  onReloadStructured,
  onLoadReport,
  onOpenHtml,
}: ReportControlsCardProps) {
  const [activeTab, setActiveTab] = useState('findings');

  return (
    <AppCard
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      styles={{
        header: { display: 'none' },
        body: {
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }
      }}
    >
      <Flex
        align="center"
        justify="space-between"
        gap={12}
        wrap
        style={{
          flexShrink: 0,
          paddingBottom: 12,
          borderBottom: '1px solid rgba(64, 71, 84, 0.08)',
          marginBottom: 8,
        }}
      >
        <Space wrap>
          <Button size="small" onClick={onReloadStructured} disabled={!selectedScan}>
            Refresh
          </Button>
          <Button type="primary" size="small" onClick={onOpenHtml} disabled={!selectedScan}>
            Open HTML
          </Button>
        </Space>

        <Segmented
          size="middle"
          disabled={!selectedScan}
          options={[
            { label: 'Markdown', value: 'markdown' },
            { label: 'JSON', value: 'json' },
            { label: 'Snapshot', value: 'snapshot' },
          ]}
          onChange={(value) => {
            setActiveTab('raw');
            onLoadReport(value as string);
          }}
        />
      </Flex>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        className="report-tabs"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        items={[
          {
            key: 'overview',
            label: 'Overview',
            style: { flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 8 },
            children: <OverviewView selectedScan={selectedScan as any} reportData={reportData as any} />,
          },
          {
            key: 'findings',
            label: 'Findings',
            style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
            children: <FindingsView reportData={reportData as any} />,
          },
          {
            key: 'raw',
            label: 'Raw Output',
            style: { flex: 1, minHeight: 0, overflowY: 'auto' },
            children: selectedScan ? (
              <AppCard size="small" bodyGap={0} style={{ minHeight: '100%' }}>
                <Paragraph
                  style={{
                    marginBottom: 0,
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    fontFamily: 'SFMono-Regular, Consolas, Menlo, monospace',
                  }}
                >
                  {reportText}
                </Paragraph>
              </AppCard>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Select a scan to load raw report output." />
            ),
          },
        ]}
      />
    </AppCard>
  );
}
