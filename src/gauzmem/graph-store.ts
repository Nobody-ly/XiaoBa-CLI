import { appendJsonl, readJsonl } from './jsonl';
import { GauzMemFiles, ensureGauzMemDirs } from './paths';
import { normalizeMemoryText, stableHash } from './hash';
import type { GauzMemEdge, GauzMemNode, GauzMemState, GauzMemWeightChange } from './types';

const NODE_SELECTED_DELTA = 0.12;
const NODE_REJECTED_DELTA = -0.03;
const EDGE_SELECTED_DELTA = 0.08;
const EDGE_REJECTED_DELTA = -0.03;
const FADED_THRESHOLD = -0.25;
const INITIAL_SCORE = 0.4;

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

  upsertNode(text: string, sourceId: string): { node: GauzMemNode; created: boolean } {
    ensureGauzMemDirs();
    const normalized = normalizeMemoryText(text);
    const id = 'gzn_' + stableHash(normalized.toLowerCase());
    const existing = this.readNodes().find(node => node.id === id);
    const now = new Date().toISOString();
    const node: GauzMemNode = existing
      ? {
          ...existing,
          sourceIds: Array.from(new Set([...existing.sourceIds, sourceId])),
          updatedAt: now,
        }
      : {
          id,
          text: normalized,
          sourceIds: [sourceId],
          createdAt: now,
          updatedAt: now,
        };
    appendJsonl(GauzMemFiles.nodes(), node);
    if (!existing) this.ensureState('node', id);
    return { node, created: !existing };
  }

  upsertEdge(from: string, to: string, text: string, sourceId: string): { edge: GauzMemEdge; created: boolean } | null {
    if (from === to) return null;
    ensureGauzMemDirs();
    const [left, right] = [from, to].sort();
    const id = 'gze_' + stableHash(`${left}:${right}:${normalizeMemoryText(text).toLowerCase()}`);
    const existing = this.readEdges().find(edge => edge.id === id);
    const now = new Date().toISOString();
    const edge: GauzMemEdge = existing
      ? {
          ...existing,
          sourceIds: Array.from(new Set([...existing.sourceIds, sourceId])),
          updatedAt: now,
        }
      : {
          id,
          from: left,
          to: right,
          text: normalizeMemoryText(text),
          sourceIds: [sourceId],
          createdAt: now,
          updatedAt: now,
        };
    appendJsonl(GauzMemFiles.edges(), edge);
    if (!existing) this.ensureState('edge', id);
    return { edge, created: !existing };
  }

  graphScan(terms: string[]): { nodes: GauzMemNode[]; edges: GauzMemEdge[] } {
    const nodeStates = this.readNodeStates();
    const edgeStates = this.readEdgeStates();
    const lowered = terms.map(term => term.toLowerCase()).filter(Boolean);
    const nodes = this.readNodes().filter(node => {
      const state = nodeStates.get(node.id);
      if (state?.faded) return false;
      const text = node.text.toLowerCase();
      return lowered.some(term => text.includes(term));
    });
    const nodeIds = new Set(nodes.map(node => node.id));
    const edges = this.readEdges().filter(edge => {
      const state = edgeStates.get(edge.id);
      if (state?.faded) return false;
      const text = edge.text.toLowerCase();
      return nodeIds.has(edge.from)
        || nodeIds.has(edge.to)
        || lowered.some(term => text.includes(term));
    });
    return { nodes, edges };
  }

  disclose(nodeIds: string[], maxEdges = 48): { nodes: GauzMemNode[]; edges: GauzMemEdge[] } {
    const ids = new Set(nodeIds);
    const edges = this.readEdges()
      .filter(edge => ids.has(edge.from) || ids.has(edge.to))
      .slice(0, maxEdges);
    const nextIds = new Set<string>(nodeIds);
    for (const edge of edges) {
      nextIds.add(edge.from);
      nextIds.add(edge.to);
    }
    const nodeMap = new Map(this.readNodes().map(node => [node.id, node]));
    return {
      nodes: Array.from(nextIds).map(id => nodeMap.get(id)).filter(Boolean) as GauzMemNode[],
      edges,
    };
  }

  applySelection(params: {
    selectedNodeIds: string[];
    selectedEdgeIds: string[];
    rejectedNodeIds: string[];
    rejectedEdgeIds: string[];
  }): GauzMemWeightChange[] {
    const selectedNodes = new Set(params.selectedNodeIds);
    const selectedEdges = new Set(params.selectedEdgeIds);
    const rejectedNodes = params.rejectedNodeIds.filter(id => !selectedNodes.has(id));
    const rejectedEdges = params.rejectedEdgeIds.filter(id => !selectedEdges.has(id));
    const changes: GauzMemWeightChange[] = [];
    for (const id of params.selectedNodeIds) changes.push(this.bump('node', id, 'selected', NODE_SELECTED_DELTA));
    for (const id of rejectedNodes) changes.push(this.bump('node', id, 'rejected', NODE_REJECTED_DELTA));
    for (const id of params.selectedEdgeIds) changes.push(this.bump('edge', id, 'selected', EDGE_SELECTED_DELTA));
    for (const id of rejectedEdges) changes.push(this.bump('edge', id, 'rejected', EDGE_REJECTED_DELTA));
    return changes;
  }

  getFadedIds(): { nodeIds: string[]; edgeIds: string[] } {
    return {
      nodeIds: Array.from(this.readNodeStates().values()).filter(state => state.faded).map(state => state.id),
      edgeIds: Array.from(this.readEdgeStates().values()).filter(state => state.faded).map(state => state.id),
    };
  }

  private bump(kind: 'node' | 'edge', id: string, reason: 'selected' | 'rejected', delta: number): GauzMemWeightChange {
    const states = kind === 'node' ? this.readNodeStates() : this.readEdgeStates();
    const beforeState = states.get(id) || this.defaultState(id);
    const afterScore = Number((beforeState.score + delta).toFixed(3));
    const after: GauzMemState = {
      id,
      score: afterScore,
      selectedCount: beforeState.selectedCount + (reason === 'selected' ? 1 : 0),
      rejectedCount: beforeState.rejectedCount + (reason === 'rejected' ? 1 : 0),
      faded: afterScore < FADED_THRESHOLD,
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
      updatedAt: new Date().toISOString(),
    };
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
}
