import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radar, Settings, LogOut } from 'lucide-react';
import { Flex, Space, Tag, Typography, theme, Avatar, Dropdown } from 'antd';

import { tagColor } from '@/utils/ui';
import type { ScanDetail, StructuredReport } from '@/types';
import { useAuthStore } from '@/stores/authStore';

const { Text, Title } = Typography;

export interface AppHeaderProps {
  selectedScan: ScanDetail | null;
  reportData: StructuredReport | null;
}

export function AppHeader({ selectedScan, reportData }: AppHeaderProps) {
  const { token } = theme.useToken();
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  const workspaceDisplayPath =
    (reportData as any)?.metadata?.workspacePath
    || selectedScan?.workspacePath
    || 'Select a workspace and start a scan to populate the console.';

  const dropdownItems = useMemo(() => [
    {
      key: 'settings',
      icon: <Settings size={16} />,
      label: 'Settings',
      onClick: () => navigate('/settings'),
    },
    { type: 'divider' as const },
    {
      key: 'logout',
      icon: <LogOut size={16} />,
      label: 'Logout',
      onClick: async () => {
        await logout();
        navigate('/login');
      },
    },
  ], [navigate, logout]);

  return (
    <Flex justify="space-between" align="center" gap={16} wrap>
      <Space size={12} align="center">
        <Flex
          align="center"
          justify="center"
          style={{
            width: 40,
            height: 40,
            borderRadius: token.borderRadius,
            background: token.colorPrimaryBg,
          }}
        >
          <Radar size={20} color={token.colorPrimary} />
        </Flex>
        <Flex vertical gap={2} style={{ textAlign: 'left' }}>
          <Title level={4} style={{ margin: 0 }}>
            MCP-VUL
          </Title>
          <Text type="secondary">Memory Leak Console</Text>
        </Flex>
      </Space>

      <Flex gap={8} wrap align="center" justify="flex-end">
        <Tag color={tagColor(selectedScan?.status)}>{selectedScan?.status || 'idle'}</Tag>
        <Text type="secondary" style={{ textAlign: 'right' }}>
          {workspaceDisplayPath}
        </Text>
        {selectedScan ? <Tag>{selectedScan.scanId}</Tag> : <Tag>no active scan</Tag>}

        {user && (
          <Dropdown menu={{ items: dropdownItems }} placement="bottomRight">
            <Flex
              align="center"
              gap={8}
              style={{ cursor: 'pointer', padding: '4px 8px', borderRadius: 8 }}
            >
              <Avatar
                src={user.avatarUrl}
                size={32}
                style={{ backgroundColor: token.colorPrimary }}
              >
                {user.login?.charAt(0).toUpperCase()}
              </Avatar>
              <Text strong>{user.login}</Text>
            </Flex>
          </Dropdown>
        )}
      </Flex>
    </Flex>
  );
}
