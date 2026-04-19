import { GraphDocument, SourceRef, ZoomLevel } from "../python/model/graphTypes";

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
}

export interface UiStateView {
  showEvidence: boolean;
  repelStrength: number;
  attractStrength: number;
  ambientRepelStrength: number;
}

export interface SetUiStateMessage {
  type: "setUiState";
  state: UiStateView;
}

export type FromExtensionMessage =
  | SetGraphMessage
  | SetThemeMessage
  | SetRuntimeFrameMessage
  | SetUiStateMessage;
export type FromWebviewMessage =
  | RevealNodeMessage
  | RequestRefreshMessage
  | RequestFlowchartMessage
  | NavigateLevelMessage
  | NavigatePeripheralMessage
  | ReadyMessage
  | DebugMessage;
