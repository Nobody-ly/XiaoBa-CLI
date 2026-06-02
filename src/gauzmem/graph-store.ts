import { appendJsonl, readJsonl } from './jsonl';
import { GauzMemFiles, ensureGauzMemDirs } from './paths';
import { normalizeMemoryText, stableHash } from './hash';
import type { GauzMemEdge, GauzMemEvidenceRef, GauzMemNode, GauzMemState, GauzMemWeightChange } from './types';

const NODE_SELECTED_DELTA = 0.12;
const NODE_REJECTED_DELTA = -0.01;
const EDGE_SELECTED_DELTA = 0.08;
const EDGE_REJECTED_DELTA = -0.015;
const NORMAL_RETRIEVAL_THRESHOLD = 0.1;
const DEEP_RETRIEVAL_THRESHOLD = -0.45;
const DECAY_FLOOR = -0.2;
const DECAY_LAMBDA = 0.08;
const INITIAL_SCORE = 0.45;
const MAX_SCORE = 1;
const MIN_SCORE = -0.8;
const NEAR_DUPLICATE_THRESHOLD = 0.86;

export class GauzMemGraphStore {
  readNodes(): GauzMemNode[] {
    return this.latestById(readJsonl<GauzMemNode>(GauzMemFiles.nodes()));
  }

  readEdges(): GauzMemEdge[] {
    return this.latestById(readJsonl<GauzMemEdge>(GauzMemFiles.edges()));
  }

  readNodeStates(): Map<string, GauzMemState> {
    return this.stateMap(readJsonl<GauzMemState>(GauzMemFiles.nodeState()));
  }

  readEdgeStates(): Map<string, GauzMemState> {
    return this.stateMap(readJsonl<GauzMemState>(GauzMemFiles.edgeState()));
  }

  applyRecallDecay(currentTurn: number): GauzMemWeightChange[] {
    ensureGauzMemDirs();
    const changes: GauzMemWeightChange[] = [];
    for (const state of this.readNodeStates().values()) {
      const change = this.decayState('node', state, currentTurn);
      if (change) changes.push(change);
    }
    for (const state of this.readEdgeStates().values()) {
      const change = this.decayState('edge', state, currentTurn);
      if (change) changes.push(change);
    }
    return changes;
  }

  upsertNode(text: string, evidenceRefInput: GauzMemEvidenceRef | string): { node: GauzMemNode; created: boolean; deduped?: boolean; matchedNodeId?: string } {
    ensureGauzMemDirs();
    const evidenceRef = this.coerceEvidenceRef(evidenceRefInput);
    const normalized = normalizeMemoryText(text);
    const canonical = this.canonicalEvidenceText(normalized);
    const id = 'gzn_' + stableHash(canonical.toLowerCase());
    const existingNodes = this.readNodes();
    const existing = existingNodes.find(node => node.id === id)
      || this.findNearDuplicateNode(canonical, existingNodes);
    const now = new Date().toISOString();
    const node: GauzMemNode = existing
      ? {
          ...existing,
          evidenceRefs: this.mergeEvidenceRefs(existing.evidenceRefs || this.refsFromLegacySourceIds(existing.sourceIds), evidenceRef),
          updatedAt: now,
        }
      : {
          id,
          text: normalized,
          evidenceRefs: [evidenceRef],
          createdAt: now,
          updatedAt: now,
        };
    appendJsonl(GauzMemFiles.nodes(), node);
    if (!existing) this.ensureState('node', id);
    return {
      node,
      created: !existing,
      ...(existing && existing.id !== id && { deduped: true, matchedNodeId: existing.id }),
    };
  }

  upsertEdge(from: string, to: string, text: string, evidenceRefInput: GauzMemEvidenceRef | string): { edge: GauzMemEdge; created: boolean } | null {
    if (from === to) return null;
    ensureGauzMemDirs();
    const evidenceRef = this.coerceEvidenceRef(evidenceRefInput);
    const [left, right] = [from, to].sort();
    const edgeText = this.normalizeEdgeText(text);
    const id = 'gze_' + stableHash(`${left}:${right}:${edgeText.toLowerCase()}`);
    const existing = this.readEdges().find(edge => edge.id === id);
    const now = new Date().toISOString();
    const edge: GauzMemEdge = existing
      ? {
          ...existing,
          evidenceRefs: this.mergeEvidenceRefs(existing.evidenceRefs || this.refsFromLegacySourceIds(existing.sourceIds), evidenceRef),
          updatedAt: now,
        }
      : {
          id,
          from: left,
          to: right,
          text: edgeText,
          evidenceRefs: [evidenceRef],
          createdAt: now,
          updatedAt: now,
        };
    appendJsonl(GauzMemFiles.edges(), edge);
    if (!existing) this.ensureState('edge', id);
    return { edge, created: !existing };
  }

