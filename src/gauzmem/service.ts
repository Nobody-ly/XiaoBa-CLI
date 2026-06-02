import type { ContentBlock, Message } from '../types';
import type { RunResult } from '../core/conversation-runner';
import { appendJsonl, readJsonl } from './jsonl';
import { GauzMemFiles, ensureGauzMemDirs, getGauzMemRoot } from './paths';
import { truncateText, stableHash } from './hash';
import { ConfigManager } from '../utils/config';
import { GauzMemGraphStore } from './graph-store';
import { GauzMemReasoner } from './reasoner';
import { GauzMemSourceJournal } from './source-journal';
import type {
  GauzMemCallType,
  GauzMemRecallResult,
  GauzMemRunRecord,
} from './types';

export interface GauzMemRecallParams {
  callType: GauzMemCallType;
  query: string;
  sessionKey?: string;
  sessionType?: string;
  durableMessages?: Message[];
}

export interface GauzMemRecordTurnParams {
  sessionKey: string;
  sessionType?: string;
  turnId: string;
  userInput: string | ContentBlock[];
  result: RunResult;
}

export interface GauzMemRecordErrorTurnParams {
  sessionKey: string;
  sessionType?: string;
  turnId: string;
  userInput: string | ContentBlock[];
  error: unknown;
}

export class GauzMemService {
  private static instance: GauzMemService | null = null;

  static getInstance(): GauzMemService {
    if (!GauzMemService.instance) GauzMemService.instance = new GauzMemService();
    return GauzMemService.instance;
  }

  private readonly graph = new GauzMemGraphStore();
  private readonly sources = new GauzMemSourceJournal();

  isEnabled(): boolean {
    return /^(1|true|yes)$/i.test(process.env.GAUZMEM_ENABLED || '');
  }

  getStatus(): any {
    const config = ConfigManager.getConfigReadonly();
    const nodes = this.graph.readNodes();
    const edges = this.graph.readEdges();
    const runs = this.readRuns();
    const nodeStates = Array.from(this.graph.readNodeStates().values());
    const edgeStates = Array.from(this.graph.readEdgeStates().values());
    return {
      enabled: this.isEnabled(),
      root: getGauzMemRoot(),
      llm: {
        provider: config.provider || null,
        apiKeyPresent: Boolean(config.apiKey),
        apiBase: sanitizeUrl(config.apiUrl),
        model: config.model || null,
        timeoutMs: Number(process.env.GAUZMEM_LLM_TIMEOUT_MS || 60000),
        disableThinking: String(process.env.GAUZ_LLM_THINKING || '').toLowerCase() !== 'enabled'
          && String(process.env.GAUZ_LLM_DISABLE_THINKING || '').toLowerCase() !== 'false',
      },
      counts: {
        sources: this.sources.readAll().length,
        nodes: nodes.length,
        edges: edges.length,
        runs: runs.length,
        fadedNodes: nodeStates.filter(s => s.faded).length,
        fadedEdges: edgeStates.filter(s => s.faded).length,
      },
      latestRun: runs[runs.length - 1] || null,
    };
  }

  async probeReasoner(): Promise<any> {
    const reasoner = new GauzMemReasoner();
    const probe = await reasoner.probe();
    return {
      ...this.getStatus(),
      probe,
      reasonerSteps: reasoner.steps,
    };
  }

