import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  getBezierPath,
  useReactFlow,
  useEdgesState,
  useNodesState,
  Handle,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button, Flex, Space, Tag, Typography, theme as antdTheme } from "antd";
import type { Node, Edge } from "@xyflow/react";

import { formatClock, tagColor } from "@/utils/ui";
import { AppCard } from "@/components/ui";
import type { ScanEvent, ScanDetail, StructuredReport } from "@/types";
import {
  ScanPhase,
  SCAN_PHASE_ORDER,
  PHASE_META,
  EVENT_PHASE,
  EVENT_KIND,
  TOOL_PHASE,
  type ScanEventName,
  type ScanEventKind,
} from "@mcpvul/common/flow/scan-flow-contract";

const { Text } = Typography;

interface NodeModel extends Record<string, unknown> {
  id: string;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  theme: string;
  width: number;
  height: number;
  status: string;
  latestEvent: ScanEvent | null;
  input: [string, any][];
  output: [string, any][] | { error: string };
  error?: string;
}

// ── Per-phase canvas layout (theme + position), keyed by ScanPhase ──
// One node per canonical phase; the agentic loop's per-turn activity lives
// inside the INVESTIGATION node, with LEAKGUARD/DYNAMIC as optional sub-phases.
const PHASE_LAYOUT: Record<ScanPhase, { x: number; y: number; theme: string }> =
  {
    [ScanPhase.SETUP]: { x: 40, y: 110, theme: "sky" },
    [ScanPhase.PREFLIGHT]: { x: 340, y: 110, theme: "cyan" },
    [ScanPhase.WORKSPACE]: { x: 640, y: 110, theme: "amber" },
    [ScanPhase.DISCOVERY]: { x: 940, y: 110, theme: "orange" },
    [ScanPhase.INVESTIGATION]: { x: 1240, y: 110, theme: "violet" },
    [ScanPhase.LEAKGUARD]: { x: 1120, y: 350, theme: "rose" },
    [ScanPhase.DYNAMIC]: { x: 1400, y: 350, theme: "fuchsia" },
    [ScanPhase.JUDGING]: { x: 1240, y: 590, theme: "emerald" },
    [ScanPhase.REPORTING]: { x: 940, y: 590, theme: "teal" },
    [ScanPhase.REPORT]: { x: 640, y: 590, theme: "lime" },
  };

const STATUS_ORDER = [
  "pending",
  "running",
  "completed",
  "skipped",
  "failed",
  "cancelled",
];

/** Resolve which display phase an event belongs to: contract event-name → phase,
 *  then the explicit phase field, then a tool-name fallback. */
function eventPhase(event: ScanEvent): ScanPhase | null {
  if (!event) return null;
  const byName = event.message
    ? EVENT_PHASE[event.message as ScanEventName]
    : undefined;
  if (byName) return byName;
  if (event.phase && SCAN_PHASE_ORDER.includes(event.phase as ScanPhase))
    return event.phase as ScanPhase;
  if (event.tool && TOOL_PHASE[event.tool]) return TOOL_PHASE[event.tool];
  return null;
}

/** Resolve the contract kind of an event (drives generic node status transitions). */
function eventKind(event: ScanEvent): ScanEventKind | undefined {
  if (event?.kind) return event.kind as ScanEventKind;
  if (event?.message) return EVENT_KIND[event.message as ScanEventName];
  return undefined;
}

function normalizeNodeStatus(status: string): string {
  if (status === "starting") return "running";
  if (status === "queued") return "pending";
  return STATUS_ORDER.includes(status) ? status : "pending";
}

function summarizePairs(
  payload: Record<string, any> | undefined | null,
): [string, any][] {
  if (!payload) return [];
  return Object.entries(payload).filter(
    ([, value]) =>
      value !== undefined &&
      value !== null &&
      value !== "" &&
      (!Array.isArray(value) || value.length),
  );
}

