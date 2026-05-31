import { create } from 'zustand';
import type { Workspace, WorkspaceDetail, Repo, GitHubUser, GitHubRepo, Branch, LlmAnalysisResult } from '@/types';
import {
  addRepoByPath,
  addRepository,
  cloneRepository,
  createWorkspace,
  deleteRepository,
  deleteWorkspace,
  detectBuildCommand,
  disconnectGitHub,
  fetchGitHubAuthUrl,
  fetchGitHubBranches,
  fetchGitHubCachedRepos,
  fetchGitHubPrivateRepoAuthUrl,
  fetchGitHubRepos,
  fetchGitHubStatus,
  fetchWorkspace as fetchWorkspaceApi,
  fetchWorkspaces,
  updateWorkspaceSettings,
  uploadRepoZip,
} from '@/services/memoryLeakApi';

interface WorkspaceState {
  githubConnected: boolean;
  githubUser: GitHubUser | null;
  githubScope: string;
  githubRepos: GitHubRepo[];
  githubBranches: Branch[];
  loadingGitHubStatus: boolean;
  loadingGitHubRepos: boolean;
  workspaces: Workspace[];
  currentWorkspace: WorkspaceDetail | null;
  currentWorkspaceRepos: Repo[];
  selectedWorkspaceId: string | null;
  selectedRepoId: string | null;
  selectedBranch: string;
  lsanEnabled: boolean;
  llmAnalysisLoading: boolean;
  llmAnalysisResult: LlmAnalysisResult | null;
  llmAnalysisProgress: string;
  llmAnalysisError: string | null;
  llmFilesExamined: string[];
}

interface WorkspaceActions {
  initializeFromServer: () => Promise<void>;
  checkGitHubStatus: () => Promise<void>;
  connectGitHub: () => Promise<void>;
  disconnectGitHub: () => Promise<void>;
  loadGitHubRepos: (type?: string) => Promise<GitHubRepo[]>;
  loadCachedGitHubRepos: () => Promise<{ repos: GitHubRepo[]; scope: string }>;
  requestPrivateRepoAccess: (repoFullName: string) => Promise<void>;
  refreshGitHubRepos: () => Promise<GitHubRepo[]>;
  loadGitHubBranches: (owner: string, name: string) => Promise<Branch[]>;
  createWorkspace: (payload: Record<string, any>) => Promise<Workspace>;
  loadWorkspace: (workspaceId: string) => Promise<void>;
  selectRepo: (repoId: string | null) => void;
  selectBranch: (branch: string) => void;
  setLsanEnabled: (enabled: boolean) => void;
  addRepo: (workspaceId: string, repoData: Record<string, any>) => Promise<Repo>;
  addRepoByPath: (workspaceId: string, path: string, name?: string) => Promise<any>;
  cloneRepo: (workspaceId: string, repoId: string) => Promise<any>;
  addRepoFromZip: (workspaceId: string, file: File) => Promise<any>;
  detectBuild: (workspaceId: string, repoId: string) => Promise<string | null>;
  removeRepo: (workspaceId: string, repoId: string) => Promise<void>;
  deleteWorkspace: (workspaceId: string) => Promise<void>;
  analyzeWithLLM: (workspaceId: string, repoId: string) => Promise<LlmAnalysisResult | null>;
  resetLlmAnalysis: () => void;
}

