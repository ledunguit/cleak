import { FolderCode, History, RefreshCw, Trash2 } from 'lucide-react';
import { Button, Flex, List, Space, Tag, Typography, theme } from 'antd';

import { formatClock, formatRelativeTime, tagColor } from '@/utils/ui';
import { AppCard } from '@/components/ui';
import type { ScanSummary } from '@/types';

const { Text } = Typography;
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

interface ScanHistoryListProps {
  recentScans: ScanSummary[];
  selectedScanId?: string;
  terminalScanCount: number;
  deletingScans: boolean;
  onRefresh: () => void;
  onSelectScan: (scan: ScanSummary) => void;
  onRequestDeleteScan: (scan: ScanSummary) => void;
  onRequestDeleteTerminalScans: () => void;
  standalone?: boolean;
}

export function ScanHistoryList({
  recentScans,
  selectedScanId,
  terminalScanCount,
  deletingScans,
  onRefresh,
  onSelectScan,
  onRequestDeleteScan,
  onRequestDeleteTerminalScans,
  standalone = false,
}: ScanHistoryListProps) {
  const { token } = theme.useToken();

  return (
    <AppCard
      styles={{ header: { display: 'none' } }}
    >
      <Flex align="center" justify="space-between" gap={12} wrap>
        <Text type="secondary">Open a running or completed scan, compare statuses, and clean up terminal entries.</Text>
        <Space wrap>
          <Tag>
            <Flex align="center" gap={6}>
              <History size={14} />
              <span>Scan history</span>
            </Flex>
          </Tag>
          <Button size="small" icon={<RefreshCw size={14} />} onClick={onRefresh}>
            Refresh
          </Button>
          <Button
            type="primary"
            danger
            size="small"
            icon={<Trash2 size={14} />}
            onClick={onRequestDeleteTerminalScans}
            disabled={deletingScans || !terminalScanCount}
          >
            Delete Old
          </Button>
        </Space>
      </Flex>

      <List
        dataSource={recentScans}
        locale={{ emptyText: 'No persisted scans yet.' }}
        split={false}
        grid={
          standalone
            ? { gutter: 16, xs: 1, md: 2, xxl: 3 }
            : undefined
        }
        style={{ maxHeight: standalone ? 'none' : '70vh', overflow: standalone ? 'visible' : 'auto' }}
        renderItem={(scan) => {
          const selected = selectedScanId === scan.scanId;

          return (
            <List.Item style={{ paddingBlock: 0, paddingInline: 0, border: 0, marginBottom: 12 }}>
              <AppCard
                hoverable
                size="small"
                onClick={() => onSelectScan(scan)}
                bodyGap={12}
                style={{
                  width: '100%',
                  cursor: 'pointer',
                  borderColor: selected ? token.colorPrimary : token.colorBorderSecondary,
                  background: selected ? token.colorPrimaryBg : token.colorBgContainer,
                  boxShadow: selected ? `0 0 0 1px ${token.colorPrimaryBorder}` : undefined,
                }}
              >
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Space wrap align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
                    <Text strong>{scan.scanId}</Text>
                    <Space size={8} wrap>
                      <Tag color={tagColor(scan.status)}>{scan.status}</Tag>
                      <Tag>{scan.analysisMode || 'no_llm'}</Tag>
                    </Space>
                  </Space>

                  <Space size={8} align="start">
                    <FolderCode size={14} color={token.colorPrimary} style={{ marginTop: 2 }} />
                    <Text type="secondary">{(scan as any).workspacePath}</Text>
                  </Space>

                  <Space size={24} wrap>
                    <div>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        Created
                      </Text>
                      <div>{formatClock(scan.createdAt as any)}</div>
                    </div>
                    <div>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        Age
                      </Text>
                      <div>{formatRelativeTime(scan.createdAt as any)}</div>
                    </div>
                  </Space>
                </Space>

                <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Tap to inspect on the canvas
                  </Text>
                  <Button
                    danger
                    type="link"
                    size="small"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRequestDeleteScan(scan);
                    }}
                    disabled={deletingScans || !TERMINAL_STATES.has(scan.status)}
                  >
                    Delete
                  </Button>
                </Space>
              </AppCard>
            </List.Item>
          );
        }}
      />
    </AppCard>
  );
}
