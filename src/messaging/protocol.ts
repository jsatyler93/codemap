import { GraphDocument, SourceRef } from "../python/model/graphTypes";

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

export interface SetThemeMessage {
  type: "setTheme";
  theme: "dark" | "light";
}

export type FromExtensionMessage = SetGraphMessage | SetThemeMessage;
export type FromWebviewMessage =
  | RevealNodeMessage
  | RequestRefreshMessage
  | RequestFlowchartMessage
  | ReadyMessage
  | DebugMessage;
