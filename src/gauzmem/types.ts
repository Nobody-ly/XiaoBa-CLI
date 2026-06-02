export type GauzMemCallType = 'passive' | 'active';
export type GauzMemRunKind = 'recall' | 'construct';
export interface GauzMemSourceRecord {
  sourceId: string;
  sessionKey: string;
  sessionType?: string;
  turnId: string;
  role: 'user' | 'assistant' | 'tool';
  blockType?: 'user_text' | 'assistant_text' | 'tool_result';
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
  blockType?: NonNullable<GauzMemSourceRecord['blockType']>;
  matchedTerms: string[];
  distinctTermCount: number;
  firstMatchedTermIndex: number;
  span: {
    start: number;
    end: number;
  };
}

export interface GauzMemEvidenceRef {
  sourceId: string;
  span: {
    start: number;
    end: number;
  };
  blockType?: NonNullable<GauzMemSourceRecord['blockType']>;
  sourceRef: GauzMemSourceRecord['sourceRef'];
}

export interface GauzMemNode {
  id: string;
  text: string;
  evidenceRefs: GauzMemEvidenceRef[];
  sourceIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GauzMemEdge {
  id: string;
  from: string;
  to: string;
  text: string;
  evidenceRefs: GauzMemEvidenceRef[];
  sourceIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GauzMemState {
  id: string;
  score: number;
  selectedCount: number;
  rejectedCount: number;
  faded: boolean;
  lastDecayTurn?: number;
  lastSelectedTurn?: number;
  lastRejectedTurn?: number;
  updatedAt: string;
}

export interface GauzMemQueryPlan {
  rootQuery: string;
  searchTerms: string[];
}

export interface GauzMemReasonerStep {
  name: string;
  ok: boolean;
  durationMs: number;
  error?: string;
  inputPreview?: string;
  outputPreview?: string;
}

export interface GauzMemExtractedEvidence {
  sourceId: string;
  span: {
    start: number;
    end: number;
  };
  sourceSnippet?: string;
  text: string;
  relationToParent?: {
    whyRelevant: string;
  };
}

export interface GauzMemWeightChange {
  id: string;
  kind: 'node' | 'edge';
  reason: 'selected' | 'rejected' | 'decay';
  delta: number;
  before: number;
  after: number;
  faded: boolean;
}

export interface GauzMemRunRecord {
  runId: string;
  kind?: GauzMemRunKind;
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
  extractedEvidence: GauzMemExtractedEvidence[];
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
    frontierSteps?: number;
    rootConstructCount?: number;
    nodeConstructCount?: number;
    constructTurnIds?: string[];
    constructNewTurnIds?: string[];
    constructBatchStart?: string;
    constructBatchEnd?: string;
    mergedNodeCount?: number;
    skippedEdgeCount?: number;
    warningCount?: number;
  };
}

export interface GauzMemRecallResult {
  message?: string;
  run: GauzMemRunRecord;
}

export interface GauzMemGraphPatchNode {
  tempId: string;
  text: string;
  sourceIds: string[];
}

export interface GauzMemGraphPatchEdge {
  from: string;
  to: string;
  text: string;
  sourceIds?: string[];
}

export interface GauzMemGraphPatchMerge {
  tempId: string;
  existingNodeId: string;
}

export interface GauzMemGraphPatch {
  batchSummary: string;
  nodes: GauzMemGraphPatchNode[];
  edges: GauzMemGraphPatchEdge[];
  merges?: GauzMemGraphPatchMerge[];
  skipped?: string[];
}
