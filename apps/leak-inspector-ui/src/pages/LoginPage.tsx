import { Typography, Button, Card, Space, Spin } from 'antd';
import { GithubOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';

const { Title, Text } = Typography;

// Module-level flag: StrictMode unmount/remount reset component instance state,
// nên ref không đủ. Dùng Set để đánh dấu code đã được xử lý.
const processedCodes = new Set<string>();

export default function LoginPage() {
  const { user, initialized } = useAuthStore();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Handle GitHub OAuth callback
  useEffect(() => {
    const code = searchParams.get('code');
    if (!code || processedCodes.has(code)) return;
    processedCodes.add(code);

    // Xóa code khỏi URL ngay
    navigate('/login', { replace: true });

    // Clear stale token before exchanging code
    localStorage.removeItem('auth_token');

    setLoading(true);
    setError(null);

    fetch('/api/auth/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.message || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        useAuthStore.getState().setAuth(data.user, data.token);
        navigate('/workspaces', { replace: true });
      })
      .catch((err) => {
        setError('GitHub authentication failed. Please try again.');
        setLoading(false);
      });
  }, [searchParams, navigate]);

  // Already logged in
  useEffect(() => {
    if (initialized && user && !searchParams.get('code')) {
      navigate('/workspaces', { replace: true });
    }
  }, [initialized, user, navigate, searchParams]);

  const handleGitHubLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      // Use plain fetch to avoid sending stale Authorization header
      const res = await fetch('/api/github/auth-url');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      window.location.href = data.authorization_url;
    } catch (err: any) {
      setError('Failed to connect to GitHub. Is GITHUB_CLIENT_ID configured?');
      setLoading(false);
    }
  };

  if (!initialized) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #f7f8fa 0%, #eef2ff 100%)',
      }}
    >
      <Card
        style={{
          width: 420,
          borderRadius: 20,
          boxShadow: '0 12px 32px rgba(64, 71, 84, 0.08)',
          textAlign: 'center',
          padding: '40px 24px',
        }}
        styles={{ body: { padding: '40px 24px' } }}
      >
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div>
            <Title level={2} style={{ margin: 0 }}>MCP-VUL</Title>
            <Text type="secondary" style={{ fontSize: 16 }}>
              Memory Leak Investigation Console
            </Text>
          </div>

          {error && (
            <Text type="danger" style={{ display: 'block' }}>
              {error}
            </Text>
          )}

          <Button
            type="primary"
            size="large"
            icon={<GithubOutlined />}
            onClick={handleGitHubLogin}
            loading={loading}
            disabled={loading}
            style={{ height: 48, borderRadius: 12, width: '100%' }}
          >
            Sign in with GitHub
          </Button>

          <Text type="secondary" style={{ fontSize: 13 }}>
            Connect your GitHub account to manage repositories<br />
            and run memory leak investigations.
          </Text>
        </Space>
      </Card>
    </div>
  );
}
