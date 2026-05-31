import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Play, Sparkles, Check,
} from 'lucide-react';
import {
  Button, Flex, Tag, Typography, Space, Spin, Divider, Select,
  InputNumber, Input, Collapse, Form, Switch, Alert, Tooltip,
} from 'antd';
import { AppCard } from '@/components/ui';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useConsoleContext } from '@/layouts/AppLayout';

const { Text, Title } = Typography;

export function ScanConfigPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const navigate = useNavigate();
  const wsStore = useWorkspaceStore();
  const consoleState = useConsoleContext();

  useEffect(() => {
    if (workspaceId) wsStore.loadWorkspace(workspaceId);
  }, [workspaceId]);

  useEffect(() => {
    consoleState.checkRuntimePreflight();
  }, []);

  const ws = wsStore.currentWorkspace;
  const repos = wsStore.currentWorkspaceRepos;
  const selectedRepo = repos.find((r) => r.repo_id === wsStore.selectedRepoId);
  const selectedWorkspacePath = ws?.path || '';
  const blockingPreflightChecks = (consoleState.runtimePreflight?.checks || []).filter(
    (check) => check.status === 'failed' && !String(check.detail).includes('optional'),
  );
  const canStartScan = !consoleState.activeScan
    && Boolean(selectedWorkspacePath || consoleState.customPath.trim())
    && blockingPreflightChecks.length === 0;

  // ── Handlers ──

  async function handleAnalyzeWithLLM() {
    if (!workspaceId || !wsStore.selectedRepoId) return;
    await wsStore.analyzeWithLLM(workspaceId, wsStore.selectedRepoId);
  }

  async function handleStartScan() {
    if (workspaceId && wsStore.selectedRepoId) {
      const repo = repos.find((r) => r.repo_id === wsStore.selectedRepoId);
      // Ensure the repo is cloned before scanning, and SURFACE clone failures
      // (previously swallowed) instead of proceeding to a guaranteed 400.
      // Do NOT funnel local_clone_path through customPath — that would flip the
      // scan into "custom path" mode and drop repoId/workspaceId from the payload,
      // leaving the backend unable to resolve the repo. The backend resolves the
      // clone path from repoId+workspaceId directly.
      if (repo && !repo.local_clone_path) {
        try {
          await wsStore.cloneRepo(workspaceId, wsStore.selectedRepoId!);
        } catch (err) {
          consoleState.showError({
            error: 'Failed to clone the repository before scanning.',
            remediation: String((err as Error)?.message || err),
          });
          return;
        }
      }
    }

    const result = await consoleState.startScan();
    if (result) navigate(`/activity/${result.scanId}`);
  }

  // ── Loading state ──
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
          <Button
            icon={<ArrowLeft size={16} />}
            onClick={() => navigate(`/workspace/${workspaceId}`)}
          >
            Back to repositories
          </Button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Title level={4} style={{ margin: 0 }}>Scan Configuration</Title>
            <Text type="secondary" style={{ fontSize: 13 }}>{ws.name}</Text>
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
          </Space>
        </Flex>

        {/* Selected repo indicator */}
        {selectedRepo && (
          <AppCard size="small" bodyGap={8}>
            <Flex align="center" gap={12} wrap>
              <Text strong style={{ fontSize: 13 }}>Selected repository:</Text>
              <Text>{selectedRepo.repo_full_name || selectedRepo.repo_id}</Text>
              {selectedRepo.local_clone_path ? (
                <Tag color="success" style={{ fontSize: 11 }}>Cloned</Tag>
              ) : (
                <Tag style={{ fontSize: 11 }}>Pending</Tag>
              )}
              <Text type="secondary" style={{ fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {selectedRepo.local_clone_path || selectedRepo.clone_url || ''}
              </Text>
              <Button
                size="small"
                onClick={() => navigate(`/workspace/${workspaceId}`)}
              >
                Change Repository
              </Button>
            </Flex>
          </AppCard>
        )}

        <AppCard title="Runtime Preflight" size="small">
          <Flex vertical gap={12}>
            {consoleState.runtimePreflightLoading ? (
              <Flex align="center" gap={8}>
                <Spin size="small" />
                <Text type="secondary">Checking scan stack availability...</Text>
              </Flex>
            ) : consoleState.runtimePreflight ? (
              <>
                <Alert
                  type={consoleState.runtimePreflight.ok ? 'success' : 'warning'}
                  showIcon
                  message={consoleState.runtimePreflight.ok
                    ? 'Scan stack looks reachable'
                    : 'Some required runtime dependencies are not reachable'}
                  description={consoleState.runtimePreflight.ok
                    ? `Checked at ${new Date(consoleState.runtimePreflight.checkedAt).toLocaleString()}`
                    : 'Resolve the failed checks below before starting a scan.'}
                />
                <Flex vertical gap={8}>
                  {consoleState.runtimePreflight.checks.map((check) => (
                    <Flex key={check.name} align="center" justify="space-between" gap={12} wrap>
                      <Flex vertical style={{ minWidth: 0, flex: 1 }}>
                        <Text strong style={{ fontSize: 13 }}>{check.name}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>{check.detail}</Text>
                      </Flex>
                      <Tag color={check.status === 'ok' ? 'success' : 'error'}>
                        {check.status}
                      </Tag>
                    </Flex>
                  ))}
                </Flex>
                <Flex>
                  <Button size="small" onClick={() => consoleState.checkRuntimePreflight()}>
                    Refresh Preflight
                  </Button>
                </Flex>
              </>
            ) : (
              <Alert
                type="info"
                showIcon
                message="Runtime preflight has not been loaded yet."
              />
            )}
          </Flex>
        </AppCard>

        <Flex vertical gap={16}>
          {/* LLM Project Analysis */}
          <AppCard title="LLM Project Analysis">
            <Flex vertical gap={12}>
              <Text type="secondary" style={{ fontSize: 13 }}>
                Use AI to detect the programming language, build command, and LSan compatibility of this repository.
              </Text>

              <Flex gap={12} align="center" wrap>
                <Button
                  icon={<Sparkles size={14} />}
                  onClick={handleAnalyzeWithLLM}
                  loading={wsStore.llmAnalysisLoading}
                >
                  Analyze with LLM
                </Button>

                {wsStore.llmAnalysisResult && (
                  <Button
                    size="small"
                    icon={<Check size={12} />}
                    onClick={wsStore.resetLlmAnalysis}
                    type="text"
                  >
                    Clear result
                  </Button>
                )}
              </Flex>

              {/* Loading progress */}
              {wsStore.llmAnalysisLoading && (
                <Flex vertical gap={8}>
                  <Flex align="center" gap={8}>
                    <Spin size="small" />
                    <Text type="secondary">{wsStore.llmAnalysisProgress || 'Analyzing...'}</Text>
                  </Flex>
                  {wsStore.llmFilesExamined.length > 0 && (
                    <Flex wrap gap={4}>
                      {wsStore.llmFilesExamined.map((f) => (
                        <Tag key={f} style={{ fontSize: 10 }}>{f}</Tag>
                      ))}
                    </Flex>
                  )}
                </Flex>
              )}

              {/* Error */}
              {wsStore.llmAnalysisError && (
                <Alert
                  type="error"
                  message={wsStore.llmAnalysisError}
                  closable
                  onClose={wsStore.resetLlmAnalysis}
                  showIcon
                />
              )}

              {/* Results */}
              {wsStore.llmAnalysisResult && (
                <Flex vertical gap={12} style={{
                  background: '#f8f9fa',
                  borderRadius: 12,
                  padding: 16,
                  border: '1px solid #f0f0f0',
                }}>
                  {/* Languages */}
                  <div>
                    <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                      Detected Languages
                    </Text>
                    <Space size={4} wrap>
                      {wsStore.llmAnalysisResult.languages.map((lang) => (
                        <Tag key={lang} color="blue">{lang}</Tag>
                      ))}
                    </Space>
                  </div>

                  {/* Build command */}
                  <div>
                    <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                      Suggested Build Command
                    </Text>
                    <Flex gap={8} align="center" wrap>
                      <Text code style={{ padding: '4px 10px', background: '#fff', borderRadius: 6 }}>
                        {wsStore.llmAnalysisResult.buildCommand}
                      </Text>
                      <Tooltip title="Apply this build command to the scan configuration">
                        <Button
                          size="small"
                          icon={<Check size={12} />}
                          onClick={() => consoleState.setBuildCommand(wsStore.llmAnalysisResult!.buildCommand)}
                        >
                          Apply
                        </Button>
                      </Tooltip>
                    </Flex>
                  </div>

                  {/* LSan support */}
                  <div>
                    <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                      LeakSanitizer Compatibility
                    </Text>
                    <Flex gap={8} align="center" wrap>
                      <Tag color={wsStore.llmAnalysisResult.lsanSupported ? 'green' : 'red'}>
                        {wsStore.llmAnalysisResult.lsanSupported ? 'Supported' : 'Not Supported'}
                      </Tag>
                      {wsStore.llmAnalysisResult.lsanNote && (
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {wsStore.llmAnalysisResult.lsanNote}
                        </Text>
                      )}
                    </Flex>
                  </div>

                  {/* Files examined */}
                  {wsStore.llmAnalysisResult.filesExamined && wsStore.llmAnalysisResult.filesExamined.length > 0 && (
                    <div>
                      <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                        Files Examined
                      </Text>
                      <Flex wrap gap={4}>
                        {wsStore.llmAnalysisResult.filesExamined.map((f) => (
                          <Tag key={f} style={{ fontSize: 10 }}>{f}</Tag>
                        ))}
                      </Flex>
                    </div>
                  )}

                  {/* Thinking trace */}
                  {wsStore.llmAnalysisResult.thinkingTrace && (
                    <div>
                      <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                        Analysis Reasoning
                      </Text>
                      <Text type="secondary" style={{
                        fontSize: 11, whiteSpace: 'pre-wrap', display: 'block',
                        background: '#fff', padding: 8, borderRadius: 6,
                        maxHeight: 200, overflow: 'auto',
                      }}>
                        {wsStore.llmAnalysisResult.thinkingTrace}
                      </Text>
                    </div>
                  )}
                </Flex>
              )}
            </Flex>
          </AppCard>

          {/* Scan Configuration */}
          <AppCard title="Scan Configuration">
            <Form layout="vertical">
              <Flex vertical gap={16}>
                {/* Target path */}
                <div>
                  <Text strong style={{ fontSize: 13 }}>Target path</Text>
                  <Text code style={{
                    display: 'block', padding: '6px 11px', background: '#f5f5f5',
                    borderRadius: 6, marginTop: 4,
                  }}>
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

                {/* LSan Toggle with LLM info */}
                <Flex vertical gap={4}>
                  <Flex align="center" justify="space-between">
                    <Flex align="center" gap={8}>
                      <Text>LeakSanitizer</Text>
                      {wsStore.llmAnalysisResult && (
                        <Tag color={wsStore.llmAnalysisResult.lsanSupported ? 'green' : 'red'} style={{ fontSize: 10 }}>
                          {wsStore.llmAnalysisResult.lsanSupported ? 'Compatible' : 'Incompatible'}
                        </Tag>
                      )}
                    </Flex>
                    <Switch checked={wsStore.lsanEnabled} onChange={wsStore.setLsanEnabled} />
                  </Flex>
                  {wsStore.llmAnalysisResult?.lsanNote && (
                    <Text type="secondary" style={{ fontSize: 11, marginTop: 2 }}>
                      {wsStore.llmAnalysisResult.lsanNote}
                    </Text>
                  )}
                </Flex>

                <Divider style={{ margin: '4px 0' }} />

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
                        <Form.Item label="Build command" style={{ marginBottom: 0 }}>
                          <Flex vertical gap={4}>
                            <Input
                              placeholder="make CC=clang"
                              value={consoleState.buildCommand}
                              onChange={(e) => consoleState.setBuildCommand(e.target.value)}
                            />
                            {wsStore.llmAnalysisResult && !consoleState.buildCommand && (
                              <Button
                                size="small"
                                type="link"
                                style={{ padding: 0, fontSize: 12 }}
                                onClick={() => consoleState.setBuildCommand(wsStore.llmAnalysisResult!.buildCommand)}
                              >
                                Apply detected: {wsStore.llmAnalysisResult.buildCommand}
                              </Button>
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
        </Flex>
      </Flex>
    </div>
  );
}
