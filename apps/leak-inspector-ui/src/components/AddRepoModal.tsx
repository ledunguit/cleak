import { useState, useEffect } from 'react';
import {
  Modal, Tabs, Input, Button, Flex, Typography, Upload, UploadProps,
  message, Spin, Empty, Tag, Checkbox, List, Space, Tooltip,
} from 'antd';
import {
  InboxOutlined, GithubOutlined, FolderOutlined,
  ReloadOutlined, LockOutlined, GlobalOutlined,
} from '@ant-design/icons';
import type { GitHubRepo } from '@/types';
import { useWorkspaceStore } from '@/stores/workspaceStore';

const { Text } = Typography;
const { Dragger } = Upload;

interface AddRepoModalProps {
  open: boolean;
  workspaceId: string;
  onClose: () => void;
}

export function AddRepoModal({ open, workspaceId, onClose }: AddRepoModalProps) {
  const wsStore = useWorkspaceStore();
  const [activeTab, setActiveTab] = useState('local');

  // Local path state
  const [localName, setLocalName] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [addingLocal, setAddingLocal] = useState(false);

  // ZIP upload state
  const [uploading, setUploading] = useState(false);

  // GitHub state
  const [gitHubRepos, setGitHubRepos] = useState<GitHubRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [selectedRepos, setSelectedRepos] = useState<Set<number>>(new Set());
  const [addingGitHub, setAddingGitHub] = useState(false);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (!open) {
      setLocalName('');
      setLocalPath('');
      setSelectedRepos(new Set());
      setGitHubRepos([]);
    } else {
      // Refresh GitHub status mỗi khi mở modal (phòng khi BE đã được restart)
      wsStore.checkGitHubStatus();
    }
  }, [open]);

  // Load GitHub repos when tab switches to 'github'
  useEffect(() => {
    if (open && activeTab === 'github') {
      setLoadingRepos(true);
      wsStore.loadCachedGitHubRepos().then(({ repos, scope }) => {
        if (repos.length > 0) {
          setGitHubRepos(repos);
          setLoadingRepos(false);
        } else {
          wsStore.loadGitHubRepos().then((liveRepos) => {
            setGitHubRepos(liveRepos);
            setLoadingRepos(false);
          });
        }
      }).catch(() => {
        // Nếu cache không có, fallback load từ API
        wsStore.loadGitHubRepos().then((liveRepos) => {
          setGitHubRepos(liveRepos);
          setLoadingRepos(false);
        });
      });
    }
  }, [open, activeTab]);

  // ── Tab: Local Path ──

  async function handleAddLocalPath() {
    if (!localPath.trim()) return;
    setAddingLocal(true);
    try {
      await wsStore.addRepoByPath(workspaceId, localPath.trim(), localName.trim() || undefined);
      message.success('Repository added');
      onClose();
    } catch (err: any) {
      message.error(err.message || 'Failed to add repository');
    } finally {
      setAddingLocal(false);
    }
  }

  // ── Tab: ZIP Upload ──

  const uploadProps: UploadProps = {
    name: 'file',
    multiple: false,
    accept: '.zip',
    showUploadList: true,
    customRequest: async ({ file, onSuccess, onError }) => {
      setUploading(true);
      try {
        await wsStore.addRepoFromZip(workspaceId, file as File);
        message.success('ZIP uploaded and extracted');
        onSuccess?.(null);
        onClose();
      } catch (err: any) {
        onError?.(err);
        message.error(err.message || 'Failed to upload ZIP');
      } finally {
        setUploading(false);
      }
    },
  };

  // ── Tab: GitHub ──

  function toggleRepo(repoId: number) {
    setSelectedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
      return next;
    });
  }

  async function handleAddGitHubRepos() {
    if (selectedRepos.size === 0) return;
    setAddingGitHub(true);
    try {
      for (const repo of gitHubRepos) {
        if (selectedRepos.has(repo.id)) {
          await wsStore.addRepo(workspaceId, {
            github_repo_id: repo.id,
            repo_full_name: repo.full_name,
            clone_url: repo.clone_url,
            default_branch: repo.default_branch,
            is_private: repo.private,
          });
        }
      }
      message.success(`${selectedRepos.size} repo(s) added`);
      onClose();
    } catch (err: any) {
      message.error(err.message || 'Failed to add GitHub repos');
    } finally {
      setAddingGitHub(false);
    }
  }

  const tabItems = [
    {
      key: 'local',
      label: 'Local Path',
      children: (
        <Flex vertical gap={12}>
          <Text type="secondary">Display name (optional)</Text>
          <Input
            placeholder="my-project"
            value={localName}
            onChange={(e) => setLocalName(e.target.value)}
          />
          <Text type="secondary">Filesystem path</Text>
          <Input
            placeholder="/path/to/repo"
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
          />
          <Button
            type="primary"
            disabled={!localPath.trim()}
            loading={addingLocal}
            onClick={handleAddLocalPath}
            icon={<FolderOutlined />}
            block
          >
            Add Local Path
          </Button>
        </Flex>
      ),
    },
    {
      key: 'zip',
      label: 'Upload ZIP',
      children: (
        <Flex vertical gap={12}>
          <Text type="secondary">Upload a ZIP archive containing C/C++ source code.</Text>
          <Dragger {...uploadProps} disabled={uploading}>
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">Click or drag a .zip file here</p>
            <p className="ant-upload-hint">Only .zip files are accepted. The archive will be extracted automatically.</p>
          </Dragger>
        </Flex>
      ),
    },
    {
      key: 'github',
      label: 'From GitHub',
      children: (
        <Flex vertical gap={12}>
          {!wsStore.githubConnected ? (
            <Flex vertical align="center" gap={12} style={{ padding: '24px 0' }}>
              <GithubOutlined style={{ fontSize: 40, opacity: 0.3 }} />
              <Text type="secondary" style={{ textAlign: 'center' }}>
                GitHub connection not available.
              </Text>
            </Flex>
          ) : loadingRepos ? (
            <Flex justify="center" style={{ padding: 24 }}><Spin /></Flex>
          ) : gitHubRepos.length === 0 ? (
            <Empty
              description="No GitHub repositories found"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            >
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={async () => {
                  setLoadingRepos(true);
                  const repos = await wsStore.refreshGitHubRepos();
                  setGitHubRepos(repos);
                  setLoadingRepos(false);
                }}
              >
                Refresh from GitHub
              </Button>
            </Empty>
          ) : (
            <>
              <Flex align="center" justify="space-between" style={{ marginBottom: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {wsStore.githubScope === 'repo'
                    ? 'All repos (public + private)'
                    : 'Showing public repos only'}
                </Text>
                <Space size={4}>
                  {wsStore.githubScope !== 'repo' && (
                    <Tooltip title="Grant private repo access via GitHub">
                      <Button
                        size="small"
                        type="link"
                        icon={<LockOutlined />}
                        onClick={async () => {
                          try {
                            await wsStore.requestPrivateRepoAccess('full');
                          } catch (e: any) {
                            message.error(e.message);
                          }
                        }}
                        style={{ fontSize: 12 }}
                      >
                        Private access
                      </Button>
                    </Tooltip>
                  )}
                  <Tooltip title="Refresh repo list">
                    <Button
                      size="small"
                      type="text"
                      icon={<ReloadOutlined />}
                      onClick={async () => {
                        setLoadingRepos(true);
                        const repos = await wsStore.refreshGitHubRepos();
                        setGitHubRepos(repos);
                        setLoadingRepos(false);
                      }}
                    />
                  </Tooltip>
                </Space>
              </Flex>
              <List
                size="small"
                style={{ maxHeight: 320, overflow: 'auto' }}
                dataSource={gitHubRepos}
                renderItem={(repo) => (
                  <List.Item
                    onClick={() => toggleRepo(repo.id)}
                    style={{ cursor: 'pointer', padding: '8px 12px' }}
                  >
                    <Flex align="center" gap={8} style={{ width: '100%' }}>
                      <Checkbox checked={selectedRepos.has(repo.id)} />
                      {repo.private ? (
                        <LockOutlined style={{ color: '#faad14', fontSize: 13 }} />
                      ) : (
                        <GlobalOutlined style={{ opacity: 0.45, fontSize: 13 }} />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text strong style={{ fontSize: 13 }}>{repo.full_name}</Text>
                        {repo.private && (
                          <Tag color="warning" style={{ fontSize: 10, marginLeft: 4 }}>Private</Tag>
                        )}
                      </div>
                    </Flex>
                  </List.Item>
                )}
              />
              <Flex vertical gap={8}>
                {wsStore.githubScope !== 'repo' && selectedRepos.size > 0 && (
                  <Text type="warning" style={{ fontSize: 12, padding: '0 4px' }}>
                    <LockOutlined style={{ marginRight: 4 }} />
                    Some selected repos may be private. Request{" "}
                    <a
                      onClick={(e) => {
                        e.stopPropagation();
                        wsStore.requestPrivateRepoAccess('full');
                      }}
                    >
                      full repo access
                    </a>{" "}
                    on GitHub to clone them.
                  </Text>
                )}
                <Button
                  type="primary"
                  disabled={selectedRepos.size === 0}
                  loading={addingGitHub}
                  onClick={handleAddGitHubRepos}
                  icon={<GithubOutlined />}
                  block
                >
                  Add {selectedRepos.size > 0 ? `(${selectedRepos.size}) ` : ''}Selected Repo(s)
                </Button>
              </Flex>
            </>
          )}
        </Flex>
      ),
    },
  ];

  return (
    <Modal
      title="Add Repository"
      open={open}
      onCancel={onClose}
      footer={null}
      width={520}
      destroyOnClose
    >
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
    </Modal>
  );
}