  appendNodeEvidence(nodeId: string, evidenceRefs: GauzMemEvidenceRef[]): GauzMemNode | null {
    if (evidenceRefs.length === 0) return this.readNodes().find(node => node.id === nodeId) || null;
    const existing = this.readNodes().find(node => node.id === nodeId);
    if (!existing) return null;
    const now = new Date().toISOString();
    const merged = evidenceRefs.reduce(
      (refs, ref) => this.mergeEvidenceRefs(refs, ref),
      existing.evidenceRefs || this.refsFromLegacySourceIds(existing.sourceIds),
    );
    const node: GauzMemNode = {
      ...existing,
      evidenceRefs: merged,
      updatedAt: now,
    };
    appendJsonl(GauzMemFiles.nodes(), node);
    return node;
  }

  graphScan(terms: string[]): { nodes: GauzMemNode[]; edges: GauzMemEdge[] } {
    const nodeStates = this.readNodeStates();
    const edgeStates = this.readEdgeStates();
    const lowered = terms.map(term => term.toLowerCase().trim()).filter(Boolean);
    const nodeMap = new Map<string, GauzMemNode>();
    for (const node of this.readNodes()) {
      const state = nodeStates.get(node.id);
      if (!this.isNormallyRetrievable(state)) continue;
      if (this.matchedTermIndexes(node.text, lowered).length === 0) continue;
      nodeMap.set(node.id, node);
    }
    const nodes = this.sortByTermMatches(Array.from(nodeMap.values()), lowered, node => node.text);
    const nodeIds = new Set(nodes.map(node => node.id));
    const edgeMap = new Map<string, GauzMemEdge>();
    for (const edge of this.readEdges()) {
      const state = edgeStates.get(edge.id);
      if (!this.isNormallyRetrievable(state)) continue;
      if (!this.isNormallyRetrievable(nodeStates.get(edge.from)) || !this.isNormallyRetrievable(nodeStates.get(edge.to))) continue;
      if (nodeIds.has(edge.from) || nodeIds.has(edge.to)) {
        edgeMap.set(edge.id, edge);
        continue;
      }
      if (this.matchedTermIndexes(edge.text, lowered).length === 0) continue;
      edgeMap.set(edge.id, edge);
    }
    const edges = this.sortByTermMatches(Array.from(edgeMap.values()), lowered, edge => edge.text);
    return { nodes, edges };
  }

  disclose(nodeIds: string[], maxEdges?: number): { nodes: GauzMemNode[]; edges: GauzMemEdge[] } {
    const ids = new Set(nodeIds);
    const nodeStates = this.readNodeStates();
    const edgeStates = this.readEdgeStates();
    const edges = this.readEdges()
      .filter(edge => {
        if (!this.isNormallyRetrievable(edgeStates.get(edge.id))) return false;
        if (!ids.has(edge.from) && !ids.has(edge.to)) return false;
        if (!this.isNormallyRetrievable(nodeStates.get(edge.from)) || !this.isNormallyRetrievable(nodeStates.get(edge.to))) return false;
        return true;
      });
    const limitedEdges = typeof maxEdges === 'number' ? edges.slice(0, maxEdges) : edges;
    const nextIds = new Set<string>(nodeIds);
    for (const edge of limitedEdges) {
      nextIds.add(edge.from);
      nextIds.add(edge.to);
    }
    const nodeMap = new Map(this.readNodes().map(node => [node.id, node]));
    return {
      nodes: Array.from(nextIds).map(id => nodeMap.get(id)).filter(Boolean) as GauzMemNode[],
      edges: limitedEdges,
    };
  }

  applySelection(params: {
    selectedNodeIds: string[];
    selectedEdgeIds: string[];
    rejectedNodeIds: string[];
    rejectedEdgeIds: string[];
    currentTurn?: number;
  }): GauzMemWeightChange[] {
    const selectedNodes = new Set(params.selectedNodeIds);
    const selectedEdges = new Set(params.selectedEdgeIds);
    const rejectedNodes = params.rejectedNodeIds.filter(id => !selectedNodes.has(id));
    const rejectedEdges = params.rejectedEdgeIds.filter(id => !selectedEdges.has(id));
    const changes: GauzMemWeightChange[] = [];
    const currentTurn = params.currentTurn ?? this.currentRecallTurn();
    for (const id of params.selectedNodeIds) changes.push(this.bump('node', id, 'selected', NODE_SELECTED_DELTA, currentTurn));
    for (const id of rejectedNodes) changes.push(this.bump('node', id, 'rejected', NODE_REJECTED_DELTA, currentTurn));
    for (const id of params.selectedEdgeIds) changes.push(this.bump('edge', id, 'selected', EDGE_SELECTED_DELTA, currentTurn));
    for (const id of rejectedEdges) changes.push(this.bump('edge', id, 'rejected', EDGE_REJECTED_DELTA, currentTurn));
    return changes;
  }

