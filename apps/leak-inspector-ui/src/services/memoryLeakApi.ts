import type {
  ScanListResponse,
  ScanDetail,
  ScanEvent,
  ScanResponse,
  StructuredReport,
  RuntimePreflightReport,
  Workspace,
  WorkspaceDetail,
  GitHubStatusResponse,
  GitHubRepo,
  Branch,
  Repo,
} from '@/types';

async function parseError(response: Response): Promise<Record<string, any>> {
  try {
    return await response.json();
  } catch {
    return { error: await response.text() };
  }
}

function getToken(): string | null {
  try {
    // Inline access to avoid circular dep — Zustand store is a module singleton
    const raw = localStorage.getItem('auth_token');
    return raw;
  } catch {
    return null;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const response = await fetch(path, {
    ...options,
    headers: { ...headers, ...(options.headers as Record<string, string>) },
  });
  if (!response.ok) {
    const payload = await parseError(response);
    const error = new Error(payload.error || `HTTP ${response.status}`) as any;
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return response.json();
}

// ── Scans ──

export function fetchWorkspaces(): Promise<{ workspaces: Workspace[]; allowed_roots?: string[] }> {
  return api('/api/workspaces');
}

export function fetchScans(): Promise<ScanListResponse> {
  return api('/api/scans');
}

export function fetchScan(scanId: string): Promise<ScanDetail> {
  return api(`/api/scans/${scanId}`);
}

export function fetchScanEvents(scanId: string): Promise<{ events: ScanEvent[] }> {
  return api(`/api/scans/${scanId}/events/history`);
}

export function fetchScanReport(scanId: string, format = 'markdown'): Promise<string> {
  return fetch(`/api/scans/${scanId}/report?format=${format}`).then((res) => {
    if (!res.ok) throw new Error(res.statusText);
    return res.text();
  });
}

export function fetchScanReportJson(scanId: string): Promise<StructuredReport> {
  return api(`/api/scans/${scanId}/report?format=json`);
}

export function createScan(payload: Record<string, any>): Promise<ScanResponse> {
  return api('/api/scans', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchRuntimePreflight(): Promise<RuntimePreflightReport> {
  return api('/api/runtime/preflight');
}

export function cancelScanRequest(scanId: string): Promise<{ success: boolean }> {
  return api(`/api/scans/${scanId}/cancel`, {
    method: 'POST',
    body: '{}',
  });
}

export function deleteScanRequest(scanId: string): Promise<{ success: boolean }> {
  return api(`/api/scans/${scanId}`, {
    method: 'DELETE',
  });
}

export function purgeTerminalScansRequest(): Promise<{ deleted_scan_ids: string[] }> {
  return api('/api/scans/purge-terminal', {
    method: 'POST',
    body: '{}',
  });
}

// ── GitHub ──

export function fetchGitHubAuthUrl(scope?: string): Promise<{ authorization_url: string }> {
  const params = scope ? `?scope=${encodeURIComponent(scope)}` : '';
  return api(`/api/github/auth-url${params}`);
}

export function fetchGitHubStatus(): Promise<GitHubStatusResponse> {
  return api('/api/github/status');
}

export function fetchGitHubRepos(type = 'all', refresh = false): Promise<{ repos: GitHubRepo[]; cached?: boolean }> {
  return api(`/api/github/repos?type=${type}&refresh=${refresh}`);
}

export function fetchGitHubCachedRepos(): Promise<{ repos: GitHubRepo[]; scope: string }> {
  return api('/api/github/repos/cached');
}

export function fetchGitHubPrivateRepoAuthUrl(repoFullName: string): Promise<{ authorization_url: string }> {
  return api(`/api/github/auth-url/private-repo?repo=${encodeURIComponent(repoFullName)}`);
}

export function fetchGitHubBranches(owner: string, name: string): Promise<{ branches: Branch[] }> {
  return api(`/api/github/repos/${owner}/${name}/branches`);
}

export function disconnectGitHub(): Promise<{ success: boolean }> {
  return api('/api/github/disconnect', { method: 'POST', body: '{}' });
}

// ── Workspace ──

export function createWorkspace(payload: Record<string, any>): Promise<Workspace> {
  return api('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchWorkspace(workspaceId: string): Promise<WorkspaceDetail> {
  return api(`/api/workspaces/${workspaceId}`);
}

export function deleteWorkspace(workspaceId: string): Promise<{ success: boolean }> {
  return api(`/api/workspaces/${workspaceId}`, {
    method: 'DELETE',
  });
}

export function updateWorkspaceSettings(workspaceId: string, payload: Record<string, any>): Promise<any> {
  return api(`/api/workspaces/${workspaceId}/settings`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ── Repo ──

export function addRepository(workspaceId: string, payload: Record<string, any>): Promise<Repo> {
  return api(`/api/workspaces/${workspaceId}/repos`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function cloneRepository(workspaceId: string, repoId: string): Promise<any> {
  return api(`/api/workspaces/${workspaceId}/repos/${repoId}/clone`, {
    method: 'POST',
    body: '{}',
  });
}

export function detectBuildCommand(workspaceId: string, repoId: string): Promise<{ command: string }> {
  return api(`/api/workspaces/${workspaceId}/repos/${repoId}/detect-build`, {
    method: 'POST',
    body: '{}',
  });
}

export function addRepoByPath(workspaceId: string, path: string, name?: string): Promise<any> {
  return api(`/api/workspaces/${workspaceId}/repos`, {
    method: 'POST',
    body: JSON.stringify({ path, repo_full_name: name }),
  });
}

export function deleteRepository(workspaceId: string, repoId: string): Promise<{ success: boolean }> {
  return api(`/api/workspaces/${workspaceId}/repos/${repoId}`, {
    method: 'DELETE',
  });
}

export function uploadRepoZip(workspaceId: string, file: File): Promise<{ repo_id: string; repo_full_name: string; local_clone_path: string }> {
  const formData = new FormData();
  formData.append('file', file);
  return fetch(`/api/workspaces/${workspaceId}/repos/upload-zip`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` },
    body: formData,
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.message || `HTTP ${res.status}`);
    }
    return res.json();
  });
}