function compactJson(value: any): string {
  if (value === null || value === undefined || value === "") return "n/a";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "[]";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function getPhaseError(phase: ScanPhase, events: ScanEvent[]): string | null {
  const failed = events.find(
    (e) =>
      (e.type === "failed" || e.type === "error") && eventPhase(e) === phase,
  );
  if (failed) return failed.error || failed.message || "Unknown error";
  return null;
}

function phaseOutput(
  phase: ScanPhase,
  selectedScan: ScanDetail | null,
  reportData: StructuredReport | null,
  phaseEvents: ScanEvent[],
  allEvents: ScanEvent[],
): {
  input: [string, any][];
  output: [string, any][];
  latest: ScanEvent | null;
  error: string | null;
} {
  const latest = phaseEvents.length
    ? phaseEvents[phaseEvents.length - 1]
    : null;
  const error = getPhaseError(phase, allEvents);
  const scan = selectedScan as any;
  const report = reportData as any;
  const byMsg = (name: string) =>
    [...phaseEvents].reverse().find((e) => e.message === name) as any;

  switch (phase) {
    case ScanPhase.SETUP:
      return {
        input: summarizePairs({
          workspace: scan?.workspacePath,
          analysisMode: scan?.analysisMode,
          dynamic_mode: scan?.dynamicMode,
          build_command: scan?.buildCommand,
        }),
        output: summarizePairs({
          scanId: selectedScan?.scanId,
          status: scan?.status,
        }),
        latest,
        error,
      };
    case ScanPhase.PREFLIGHT:
      return {
        input: summarizePairs({ checks: (latest as any)?.checks }),
        output: summarizePairs({
          result: phaseEvents.some((e) => e.message === "preflight_passed")
            ? "passed"
            : phaseEvents.some((e) => e.message === "preflight_failed")
              ? "failed"
              : "running",
        }),
        latest,
        error,
      };
    case ScanPhase.WORKSPACE: {
      const mat = byMsg("workspace_materialized");
      const plan = byMsg("build_plan_selected");
      return {
        input: summarizePairs({
          source: mat?.sourcePath,
          source_type: mat?.sourceType,
        }),
        output: summarizePairs({
          build_system: plan?.buildSystem,
          build_command: plan?.buildCommand,
        }),
        latest,
        error,
      };
    }
    case ScanPhase.DISCOVERY: {
      const fin = byMsg("discovery_finished");
      const scanning = byMsg("candidates_scanning");
      return {
        input: summarizePairs({
          total_files: scanning?.totalFiles ?? fin?.totalFiles,
        }),
        output: summarizePairs({
          candidates: fin?.totalCandidates ?? report?.finding_count,
        }),
        latest,
        error,
      };
    }
    case ScanPhase.INVESTIGATION: {
      const turn = byMsg("agent_turn_started");
      const toolEvents = phaseEvents.filter(
        (e) => e.message === "agent_tool_result",
      );
      const tools = Array.from(
        new Set(toolEvents.map((e) => e.tool).filter(Boolean)),
      );
      const lastDone = byMsg("agent_turn_finished");
      return {
        input: summarizePairs({
          turn: turn ? `${turn.turn}/${turn.maxLoops}` : null,
          bundles_remaining: turn?.bundlesRemaining,
        }),
        output: summarizePairs({
          tools_run: tools,
          last_action: lastDone?.actionKind,
        }),
        latest,
        error,
      };
    }
    case ScanPhase.LEAKGUARD: {
      const fin = byMsg("leakguard_finished");
      return {
        input: summarizePairs({}),
        output: summarizePairs({ run_id: fin?.runId, findings: fin?.findings }),
        latest,
        error,
      };
    }
    case ScanPhase.DYNAMIC: {
      const rows: Record<string, any> = {};
      for (const e of phaseEvents.filter(
        (ev) => ev.message === "dynamic_tool_result",
      ) as any[]) {
        if (e.tool) rows[String(e.tool)] = e.findings;
      }
      const binary = byMsg("dynamic_binary_built");
      return {
        input: summarizePairs({ binary: binary?.binaryPath }),
        output: summarizePairs(
          Object.keys(rows).length
            ? rows
            : { findings: (byMsg("dynamic_finished") as any)?.findings },
        ),
        latest,
        error,
      };
    }
    case ScanPhase.JUDGING: {
      const fin = byMsg("judging_finished");
      const judgeSummary = report?.judge_summary || scan?.judge_summary;
      return {
        input: summarizePairs({ requested_mode: judgeSummary?.requested_mode }),
        output: summarizePairs({
          judged: fin?.judged ?? fin?.total,
          confirmed: fin?.confirmed,
          effective_mode: judgeSummary?.effective_mode,
        }),
        latest,
        error,
      };
    }
    case ScanPhase.REPORTING:
      return {
        input: summarizePairs({ bundle_count: (latest as any)?.bundleCount }),
        output: summarizePairs({
          formats: "overview, markdown, json, snapshot, html",
        }),
        latest,
        error,
      };
    case ScanPhase.REPORT:
      return {
        input: summarizePairs({
          finding_count:
            report?.finding_count ?? scan?.finding_count ?? scan?.bundle_count,
          evidence_count: report?.evidence_count ?? scan?.evidence_count,
        }),
        output: summarizePairs({ status: scan?.status }),
        latest,
        error,
      };
    default:
      return {
        input: summarizePairs({ message: latest?.message, tool: latest?.tool }),
        output: summarizePairs({
          status: (latest as any)?.status || scan?.status,
        }),
        latest,
        error,
      };
  }
}

function computeNodeModel(
  selectedScan: ScanDetail | null,
  reportData: StructuredReport | null,
  deferredEvents: ScanEvent[],
) {
  const events = deferredEvents || [];
  const scan = selectedScan as any;

  // Bucket every event under its canonical phase (contract-driven).
  const phaseEvents = {} as Record<ScanPhase, ScanEvent[]>;
  for (const phase of SCAN_PHASE_ORDER) phaseEvents[phase] = [];

  let terminal: "completed" | "failed" | null = null;
  let failedPhase: ScanPhase | null = null;

  for (const event of events) {
    if (event.type === "completed") {
      terminal = "completed";
      continue;
    }
    const phase = eventPhase(event);
    if (event.type === "failed" || event.type === "error") {
      terminal = "failed";
      if (phase) {
        phaseEvents[phase].push(event);
        if (!failedPhase) failedPhase = phase;
      }
      continue;
    }
    if (!phase) continue;
    phaseEvents[phase].push(event);
  }

  const scanStatus = normalizeNodeStatus(scan?.status);
  if (reportData || scanStatus === "completed")
    terminal = terminal ?? "completed";
  if (scanStatus === "failed") terminal = terminal ?? "failed";

  // Current node = last phase (in canonical order) that has received any event.
  let currentNodeId: string | null = selectedScan ? ScanPhase.SETUP : null;
  for (const phase of SCAN_PHASE_ORDER)
    if (phaseEvents[phase].length) currentNodeId = phase;
  if (terminal === "completed") currentNodeId = ScanPhase.REPORT;

  const failedIdx = failedPhase ? SCAN_PHASE_ORDER.indexOf(failedPhase) : -1;

  const nodes: NodeModel[] = SCAN_PHASE_ORDER.map((phase, idx) => {
    const meta = PHASE_META[phase];
    const layout = PHASE_LAYOUT[phase];
    const evs = phaseEvents[phase];
    const io = phaseOutput(phase, selectedScan, reportData, evs, events);

    let status = "pending";
    if (!selectedScan) {
      status = "pending";
    } else if (phase === ScanPhase.SETUP) {
      status = "completed";
    } else if (evs.some((e) => e.type === "failed" || e.type === "error")) {
      status = "failed";
    } else if (terminal === "failed" && failedIdx >= 0) {
      status =
        idx < failedIdx
          ? evs.length
            ? "completed"
            : "skipped"
          : idx === failedIdx
            ? "failed"
            : "skipped";
    } else if (evs.some((e) => eventKind(e) === "phase_finish")) {
      status = "completed";
    } else if (evs.length) {
      // Phase started / has activity but not finished.
      status = terminal === "completed" ? "completed" : "running";
    } else if (phase === ScanPhase.REPORT && terminal === "completed") {
      status = "completed";
    } else if (terminal) {
      // Terminal reached and this phase never emitted — it was skipped (e.g.
      // optional PREFLIGHT/LEAKGUARD/DYNAMIC the agent chose not to run).
      status = "skipped";
    } else {
      status = "pending";
    }

    return {
      id: phase,
      title: meta.title,
      subtitle: meta.subtitle,
      x: layout.x,
      y: layout.y,
      theme: layout.theme,
      width: 270,
      height: io.error ? 200 : 170,
      status,
      latestEvent: io.latest,
      input: io.input,
      output: io.output,
      error: io.error || undefined,
    };
  });

  const nodesById = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const edges: {
    id: string;
    from: string;
    to: string;
    active: boolean;
    complete: boolean;
    failed: boolean;
  }[] = [];
  for (let i = 0; i < SCAN_PHASE_ORDER.length - 1; i++) {
    const from = SCAN_PHASE_ORDER[i];
    const to = SCAN_PHASE_ORDER[i + 1];
    const fromNode = nodesById[from];
    const toNode = nodesById[to];
    const active =
      fromNode?.status === "running" || toNode?.status === "running";
    const pipelineComplete =
      !!fromNode &&
      !!toNode &&
      ["completed", "running", "skipped"].includes(fromNode.status) &&
      ["completed", "running", "skipped"].includes(toNode.status);
    const hasFailure =
      fromNode?.status === "failed" || toNode?.status === "failed";
    edges.push({
      id: `${from}-${to}`,
      from,
      to,
      active,
      complete: pipelineComplete,
      failed: hasFailure,
    });
  }

  return { nodes, edges, currentNodeId };
}

function stageAccent(token: any, stageTheme: string): string {
  const accents: Record<string, string> = {
    sky: "#6aa8ff",
    cyan: "#34b6d9",
    amber: "#d9981f",
    orange: "#dd7b28",
    rose: "#d66b8c",
    violet: "#7562ff",
    fuchsia: "#b85ee8",
    indigo: "#4f6fd9",
    emerald: token.colorSuccess,
    teal: "#169c92",
    lime: "#75ad1a",
  };
  return accents[stageTheme] || token.colorPrimary;
}

function nodePalette(token: any, status: string) {
  if (status === "running") {
    return {
      border: token.colorPrimary,
      background: `linear-gradient(180deg, ${token.colorPrimaryBgHover}, ${token.colorBgContainer})`,
      card: token.colorPrimaryBg,
      muted: token.colorPrimaryText,
      shadow: `0 0 0 1px ${token.colorPrimaryBorder}`,
    };
  }
  if (status === "completed") {
    return {
      border: token.colorSuccessBorder,
      background: `linear-gradient(180deg, ${token.colorSuccessBgHover}, ${token.colorBgContainer})`,
      card: token.colorSuccessBg,
      muted: token.colorSuccessText,
      shadow: `0 0 0 1px ${token.colorSuccessBorder}`,
    };
  }
  if (status === "failed") {
    return {
      border: token.colorErrorBorder,
      background: `linear-gradient(180deg, ${token.colorErrorBgHover}, ${token.colorBgContainer})`,
      card: token.colorErrorBg,
      muted: token.colorErrorText,
      shadow: `0 0 0 1px ${token.colorErrorBorder}`,
    };
  }
  if (status === "cancelled") {
    return {
      border: token.colorWarningBorder,
      background: `linear-gradient(180deg, ${token.colorWarningBgHover}, ${token.colorBgContainer})`,
      card: token.colorWarningBg,
      muted: token.colorWarningText,
      shadow: `0 0 0 1px ${token.colorWarningBorder}`,
    };
  }
  if (status === "skipped") {
    return {
      border: token.colorBorderSecondary,
      background: token.colorBgLayout,
      card: token.colorBgContainer,
      muted: token.colorTextTertiary,
      shadow: "none",
    };
  }
  return {
    border: token.colorBorderSecondary,
    background: token.colorBgContainer,
    card: token.colorBgLayout,
    muted: token.colorTextSecondary,
    shadow: "none",
  };
}

function WorkflowNode({ data, selected }: { data: any; selected: boolean }) {
  const { token } = antdTheme.useToken();
  const accent = stageAccent(token, data.theme);
  const palette = nodePalette(token, data.status);
  const errorMsg = data.error || data.latestEvent?.error || "";

  return (
    <div
      className="rf-workflow-node"
      style={{
        borderColor: palette.border,
        background: palette.background,
        boxShadow: selected
          ? `${token.boxShadowSecondary}, 0 0 0 1px ${palette.border}`
          : palette.shadow,
        ["--workflow-accent" as any]: accent,
        ["--workflow-handle-border" as any]: token.colorBgContainer,
      }}
      title={`${data.title}\n\nInput:\n${data.input.length ? (data.input as [string, any][]).map(([key, value]) => `${key}: ${compactJson(value)}`).join("\n") : "No explicit input"}\n\nOutput:\n${data.output.length ? (data.output as [string, any][]).map(([key, value]) => `${key}: ${compactJson(value)}`).join("\n") : "No explicit output"}${errorMsg ? "\n\nError: " + errorMsg : ""}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="rf-workflow-handle"
      />

      <Flex justify="space-between" align="start" gap={12}>
        <div>
          <div className="workflow-node-title">{data.title}</div>
          <div className="workflow-node-subtitle">{data.subtitle}</div>
          {data.status === "failed" && errorMsg ? (
            <div
              style={{
                color: token.colorError,
                fontSize: 11,
                marginTop: 4,
                lineHeight: 1.3,
              }}
            >
              {errorMsg.length > 60 ? errorMsg.slice(0, 60) + "…" : errorMsg}
            </div>
          ) : null}
        </div>
        <Tag color={tagColor(data.status)}>{data.status}</Tag>
      </Flex>

      <Flex vertical gap={8} style={{ marginTop: 16 }}>
        {(data.output as [string, any][]).slice(0, 2).map(([key, value]) => (
          <div
            key={key}
            className="workflow-node-output-card"
            style={{ background: palette.card }}
          >
            <div
              className="workflow-node-output-key"
              style={{ color: palette.muted }}
            >
              {key}
            </div>
            <div className="workflow-node-output-value">
              {compactJson(value)}
            </div>
          </div>
        ))}

        {!data.output.length ? (
          <div className="workflow-node-empty">Waiting for data.</div>
        ) : null}
      </Flex>
      <Handle
        type="source"
        position={Position.Right}
        className="rf-workflow-handle"
      />
    </div>
  );
}

function WorkflowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: any) {
  const { token } = antdTheme.useToken();
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  let stroke = token.colorTextTertiary;
  if (data?.failed) {
    stroke = token.colorError;
  } else if (data?.active) {
    stroke = token.colorPrimary;
  } else if (data?.complete) {
    stroke = token.colorSuccess;
  }

  return (
    <>
      <path
        id={id}
        d={path}
        markerEnd={markerEnd}
        style={{
          fill: "none",
          stroke,
          strokeWidth: data?.active ? 3 : data?.complete ? 2.5 : 1.8,
          opacity: data?.active || data?.complete || data?.failed ? 0.95 : 0.55,
          strokeLinecap: "round",
        }}
      />
      {data?.active ? (
        <path
          d={path}
          className="workflow-edge-signal"
          style={{
            fill: "none",
            stroke: token.colorPrimaryHover,
            strokeWidth: 1.5,
            strokeLinecap: "round",
          }}
        />
      ) : null}
    </>
  );
}

const nodeTypes = { workflow: WorkflowNode as any };
const edgeTypes = { workflow: WorkflowEdge as any };

interface WorkflowCanvasProps {
  selectedScan: ScanDetail | null;
  lastEvent: ScanEvent | null;
  activeScan: boolean;
  deferredEvents: ScanEvent[];
  reportData: StructuredReport | null;
  onCancel: () => void;
  onOpenReport: () => void;
}

function WorkflowCanvas({
  selectedScan,
  lastEvent,
  activeScan,
  deferredEvents,
  reportData,
  onCancel,
  onOpenReport,
}: WorkflowCanvasProps) {
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const { token } = antdTheme.useToken();
  const reactFlow = useReactFlow();
  const canvasShellRef = useRef<HTMLDivElement>(null);
  const model = useMemo(
    () => computeNodeModel(selectedScan, reportData, deferredEvents),
    [selectedScan, reportData, deferredEvents],
  );

  const flowColors = useMemo(
    () => ({
      mode: "light" as const,
      backgroundColor: token.colorPrimaryBorder,
      minimapMaskColor: "rgba(247, 248, 250, 0.76)",
      minimapBgColor: token.colorBgContainer,
      nodeStrokeColor: token.colorBorderSecondary,
      nodeColor: (node: any) => {
        if (node.data?.status === "running") return token.colorPrimary;
        if (node.data?.status === "completed") return token.colorSuccess;
        if (node.data?.status === "failed") return token.colorError;
        if (node.data?.status === "cancelled") return token.colorWarning;
        return token.colorTextTertiary;
      },
    }),
    [token],
  );

  const initialNodes: Node[] = useMemo(
    () =>
      model.nodes.map((node) => ({
        id: node.id,
        type: "workflow",
        position: { x: node.x, y: node.y },
        draggable: true,
        data: node,
      })),
    [model.nodes],
  );

  const initialEdges: Edge[] = useMemo(
    () =>
      model.edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        type: "workflow",
        animated: edge.active,
        data: {
          active: edge.active,
          complete: edge.complete,
          failed: edge.failed,
        },
      })),
    [model.edges],
  );

  const [nodes, setNodes] = useNodesState(initialNodes);
  const [edges, setEdges] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes((currentNodes) =>
      currentNodes.map((currentNode) => {
        const nextNode = initialNodes.find(
          (item) => item.id === currentNode.id,
        );
        if (!nextNode) return currentNode;
        return { ...currentNode, data: nextNode.data };
      }),
    );
  }, [initialNodes, setNodes]);

  useEffect(() => {
    setEdges(initialEdges);
  }, [initialEdges, setEdges]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      reactFlow.fitView({ padding: 0.16, duration: 0 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    reactFlow,
    selectedScan?.scanId,
    model.nodes.length,
    model.currentNodeId,
  ]);

  const nodesById = useMemo(
    () => Object.fromEntries(model.nodes.map((node) => [node.id, node])),
    [model.nodes],
  );
  const hoverNode = hoveredNodeId ? nodesById[hoveredNodeId] : null;
  const hoverNodeError =
    hoverNode?.error || (hoverNode?.latestEvent as any)?.error || "";

  const hoverPopupStyle = useMemo(() => {
    if (!hoverNode || !canvasShellRef.current) return null;

    const popupWidth = 384;
    const edgeGap = 24;
    const estimatedPopupHeight = 360;
    const canvasElement = canvasShellRef.current;
    const nodeElement = canvasElement.querySelector(
      `.react-flow__node[data-id="${hoverNode.id}"]`,
    ) as HTMLElement;

    if (!nodeElement) return null;

    const canvasRect = canvasElement.getBoundingClientRect();
    const nodeRect = nodeElement.getBoundingClientRect();
    const nodeLeft = nodeRect.left - canvasRect.left;
    const nodeRight = nodeRect.right - canvasRect.left;
    const nodeTop = nodeRect.top - canvasRect.top;
    const preferredRight = nodeRight + edgeGap;
    const preferredLeft = nodeLeft - popupWidth - edgeGap;
    const hasRoomOnRight =
      preferredRight + popupWidth <= canvasRect.width - edgeGap;
    const left = hasRoomOnRight
      ? preferredRight
      : Math.max(edgeGap, preferredLeft);
    const top = Math.min(
      Math.max(edgeGap, nodeTop),
      Math.max(edgeGap, canvasRect.height - estimatedPopupHeight - edgeGap),
    );

    return { left, top };
  }, [hoverNode, nodes]);

  const onNodesChange = useCallback(
    (changes: any) => setNodes((current) => applyNodeChanges(changes, current)),
    [setNodes],
  );
  const onEdgesChange = useCallback(
    (changes: any) => setEdges((current) => applyEdgeChanges(changes, current)),
    [setEdges],
  );
  const onNodeMouseEnter = useCallback(
    (_: any, node: Node) => setHoveredNodeId(node.id),
    [],
  );
  const onNodeMouseLeave = useCallback(() => setHoveredNodeId(null), []);
  const scanLabel = selectedScan?.scanId || "No scan selected";
  const statusLabel = (selectedScan as any)?.status || "idle";
  const workspaceLabel =
    (selectedScan as any)?.workspacePath || "No workspace selected";
  const lastEventLabel = lastEvent
    ? `${lastEvent.type} • ${formatClock(lastEvent.timestamp)}`
    : "Waiting for events";

  return (
    <AppCard
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
      styles={{
        header: { display: "none" } as any,
        body: { flex: 1, minHeight: 0 } as any,
      }}
    >
      <Flex vertical gap={16} style={{ flex: 1, minHeight: 0 }}>
        <Flex justify="space-between" align="center" gap={12} wrap>
          <Flex vertical gap={6} style={{ minWidth: 0, flex: "1 1 360px" }}>
            <Space wrap size={[8, 8]}>
              <Tag color={tagColor(statusLabel)}>{statusLabel}</Tag>
              <Text strong>{scanLabel}</Text>
              <Text type="secondary">{lastEventLabel}</Text>
            </Space>
            <Text
              type="secondary"
              title={workspaceLabel}
              style={{
                display: "block",
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {workspaceLabel}
            </Text>
          </Flex>

          <Space wrap size={[8, 8]} style={{ justifyContent: "flex-end" }}>
            <Button
              danger
              type="primary"
              size="small"
              onClick={onCancel}
              disabled={!activeScan}
            >
              Cancel Scan
            </Button>
            <Button
              type="primary"
              size="small"
              onClick={onOpenReport}
              disabled={!selectedScan}
            >
              Open Full Report
            </Button>
            {[
              [
                "Findings",
                (selectedScan as any)?.finding_count ??
                  (selectedScan as any)?.bundle_count ??
                  "-",
              ],
              ["Candidates", (selectedScan as any)?.candidate_count ?? "-"],
              ["Evidence", (selectedScan as any)?.evidence_count ?? "-"],
            ].map(([label, value]) => (
              <div
                key={label as string}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 10px",
                  borderRadius: 999,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  background: token.colorBgLayout,
                }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {label as string}
                </Text>
                <Text strong>{value as string}</Text>
              </div>
            ))}
          </Space>
        </Flex>

        <div
          ref={canvasShellRef}
          className="workflow-canvas-shell"
          style={{
            position: "relative",
            flex: 1,
            minHeight: 0,
            background: token.colorBgContainer,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadiusLG,
            overflow: "hidden",
            ["--workflow-minimap-border" as any]: token.colorBorderSecondary,
          }}
        >
          <ReactFlow
            colorMode={flowColors.mode}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeMouseEnter={onNodeMouseEnter}
            onNodeMouseLeave={onNodeMouseLeave}
            fitView
            fitViewOptions={{ padding: 0.16, duration: 450 }}
            minZoom={0.35}
            maxZoom={1.6}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
            panOnDrag
            zoomOnScroll
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ animated: true }}
          >
            <Controls
              className="workflow-flow-ui"
              showInteractive={false}
              position="bottom-right"
            />
            <MiniMap
              className="workflow-flow-ui"
              pannable
              zoomable
              position="bottom-left"
              nodeStrokeWidth={3}
              bgColor={flowColors.minimapBgColor}
              maskColor={flowColors.minimapMaskColor}
              nodeStrokeColor={flowColors.nodeStrokeColor}
              nodeColor={flowColors.nodeColor}
            />
            <Background
              gap={20}
              size={1.1}
              color={flowColors.backgroundColor}
            />
          </ReactFlow>

          {hoverNode && hoverPopupStyle ? (
            <AppCard
              size="small"
              bodyGap={12}
              style={{
                position: "absolute",
                width: 384,
                maxHeight: "calc(100% - 32px)",
                pointerEvents: "none",
                borderColor: token.colorBorderSecondary,
                boxShadow: token.boxShadowSecondary,
                ...hoverPopupStyle,
              }}
            >
              <Flex justify="space-between" align="start" gap={12}>
                <div>
                  <Text strong>{hoverNode.title}</Text>
                  <div>
                    <Text type="secondary">{hoverNode.subtitle}</Text>
                  </div>
                </div>
                <Tag color={tagColor(hoverNode.status)}>{hoverNode.status}</Tag>
              </Flex>

              {hoverNodeError ? (
                <div
                  style={{
                    color: token.colorError,
                    fontSize: 12,
                    background: token.colorErrorBg,
                    padding: "4px 8px",
                    borderRadius: 6,
                  }}
                >
                  {hoverNodeError}
                </div>
              ) : null}

              {hoverNode.latestEvent ? (
                <Text type="secondary">
                  {hoverNode.latestEvent.type} •{" "}
                  {formatClock(hoverNode.latestEvent.timestamp)}
                </Text>
              ) : null}

              <AppCard size="small" title="Input" bodyGap={8}>
                {hoverNode.input.length ? (
                  hoverNode.input.slice(0, 3).map(([key, value]) => (
                    <Flex
                      key={key}
                      justify="space-between"
                      gap={12}
                      style={{ marginBottom: 8 }}
                    >
                      <Text type="secondary">{key}</Text>
                      <Text style={{ textAlign: "right" }}>
                        {compactJson(value)}
                      </Text>
                    </Flex>
                  ))
                ) : (
                  <Text type="secondary">No explicit input yet.</Text>
                )}
              </AppCard>

              <AppCard size="small" title="Output" bodyGap={8}>
                {Array.isArray(hoverNode.output) ? (
                  (hoverNode.output as [string, any][]).length ? (
                    (hoverNode.output as [string, any][])
                      .slice(0, 3)
                      .map(([key, value]) => (
                        <Flex
                          key={key}
                          justify="space-between"
                          gap={12}
                          style={{ marginBottom: 8 }}
                        >
                          <Text type="secondary">{key}</Text>
                          <Text style={{ textAlign: "right" }}>
                            {compactJson(value)}
                          </Text>
                        </Flex>
                      ))
                  ) : (
                    <Text type="secondary">Waiting for data.</Text>
                  )
                ) : (
                  <Text type="danger" style={{ fontSize: 12 }}>
                    {(hoverNode.output as { error: string }).error}
                  </Text>
                )}
              </AppCard>
            </AppCard>
          ) : null}
        </div>
      </Flex>
    </AppCard>
  );
}

export function WorkflowCanvasBoard(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvas {...props} />
    </ReactFlowProvider>
  );
}