  getFadedIds(): { nodeIds: string[]; edgeIds: string[] } {
    return {
      nodeIds: Array.from(this.readNodeStates().values()).filter(state => this.isDeepForgotten(state)).map(state => state.id),
      edgeIds: Array.from(this.readEdgeStates().values()).filter(state => this.isDeepForgotten(state)).map(state => state.id),
    };
  }

  private bump(kind: 'node' | 'edge', id: string, reason: 'selected' | 'rejected', delta: number, currentTurn: number): GauzMemWeightChange {
    const states = kind === 'node' ? this.readNodeStates() : this.readEdgeStates();
    const beforeState = states.get(id) || this.defaultState(id);
    const afterScore = this.clampScore(beforeState.score + delta);
    const after: GauzMemState = {
      id,
      score: afterScore,
      selectedCount: beforeState.selectedCount + (reason === 'selected' ? 1 : 0),
      rejectedCount: beforeState.rejectedCount + (reason === 'rejected' ? 1 : 0),
      faded: afterScore < DEEP_RETRIEVAL_THRESHOLD,
      lastDecayTurn: currentTurn,
      lastSelectedTurn: reason === 'selected' ? currentTurn : beforeState.lastSelectedTurn,
      lastRejectedTurn: reason === 'rejected' ? currentTurn : beforeState.lastRejectedTurn,
      updatedAt: new Date().toISOString(),
    };
    appendJsonl(kind === 'node' ? GauzMemFiles.nodeState() : GauzMemFiles.edgeState(), after);
    return {
      id,
      kind,
      reason,
      delta,
      before: beforeState.score,
      after: after.score,
      faded: after.faded,
    };
  }

  private ensureState(kind: 'node' | 'edge', id: string): void {
    const states = kind === 'node' ? this.readNodeStates() : this.readEdgeStates();
    if (states.has(id)) return;
    appendJsonl(kind === 'node' ? GauzMemFiles.nodeState() : GauzMemFiles.edgeState(), this.defaultState(id));
  }

  private defaultState(id: string): GauzMemState {
    return {
      id,
      score: INITIAL_SCORE,
      selectedCount: 0,
      rejectedCount: 0,
      faded: false,
      lastDecayTurn: this.currentRecallTurn(),
      updatedAt: new Date().toISOString(),
    };
  }

  private decayState(kind: 'node' | 'edge', state: GauzMemState, currentTurn: number): GauzMemWeightChange | null {
    const lastDecayTurn = state.lastDecayTurn ?? Math.max(0, currentTurn - 1);
    const elapsed = Math.max(0, currentTurn - lastDecayTurn);
    if (elapsed === 0) return null;
    const before = state.score;
    const afterScore = this.decayScore(before, elapsed);
    const after: GauzMemState = {
      ...state,
      score: afterScore,
      faded: afterScore < DEEP_RETRIEVAL_THRESHOLD,
      lastDecayTurn: currentTurn,
      updatedAt: new Date().toISOString(),
    };
    appendJsonl(kind === 'node' ? GauzMemFiles.nodeState() : GauzMemFiles.edgeState(), after);
    return {
      id: state.id,
      kind,
      reason: 'decay',
      delta: Number((afterScore - before).toFixed(3)),
      before,
      after: afterScore,
      faded: after.faded,
    };
  }

  private decayScore(score: number, elapsedTurns: number): number {
    if (score <= DECAY_FLOOR) return this.clampScore(score);
    const factor = Math.exp(-DECAY_LAMBDA * elapsedTurns);
    return this.clampScore(DECAY_FLOOR + (score - DECAY_FLOOR) * factor);
  }

  private clampScore(score: number): number {
    return Number(Math.min(MAX_SCORE, Math.max(MIN_SCORE, score)).toFixed(3));
  }

  private isNormallyRetrievable(state: GauzMemState | undefined): boolean {
    if (!state) return INITIAL_SCORE >= NORMAL_RETRIEVAL_THRESHOLD;
    return !this.isDeepForgotten(state) && state.score >= NORMAL_RETRIEVAL_THRESHOLD;
  }

