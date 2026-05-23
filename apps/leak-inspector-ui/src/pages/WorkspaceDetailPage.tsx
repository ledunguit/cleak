import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Play, Trash2, FolderPlus, Settings,
  GitBranch, RefreshCw,
} from 'lucide-react';
import {
  Button, Col, Flex, Row, Switch, Tag, Typography, Space, Empty, Spin,
  Divider, Select, InputNumber, Input, Collapse, Form,
} from 'antd';
import { AppCard } from '@/components/ui';
import { AddRepoModal } from '@/components/AddRepoModal';
import { BuildDetectButton } from '@/components/BuildDetectButton';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useConsoleContext } from '@/layouts/AppLayout';

const { Text, Title } = Typography;

export function WorkspaceDetailPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const wsStore = useWorkspaceStore();
  const consoleState = useConsoleContext();

  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [buildDetectLoading, setBuildDetectLoading] = useState(false);
  const [buildDetectResult, setBuildDetectResult] = useState<string | null>(null);

  useEffect(() => {
    if (workspaceId) wsStore.loadWorkspace(workspaceId);
  }, [workspaceId]);

  const ws = wsStore.currentWorkspace;
  const repos = wsStore.currentWorkspaceRepos;
  const selectedWorkspacePath = ws?.path || '';
  const canStartScan = !consoleState.activeScan && Boolean(selectedWorkspacePath || consoleState.customPath.trim());

  // ── Handlers ──

  async function handleClone(repoId: string) {
    if (!workspaceId) return;
    await wsStore.cloneRepo(workspaceId, repoId);
  }

  async function handleStartScan() {
    const { selectedRepoId, currentWorkspaceRepos } = wsStore;

    if (workspaceId && selectedRepoId) {
      const repo = currentWorkspaceRepos.find((r) => r.repo_id === selectedRepoId);
      if (repo && !repo.local_clone_path) {
        try {
          const result = await wsStore.cloneRepo(workspaceId, selectedRepoId);
          if (result?.local_clone_path) consoleState.setCustomPath(result.local_clone_path);
        } catch { /* ignore */ }
      } else if (repo?.local_clone_path) {
        consoleState.setCustomPath(repo.local_clone_path);
      }
    }

    const result = await consoleState.startScan();
    if (result) navigate(`/activity/${result.scanId}`);
  }

  async function handleDetectBuild() {
    if (!workspaceId) return;
    const repoId = wsStore.selectedRepoId;
    if (!repoId) return;

    setBuildDetectLoading(true);
    setBuildDetectResult(null);
    try {
      const command = await wsStore.detectBuild(workspaceId, repoId);
      if (command) setBuildDetectResult(command);
    } catch { /* ignore */ }
    finally { setBuildDetectLoading(false); }
  }

  if (!ws) {
    return <Flex justify="center" style={{ height: '100%', paddingTop: 80 }}><Spin size="large" /></Flex>;
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 24 }}>
      <Flex vertical gap={20}>
        {/* Header */}
        <Flex align="center" gap={16} wrap>
          <Button icon={<ArrowLeft size={16} />} onClick={() => navigate('/workspaces')}>Back</Button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Title level={4} style={{ margin: 0 }}>{ws.name}</Title>
            <Text type="secondary" style={{ fontSize: 13 }}>{ws.path}</Text>
          </div>
          <Space>
            <Button
              type="primary"
              icon={<Play size={14} />}
              onClick={handleStartScan}
              disabled={!canStartScan}
            >
              Start Scan
            </Button>
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

        <Row gutter={[20, 20]}>
          {/* Left: Repositories */}
          <Col xs={24} lg={14}>
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
                  {repos.map((repo) => (
                    <Flex
                      key={repo.repo_id}
                      align="center"
                      gap={12}
                      style={{
                        padding: '12px 16px',
                        borderRadius: 12,
                        background: '#f8f9fa',
                        border: '1px solid #f0f0f0',
                        cursor: 'pointer',
                        ...(wsStore.selectedRepoId === repo.repo_id ? { borderColor: '#2e5bff', background: '#eef2ff' } : {}),
                      }}
                      onClick={() => wsStore.selectRepo(repo.repo_id)}
                    >
                      <GitBranch size={16} style={{ flexShrink: 0, opacity: 0.6 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text strong style={{ fontSize: 14 }}>{repo.repo_full_name || repo.repo_id}</Text>
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
                        <Button size="small" icon={<RefreshCw size={12} />} onClick={() => handleClone(repo.repo_id)} type="text">
                          {repo.local_clone_path ? 'Re-clone' : 'Clone'}
                        </Button>
                        <Button
                          size="small" icon={<Trash2 size={12} />} danger type="text"
                          onClick={() => wsStore.removeRepo(workspaceId!, repo.repo_id)}
                        />
                      </Space>
                    </Flex>
                  ))}
                </Flex>
              )}
            </AppCard>

            {/* Settings */}
            <AppCard title="Settings" style={{ marginTop: 16 }}>
              <Flex vertical gap={16}>
                <Flex align="center" justify="space-between">
                  <Text>LeakSanitizer</Text>
                  <Switch checked={wsStore.lsanEnabled} onChange={wsStore.setLsanEnabled} />
                </Flex>
                <Flex vertical gap={4}>
                  <Text type="secondary" style={{ fontSize: 12 }}>Source</Text>
                  <Tag>{ws.source || 'filesystem'}</Tag>
                </Flex>
                <Flex vertical gap={4}>
                  <Text type="secondary" style={{ fontSize: 12 }}>Created</Text>
                  <Text style={{ fontSize: 13 }}>{ws.createdAt ? new Date(ws.createdAt).toLocaleString() : 'n/a'}</Text>
                </Flex>
              </Flex>
            </AppCard>
          </Col>

          {/* Right: Scan Config */}
          <Col xs={24} lg={10}>
            <AppCard title="Scan Configuration">
              <Form layout="vertical">
                <Flex vertical gap={16}>
                  <div>
                    <Text strong style={{ fontSize: 13 }}>Target path</Text>
                    <Text code style={{ display: 'block', padding: '6px 11px', background: '#f5f5f5', borderRadius: 6, marginTop: 4 }}>
                      {consoleState.customPath.trim() || selectedWorkspacePath || '(not set)'}
                    </Text>
                  </div>

                  <Form.Item label="Path override" style={{ marginBottom: 0 }}>
                    <Input
                      placeholder="/workspace/project"
                      value={consoleState.customPath}
                      onChange={(e) => consoleState.setCustomPath(e.target.value)}
                    />
                  </Form.Item>

                  <Divider style={{ margin: '4px 0' }} />

                  <Form.Item label="Analysis mode" style={{ marginBottom: 0 }}>
                    <Select
                      value={consoleState.analysisMode}
                      onChange={consoleState.setAnalysisMode}
                      options={[
                        { value: 'no_llm', label: 'No LLM' },
                        { value: 'llm_assisted', label: 'LLM-assisted' },
                      ]}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>

                  <Form.Item label="Dynamic mode" style={{ marginBottom: 0 }}>
                    <Select
                      value={consoleState.dynamicMode}
                      onChange={consoleState.setDynamicMode}
                      options={[
                        { value: 'off', label: 'Off' },
                        { value: 'selective', label: 'Selective' },
                        { value: 'aggressive', label: 'Aggressive' },
                      ]}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>

                  <Collapse
                    size="small"
                    items={[{
                      key: 'advanced',
                      label: 'Advanced options',
                      children: (
                        <Flex vertical gap={12}>
                          <Form.Item label="File limit" style={{ marginBottom: 0 }}>
                            <InputNumber min={1} max={200000}
                              value={Number(consoleState.fileLimit)}
                              onChange={(v) => consoleState.setFileLimit(String(v ?? 500))}
                              style={{ width: '100%' }}
                            />
                          </Form.Item>
                          <Form.Item label="Runner" style={{ marginBottom: 0 }}>
                            <Select
                              value={consoleState.dynamicToolPreference}
                              onChange={consoleState.setDynamicToolPreference}
                              options={[
                                { value: 'auto', label: 'Auto' },
                                { value: 'valgrind', label: 'Valgrind' },
                                { value: 'lsan', label: 'LSan' },
                                { value: 'asan', label: 'ASan' },
                              ]}
                              style={{ width: '100%' }}
                            />
                          </Form.Item>
                          <Form.Item label="Timeout (sec)" style={{ marginBottom: 0 }}>
                            <InputNumber min={1} max={7200}
                              value={Number(consoleState.dynamicTimeoutSec)}
                              onChange={(v) => consoleState.setDynamicTimeoutSec(String(v ?? 120))}
                              style={{ width: '100%' }}
                            />
                          </Form.Item>
                          <Form.Item label="Build command"
                            extra={wsStore.selectedRepoId && buildDetectResult ? `Detected: ${buildDetectResult}` : null}
                            style={{ marginBottom: 0 }}
                          >
                            <Flex vertical gap={4}>
                              <Input
                                placeholder="make CC=clang"
                                value={consoleState.buildCommand}
                                onChange={(e) => consoleState.setBuildCommand(e.target.value)}
                              />
                              {wsStore.selectedRepoId && (
                                <BuildDetectButton
                                  loading={buildDetectLoading}
                                  onDetect={handleDetectBuild}
                                  detectedCommand={wsStore.selectedRepoId && !consoleState.buildCommand ? buildDetectResult : null}
                                  onApply={() => { if (buildDetectResult) consoleState.setBuildCommand(buildDetectResult); setBuildDetectResult(null); }}
                                />
                              )}
                            </Flex>
                          </Form.Item>
                          <Form.Item label="Executable hint" style={{ marginBottom: 0 }}>
                            <Input placeholder="/workspace/project/build/bin/app"
                              value={consoleState.dynamicBinaryPath}
                              onChange={(e) => consoleState.setDynamicBinaryPath(e.target.value)}
                            />
                          </Form.Item>
                          <Form.Item label="Executable args" style={{ marginBottom: 0 }}>
                            <Input placeholder="--input corpus.txt"
                              value={consoleState.dynamicArgs}
                              onChange={(e) => consoleState.setDynamicArgs(e.target.value)}
                            />
                          </Form.Item>
                          <Form.Item label="External run IDs" extra="Comma-separated" style={{ marginBottom: 0 }}>
                            <Input placeholder="run-1, run-2"
                              value={consoleState.dynamicRunIds}
                              onChange={(e) => consoleState.setDynamicRunIds(e.target.value)}
                            />
                          </Form.Item>
                        </Flex>
                      ),
                    }]}
                  />

                  <Flex gap={8} justify="end">
                    <Button onClick={() => navigate('/activity')}>Open Activity</Button>
                    <Button type="primary" icon={<Play size={14} />} onClick={handleStartScan} disabled={!canStartScan}>
                      Start Scan
                    </Button>
                  </Flex>
                </Flex>
              </Form>
            </AppCard>
          </Col>
        </Row>
      </Flex>

      <AddRepoModal
        open={addRepoOpen}
        workspaceId={workspaceId!}
        onClose={() => setAddRepoOpen(false)}
      />
    </div>
  );
}