export const useWorkspaceStore = create<WorkspaceState & WorkspaceActions>((set, get) => ({
  githubConnected: false,
  githubUser: null,
  githubScope: '',
  githubRepos: [],
  githubBranches: [],
  loadingGitHubStatus: false,
  loadingGitHubRepos: false,
  workspaces: [],
  currentWorkspace: null,
  currentWorkspaceRepos: [],
  selectedWorkspaceId: null,
  selectedRepoId: null,
  selectedBranch: 'main',
  lsanEnabled: false,
  llmAnalysisLoading: false,
  llmAnalysisResult: null,
  llmAnalysisProgress: '',
  llmAnalysisError: null,
  llmFilesExamined: [],

  initializeFromServer: async () => {
    try {
      const data = await fetchWorkspaces();
      set({ workspaces: data.workspaces || [] });
    } catch {
      // non-critical
    }
    await get().checkGitHubStatus();
  },

  checkGitHubStatus: async () => {
    set({ loadingGitHubStatus: true });
    try {
      const data = await fetchGitHubStatus();
      set({
        githubConnected: data.connected || false,
        githubUser: data.user || null,
        loadingGitHubStatus: false,
      });
    } catch {
      set({ githubConnected: false, githubUser: null, loadingGitHubStatus: false });
    }
  },

  connectGitHub: async () => {
    try {
      const data = await fetchGitHubAuthUrl();
      if (data.authorization_url) {
        window.location.href = data.authorization_url;
      }
    } catch (error: any) {
      throw new Error(error.message || 'Failed to start GitHub OAuth');
    }
  },

  disconnectGitHub: async () => {
    await disconnectGitHub();
    set({ githubConnected: false, githubUser: null, githubRepos: [] });
  },

  loadGitHubRepos: async (type = 'all') => {
    set({ loadingGitHubRepos: true });
    try {
      const data = await fetchGitHubRepos(type);
      set({ githubRepos: data.repos || [], loadingGitHubRepos: false });
      return data.repos || [];
    } catch {
      set({ loadingGitHubRepos: false });
      return [];
    }
  },

  loadCachedGitHubRepos: async () => {
    try {
      const data = await fetchGitHubCachedRepos();
      set({ githubRepos: data.repos || [], githubScope: data.scope || '' });
      return data;
    } catch {
      return { repos: [], scope: '' };
    }
  },

  requestPrivateRepoAccess: async (repoFullName) => {
    try {
      const data = await fetchGitHubPrivateRepoAuthUrl(repoFullName);
      if (data.authorization_url) {
        window.location.href = data.authorization_url;
      }
    } catch (err: any) {
      throw new Error(err.message || 'Failed to request private repo access');
    }
  },

  refreshGitHubRepos: async () => {
    set({ loadingGitHubRepos: true });
    try {
      const data = await fetchGitHubRepos('all', true);
      set({ githubRepos: data.repos || [], loadingGitHubRepos: false });
      return data.repos || [];
    } catch {
      set({ loadingGitHubRepos: false });
      return [];
    }
  },

  loadGitHubBranches: async (owner, name) => {
    try {
      const data = await fetchGitHubBranches(owner, name);
      set({ githubBranches: data.branches || [] });
      return data.branches || [];
    } catch {
      set({ githubBranches: [] });
      return [];
    }
  },

  createWorkspace: async (payload) => {
    const workspace = await createWorkspace(payload);
    await get().initializeFromServer();
    return workspace;
  },

  loadWorkspace: async (workspaceId) => {
    if (!workspaceId) {
      set({ currentWorkspace: null, currentWorkspaceRepos: [], selectedWorkspaceId: null });
      return;
    }
    try {
      const ws = await fetchWorkspaceApi(workspaceId);
      set({
        currentWorkspace: ws,
        currentWorkspaceRepos: ws.repos || [],
        selectedWorkspaceId: workspaceId,
        selectedRepoId: ws.repos?.[0]?.repo_id || null,
        lsanEnabled: ws.settings?.lsanEnabled || false,
      });
    } catch {
      set({ currentWorkspace: null, currentWorkspaceRepos: [] });
    }
  },

  selectRepo: (repoId) => set({ selectedRepoId: repoId }),
  selectBranch: (branch) => set({ selectedBranch: branch }),

  setLsanEnabled: (lsanEnabled) => {
    set({ lsanEnabled });
    const wsId = get().selectedWorkspaceId;
    if (wsId) {
      updateWorkspaceSettings(wsId, { lsanEnabled }).catch(() => {});
    }
  },

  addRepo: async (workspaceId, repoData) => {
    const repo = await addRepository(workspaceId, repoData);
    await get().loadWorkspace(workspaceId);
    return repo;
  },

  addRepoByPath: async (workspaceId, path, name) => {
    const result = await addRepoByPath(workspaceId, path, name);
    await get().loadWorkspace(workspaceId);
    return result;
  },

  cloneRepo: async (workspaceId, repoId) => {
    const result = await cloneRepository(workspaceId, repoId);
    await get().loadWorkspace(workspaceId);
    return result;
  },

  addRepoFromZip: async (workspaceId, file) => {
    const result = await uploadRepoZip(workspaceId, file);
    await get().loadWorkspace(workspaceId);
    return result;
  },

  detectBuild: async (workspaceId, repoId) => {
    const result = await detectBuildCommand(workspaceId, repoId);
    if (result.command) return result.command;
    return null;
  },

  removeRepo: async (workspaceId, repoId) => {
    await deleteRepository(workspaceId, repoId);
    await get().loadWorkspace(workspaceId);
  },

  deleteWorkspace: async (workspaceId) => {
    await deleteWorkspace(workspaceId);
    set({ currentWorkspace: null, currentWorkspaceRepos: [], selectedWorkspaceId: null });
    await get().initializeFromServer();
  },

  analyzeWithLLM: async (workspaceId, repoId) => {
    set({
      llmAnalysisLoading: true,
      llmAnalysisResult: null,
      llmAnalysisProgress: 'Scanning repository files...',
      llmAnalysisError: null,
    });

    try {
      const token = localStorage.getItem('auth_token');
      const url = `/api/workspaces/${workspaceId}/repos/${repoId}/llm-analyze`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
        },
      });

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmed.slice(6));

              if (data.event === 'scanning_files') {
                set({ llmAnalysisProgress: data.message });
              } else if (data.event === 'analyzing_with_llm') {
                set({ llmAnalysisProgress: data.message });
              } else if (data.event === 'reading_file') {
                set((state) => ({
                  llmAnalysisProgress: data.message,
                  llmFilesExamined: [...state.llmFilesExamined, data.data?.file].filter(Boolean),
                }));
              } else if (data.event === 'tool_call') {
                set({ llmAnalysisProgress: data.message });
              } else if (data.event === 'thinking') {
                set({ llmAnalysisProgress: data.message || 'Model is analyzing...' });
              } else if (data.event === 'complete' && data.data) {
                set({
                  llmAnalysisResult: data.data,
                  llmAnalysisLoading: false,
                  llmAnalysisProgress: 'Analysis complete',
                });
                return data.data as LlmAnalysisResult;
              } else if (data.event === 'error') {
                throw new Error(data.message || 'LLM analysis failed');
              }
            } catch (e) {
              if (e instanceof SyntaxError) continue;
              throw e;
            }
          }
        }
      }

      set({ llmAnalysisLoading: false });
      return null;
    } catch (err: any) {
      set({
        llmAnalysisLoading: false,
        llmAnalysisError: err.message || 'LLM analysis failed',
        llmAnalysisProgress: '',
      });
      return null;
    }
  },

  resetLlmAnalysis: () => set({
    llmAnalysisLoading: false,
    llmAnalysisResult: null,
    llmAnalysisProgress: '',
    llmAnalysisError: null,
    llmFilesExamined: [],
  }),
}));