  private isDeepForgotten(state: GauzMemState): boolean {
    return state.faded || state.score < DEEP_RETRIEVAL_THRESHOLD;
  }

  private currentRecallTurn(): number {
    const runs = readJsonl<{ kind?: string }>(GauzMemFiles.runs());
    return runs.filter(run => run.kind === 'recall').length;
  }

  private latestById<T extends { id: string }>(rows: T[]): T[] {
    const map = new Map<string, T>();
    for (const row of rows) map.set(row.id, row);
    return Array.from(map.values());
  }

  private stateMap(rows: GauzMemState[]): Map<string, GauzMemState> {
    const map = new Map<string, GauzMemState>();
    for (const row of rows) map.set(row.id, row);
    return map;
  }

  private sortByTermMatches<T extends { id: string }>(
    items: T[],
    terms: string[],
    textOf: (item: T) => string,
  ): T[] {
    return [...items].sort((a, b) => {
      const aMatches = this.matchedTermIndexes(textOf(a), terms);
      const bMatches = this.matchedTermIndexes(textOf(b), terms);
      return bMatches.length - aMatches.length
        || Math.min(...aMatches) - Math.min(...bMatches)
        || a.id.localeCompare(b.id);
    });
  }

  private matchedTermIndexes(text: string, terms: string[]): number[] {
    const lower = text.toLowerCase();
    return terms
      .map((term, index) => lower.includes(term) ? index : -1)
      .filter(index => index >= 0);
  }

  private canonicalEvidenceText(text: string): string {
    return normalizeMemoryText(text)
      .replace(/^[\s"'“”‘’`*_「」『』【】《》]+/, '')
      .replace(/[\s"'“”‘’`*_「」『』【】《》。！？!?，,；;：:、.]+$/, '')
      .replace(/["“”'‘’`*_「」『』【】《》]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private findNearDuplicateNode(canonical: string, nodes: GauzMemNode[]): GauzMemNode | undefined {
    if (canonical.length < 12) return undefined;
    return nodes.find(node => {
      const existing = this.canonicalEvidenceText(node.text);
      if (existing === canonical) return true;
      if (existing.length >= 12 && (existing.includes(canonical) || canonical.includes(existing))) return true;
      return this.trigramSimilarity(existing, canonical) >= NEAR_DUPLICATE_THRESHOLD;
    });
  }

  private mergeEvidenceRefs(refs: GauzMemEvidenceRef[], next: GauzMemEvidenceRef): GauzMemEvidenceRef[] {
    const key = (ref: GauzMemEvidenceRef) => `${ref.sourceId}:${ref.span.start}:${ref.span.end}`;
    const map = new Map<string, GauzMemEvidenceRef>();
    for (const ref of refs) map.set(key(ref), ref);
    map.set(key(next), next);
    return Array.from(map.values());
  }

  private refsFromLegacySourceIds(sourceIds?: string[]): GauzMemEvidenceRef[] {
    return (sourceIds || []).map(sourceId => ({
      sourceId,
      span: { start: 0, end: 0 },
      sourceRef: { kind: 'session_turn', turnId: '', role: '', index: 0 },
    }));
  }

  private coerceEvidenceRef(input: GauzMemEvidenceRef | string): GauzMemEvidenceRef {
    if (typeof input !== 'string') return input;
    return {
      sourceId: input,
      span: { start: 0, end: 0 },
      sourceRef: { kind: 'session_turn', turnId: '', role: '', index: 0 },
    };
  }

  private trigramSimilarity(left: string, right: string): number {
    const a = this.trigrams(left);
    const b = this.trigrams(right);
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const item of a) {
      if (b.has(item)) intersection += 1;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  private trigrams(text: string): Set<string> {
    const compact = text.replace(/\s+/g, '');
    const grams = new Set<string>();
    for (let i = 0; i <= compact.length - 3; i += 1) {
      grams.add(compact.slice(i, i + 3));
    }
    return grams;
  }

  private normalizeEdgeText(text: string): string {
    let value = normalizeMemoryText(text)
      .replace(/Parent fact\s*:?\s*/gi, '')
      .replace(/Evidence\s*:?\s*/gi, '')
      .replace(/This evidence (directly )?(confirms|supports|explains)[^.。]*[.。]?\s*/gi, '')
      .replace(/The evidence (directly )?(confirms|supports|explains)[^.。]*[.。]?\s*/gi, '')
      .trim();
    if (value.length > 120) value = value.slice(0, 117).trimEnd() + '...';
    return value;
  }
}