  async recall(params: GauzMemRecallParams): Promise<GauzMemRecallResult | null> {
    if (!this.isEnabled()) return null;
    ensureGauzMemDirs();
    const started = Date.now();
    const run = this.emptyRun(params, started);
    const reasoner = new GauzMemReasoner();

    try {
      const recent = this.extractRecentContext(params.durableMessages || []);
      const queryPlan = await reasoner.buildQueryPlan({
        userInput: params.query,
        previousUser: recent.previousUser,
        previousAssistant: recent.previousAssistant,
        sessionKey: params.sessionKey,
        sessionType: params.sessionType,
      });
      run.queryPlan = queryPlan;
      run.trace.push({ step: 'query_build', detail: queryPlan.searchTerms.join(' | ') });

      const graphScan = this.graph.graphScan(queryPlan.searchTerms);
      run.trace.push({
        step: 'graph_scan',
        nodeIds: graphScan.nodes.map(node => node.id),
        edgeIds: graphScan.edges.map(edge => edge.id),
      });

      const disclosed = this.graph.disclose(graphScan.nodes.map(node => node.id));
      const candidateNodes = this.uniqueById([...graphScan.nodes, ...disclosed.nodes]);
      const candidateEdges = this.uniqueById([...graphScan.edges, ...disclosed.edges]);
      run.trace.push({
        step: 'disclose',
        nodeIds: disclosed.nodes.map(node => node.id),
        edgeIds: disclosed.edges.map(edge => edge.id),
      });

      let selection = await reasoner.selectRelevant({
        rootQuery: queryPlan.rootQuery,
        nodes: candidateNodes,
        edges: candidateEdges,
      });
      run.trace.push({
        step: 'relevance_graph',
        nodeIds: selection.selectedNodeIds,
        edgeIds: selection.selectedEdgeIds,
      });

      let sourceWindowCount = 0;
      let evidenceCount = 0;
      if (this.shouldConstructFromSources(selection)) {
        const constructSeedNodeIds = selection.selectedNodeIds.slice(0, 3);
        run.trace.push({
          step: constructSeedNodeIds.length > 0 ? 'node_construct_start' : 'root_construct_start',
          nodeIds: constructSeedNodeIds,
        });

        const windows = this.sources.searchWindows(queryPlan.searchTerms);
        run.sourceWindows = windows;
        sourceWindowCount = windows.length;
        run.trace.push({ step: 'source_windows', windowIds: windows.map(window => window.windowId) });

        const evidence = await reasoner.extractEvidence(queryPlan.rootQuery, windows);
        run.extractedEvidence = evidence;
        evidenceCount = evidence.length;
        run.trace.push({ step: 'extract_evidence', detail: `${evidence.length} evidence` });

        const createdNodes = [];
        for (const item of evidence) {
          const window = windows.find(w => w.windowId === item.windowId);
          if (!window) continue;
          const { node, created } = this.graph.upsertNode(item.text, window.sourceId);
          createdNodes.push(node);
          if (created) run.createdNodeIds.push(node.id);
        }

        const createdEdges = [];
        if (constructSeedNodeIds.length > 0) {
          const nodeMap = new Map(this.graph.readNodes().map(node => [node.id, node]));
          for (const seedId of constructSeedNodeIds) {
            const seed = nodeMap.get(seedId);
            if (!seed) continue;
            for (const node of createdNodes.slice(0, 8)) {
              const sourceId = node.sourceIds[0];
              if (!sourceId) continue;
              const edgeResult = this.graph.upsertEdge(
                seed.id,
                node.id,
                `Constructed evidence connected to frontier memory: ${seed.text} -> ${node.text}`,
                sourceId,
              );
              if (!edgeResult) continue;
              createdEdges.push(edgeResult.edge);
              if (edgeResult.created) run.createdEdgeIds.push(edgeResult.edge.id);
            }
          }
        }

        run.trace.push({
          step: constructSeedNodeIds.length > 0 ? 'node_construct' : 'root_construct',
          nodeIds: run.createdNodeIds,
          edgeIds: run.createdEdgeIds,
        });

        const sourceSelection = await reasoner.selectRelevant({
          rootQuery: queryPlan.rootQuery,
          nodes: createdNodes,
          edges: createdEdges,
        });
        run.trace.push({
          step: 'relevance_construct',
          nodeIds: sourceSelection.selectedNodeIds,
          edgeIds: sourceSelection.selectedEdgeIds,
        });

        selection = this.mergeSelection(selection, sourceSelection);
      } else {
        run.trace.push({ step: 'construct_skipped', detail: 'graph selection was sufficient' });
      }
      const weightChanges = this.graph.applySelection(selection);
      const faded = this.graph.getFadedIds();

      run.selectedNodeIds = selection.selectedNodeIds;
      run.selectedEdgeIds = selection.selectedEdgeIds;
      run.rejectedNodeIds = selection.rejectedNodeIds;
      run.rejectedEdgeIds = selection.rejectedEdgeIds;
      run.fadedNodeIds = faded.nodeIds;
      run.fadedEdgeIds = faded.edgeIds;
      run.weightChanges = weightChanges;
      run.promptBundle = this.buildPromptBundle(run.selectedNodeIds, run.selectedEdgeIds);
      run.status = 'ok';
      run.stats = {
        sourceCount: this.sources.readAll().length,
        graphNodeCount: this.graph.readNodes().length,
        graphEdgeCount: this.graph.readEdges().length,
        sourceWindowCount,
        evidenceCount,
        durationMs: Date.now() - started,
      };
      run.reasonerSteps = reasoner.steps;
      this.saveRun(run);

      if (!run.promptBundle.trim()) return { run };
      return {
        run,
        message: `[transient_gauzmem_recall]\n${run.promptBundle}`,
      };
    } catch (error: any) {
      run.status = 'error';
      run.error = String(error?.message || error);
      run.reasonerSteps = reasoner.steps;
      run.stats.durationMs = Date.now() - started;
      this.saveRun(run);
      return { run };
    }
  }

  recordTurnSource(params: GauzMemRecordTurnParams): void {
    if (!this.isEnabled()) return;
    this.sources.appendTurn(params);
  }

  recordErrorTurnSource(params: GauzMemRecordErrorTurnParams): void {
    if (!this.isEnabled()) return;
    this.sources.appendTurn({
      sessionKey: params.sessionKey,
      sessionType: params.sessionType,
      turnId: params.turnId,
      userInput: params.userInput,
      result: {
        response: `[turn_error] ${String((params.error as any)?.message || params.error)}`,
        finalResponseVisible: false,
        messages: [],
        newMessages: [],
      },
    });
  }

