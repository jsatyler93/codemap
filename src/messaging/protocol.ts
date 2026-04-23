import { GraphDocument, SourceRef, ZoomLevel } from "../python/model/graphTypes";
import { NarrationKind, NarrationScript } from "../ai/narrationTypes";
import { DebugProbe, ProbeResult } from "../debug/debugProbeTypes";

// Messages: webview <-> extension host

export interface SetGraphMessage {
  type: "setGraph";
  graph: GraphDocument;
}

export interface RevealNodeMessage {
  type: "revealNode";
  nodeId: string;
  source?: SourceRef;
}

export interface RequestRefreshMessage {
  type: "requestRefresh";
}

export interface RequestFlowchartMessage {
  type: "requestFlowchart";
  nodeId: string;
  source?: SourceRef;
}

export interface RequestNarrationMessage {
  type: "requestNarration";
  kind?: NarrationKind;
  regenerate?: boolean;
}

export interface RequestExportNarrationMessage {
  type: "requestExportNarration";
}

export interface ToggleAiAssistanceMessage {
  type: "toggleAiAssistance";
  enabled: boolean;
}

export interface RegenerateProbesMessage {
  type: "regenerateProbes";
  nodeId: string;
}

export interface DismissProbeMessage {
  type: "dismissProbe";
  probeId: string;
}

export interface ReadyMessage {
  type: "ready";
}

export interface DebugMessage {
  type: "debug";
  message: string;
}

export interface NavigateLevelMessage {
  type: "navigateLevel";
  targetLevel: ZoomLevel;
  targetId: string;
}

export interface NavigatePeripheralMessage {
  type: "navigatePeripheral";
  targetLevel: ZoomLevel;
  targetId: string;
}

export interface SetThemeMessage {
  type: "setTheme";
  theme: "dark" | "light";
}

export interface RuntimeFrameView {
  frameId: number;
  name: string;
  source?: { file: string; line: number; column?: number };
  callStack: { name: string; file?: string; line?: number }[];
  variables: { name: string; type?: string; value: string; scope: string }[];
  threadId?: number;
  sessionId: string;
}

export interface SetRuntimeFrameMessage {
  type: "setRuntimeFrame";
  frame: RuntimeFrameView | null;
  // Optional list of node IDs to highlight (computed by the host).
  highlightNodeIds?: string[];
  // Optional list of node IDs whose current frame line is an active source breakpoint.
  breakpointNodeIds?: string[];
}

export interface UiStateView {
  showEvidence: boolean;
  narrationEnabled?: boolean;
  repelStrength: number;
  attractStrength: number;
  ambientRepelStrength: number;
  cohesionStrength: number;
  layoutMode?: "tree" | "lanes" | "freeform";
  treeView: boolean;
  /** Groups = collapsed group chips; full = all nodes expanded flat */
  flowchartViewMode?: "grouped" | "full";
  /** Canvas brightness multiplier: 0.0 = black, 1.0 = normal, 2.0 = double. Default 1.0. */
  canvasBrightness?: number;
  /** Canvas theme mode: custom CodeMap palette or VS Code-native surface colors. */
  canvasThemeMode?: "codemap" | "vscode";
  /** Flowchart progressive reading state – undefined means overview mode */
  flowchartFocusGroupId?: string;
  flowchartBreadcrumb?: BreadcrumbEntry[];
}

/** One entry in the flowchart breadcrumb trail */
export interface BreadcrumbEntry {
  /** Group or block node id that was drilled into */
  groupId: string;
  /** Human-readable label to display in the breadcrumb */
  label: string;
}

/**
 * Webview → host: user has clicked a compound block and wants to drill into
 * the focused subgraph for that region.
 */
export interface DrilldownFlowchartMessage {
  type: "drilldownFlowchart";
  /** The group/block node id to focus on */
  groupId: string;
  /** Label shown in breadcrumb for this level */
  label: string;
}

/**
 * Webview → host: user wants to navigate back to a parent breadcrumb level.
 * Passing `null` breadcrumbIndex means "go back to overview (top)".
 */
export interface FlowchartBreadcrumbNavigateMessage {
  type: "flowchartBreadcrumbNavigate";
  /** 0-based index of the breadcrumb entry to restore; -1 = root overview */
  breadcrumbIndex: number;
}

/**
 * Host → webview: delivers a new focused flowchart layer together with the
 * updated breadcrumb state.  The webview replaces its current canvas content.
 */
export interface FlowchartLayerMessage {
  type: "flowchartLayer";
  graph: import("../python/model/graphTypes").GraphDocument;
  /** Full breadcrumb trail at this point (empty = overview) */
  breadcrumb: BreadcrumbEntry[];
  /** The group id being focused, or null for overview */
  focusGroupId: string | null;
}

export interface SetUiStateMessage {
  type: "setUiState";
  state: UiStateView;
}

export interface SetNarrationScriptMessage {
  type: "setNarrationScript";
  script: NarrationScript;
}

export interface ClearNarrationMessage {
  type: "clearNarration";
}

export interface SetDebugProbesMessage {
  type: "setDebugProbes";
  probes?: DebugProbe[];
  probesPacked?: string;
}

export interface ProbeResultMessage {
  type: "probeResult";
  result?: ProbeResult;
  resultPacked?: string;
}

export interface ClearDebugProbesMessage {
  type: "clearDebugProbes";
  nodeId?: string;
}

export interface HighlightProbeNodeMessage {
  type: "highlightProbeNode";
  nodeId: string;
}

export type FromExtensionMessage =
  | SetGraphMessage
  | SetThemeMessage
  | SetRuntimeFrameMessage
  | SetUiStateMessage
  | SetNarrationScriptMessage
  | ClearNarrationMessage
  | SetDebugProbesMessage
  | ProbeResultMessage
  | ClearDebugProbesMessage
  | HighlightProbeNodeMessage
  | FlowchartLayerMessage;
export type FromWebviewMessage =
  | RevealNodeMessage
  | RequestRefreshMessage
  | RequestFlowchartMessage
  | RequestNarrationMessage
  | RequestExportNarrationMessage
  | ToggleAiAssistanceMessage
  | RegenerateProbesMessage
  | DismissProbeMessage
  | NavigateLevelMessage
  | NavigatePeripheralMessage
  | DrilldownFlowchartMessage
  | FlowchartBreadcrumbNavigateMessage
  | ReadyMessage
  | DebugMessage;
