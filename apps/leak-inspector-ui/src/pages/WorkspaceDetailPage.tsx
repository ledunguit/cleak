import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Play, Trash2, FolderPlus, GitBranch, RefreshCw, ExternalLink,
} from 'lucide-react';
import {
  Button, Flex, Tag, Typography, Space, Empty, Spin,
} from 'antd';
import { AppCard } from '@/components/ui';
import { AddRepoModal } from '@/components/AddRepoModal';
import { useWorkspaceStore } from '@/stores/workspaceStore';

const { Text, Title } = Typography;

export function WorkspaceDetailPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const wsStore = useWorkspaceStore();

  const [addRepoOpen, setAddRepoOpen] = useState(false);

  useEffect(() => {
    if (workspaceId) wsStore.loadWorkspace(workspaceId);
  }, [workspaceId]);

  const ws = wsStore.currentWorkspace;
  const repos = wsStore.currentWorkspaceRepos;

  // ── Handlers ──

  async function handleClone(repoId: string) {
    if (!workspaceId) return;
    await wsStore.cloneRepo(workspaceId, repoId);
  }

  function handleOpenGitHub(cloneUrl?: string) {
    if (!cloneUrl) return;
    // Convert git@github.com:org/repo.git to https://github.com/org/repo
    const httpsUrl = cloneUrl
      .replace(/^git@([^:]+):/, 'https://$1/')
      .replace(/\.git$/, '');
    window.open(httpsUrl, '_blank', 'noopener,noreferrer');
  }

  if (!ws) {
    return (
      <Flex justify="center" style={{ height: '100%', paddingTop: 80 }}>
        <Spin size="large" />
      </Flex>
    );
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 24 }}>
      <Flex vertical gap={20}>
        {/* Header */}
        <Flex align="center" gap={16} wrap>
          <Button icon={<ArrowLeft size={16} />} onClick={() => navigate('/workspaces')}>
            Back
          </Button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Title level={4} style={{ margin: 0 }}>{ws.name}</Title>
            <Text type="secondary" style={{ fontSize: 13 }}>{ws.path}</Text>
          </div>
          <Space>
            <Button
              danger
              icon={<Trash2 size={14} />}
              onClick={async () => {
                await wsStore.deleteWorkspace(ws.workspaceId);
                navigate('/workspaces');
              }}
            >
              Delete
            </Button>
          </Space>
        </Flex>

        {/* Repositories */}
        <AppCard
          title="Repositories"
          extra={
            <Button size="small" icon={<FolderPlus size={14} />} onClick={() => setAddRepoOpen(true)}>
              Add Repo
            </Button>
          }
        >
          {repos.length === 0 ? (
            <Empty description="No repositories yet. Add one to get started." image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Flex vertical gap={8}>
              {repos.map((repo) => {
                const isSelected = wsStore.selectedRepoId === repo.repo_id;
                return (
                  <Flex
                    key={repo.repo_id}
                    align="center"
                    gap={12}
                    tabIndex={-1}
                    style={{
                      padding: '12px 16px',
                      borderRadius: 12,
                      border: '1px solid',
                      borderColor: isSelected ? '#2e5bff' : '#f0f0f0',
                      background: isSelected ? '#eef2ff' : '#f8f9fa',
                      cursor: 'pointer',
                      outline: 'none',
                      boxShadow: 'none',
                    }}
                    onClick={() => wsStore.selectRepo(repo.repo_id)}
                  >
                    <GitBranch size={16} style={{ flexShrink: 0, opacity: 0.6 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Text strong style={{ fontSize: 14 }}>
                        {repo.repo_full_name || repo.repo_id}
                      </Text>
                      {repo.local_clone_path ? (
                        <Tag color="success" style={{ fontSize: 11, marginLeft: 8 }}>Cloned</Tag>
                      ) : (
                        <Tag style={{ fontSize: 11, marginLeft: 8 }}>Pending</Tag>
                      )}
                      <div>
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {repo.local_clone_path || repo.clone_url || ''}
                        </Text>
                      </div>
                    </div>
                    <Space onClick={(e) => e.stopPropagation()}>
                      {repo.clone_url && (
                        <Button
                          size="small"
                          icon={<ExternalLink size={12} />}
                          onClick={() => handleOpenGitHub(repo.clone_url)}
                          type="text"
                          title="Open on GitHub"
                        />
                      )}
                      <Button
                        size="small"
                        icon={<RefreshCw size={12} />}
                        onClick={() => handleClone(repo.repo_id)}
                        type="text"
                      >
                        {repo.local_clone_path ? 'Re-clone' : 'Clone'}
                      </Button>
                      <Button
                        size="small" icon={<Trash2 size={12} />} danger type="text"
                        onClick={() => wsStore.removeRepo(workspaceId!, repo.repo_id)}
                      />
                    </Space>
                  </Flex>
                );
              })}
            </Flex>
          )}
        </AppCard>

        {/* Bottom action */}
        <Flex justify="end">
          <Button
            type="primary"
            size="large"
            icon={<Play size={16} />}
            onClick={() => navigate(`/workspace/${workspaceId}/scan-config`)}
            disabled={!wsStore.selectedRepoId}
          >
            Configure Scan
          </Button>
        </Flex>
      </Flex>

      <AddRepoModal
        open={addRepoOpen}
        workspaceId={workspaceId!}
        onClose={() => setAddRepoOpen(false)}
      />
    </div>
  );
}