  readRuns(limit = 50): GauzMemRunRecord[] {
    return readJsonl<GauzMemRunRecord>(GauzMemFiles.runs())
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .slice(-limit);
  }

  readRun(runId: string): GauzMemRunRecord | null {
    return readJsonl<GauzMemRunRecord>(GauzMemFiles.runs()).find(run => run.runId === runId) || null;
  }

  readGraph(): any {
    const nodeStates = this.graph.readNodeStates();
    const edgeStates = this.graph.readEdgeStates();
    return {
      nodes: this.graph.readNodes().map(node => ({
        ...node,
        state: nodeStates.get(node.id) || null,
      })),
      edges: this.graph.readEdges().map(edge => ({
        ...edge,
        state: edgeStates.get(edge.id) || null,
      })),
    };
  }

  private emptyRun(params: GauzMemRecallParams, started: number): GauzMemRunRecord {
    return {
      runId: 'gzr_' + stableHash(`${Date.now()}:${params.callType}:${params.query}`),
      callType: params.callType,
      sessionKey: params.sessionKey,
      sessionType: params.sessionType,
      query: params.query,
      timestamp: new Date(started).toISOString(),
      status: 'ok',
      trace: [],
      reasonerSteps: [],
      sourceWindows: [],
      extractedEvidence: [],
      createdNodeIds: [],
      createdEdgeIds: [],
      selectedNodeIds: [],
      selectedEdgeIds: [],
      rejectedNodeIds: [],
      rejectedEdgeIds: [],
      fadedNodeIds: [],
      fadedEdgeIds: [],
      weightChanges: [],
      promptBundle: '',
      stats: {
        sourceCount: 0,
        graphNodeCount: 0,
        graphEdgeCount: 0,
        sourceWindowCount: 0,
        evidenceCount: 0,
        durationMs: 0,
      },
    };
  }

  private buildPromptBundle(nodeIds: string[], edgeIds: string[]): string {
    const nodeSet = new Set(nodeIds);
    const edgeSet = new Set(edgeIds);
    const nodes = this.graph.readNodes().filter(node => nodeSet.has(node.id));
    const edges = this.graph.readEdges().filter(edge => edgeSet.has(edge.id));
    const lines: string[] = [];
    if (nodes.length > 0) {
      lines.push('Relevant memory nodes:');
      for (const node of nodes.slice(0, 12)) lines.push(`- ${node.text}`);
    }
    if (edges.length > 0) {
      lines.push('Relevant memory links:');
      for (const edge of edges.slice(0, 8)) lines.push(`- ${edge.text}`);
    }
    return lines.join('\n');
  }

  private shouldConstructFromSources(selection: ReturnTypeShape): boolean {
    return selection.selectedNodeIds.length < 2 && selection.selectedEdgeIds.length < 1;
  }

  private mergeSelection(
    left: ReturnTypeShape,
    right: ReturnTypeShape,
  ): ReturnTypeShape {
    const selectedNodeIds = Array.from(new Set([...left.selectedNodeIds, ...right.selectedNodeIds]));
    const selectedEdgeIds = Array.from(new Set([...left.selectedEdgeIds, ...right.selectedEdgeIds]));
    const selectedNodeSet = new Set(selectedNodeIds);
    const selectedEdgeSet = new Set(selectedEdgeIds);
    return {
      selectedNodeIds,
      selectedEdgeIds,
      rejectedNodeIds: Array.from(new Set([...left.rejectedNodeIds, ...right.rejectedNodeIds]))
        .filter(id => !selectedNodeSet.has(id)),
      rejectedEdgeIds: Array.from(new Set([...left.rejectedEdgeIds, ...right.rejectedEdgeIds]))
        .filter(id => !selectedEdgeSet.has(id)),
    };
  }

  private uniqueById<T extends { id: string }>(items: T[]): T[] {
    return Array.from(new Map(items.map(item => [item.id, item])).values());
  }

  private saveRun(run: GauzMemRunRecord): void {
    appendJsonl(GauzMemFiles.runs(), run);
  }

  private extractRecentContext(messages: Message[]): { previousUser?: string; previousAssistant?: string } {
    const nonInjected = messages.filter(message => !message.__injected);
    const users = nonInjected.filter(message => message.role === 'user' && typeof message.content === 'string') as Array<Message & { content: string }>;
    const assistants = nonInjected.filter(message => message.role === 'assistant' && typeof message.content === 'string') as Array<Message & { content: string }>;
    const latestUser = users[users.length - 1]?.content || '';
    const previousUser = users.length >= 2 ? users[users.length - 2].content : latestUser;
    return {
      previousUser,
      previousAssistant: assistants[assistants.length - 1]?.content || '',
    };
  }
}

type ReturnTypeShape = {
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  rejectedNodeIds: string[];
  rejectedEdgeIds: string[];
};

function sanitizeUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return '[configured]';
  }
}
