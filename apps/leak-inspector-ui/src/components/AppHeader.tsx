import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radar, Settings, LogOut } from 'lucide-react';
import { Flex, Space, Typography, theme, Avatar, Dropdown, MenuProps } from 'antd';
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

  const dropdownItems: MenuProps['items'] = useMemo(() => [
    {
      key: 'settings',
      icon: <Settings size={16} />,
      label: 'Settings',
      onClick: () => navigate('/settings'),
      style: { padding: '10px 16px', borderRadius: 8 },
    },
    { type: 'divider' as const, style: { margin: '4px 0' } },
    {
      key: 'logout',
      icon: <LogOut size={16} />,
      label: 'Logout',
      onClick: async () => {
        await logout();
        navigate('/login');
      },
      danger: true,
      style: { padding: '10px 16px', borderRadius: 8 },
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
        {user && (
          <Dropdown
            menu={{
              items: dropdownItems,
              style: { minWidth: 180, borderRadius: 12, padding: 4 },
            }}
            placement="bottomRight"
            trigger={['click']}
          >
            <Flex
              align="center"
              gap={10}
              style={{
                cursor: 'pointer',
                padding: '6px 14px 6px 10px',
                borderRadius: 10,
                background: token.colorBgElevated,
                border: `1px solid ${token.colorBorderSecondary}`,
                transition: 'all 0.2s',
                userSelect: 'none',
              }}
              className="user-dropdown-trigger"
              onMouseEnter={(e) => {
                e.currentTarget.style.background = token.colorBgTextHover;
                e.currentTarget.style.borderColor = token.colorBorder;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = token.colorBgElevated;
                e.currentTarget.style.borderColor = token.colorBorderSecondary;
              }}
            >
              <Avatar
                src={user.avatarUrl}
                size={28}
                style={{ backgroundColor: token.colorPrimary, flexShrink: 0 }}
              >
                {user.login?.charAt(0).toUpperCase()}
              </Avatar>
              <Typography.Text strong style={{ fontSize: 14, lineHeight: '28px' }}>
                {user.login}
              </Typography.Text>
            </Flex>
          </Dropdown>
        )}
      </Flex>
    </Flex>
  );
}
