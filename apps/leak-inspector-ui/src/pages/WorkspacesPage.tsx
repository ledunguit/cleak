import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, FolderCode, Files, Clock, GitBranch } from 'lucide-react';
import { Button, Card, Flex, Input, Modal, Space, Spin, Tag, Typography, theme, message } from 'antd';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { Workspace } from '@/types';

const { Title, Text } = Typography;

export default function WorkspacesPage() {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const { workspaces, initializeFromServer, createWorkspace } = useWorkspaceStore();
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setLoading(true);
    initializeFromServer().finally(() => setLoading(false));
  }, [initializeFromServer]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const ws = await createWorkspace({ name: newName.trim(), path: newPath.trim() || undefined });
      message.success(`Workspace "${ws.name}" created`);
      setCreateOpen(false);
      setNewName('');
      setNewPath('');
      navigate(`/workspace/${ws.workspaceId}`);
    } catch (err: any) {
      message.error(err.message || 'Failed to create workspace');
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <Flex justify="center" align="center" style={{ minHeight: 300 }}>
        <Spin size="large" />
      </Flex>
    );
  }

  return (
    <Flex vertical gap={24} style={{ maxWidth: 900, margin: '0 auto' }}>
      <Flex align="center" justify="space-between">
        <Title level={3} style={{ margin: 0 }}>Workspaces</Title>
        <Button type="primary" icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>
          New Workspace
        </Button>
      </Flex>

      {workspaces.length === 0 ? (
        <Card>
          <Flex vertical align="center" gap={16} style={{ padding: '40px 0' }}>
            <FolderCode size={48} color={token.colorTextTertiary} />
            <Text type="secondary">No workspaces yet. Create one to get started.</Text>
            <Button type="primary" onClick={() => setCreateOpen(true)}>Create Workspace</Button>
          </Flex>
        </Card>
      ) : (
        <Flex vertical gap={12}>
          {workspaces.map((ws) => (
            <Card
              key={ws.workspaceId}
              hoverable
              onClick={() => navigate(`/workspace/${ws.workspaceId}`)}
              styles={{ body: { padding: 20 } }}
            >
              <Flex align="center" justify="space-between" wrap gap={12}>
                <Flex align="center" gap={12}>
                  <FolderCode size={24} color={token.colorPrimary} />
                  <div>
                    <Text strong style={{ fontSize: 16 }}>{ws.name}</Text>
                    <br />
                    <Text type="secondary" style={{ fontSize: 13 }}>{ws.path}</Text>
                  </div>
                </Flex>
                <Space wrap>
                  <Tag icon={<Files size={12} />}>
                    {(ws as any).c_cpp_file_count != null ? `${(ws as any).c_cpp_file_count} files` : '...'}
                  </Tag>
                  <Tag icon={<GitBranch size={12} />}>{ws.source || 'filesystem'}</Tag>
                  {ws.createdAt && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      <Clock size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                      {new Date(ws.createdAt).toLocaleDateString()}
                    </Text>
                  )}
                </Space>
              </Flex>
            </Card>
          ))}
        </Flex>
      )}

      <Modal
        title="New Workspace"
        open={createOpen}
        onOk={handleCreate}
        onCancel={() => { setCreateOpen(false); setNewName(''); setNewPath(''); }}
        confirmLoading={creating}
        okText="Create"
      >
        <Flex vertical gap={12}>
          <div>
            <Text strong>Name</Text>
            <Input
              placeholder="my-workspace"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onPressEnter={handleCreate}
            />
          </div>
          <div>
            <Text strong>Path (optional)</Text>
            <Input
              placeholder="/path/to/project"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>Defaults to workspace name if empty.</Text>
          </div>
        </Flex>
      </Modal>
    </Flex>
  );
}
