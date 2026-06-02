export type GauzMemCallType = 'passive' | 'active';
export type GauzMemQueryKind = 'direct' | 'anaphora' | 'continuation' | 'recall' | 'task';

export interface GauzMemSourceRecord {
  sourceId: string;
  sessionKey: string;
  sessionType?: string;
  turnId: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  timestamp: string;
  toolCall?: {
    id: string;
    name: string;
    arguments: string;
    result: string;
  };
  sourceRef: {
    kind: 'session_turn';
    turnId: string;
    role: string;
    index: number;
  };
}

export interface GauzMemSourceWindow {
  windowId: string;
  sourceId: string;
  sessionKey: string;
  sessionType?: string;
  text: string;
  timestamp: string;
  sourceRef: GauzMemSourceRecord['sourceRef'];
}

export interface GauzMemNode {
  id: string;
  text: string;
  sourceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GauzMemEdge {
  id: string;
  from: string;
  to: string;
  text: string;
  sourceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GauzMemState {
  id: string;
  score: number;
  selectedCount: number;
  rejectedCount: number;
  faded: boolean;
  updatedAt: string;
}

export interface GauzMemQueryPlan {
  rootQuery: string;
  searchTerms: string[];
  contextHints: string[];
  queryKind: GauzMemQueryKind;
}

export interface GauzMemReasonerStep {
  name: string;
  ok: boolean;
  durationMs: number;
  error?: string;
  inputPreview?: string;
  outputPreview?: string;
}

export interface GauzMemWeightChange {
  id: string;
  kind: 'node' | 'edge';
  reason: 'selected' | 'rejected';
  delta: number;
  before: number;
  after: number;
  faded: boolean;
}

export interface GauzMemRunRecord {
  runId: string;
  callType: GauzMemCallType;
  sessionKey?: string;
  sessionType?: string;
  query: string;
  timestamp: string;
  status: 'ok' | 'error';
  error?: string;
  queryPlan?: GauzMemQueryPlan;
  trace: Array<{
    step: string;
    detail?: string;
    nodeIds?: string[];
    edgeIds?: string[];
    windowIds?: string[];
  }>;
  reasonerSteps: GauzMemReasonerStep[];
  sourceWindows: GauzMemSourceWindow[];
  extractedEvidence: Array<{ windowId: string; text: string }>;
  createdNodeIds: string[];
  createdEdgeIds: string[];
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  rejectedNodeIds: string[];
  rejectedEdgeIds: string[];
  fadedNodeIds: string[];
  fadedEdgeIds: string[];
  weightChanges: GauzMemWeightChange[];
  promptBundle: string;
  stats: {
    sourceCount: number;
    graphNodeCount: number;
    graphEdgeCount: number;
    sourceWindowCount: number;
    evidenceCount: number;
    durationMs: number;
  };
}

export interface GauzMemRecallResult {
  message?: string;
  run: GauzMemRunRecord;
}
