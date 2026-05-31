import { create } from 'zustand';
import type { RuntimePreflightReport, ScanSummary, ScanDetail, ScanEvent, ScanPayload, ScanResponse, StructuredReport } from '@/types';
import {
  cancelScanRequest,
  createScan,
  deleteScanRequest,
  fetchRuntimePreflight,
  fetchScan,
  fetchScanEvents,
  fetchScanReport,
  fetchScanReportJson,
  fetchScans,
  fetchWorkspaces,
  purgeTerminalScansRequest,
} from '@/services/memoryLeakApi';
import { mapStructuredReport } from '@/components/report/reportAdapter';
import { useWorkspaceStore } from '@/stores/workspaceStore';

export const TERMINAL_STATES = ['completed', 'failed', 'cancelled'];

function formatFailure(payload: any): { text: string; hint: string } {
  if (!payload) return { text: '', hint: '' };
  if (typeof payload === 'string') return { text: payload, hint: '' };
  const code = payload.error_category || payload.error_code;
  const prefix = code ? `[${code}] ` : '';
  return {
    text: `${prefix}${payload.error || payload.message || 'Request failed'}`,
    hint: payload.remediation || '',
  };
}

let eventIds = new Set<string>();
let loadingScanId: string | null = null;

interface DeleteDialog {
  open: boolean;
  mode: 'single' | 'bulk';
  scan: ScanSummary | null;
  count: number;
}

interface ConsoleState {
  bootstrapped: boolean;
  bootstrapping: boolean;
  workspaces: any[];
  allowedRoots: string[];
  workspacePath: string;
  customPath: string;
  buildCommand: string;
  analysisMode: string;
  fileLimit: string;
  dynamicRunIds: string;
  dynamicMode: string;
  dynamicBinaryPath: string;
  dynamicArgs: string;
  dynamicTimeoutSec: string;
  dynamicToolPreference: string;
  recentScans: ScanSummary[];
  selectedScan: ScanDetail | null;
  events: ScanEvent[];
  reportData: StructuredReport | null;
  reportText: string;
  errorBanner: { text: string; hint: string };
  runtimePreflight: RuntimePreflightReport | null;
  runtimePreflightLoading: boolean;
  loadingWorkspaces: boolean;
  loadingScan: boolean;
  deleteDialog: DeleteDialog;
  deletingScans: boolean;
}

interface ConsoleActions {
  setWorkspacePath: (v: string) => void;
  setCustomPath: (v: string) => void;
  setBuildCommand: (v: string) => void;
  setAnalysisMode: (v: string) => void;
  setFileLimit: (v: string) => void;
  setDynamicRunIds: (v: string) => void;
  setDynamicMode: (v: string) => void;
  setDynamicBinaryPath: (v: string) => void;
  setDynamicArgs: (v: string) => void;
  setDynamicTimeoutSec: (v: string) => void;
  setDynamicToolPreference: (v: string) => void;
  showError: (payload: any) => void;
  clearError: () => void;
  initialize: () => Promise<void>;
  loadRecentScans: () => Promise<ScanSummary[]>;
  checkRuntimePreflight: () => Promise<RuntimePreflightReport | null>;
  loadReport: (scanId: string, format?: string) => Promise<string | null>;
  loadStructuredReport: (scanId: string) => Promise<StructuredReport | null>;
  refreshStatus: (scanId: string) => Promise<ScanDetail | null>;
  loadEventHistory: (scanId: string) => Promise<ScanEvent[]>;
  openScan: (scanId: string, seed?: ScanDetail | null) => Promise<ScanDetail | null>;
  ensureScanLoaded: (scanId: string) => Promise<ScanDetail | null>;
  handleStreamEvent: (event: ScanEvent) => Promise<void>;
  startScan: () => Promise<ScanResponse | null>;
  cancelScan: () => Promise<any>;
  requestDeleteScan: (scan: ScanSummary) => void;
  requestDeleteTerminalScans: () => void;
  closeDeleteDialog: () => void;
  confirmDeleteDialog: () => Promise<any>;
}

