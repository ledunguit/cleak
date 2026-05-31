import { Avatar, Button, Card, Descriptions, Divider, Flex, Space, Spin, Tag, Typography, theme, message } from 'antd';
import { GithubOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { api } from '@/services/memoryLeakApi';
import { useState } from 'react';

const { Title, Text } = Typography;

export default function SettingsPage() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [loggingOut, setLoggingOut] = useState(false);

  const handleGitHubConnect = async () => {
    try {
      const data = await api<{ authorization_url: string }>('/api/github/auth-url');
      window.location.href = data.authorization_url;
    } catch (err: any) {
      message.error(err.message || 'Failed to get GitHub auth URL');
    }
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    await logout();
    navigate('/login');
  };

  if (!user) {
    return (
      <Flex justify="center" align="center" style={{ minHeight: 300 }}>
        <Spin size="large" />
      </Flex>
    );
  }

  return (
    <Flex vertical gap={24}>
      <Title level={3}>Settings</Title>

      {/* Profile section */}
      <Card title="Profile">
        <Flex align="center" gap={16} style={{ marginBottom: 24 }}>
          <Avatar
            src={user.avatarUrl}
            size={64}
            icon={<UserOutlined />}
            style={{ backgroundColor: token.colorPrimary }}
          />
          <div>
            <Title level={4} style={{ margin: 0 }}>{user.name || user.login}</Title>
            <Text type="secondary">@{user.login}</Text>
          </div>
        </Flex>
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label="GitHub ID">{user.githubUserId}</Descriptions.Item>
          <Descriptions.Item label="Login">{user.login}</Descriptions.Item>
          <Descriptions.Item label="Name">{user.name || '-'}</Descriptions.Item>
          <Descriptions.Item label="Email">{user.email || '-'}</Descriptions.Item>
          <Descriptions.Item label="User ID">
            <Text copyable={{ text: user.userId }} style={{ fontSize: 12 }}>{user.userId}</Text>
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {/* GitHub section */}
      <Card title="GitHub Connection">
        <Flex align="center" gap={12}>
          <Tag icon={<GithubOutlined />} color="success">Connected</Tag>
          <Text>Authenticated as <strong>{user.login}</strong></Text>
        </Flex>
        <Divider />
        <Button onClick={handleGitHubConnect}>Reconnect GitHub</Button>
      </Card>

      {/* Account section */}
      <Card title="Account">
        <Button
          danger
          type="primary"
          icon={<LogoutOutlined />}
          onClick={handleLogout}
          loading={loggingOut}
        >
          Logout
        </Button>
      </Card>
    </Flex>
  );
}