export const useMemoryLeakConsoleStore = create<ConsoleState & ConsoleActions>((set, get) => ({
  bootstrapped: false,
  bootstrapping: false,
  workspaces: [],
  allowedRoots: [],
  workspacePath: '',
  customPath: '',
  buildCommand: '',
  analysisMode: 'llm_assisted',
  fileLimit: '500',
  dynamicRunIds: '',
  dynamicMode: 'selective',
  dynamicBinaryPath: '',
  dynamicArgs: '',
  dynamicTimeoutSec: '120',
  dynamicToolPreference: 'auto',
  recentScans: [],
  selectedScan: null,
  events: [],
  reportData: null,
  reportText: 'Run a scan to generate a report.',
  errorBanner: { text: '', hint: '' },
  runtimePreflight: null,
  runtimePreflightLoading: false,
  loadingWorkspaces: true,
  loadingScan: false,
  deleteDialog: { open: false, mode: 'single', scan: null, count: 0 },
  deletingScans: false,

  setWorkspacePath: (workspacePath) => set({ workspacePath }),
  setCustomPath: (customPath) => set({ customPath }),
  setBuildCommand: (buildCommand) => set({ buildCommand }),
  setAnalysisMode: (analysisMode) => set({ analysisMode }),
  setFileLimit: (fileLimit) => set({ fileLimit }),
  setDynamicRunIds: (dynamicRunIds) => set({ dynamicRunIds }),
  setDynamicMode: (dynamicMode) => set({ dynamicMode }),
  setDynamicBinaryPath: (dynamicBinaryPath) => set({ dynamicBinaryPath }),
  setDynamicArgs: (dynamicArgs) => set({ dynamicArgs }),
  setDynamicTimeoutSec: (dynamicTimeoutSec) => set({ dynamicTimeoutSec }),
  setDynamicToolPreference: (dynamicToolPreference) => set({ dynamicToolPreference }),

  showError: (payload) => set({ errorBanner: formatFailure(payload) }),
  clearError: () => set({ errorBanner: { text: '', hint: '' } }),

  initialize: async () => {
    if (get().bootstrapped || get().bootstrapping) return;
    set({ bootstrapping: true, loadingWorkspaces: true });
    try {
      const workspaceData = await fetchWorkspaces();
      const scansData = await fetchScans();
      set((state) => ({
        workspaces: workspaceData.workspaces || [],
        allowedRoots: workspaceData.allowed_roots || [],
        workspacePath: state.workspacePath || workspaceData.workspaces?.[0]?.path || '',
        recentScans: scansData.scans || [],
        loadingWorkspaces: false,
        bootstrapped: true,
        bootstrapping: false,
      }));
    } catch (error: any) {
      set({
        errorBanner: formatFailure(error.payload || error.message),
        loadingWorkspaces: false,
        bootstrapping: false,
      });
    }
  },

  loadRecentScans: async () => {
    const data = await fetchScans();
    set({ recentScans: data.scans || [] });
    return data.scans || [];
  },

  checkRuntimePreflight: async () => {
    set({ runtimePreflightLoading: true });
    try {
      const data = await fetchRuntimePreflight();
      set({ runtimePreflight: data, runtimePreflightLoading: false });
      return data;
    } catch (error: any) {
      set({ runtimePreflightLoading: false });
      get().showError(error.payload || error.message);
      return null;
    }
  },

  loadReport: async (scanId, format = 'markdown') => {
    if (!scanId) return null;
    get().clearError();
    try {
      const text = await fetchScanReport(scanId, format);
      set({ reportText: text });
      return text;
    } catch (error: any) {
      get().showError(error.message);
      return null;
    }
  },

  loadStructuredReport: async (scanId) => {
    if (!scanId) return null;
    get().clearError();
    try {
      const data = await fetchScanReportJson(scanId);
      set({ reportData: mapStructuredReport(data) as any });
      return data;
    } catch (error: any) {
      get().showError(error.payload || error.message);
      return null;
    }
  },

  refreshStatus: async (scanId) => {
    if (!scanId) return null;
    const data = await fetchScan(scanId);
    set({ selectedScan: data });
    if ((data as any).error) get().showError(data);
    return data;
  },

  loadEventHistory: async (scanId) => {
    if (!scanId) return [];
    const data = await fetchScanEvents(scanId);
    const loadedEvents = data.events || [];
    eventIds = new Set(loadedEvents.map((e) => e.eventId || e.event_id).filter(Boolean) as string[]);
    set({ events: loadedEvents });
    return loadedEvents;
  },

  openScan: async (scanId, seed = null) => {
    if (!scanId || loadingScanId === scanId) return null;
    loadingScanId = scanId;
    set({ loadingScan: true });
    try {
      const snapshot = seed || (await fetchScan(scanId));
      eventIds = new Set();
      set({ selectedScan: snapshot });
      await get().loadEventHistory(scanId);
      const refreshed = await get().refreshStatus(scanId);
      const effectiveScan = refreshed || snapshot;

      if (effectiveScan?.status === 'completed') {
        await get().loadStructuredReport(scanId);
        set({ reportText: 'Load Markdown, JSON, Snapshot, or HTML from the raw output tab when needed.' });
      } else {
        set({ reportData: null, reportText: 'Run a completed scan to inspect the report.' });
      }

      await get().loadRecentScans();
      return effectiveScan;
    } finally {
      if (loadingScanId === scanId) loadingScanId = null;
      set({ loadingScan: false });
    }
  },

  ensureScanLoaded: async (scanId) => {
    if (!scanId) return null;
    if (get().selectedScan?.scanId === scanId || loadingScanId === scanId) return get().selectedScan;
    const seed = get().recentScans.find((scan) => scan.scanId === scanId) || null;
    return get().openScan(scanId, seed);
  },

  handleStreamEvent: async (event) => {
    const eventId = event.eventId || event.event_id;
    if (!eventId || eventIds.has(eventId)) return;
    eventIds.add(eventId);
    set((state) => ({ events: [...state.events, event] }));
    const scanId = event.scanId || event.scan_id;
    if (scanId) await get().refreshStatus(scanId);
    if (TERMINAL_STATES.includes(event.type || '')) {
      await get().loadRecentScans();
      if (event.type === 'completed') {
        if (scanId) await get().loadStructuredReport(scanId);
        set({ reportText: 'Load Markdown, JSON, Snapshot, or HTML from the raw output tab when needed.' });
      } else {
        get().showError(event);
      }
    }
  },

  startScan: async () => {
    get().clearError();
    const state = get();
    const preflight = await get().checkRuntimePreflight();
    if (!preflight?.ok) {
      const blockingChecks = (preflight?.checks || []).filter(
        (check) => check.status === 'failed' && !String(check.detail).includes('optional'),
      );
      if (blockingChecks.length > 0) {
        get().showError({
          error: 'Runtime preflight failed. The scan stack is not ready.',
          remediation: blockingChecks.map((check) => `${check.name}: ${check.detail}`).join('\n'),
        });
        return null;
      }
    }

    const workspaceState = useWorkspaceStore.getState();
    const selectedRepo = workspaceState.currentWorkspaceRepos.find(
      (repo) => repo.repo_id === workspaceState.selectedRepoId,
    );
    const hasCustomPath = Boolean(state.customPath.trim());
    const inferredSourceType = hasCustomPath
      ? 'local_path'
      : selectedRepo?.clone_url
        ? 'github'
        : selectedRepo?.local_clone_path && workspaceState.currentWorkspace?.path &&
            selectedRepo.local_clone_path.startsWith(`${workspaceState.currentWorkspace.path}/`)
          ? 'upload_zip'
          : selectedRepo
            ? 'local_path'
            : 'workspace_path';
    const payload: Record<string, any> = {
      workspacePath: state.customPath.trim() || state.workspacePath,
      sourceType: inferredSourceType,
      fileLimit: Number(state.fileLimit || 500),
      analysisMode: state.analysisMode,
      buildCommand: state.buildCommand.trim() || null,
      dynamicMode: state.dynamicMode,
      dynamicBinaryPath: state.dynamicBinaryPath.trim() || null,
      dynamicArgs: state.dynamicArgs.trim() || null,
      dynamicTimeoutSec: state.dynamicTimeoutSec.trim() ? Number(state.dynamicTimeoutSec) : null,
      dynamicToolPreference: state.dynamicToolPreference === 'auto' ? null : state.dynamicToolPreference,
      dynamicRunIds: state.dynamicRunIds
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    };

    // Always send the identifiers when a repository is selected so the backend
    // resolves the authoritative clone path from the DB. (Previously these were
    // dropped whenever a customPath was set — which the repo flow always did —
    // leaving the backend unable to locate the repo → "source path must exist" 400.)
    if (workspaceState.selectedWorkspaceId && (workspaceState.selectedRepoId || !hasCustomPath)) {
      payload.workspaceId = workspaceState.selectedWorkspaceId;
    }

    if (workspaceState.selectedRepoId) {
      payload.repoId = workspaceState.selectedRepoId;
    }

    let data: ScanResponse;
    try {
      data = await createScan(payload);
    } catch (error: any) {
      if (error.status === 409 && error.payload?.existing_scan) {
        data = error.payload.existing_scan;
        get().showError(`Reusing active scan ${data.scanId} for this workspace.`);
      } else {
        get().showError(error.payload || error.message);
        return null;
      }
    }

    await get().openScan(data.scanId, data as ScanDetail);
    return data;
  },

  cancelScan: async () => {
    const scanId = get().selectedScan?.scanId;
    if (!scanId) return null;
    get().clearError();
    try {
      const response = await cancelScanRequest(scanId);
      await get().refreshStatus(scanId);
      await get().loadRecentScans();
      return response;
    } catch (error: any) {
      get().showError(error.payload || error.message);
      return null;
    }
  },

  requestDeleteScan: (scan) => {
    if (!scan) return;
    set({ deleteDialog: { open: true, mode: 'single', scan, count: 1 } });
  },

  requestDeleteTerminalScans: () => {
    const terminalScans = get().recentScans.filter((scan) => TERMINAL_STATES.includes(scan.status));
    if (!terminalScans.length) return;
    set({ deleteDialog: { open: true, mode: 'bulk', scan: null, count: terminalScans.length } });
  },

  closeDeleteDialog: () => {
    if (get().deletingScans) return;
    set({ deleteDialog: { open: false, mode: 'single', scan: null, count: 0 } });
  },

  confirmDeleteDialog: async () => {
    const { deleteDialog, selectedScan } = get();
    if (!deleteDialog.open) return null;
    get().clearError();
    set({ deletingScans: true });
    try {
      if (deleteDialog.mode === 'bulk') {
        const response = await purgeTerminalScansRequest();
        const deletedIds = new Set(response.deleted_scan_ids || []);
        set((state) => {
          const shouldClear = selectedScan && deletedIds.has(selectedScan.scanId);
          return {
            recentScans: state.recentScans.filter((s) => !deletedIds.has(s.scanId)),
            selectedScan: shouldClear ? null : state.selectedScan,
            events: shouldClear ? [] : state.events,
            reportData: shouldClear ? null : state.reportData,
            reportText: shouldClear ? 'Run a scan to generate a report.' : state.reportText,
          };
        });
        return response;
      }

      const scanId = deleteDialog.scan?.scanId;
      if (!scanId) return null;
      const response = await deleteScanRequest(scanId);
      set((state) => {
        const shouldClear = state.selectedScan?.scanId === scanId;
        return {
          recentScans: state.recentScans.filter((s) => s.scanId !== scanId),
          selectedScan: shouldClear ? null : state.selectedScan,
          events: shouldClear ? [] : state.events,
          reportData: shouldClear ? null : state.reportData,
          reportText: shouldClear ? 'Run a scan to generate a report.' : state.reportText,
        };
      });
      return response;
    } catch (error: any) {
      get().showError(error.payload || error.message);
      return null;
    } finally {
      set({
        deletingScans: false,
        deleteDialog: { open: false, mode: 'single', scan: null, count: 0 },
      });
    }
  },
}));
