import type { ContentBlock, Message } from '../types';
import type { RunResult } from '../core/conversation-runner';
import { appendJsonl, readJsonl } from './jsonl';
import { GauzMemFiles, ensureGauzMemDirs, getGauzMemRoot, getGauzMemSourceDir } from './paths';
import { truncateText, stableHash } from './hash';
import { ConfigManager } from '../utils/config';
import { GauzMemGraphStore } from './graph-store';
import { GauzMemReasoner } from './reasoner';
import { GauzMemSourceJournal } from './source-journal';
import type {
  GauzMemCallType,
  GauzMemConstructArtifact,
  GauzMemEdge,
  GauzMemEvidenceRef,
  GauzMemGraphSnapshot,
  GauzMemGraphPatch,
  GauzMemNode,
  GauzMemRecallResult,
  GauzMemRunRecord,
  GauzMemSourceRecord,
} from './types';

const CONSTRUCT_NEW_TURN_COUNT = 1;
const CONSTRUCT_CONTEXT_TURN_COUNT = 2;
const ONE_HOP_MAX_NEARBY_NODES = 16;
const ONE_HOP_MAX_NEARBY_EDGES = 24;
const ONE_HOP_MIN_EDGES_PER_ANCHOR = 1;
const HIGH_FREQUENCY_TERM_RATIO = 0.10;
const VERY_HIGH_FREQUENCY_TERM_RATIO = 0.20;
const HIGH_ONLY_SINGLE_LIMIT = 8;
const VERY_HIGH_ONLY_SINGLE_LIMIT = 5;
const HIGH_ONLY_MULTI_LIMIT = 8;
const SNAPSHOT_NORMAL_THRESHOLD = 0.1;
const SNAPSHOT_DEEP_THRESHOLD = -0.45;
type GauzMemScope = 'global' | 'session';

interface GauzMemPromptMemory {
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  nearbyNodeIds: string[];
  nearbyEdgeIds: string[];
}

interface GauzMemNearbyContext {
  nodeIds: string[];
  edgeIds: string[];
  rawNodeIds: string[];
  rawEdgeIds: string[];
}

interface GauzMemTermFrequency {
  term: string;
  index: number;
  hitCount: number;
  ratio: number;
  level: 'normal' | 'high' | 'very_high';
}

interface GauzMemRelevanceCandidates {
  nodes: GauzMemNode[];
  edges: GauzMemEdge[];
  droppedNodeIds: string[];
  droppedEdgeIds: string[];
  highFrequencyTerms: GauzMemTermFrequency[];
}

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
  private recallQueue: Promise<void> = Promise.resolve();
  private constructScheduled = false;
  private constructRunning = false;

  isEnabled(): boolean {
    return !/^(0|false|no|off)$/i.test(process.env.GAUZMEM_ENABLED || '');
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
      sourceRoot: getGauzMemSourceDir(),
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
      scope: this.scope(),
      sessionAllowlist: this.envList('GAUZMEM_SESSION_ALLOWLIST'),
      sessionTypeAllowlist: this.envList('GAUZMEM_SESSION_TYPE_ALLOWLIST'),
      promptInjectionEnabled: this.isPromptInjectionEnabled(),
    };
  }

  getSettings(): any {
    const status = this.getStatus();
    return {
      enabled: status.enabled,
      promptInjectionEnabled: status.promptInjectionEnabled,
      promptInjectionEnvOverride: this.hasPromptInjectionEnvOverride(),
      backgroundLearningText: status.promptInjectionEnabled
        ? '记忆辅助已开启：相关记忆会提供给 Agent。'
        : '记忆辅助已关闭：后台仍会整理记忆，但不会影响回复。',
      counts: status.counts,
      llm: status.llm,
    };
  }

  updateSettings(input: { promptInjectionEnabled?: boolean }): any {
    if (typeof input.promptInjectionEnabled === 'boolean') {
      ConfigManager.saveConfig({
        gauzmem: {
          promptInjectionEnabled: input.promptInjectionEnabled,
        },
      });
    }
    return this.getSettings();
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
    if (!this.isSessionAllowed(params.sessionKey, params.sessionType)) return null;
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
      run.trace.push({
        step: 'query_build',
        detail: `rootQuery: ${queryPlan.rootQuery}; terms ${queryPlan.searchTerms.join(' | ')}`,
      });

      const memoryTurn = this.readRuns().filter(item => item.kind === 'recall').length + 1;
      const decayChanges = this.graph.applyRecallDecay(memoryTurn);
      if (decayChanges.length > 0) {
        run.trace.push({
          step: 'memory_decay',
          detail: `turn ${memoryTurn}; decayed ${decayChanges.length}`,
          nodeIds: decayChanges.filter(change => change.kind === 'node').map(change => change.id),
          edgeIds: decayChanges.filter(change => change.kind === 'edge').map(change => change.id),
        });
      }

      run.snapshotId = this.saveGraphSnapshot(run, params.sessionKey);
      const retrievableGraph = this.filterGraphByScope(this.graph.normalRetrievableGraph(), params.sessionKey);
      const graphScan = this.grepQueryPlan(queryPlan.searchTerms, params.sessionKey);
      const grepNodeRatio = this.ratio(graphScan.nodes.length, retrievableGraph.nodes.length);
      const grepEdgeRatio = this.ratio(graphScan.edges.length, retrievableGraph.edges.length);
      run.trace.push({
        step: 'graph_grep',
        detail: [
          `nodes ${graphScan.nodes.length}/${retrievableGraph.nodes.length} (${this.percent(grepNodeRatio)})`,
          `edges ${graphScan.edges.length}/${retrievableGraph.edges.length} (${this.percent(grepEdgeRatio)})`,
        ].join('; '),
        nodeIds: graphScan.nodes.map(node => node.id),
        edgeIds: graphScan.edges.map(edge => edge.id),
      });

      const relevanceCandidates = this.compressRelevanceCandidates(
        queryPlan.searchTerms,
        graphScan,
        retrievableGraph,
      );
      run.trace.push({
        step: 'candidate_filter',
        detail: [
          `high terms ${relevanceCandidates.highFrequencyTerms.map(term =>
            `${term.term}:${term.hitCount}(${this.percent(term.ratio)})`
          ).join(', ') || 'none'}`,
          `nodes ${relevanceCandidates.nodes.length}/${graphScan.nodes.length}`,
          `edges ${relevanceCandidates.edges.length}/${graphScan.edges.length}`,
          `dropped nodes ${relevanceCandidates.droppedNodeIds.length}`,
          `dropped edges ${relevanceCandidates.droppedEdgeIds.length}`,
        ].join('; '),
        nodeIds: relevanceCandidates.nodes.map(node => node.id),
        edgeIds: relevanceCandidates.edges.map(edge => edge.id),
      });

      const initialSelection = await reasoner.selectRelevant({
        rootQuery: queryPlan.rootQuery,
        nodes: relevanceCandidates.nodes,
        edges: relevanceCandidates.edges,
      });
      run.trace.push({
        step: 'relevance_grep',
        detail: `selected ${initialSelection.selectedNodeIds.length}/${initialSelection.selectedEdgeIds.length}, rejected ${initialSelection.rejectedNodeIds.length}/${initialSelection.rejectedEdgeIds.length}`,
        nodeIds: initialSelection.selectedNodeIds,
        edgeIds: initialSelection.selectedEdgeIds,
      });

      const selectedEdgeMap = new Map(relevanceCandidates.edges.map(edge => [edge.id, edge]));
      const selectedAnchorIds = this.uniqueStrings([
        ...initialSelection.selectedNodeIds,
        ...initialSelection.selectedEdgeIds.flatMap(id => {
          const edge = selectedEdgeMap.get(id);
          return edge ? [edge.from, edge.to] : [];
        }),
      ]);
      const disclosed = selectedAnchorIds.length > 0
        ? this.filterGraphByScope(this.graph.disclose(selectedAnchorIds), params.sessionKey)
        : { nodes: [], edges: [] };
      const nearbyContext = this.limitNearbyContext(
        selectedAnchorIds,
        {
          nodeIds: initialSelection.selectedNodeIds,
          edgeIds: initialSelection.selectedEdgeIds,
        },
        disclosed,
      );
      run.trace.push({
        step: 'disclose_selected',
        detail: [
          `raw nodes ${nearbyContext.rawNodeIds.length}, edges ${nearbyContext.rawEdgeIds.length}`,
          `capped nodes ${nearbyContext.nodeIds.length}/${ONE_HOP_MAX_NEARBY_NODES}`,
          `edges ${nearbyContext.edgeIds.length}/${ONE_HOP_MAX_NEARBY_EDGES}`,
        ].join('; '),
        nodeIds: nearbyContext.nodeIds,
        edgeIds: nearbyContext.edgeIds,
      });

      const weightChanges = [
        ...decayChanges,
        ...this.graph.applySelection({ ...initialSelection, currentTurn: memoryTurn }),
      ];
      const faded = this.graph.getFadedIds();

      run.selectedNodeIds = initialSelection.selectedNodeIds;
      run.selectedEdgeIds = initialSelection.selectedEdgeIds;
      run.rejectedNodeIds = initialSelection.rejectedNodeIds;
      run.rejectedEdgeIds = initialSelection.rejectedEdgeIds;
      run.fadedNodeIds = faded.nodeIds;
      run.fadedEdgeIds = faded.edgeIds;
      run.weightChanges = weightChanges;
      const promptMemory = this.buildPromptMemory(initialSelection, params.sessionKey, nearbyContext);
      run.promptBundle = this.buildPromptBundle(queryPlan.rootQuery, queryPlan.searchTerms, promptMemory);
      run.trace.push({
        step: 'prompt_bundle',
        detail: `chars ${run.promptBundle.length}`,
      });
      run.status = 'ok';
      run.stats = {
        sourceCount: this.sources.readAll().length,
        graphNodeCount: this.graph.readNodes().length,
        graphEdgeCount: this.graph.readEdges().length,
        sourceWindowCount: 0,
        evidenceCount: 0,
        durationMs: Date.now() - started,
        frontierSteps: 1,
        rootConstructCount: 0,
        nodeConstructCount: 0,
        grepNodeCount: graphScan.nodes.length,
        grepEdgeCount: graphScan.edges.length,
        relevanceCandidateNodeCount: relevanceCandidates.nodes.length,
        relevanceCandidateEdgeCount: relevanceCandidates.edges.length,
        relevanceCandidateDroppedNodeCount: relevanceCandidates.droppedNodeIds.length,
        relevanceCandidateDroppedEdgeCount: relevanceCandidates.droppedEdgeIds.length,
        retrievableNodeCount: retrievableGraph.nodes.length,
        retrievableEdgeCount: retrievableGraph.edges.length,
        grepNodeRatio,
        grepEdgeRatio,
        relevanceSelectedNodeCount: initialSelection.selectedNodeIds.length,
        relevanceSelectedEdgeCount: initialSelection.selectedEdgeIds.length,
        relevanceRejectedNodeCount: initialSelection.rejectedNodeIds.length,
        relevanceRejectedEdgeCount: initialSelection.rejectedEdgeIds.length,
        oneHopNodeCount: nearbyContext.nodeIds.length,
        oneHopEdgeCount: nearbyContext.edgeIds.length,
        oneHopRawNodeCount: nearbyContext.rawNodeIds.length,
        oneHopRawEdgeCount: nearbyContext.rawEdgeIds.length,
        promptCharCount: run.promptBundle.length,
      };
      run.reasonerSteps = reasoner.steps;
      this.saveRun(run);

      if (!run.promptBundle.trim()) return { run };
      if (params.callType === 'passive' && !this.isPromptInjectionEnabled()) return { run };
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

  enqueueRecall(params: GauzMemRecallParams): void {
    this.recallQueue = this.recallQueue
      .catch(() => undefined)
      .then(async () => {
        await this.recall(params);
      })
      .catch(() => undefined);
  }

  recordTurnSource(params: GauzMemRecordTurnParams): void {
    if (!this.isEnabled()) return;
    if (!this.isSessionAllowed(params.sessionKey, params.sessionType)) return;
    this.sources.appendTurn(params);
    this.scheduleConstruct();
  }

  recordErrorTurnSource(params: GauzMemRecordErrorTurnParams): void {
    if (!this.isEnabled()) return;
    if (!this.isSessionAllowed(params.sessionKey, params.sessionType)) return;
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
    this.scheduleConstruct();
  }

  private scheduleConstruct(): void {
    if (this.constructScheduled || this.constructRunning) return;
    this.constructScheduled = true;
    setTimeout(() => {
      this.constructScheduled = false;
      void this.runConstructIfReady();
    }, 0);
  }

  private async runConstructIfReady(): Promise<void> {
    if (!this.isEnabled() || this.constructRunning) return;
    this.constructRunning = true;
    try {
      const batch = this.nextConstructBatch();
      if (!batch) return;
      const started = Date.now();
      const run = this.emptyConstructRun(batch, started);
      const reasoner = new GauzMemReasoner();
      try {
        const constructGraph = this.compactGraphForConstruct(batch);
        const sourceBatch = batch.batchRecords.map(source => ({
          sourceId: source.sourceId,
          turnId: source.turnId,
          role: source.role,
          blockType: source.blockType,
          text: source.text,
        }));
        const artifact: GauzMemConstructArtifact = {
          artifactId: 'gza_' + stableHash(`${run.runId}:construct_artifact`),
          runId: run.runId,
          timestamp: new Date(started).toISOString(),
          sessionKey: run.sessionKey,
          sessionType: run.sessionType,
          input: {
            sourceBatch,
            graph: constructGraph,
          },
        };
        run.artifactId = artifact.artifactId;
        const patch = await reasoner.buildGraphPatch({
          sourceBatch,
          graph: constructGraph,
        });
        artifact.patch = patch;
        const applied = this.applyGraphPatch(patch, batch.batchRecords, run);
        artifact.applyResult = {
          tempToNodeId: Array.from(applied.tempToNodeId.entries()),
          createdNodeIds: run.createdNodeIds,
          createdEdgeIds: run.createdEdgeIds,
          mergedNodeIds: applied.mergedNodeIds,
          skippedEdges: applied.skippedEdges,
          warnings: applied.warnings,
        };
        run.status = 'ok';
        run.promptBundle = patch.batchSummary || '';
        run.reasonerSteps = reasoner.steps;
        run.stats = {
          sourceCount: this.sources.readAll().length,
          graphNodeCount: this.graph.readNodes().length,
          graphEdgeCount: this.graph.readEdges().length,
          sourceWindowCount: 0,
          evidenceCount: 0,
          durationMs: Date.now() - started,
          constructTurnIds: batch.batchTurns.map(turn => turn.turnKey),
          constructNewTurnIds: batch.newTurns.map(turn => turn.turnKey),
          constructBatchStart: batch.batchTurns[0]?.turnKey,
          constructBatchEnd: batch.newTurns[batch.newTurns.length - 1]?.turnKey,
          mergedNodeCount: applied.mergedNodeIds.length,
          skippedEdgeCount: applied.skippedEdges.length,
          warningCount: applied.warnings.length,
        };
        run.trace.unshift({
          step: 'construct_graph_context',
          detail: `recall+previous_construct graph ${constructGraph.nodes.length}/${constructGraph.edges.length}`,
          nodeIds: constructGraph.nodes.map(node => node.id),
          edgeIds: constructGraph.edges.map(edge => edge.id),
        });
        this.saveConstructArtifact(artifact);
        this.saveRun(run);
      } catch (error: any) {
        run.status = 'error';
        run.error = String(error?.message || error);
        run.reasonerSteps = reasoner.steps;
        run.stats = {
          ...run.stats,
          sourceCount: this.sources.readAll().length,
          graphNodeCount: this.graph.readNodes().length,
          graphEdgeCount: this.graph.readEdges().length,
          durationMs: Date.now() - started,
          constructTurnIds: batch.batchTurns.map(turn => turn.turnKey),
          constructNewTurnIds: batch.newTurns.map(turn => turn.turnKey),
          constructBatchStart: batch.batchTurns[0]?.turnKey,
          constructBatchEnd: batch.newTurns[batch.newTurns.length - 1]?.turnKey,
        };
        if (run.artifactId) {
          this.saveConstructArtifact({
            artifactId: run.artifactId,
            runId: run.runId,
            timestamp: new Date(started).toISOString(),
            sessionKey: run.sessionKey,
            sessionType: run.sessionType,
            input: {
              sourceBatch: batch.batchRecords.map(source => ({
                sourceId: source.sourceId,
                turnId: source.turnId,
                role: source.role,
                blockType: source.blockType,
                text: source.text,
              })),
              graph: this.compactGraphForConstruct(batch),
            },
            error: run.error,
          });
        }
        this.saveRun(run);
      }
    } finally {
      this.constructRunning = false;
      if (this.nextConstructBatch()) {
        this.scheduleConstruct();
      }
    }
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
      kind: 'recall',
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

  private emptyConstructRun(batch: ConstructBatch, started: number): GauzMemRunRecord {
    const newTurnIds = batch.newTurns.map(turn => turn.turnKey);
    return {
      runId: 'gzr_' + stableHash(`${started}:construct:${newTurnIds.join('|')}`),
      kind: 'construct',
      callType: 'passive',
      sessionKey: batch.newTurns[batch.newTurns.length - 1]?.sessionKey,
      sessionType: batch.newTurns[batch.newTurns.length - 1]?.sessionType,
      query: `[construct] ${newTurnIds.join(' | ')}`,
      timestamp: new Date(started).toISOString(),
      status: 'ok',
      trace: [
        {
          step: 'construct_batch',
          detail: `batch ${batch.batchTurns.map(turn => turn.turnKey).join(' | ')}; new ${newTurnIds.join(' | ')}`,
        },
      ],
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
        constructTurnIds: batch.batchTurns.map(turn => turn.turnKey),
        constructNewTurnIds: newTurnIds,
        constructBatchStart: batch.batchTurns[0]?.turnKey,
        constructBatchEnd: newTurnIds[newTurnIds.length - 1],
      },
    };
  }

  private nextConstructBatch(): ConstructBatch | null {
    const turns = this.sources.readTurns()
      .filter(turn => this.isSessionAllowed(turn.sessionKey, turn.sessionType));
    if (turns.length < CONSTRUCT_NEW_TURN_COUNT) return null;
    if (this.scope() === 'session') {
      const sessionKeys = this.uniqueStrings(turns.map(turn => turn.sessionKey));
      for (const sessionKey of sessionKeys) {
        const batch = this.nextConstructBatchForTurns(turns.filter(turn => turn.sessionKey === sessionKey), sessionKey);
        if (batch) return batch;
      }
      return null;
    }
    return this.nextConstructBatchForTurns(turns);
  }

  private nextConstructBatchForTurns(turns: ReturnType<GauzMemSourceJournal['readTurns']>, sessionKey?: string): ConstructBatch | null {
    if (turns.length < CONSTRUCT_NEW_TURN_COUNT) return null;
      const latestCompleted = [...this.readRuns(500)]
        .reverse()
        .find(run =>
          run.kind === 'construct'
          && run.stats.constructBatchEnd
          && (!sessionKey || run.sessionKey === sessionKey)
        )
      ?.stats.constructBatchEnd;
    const startIndex = latestCompleted
      ? turns.findIndex(turn => turn.turnKey === latestCompleted) + 1
      : 0;
    if (startIndex < 0) return null;
    const pending = turns.slice(startIndex);
    if (pending.length < CONSTRUCT_NEW_TURN_COUNT) return null;
    const batchEnd = startIndex + CONSTRUCT_NEW_TURN_COUNT;
    const contextStart = Math.max(0, batchEnd - CONSTRUCT_CONTEXT_TURN_COUNT);
    const batchTurns = turns.slice(contextStart, batchEnd);
    const newTurns = turns.slice(startIndex, startIndex + CONSTRUCT_NEW_TURN_COUNT);
    return {
      batchTurns,
      newTurns,
      batchRecords: batchTurns.flatMap(turn => turn.records),
    };
  }

  private compactGraphForConstruct(batch: ConstructBatch): {
    nodes: Array<{ id: string; text: string; score?: number }>;
    edges: Array<{ id: string; from: string; to: string; text: string; score?: number }>;
  } {
    const graphIds = this.constructGraphIds(batch);
    const nodeStates = this.graph.readNodeStates();
    const edgeStates = this.graph.readEdgeStates();
    const allNodes = this.graph.readNodes();
    const allEdges = this.graph.readEdges();
    const nodeById = new Map(allNodes.map(node => [node.id, node]));
    const edgeById = new Map(allEdges.map(edge => [edge.id, edge]));
    const nodeIds = new Set(graphIds.nodeIds);
    for (const edgeId of graphIds.edgeIds) {
      const edge = edgeById.get(edgeId);
      if (!edge) continue;
      nodeIds.add(edge.from);
      nodeIds.add(edge.to);
    }
    return {
      nodes: Array.from(nodeIds)
        .map(id => nodeById.get(id))
        .filter((node): node is GauzMemNode => Boolean(node))
        .map(node => ({
        id: node.id,
        text: node.text,
        score: nodeStates.get(node.id)?.score,
      })),
      edges: Array.from(graphIds.edgeIds)
        .map(id => edgeById.get(id))
        .filter((edge): edge is GauzMemEdge => Boolean(edge))
        .map(edge => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        text: edge.text,
        score: edgeStates.get(edge.id)?.score,
      })),
    };
  }

  private constructGraphIds(batch: ConstructBatch): { nodeIds: string[]; edgeIds: string[] } {
    const latestNewTurn = batch.newTurns[batch.newTurns.length - 1];
    const latestRecall = this.latestRecallRunForSession(latestNewTurn?.sessionKey);
    const latestConstruct = this.latestPreviousConstructRun(batch);
    return {
      nodeIds: this.uniqueStrings([
        ...(latestRecall?.selectedNodeIds || []),
        ...(latestConstruct?.createdNodeIds || []),
      ]),
      edgeIds: this.uniqueStrings([
        ...(latestRecall?.selectedEdgeIds || []),
        ...(latestConstruct?.createdEdgeIds || []),
      ]),
    };
  }

  private latestRecallRunForSession(sessionKey?: string): GauzMemRunRecord | null {
    return [...this.readRuns(500)]
      .reverse()
      .find(run =>
        run.kind === 'recall'
        && run.status === 'ok'
        && (!sessionKey || run.sessionKey === sessionKey)
      ) || null;
  }

  private latestPreviousConstructRun(batch: ConstructBatch): GauzMemRunRecord | null {
    const currentEnd = batch.newTurns[batch.newTurns.length - 1]?.turnKey;
    const sessionKey = batch.newTurns[batch.newTurns.length - 1]?.sessionKey;
    return [...this.readRuns(500)]
      .reverse()
      .find(run =>
        run.kind === 'construct'
        && run.status === 'ok'
        && run.stats.constructBatchEnd !== currentEnd
        && (this.scope() !== 'session' || run.sessionKey === sessionKey)
        && ((run.createdNodeIds?.length || 0) > 0 || (run.createdEdgeIds?.length || 0) > 0)
      ) || null;
  }

  private applyGraphPatch(
    patch: GauzMemGraphPatch,
    batchRecords: GauzMemSourceRecord[],
    run: GauzMemRunRecord,
  ): {
    tempToNodeId: Map<string, string>;
    mergedNodeIds: string[];
    skippedEdges: string[];
    warnings: string[];
  } {
    const warnings: string[] = [];
    const skippedEdges: string[] = [];
    const tempToNodeId = new Map<string, string>();
    const batchSourceIds = new Set(batchRecords.map(record => record.sourceId));
    const existingNodeIds = new Set(this.graph.readNodes().map(node => node.id));
    const mergeByTemp = new Map<string, string>();
    const mergedNodeIds: string[] = [];

    for (const merge of patch.merges || []) {
      if (!merge.tempId || !merge.existingNodeId) {
        warnings.push(`invalid_merge:${JSON.stringify(merge)}`);
        continue;
      }
      if (!existingNodeIds.has(merge.existingNodeId)) {
        warnings.push(`merge_target_missing:${merge.tempId}->${merge.existingNodeId}`);
        continue;
      }
      mergeByTemp.set(merge.tempId, merge.existingNodeId);
    }

    for (const nodePatch of patch.nodes || []) {
      const tempId = nodePatch.tempId?.trim();
      const text = nodePatch.text?.trim();
      if (!tempId || !text) {
        warnings.push(`invalid_node:${JSON.stringify(nodePatch)}`);
        continue;
      }
      const evidenceRefs = this.evidenceRefsForSourceIds(nodePatch.sourceIds, batchRecords);
      const mergeTarget = mergeByTemp.get(tempId);
      if (mergeTarget) {
        const merged = this.graph.appendNodeEvidence(mergeTarget, evidenceRefs);
        if (merged) {
          tempToNodeId.set(tempId, merged.id);
          mergedNodeIds.push(merged.id);
          run.trace.push({ step: 'construct_merge_node', detail: `${tempId} -> ${merged.id}`, nodeIds: [merged.id] });
        }
        continue;
      }
      if (evidenceRefs.length === 0) {
        warnings.push(`node_no_valid_source:${tempId}`);
        continue;
      }
      const { node, created, deduped, matchedNodeId } = this.graph.upsertNode(text, evidenceRefs[0]);
      if (evidenceRefs.length > 1) this.graph.appendNodeEvidence(node.id, evidenceRefs.slice(1));
      tempToNodeId.set(tempId, node.id);
      if (created && !run.createdNodeIds.includes(node.id)) run.createdNodeIds.push(node.id);
      if (deduped || matchedNodeId) {
        mergedNodeIds.push(node.id);
        run.trace.push({ step: 'construct_dedup_node', detail: `${tempId} -> ${matchedNodeId || node.id}`, nodeIds: [node.id] });
      }
    }

    for (const edgePatch of patch.edges || []) {
      const from = this.resolvePatchNodeRef(edgePatch.from, tempToNodeId, existingNodeIds);
      const to = this.resolvePatchNodeRef(edgePatch.to, tempToNodeId, existingNodeIds);
      const text = edgePatch.text?.trim();
      if (!from || !to || !text) {
        skippedEdges.push(`invalid_edge:${JSON.stringify(edgePatch)}`);
        continue;
      }
      if (from === to) {
        skippedEdges.push(`self_edge:${edgePatch.from}->${edgePatch.to}`);
        continue;
      }
      if (this.isWeakEdgeText(text)) {
        skippedEdges.push(`weak_edge:${text}`);
        continue;
      }
      const evidenceRefs = this.evidenceRefsForSourceIds(edgePatch.sourceIds || [], batchRecords);
      const fallbackRef = evidenceRefs[0] || this.firstBatchEvidenceRef(batchRecords);
      if (!fallbackRef) {
        skippedEdges.push(`edge_no_source:${edgePatch.from}->${edgePatch.to}`);
        continue;
      }
      const result = this.graph.upsertEdge(from, to, text, fallbackRef);
      if (!result) {
        skippedEdges.push(`edge_not_created:${edgePatch.from}->${edgePatch.to}`);
        continue;
      }
      if (result.created && !run.createdEdgeIds.includes(result.edge.id)) run.createdEdgeIds.push(result.edge.id);
    }

    const detail = [
      `summary ${patch.batchSummary || '(empty)'}`,
      `nodes ${run.createdNodeIds.length}`,
      `edges ${run.createdEdgeIds.length}`,
      `merged ${mergedNodeIds.length}`,
      `warnings ${warnings.length}`,
      `skippedEdges ${skippedEdges.length}`,
      ...(patch.skipped || []).map(item => `llmSkipped:${item}`),
    ].join('; ');
    run.trace.push({
      step: 'construct_apply_patch',
      detail,
      nodeIds: run.createdNodeIds,
      edgeIds: run.createdEdgeIds,
    });
    for (const warning of warnings.slice(0, 20)) run.trace.push({ step: 'construct_warning', detail: warning });
    for (const skipped of skippedEdges.slice(0, 20)) run.trace.push({ step: 'construct_skipped_edge', detail: skipped });

    return { tempToNodeId, mergedNodeIds, skippedEdges, warnings };
  }

  private resolvePatchNodeRef(ref: string, tempToNodeId: Map<string, string>, existingNodeIds: Set<string>): string | null {
    const value = String(ref || '').trim();
    if (!value) return null;
    if (tempToNodeId.has(value)) return tempToNodeId.get(value)!;
    if (existingNodeIds.has(value)) return value;
    return null;
  }

  private evidenceRefsForSourceIds(sourceIds: string[] | undefined, batchRecords: GauzMemSourceRecord[]): GauzMemEvidenceRef[] {
    const sourceMap = new Map(batchRecords.map(record => [record.sourceId, record]));
    return this.uniqueStrings(sourceIds || [])
      .map(sourceId => sourceMap.get(sourceId))
      .filter(Boolean)
      .map(source => this.evidenceRefFromSourceRecord(source as GauzMemSourceRecord));
  }

  private firstBatchEvidenceRef(batchRecords: GauzMemSourceRecord[]): GauzMemEvidenceRef | null {
    const source = batchRecords[0];
    return source ? this.evidenceRefFromSourceRecord(source) : null;
  }

  private evidenceRefFromSourceRecord(source: GauzMemSourceRecord): GauzMemEvidenceRef {
    return {
      sourceId: source.sourceId,
      span: { start: 0, end: source.text.length },
      blockType: source.blockType,
      sourceRef: source.sourceRef,
    };
  }

  private isWeakEdgeText(text: string): boolean {
    const normalized = text.toLowerCase().replace(/\s+/g, '');
    if (normalized.length < 4) return true;
    const weakTerms = ['同主题', '同场景', '同角色', '有关', '相关', 'related', 'relevant', 'sametopic', 'samescene', 'samecharacter'];
    return weakTerms.some(term => normalized === term || normalized.includes(term));
  }

  private budgetFor(callType: GauzMemCallType): GauzMemBudget {
    return callType === 'active'
      ? {
          maxInitialSeeds: 32,
        }
      : {
          maxInitialSeeds: 24,
        };
  }

  private grepQueryPlan(searchTerms: string[], sessionKey?: string): { nodes: GauzMemNode[]; edges: GauzMemEdge[] } {
    const scan = this.filterGraphByScope(this.graph.graphScan(searchTerms), sessionKey);
    return {
      nodes: this.uniqueById([...scan.nodes, ...this.nodesForEdges(scan.edges)]),
      edges: scan.edges,
    };
  }

  private compressRelevanceCandidates(
    searchTerms: string[],
    graphScan: { nodes: GauzMemNode[]; edges: GauzMemEdge[] },
    retrievableGraph: { nodes: GauzMemNode[]; edges: GauzMemEdge[] },
  ): GauzMemRelevanceCandidates {
    const terms = searchTerms.map(term => term.trim()).filter(Boolean);
    if (terms.length === 0 || (graphScan.nodes.length === 0 && graphScan.edges.length === 0)) {
      return {
        nodes: graphScan.nodes,
        edges: graphScan.edges,
        droppedNodeIds: [],
        droppedEdgeIds: [],
        highFrequencyTerms: [],
      };
    }

    const frequencies = this.termFrequencies(terms, retrievableGraph);
    const highTermIndexes = new Set(
      frequencies
        .filter(term => term.level !== 'normal')
        .map(term => term.index),
    );
    const highFrequencyTerms = frequencies.filter(term => term.level !== 'normal');
    if (highTermIndexes.size === 0) {
      return {
        nodes: graphScan.nodes,
        edges: graphScan.edges,
        droppedNodeIds: [],
        droppedEdgeIds: [],
        highFrequencyTerms,
      };
    }

    const edgeTermIndexes = new Map<string, number[]>();
    const nodeTermIndexes = new Map<string, number[]>();
    for (const node of graphScan.nodes) {
      nodeTermIndexes.set(node.id, this.matchedTermIndexes(node.text, terms));
    }
    for (const edge of graphScan.edges) {
      const indexes = this.matchedTermIndexes(edge.text, terms);
      edgeTermIndexes.set(edge.id, indexes);
      for (const nodeId of [edge.from, edge.to]) {
        nodeTermIndexes.set(nodeId, this.uniqueNumbers([
          ...(nodeTermIndexes.get(nodeId) || []),
          ...indexes,
        ]));
      }
    }

    const keepNodeIds = new Set<string>();
    const keepEdgeIds = new Set<string>();
    const singleHighBuckets = new Map<number, Array<{ kind: 'node' | 'edge'; id: string }>>();
    const multiHighOnly: Array<{ kind: 'node' | 'edge'; id: string; termIndexes: number[] }> = [];

    const classify = (kind: 'node' | 'edge', id: string, termIndexes: number[]) => {
      const distinct = this.uniqueNumbers(termIndexes);
      if (distinct.length === 0 || distinct.some(index => !highTermIndexes.has(index))) {
        if (kind === 'node') keepNodeIds.add(id);
        else keepEdgeIds.add(id);
        return;
      }
      if (distinct.length === 1) {
        const index = distinct[0];
        const bucket = singleHighBuckets.get(index) || [];
        bucket.push({ kind, id });
        singleHighBuckets.set(index, bucket);
        return;
      }
      multiHighOnly.push({ kind, id, termIndexes: distinct });
    };

    for (const node of graphScan.nodes) classify('node', node.id, nodeTermIndexes.get(node.id) || []);
    for (const edge of graphScan.edges) classify('edge', edge.id, edgeTermIndexes.get(edge.id) || []);

    for (const [termIndex, bucket] of singleHighBuckets) {
      const frequency = frequencies[termIndex];
      const limit = frequency?.level === 'very_high' ? VERY_HIGH_ONLY_SINGLE_LIMIT : HIGH_ONLY_SINGLE_LIMIT;
      for (const candidate of this.rankCandidates(bucket, retrievableGraph).slice(0, limit)) {
        if (candidate.kind === 'node') keepNodeIds.add(candidate.id);
        else keepEdgeIds.add(candidate.id);
      }
    }

    const multiLimit = multiHighOnly.some(candidate =>
      candidate.termIndexes.some(index => frequencies[index]?.level === 'very_high')
    ) ? VERY_HIGH_ONLY_SINGLE_LIMIT : HIGH_ONLY_MULTI_LIMIT;
    for (const candidate of this.rankCandidates(multiHighOnly, retrievableGraph).slice(0, multiLimit)) {
      if (candidate.kind === 'node') keepNodeIds.add(candidate.id);
      else keepEdgeIds.add(candidate.id);
    }

    const nodes = graphScan.nodes.filter(node => keepNodeIds.has(node.id));
    const edges = graphScan.edges.filter(edge => keepEdgeIds.has(edge.id));
    return {
      nodes,
      edges,
      droppedNodeIds: graphScan.nodes.map(node => node.id).filter(id => !keepNodeIds.has(id)),
      droppedEdgeIds: graphScan.edges.map(edge => edge.id).filter(id => !keepEdgeIds.has(id)),
      highFrequencyTerms,
    };
  }

  private termFrequencies(
    terms: string[],
    graph: { nodes: GauzMemNode[]; edges: GauzMemEdge[] },
  ): GauzMemTermFrequency[] {
    const denominator = Math.max(1, graph.nodes.length + graph.edges.length);
    return terms.map((term, index) => {
      const hitCount = graph.nodes.filter(node => this.textIncludesTerm(node.text, term)).length
        + graph.edges.filter(edge => this.textIncludesTerm(edge.text, term)).length;
      const ratio = hitCount / denominator;
      return {
        term,
        index,
        hitCount,
        ratio,
        level: ratio >= VERY_HIGH_FREQUENCY_TERM_RATIO
          ? 'very_high'
          : ratio >= HIGH_FREQUENCY_TERM_RATIO
            ? 'high'
            : 'normal',
      };
    });
  }

  private matchedTermIndexes(text: string, terms: string[]): number[] {
    const indexes: number[] = [];
    for (let index = 0; index < terms.length; index += 1) {
      if (this.textIncludesTerm(text, terms[index])) indexes.push(index);
    }
    return indexes;
  }

  private textIncludesTerm(text: string, term: string): boolean {
    const value = term.trim().toLowerCase();
    return Boolean(value) && text.toLowerCase().includes(value);
  }

  private rankCandidates<T extends { kind: 'node' | 'edge'; id: string }>(
    candidates: T[],
    graph: { nodes: GauzMemNode[]; edges: GauzMemEdge[] },
  ): T[] {
    const nodeStates = this.graph.readNodeStates();
    const edgeStates = this.graph.readEdgeStates();
    const degree = this.degreeMap(graph.edges);
    return [...candidates].sort((a, b) =>
      this.candidateScore(b, nodeStates, edgeStates, degree)
      - this.candidateScore(a, nodeStates, edgeStates, degree)
      || a.id.localeCompare(b.id)
    );
  }

  private candidateScore(
    candidate: { kind: 'node' | 'edge'; id: string },
    nodeStates: ReturnType<GauzMemGraphStore['readNodeStates']>,
    edgeStates: ReturnType<GauzMemGraphStore['readEdgeStates']>,
    degree: Map<string, number>,
  ): number {
    const state = candidate.kind === 'node' ? nodeStates.get(candidate.id) : edgeStates.get(candidate.id);
    const score = state?.score ?? 0.45;
    const selected = state?.selectedCount ?? 0;
    const updated = Date.parse(state?.updatedAt || '') || 0;
    const degreeScore = candidate.kind === 'node' ? (degree.get(candidate.id) || 0) : 0;
    return score * 1_000_000
      + Math.min(selected, 1000) * 1_000
      + Math.min(updated / 1_000_000_000, 1000)
      + Math.min(degreeScore, 100) * 0.001;
  }

  private limitNearbyContext(
    anchorIds: string[],
    selected: { nodeIds: string[]; edgeIds: string[] },
    disclosed: { nodes: GauzMemNode[]; edges: GauzMemEdge[] },
  ): GauzMemNearbyContext {
    const selectedNodeIds = new Set(selected.nodeIds);
    const selectedEdgeIds = new Set(selected.edgeIds);
    const rawNodeIds = this.uniqueStrings(disclosed.nodes
      .map(node => node.id)
      .filter(id => !selectedNodeIds.has(id)));
    const rawEdgeIds = this.uniqueStrings(disclosed.edges
      .map(edge => edge.id)
      .filter(id => !selectedEdgeIds.has(id)));
    const edgeMap = new Map(disclosed.edges.map(edge => [edge.id, edge]));
    const nodeMap = new Map(disclosed.nodes.map(node => [node.id, node]));
    const rankedEdges = this.rankNearbyEdges(rawEdgeIds.map(id => edgeMap.get(id)).filter(Boolean) as GauzMemEdge[], anchorIds);
    const chosenEdgeIds: string[] = [];
    const chosenEdgeSet = new Set<string>();
    const anchorSet = new Set(anchorIds);
    for (const anchorId of anchorIds) {
      if (chosenEdgeIds.length >= ONE_HOP_MAX_NEARBY_EDGES) break;
      const localEdges = rankedEdges.filter(item =>
        !chosenEdgeSet.has(item.id)
        && (item.from === anchorId || item.to === anchorId)
      ).slice(0, ONE_HOP_MIN_EDGES_PER_ANCHOR);
      for (const edge of localEdges) {
        if (chosenEdgeIds.length >= ONE_HOP_MAX_NEARBY_EDGES) break;
        chosenEdgeIds.push(edge.id);
        chosenEdgeSet.add(edge.id);
      }
    }
    for (const edge of rankedEdges) {
      if (chosenEdgeIds.length >= ONE_HOP_MAX_NEARBY_EDGES) break;
      if (chosenEdgeSet.has(edge.id)) continue;
      chosenEdgeIds.push(edge.id);
      chosenEdgeSet.add(edge.id);
    }
    const edgeNodeIds = chosenEdgeIds.flatMap(id => {
      const edge = edgeMap.get(id);
      if (!edge) return [];
      return [edge.from, edge.to].filter(nodeId => !anchorSet.has(nodeId) && !selectedNodeIds.has(nodeId));
    });
    const rankedNodes = this.rankNearbyNodes(
      this.uniqueStrings([...edgeNodeIds, ...rawNodeIds])
        .map(id => nodeMap.get(id))
        .filter(Boolean) as GauzMemNode[],
      chosenEdgeIds.map(id => edgeMap.get(id)).filter(Boolean) as GauzMemEdge[],
    );
    return {
      rawNodeIds,
      rawEdgeIds,
      edgeIds: chosenEdgeIds,
      nodeIds: rankedNodes.slice(0, ONE_HOP_MAX_NEARBY_NODES).map(node => node.id),
    };
  }

  private rankNearbyEdges(edges: GauzMemEdge[], anchorIds: string[]): GauzMemEdge[] {
    const anchorSet = new Set(anchorIds);
    const nodeStates = this.graph.readNodeStates();
    const edgeStates = this.graph.readEdgeStates();
    const degree = this.degreeMap(this.graph.readEdges());
    return [...edges].sort((a, b) =>
      this.edgeScore(b, edgeStates, nodeStates, degree, anchorSet)
      - this.edgeScore(a, edgeStates, nodeStates, degree, anchorSet)
      || a.id.localeCompare(b.id)
    );
  }

  private rankNearbyNodes(nodes: GauzMemNode[], selectedEdges: GauzMemEdge[]): GauzMemNode[] {
    const nodeStates = this.graph.readNodeStates();
    const connectedCount = new Map<string, number>();
    for (const edge of selectedEdges) {
      connectedCount.set(edge.from, (connectedCount.get(edge.from) || 0) + 1);
      connectedCount.set(edge.to, (connectedCount.get(edge.to) || 0) + 1);
    }
    return [...nodes].sort((a, b) =>
      (connectedCount.get(b.id) || 0) - (connectedCount.get(a.id) || 0)
      || (nodeStates.get(b.id)?.score ?? 0.45) - (nodeStates.get(a.id)?.score ?? 0.45)
      || a.id.localeCompare(b.id)
    );
  }

  private edgeScore(
    edge: GauzMemEdge,
    edgeStates: Map<string, { score: number }>,
    nodeStates: Map<string, { score: number }>,
    degree: Map<string, number>,
    anchorSet: Set<string>,
  ): number {
    const edgeScore = edgeStates.get(edge.id)?.score ?? 0.45;
    const fromScore = nodeStates.get(edge.from)?.score ?? 0.45;
    const toScore = nodeStates.get(edge.to)?.score ?? 0.45;
    const anchorBoost = (anchorSet.has(edge.from) ? 0.08 : 0) + (anchorSet.has(edge.to) ? 0.08 : 0);
    const degreeBoost = Math.min(0.08, ((degree.get(edge.from) || 0) + (degree.get(edge.to) || 0)) * 0.004);
    return edgeScore * 0.65 + Math.max(fromScore, toScore) * 0.25 + anchorBoost + degreeBoost;
  }

  private degreeMap(edges: GauzMemEdge[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const edge of edges) {
      map.set(edge.from, (map.get(edge.from) || 0) + 1);
      map.set(edge.to, (map.get(edge.to) || 0) + 1);
    }
    return map;
  }

  private buildPromptMemory(
    selection: {
      selectedNodeIds: string[];
      selectedEdgeIds: string[];
    },
    sessionKey?: string,
    nearbyContext?: GauzMemNearbyContext,
  ): GauzMemPromptMemory {
    const edgeMap = new Map(this.graph.readEdges().map(edge => [edge.id, edge]));
    const selectedNodeSet = new Set(selection.selectedNodeIds);
    const selectedEdgeSet = new Set(selection.selectedEdgeIds);
    const anchors = this.uniqueStrings([
      ...selection.selectedNodeIds,
      ...selection.selectedEdgeIds.flatMap(id => {
        const edge = edgeMap.get(id);
        return edge ? [edge.from, edge.to] : [];
      }),
    ]);
    const disclosed = !nearbyContext && anchors.length > 0
      ? this.filterGraphByScope(this.graph.disclose(anchors), sessionKey)
      : { nodes: [], edges: [] };
    return {
      selectedNodeIds: selection.selectedNodeIds,
      selectedEdgeIds: selection.selectedEdgeIds,
      nearbyNodeIds: nearbyContext
        ? this.uniqueStrings(nearbyContext.nodeIds.filter(id => !selectedNodeSet.has(id)))
        : this.uniqueStrings(disclosed.nodes.map(node => node.id).filter(id => !selectedNodeSet.has(id))),
      nearbyEdgeIds: nearbyContext
        ? this.uniqueStrings(nearbyContext.edgeIds.filter(id => !selectedEdgeSet.has(id)))
        : this.uniqueStrings(disclosed.edges.map(edge => edge.id).filter(id => !selectedEdgeSet.has(id))),
    };
  }

  private buildPromptBundle(rootQuery: string, searchTerms: string[], memory: GauzMemPromptMemory): string {
    const nodeMap = new Map(this.graph.readNodes().map(node => [node.id, node]));
    const edgeMap = new Map(this.graph.readEdges().map(edge => [edge.id, edge]));
    const relevantLines: string[] = [];
    for (const id of memory.selectedNodeIds) {
      const node = nodeMap.get(id);
      if (node) relevantLines.push(`- ${node.text}`);
    }
    for (const id of memory.selectedEdgeIds) {
      const edge = edgeMap.get(id);
      if (edge) relevantLines.push(`- ${edge.text}`);
    }
    const nearbyLines: string[] = [];
    for (const id of memory.nearbyNodeIds) {
      const node = nodeMap.get(id);
      if (node) nearbyLines.push(`- ${node.text}`);
    }
    for (const id of memory.nearbyEdgeIds) {
      const edge = edgeMap.get(id);
      if (edge) nearbyLines.push(`- ${edge.text}`);
    }
    if (relevantLines.length === 0 && nearbyLines.length === 0) return '';
    const lines = [
      `Root query: ${rootQuery}`,
      searchTerms.length > 0 ? `Terms: ${searchTerms.join(', ')}` : '',
      '',
    ];
    if (relevantLines.length > 0) {
      lines.push('Relevant memory:');
      lines.push(...relevantLines);
    }
    if (nearbyLines.length > 0) {
      if (relevantLines.length > 0) lines.push('');
      lines.push('Nearby memory context:');
      lines.push(...nearbyLines);
    }
    return lines.filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== '')).join('\n');
  }

  private scope(): GauzMemScope {
    return String(process.env.GAUZMEM_SCOPE || 'global').toLowerCase() === 'session' ? 'session' : 'global';
  }

  isPromptInjectionEnabled(): boolean {
    return ConfigManager.getConfigReadonly().gauzmem?.promptInjectionEnabled !== false;
  }

  private hasPromptInjectionEnvOverride(): boolean {
    return String(process.env.GAUZMEM_PROMPT_INJECTION || '').trim().length > 0;
  }

  private isSessionAllowed(sessionKey?: string, sessionType?: string): boolean {
    const sessionPatterns = this.envList('GAUZMEM_SESSION_ALLOWLIST');
    const sessionTypes = this.envList('GAUZMEM_SESSION_TYPE_ALLOWLIST');
    if (sessionPatterns.length > 0) {
      const key = sessionKey || '';
      if (!sessionPatterns.some(pattern => this.matchesSessionPattern(pattern, key))) return false;
    }
    if (sessionTypes.length > 0) {
      const type = sessionType || '';
      if (!sessionTypes.includes(type)) return false;
    }
    return true;
  }

  private envList(name: string): string[] {
    return String(process.env[name] || '')
      .split(/[,\n;]/)
      .map(item => item.trim())
      .filter(Boolean);
  }

  private matchesSessionPattern(pattern: string, sessionKey: string): boolean {
    if (pattern.endsWith('*')) return sessionKey.startsWith(pattern.slice(0, -1));
    return pattern === sessionKey;
  }

  private filterGraphByScope<T extends { nodes: GauzMemNode[]; edges: GauzMemEdge[] }>(graph: T, sessionKey?: string): T {
    if (this.scope() !== 'session' || !sessionKey) return graph;
    const sourceSessionById = new Map(this.sources.readAll().map(source => [source.sourceId, source.sessionKey]));
    const nodeAllowed = (node: GauzMemNode) =>
      (node.evidenceRefs || [])
        .some(ref => sourceSessionById.get(ref.sourceId) === sessionKey);
    const allowedNodeIds = new Set(graph.nodes.filter(nodeAllowed).map(node => node.id));
    const edgeAllowed = (edge: GauzMemEdge) =>
      allowedNodeIds.has(edge.from)
      && allowedNodeIds.has(edge.to)
      && (edge.evidenceRefs || []).some(ref => sourceSessionById.get(ref.sourceId) === sessionKey);
    const edges = graph.edges.filter(edgeAllowed);
    for (const edge of edges) {
      allowedNodeIds.add(edge.from);
      allowedNodeIds.add(edge.to);
    }
    return {
      ...graph,
      nodes: graph.nodes.filter(node => allowedNodeIds.has(node.id)),
      edges,
    };
  }

  private emptySelection(): ReturnTypeShape {
    return {
      selectedNodeIds: [],
      selectedEdgeIds: [],
      rejectedNodeIds: [],
      rejectedEdgeIds: [],
    };
  }

  private nodesForEdges(edges: GauzMemEdge[]): GauzMemNode[] {
    const nodeMap = new Map(this.graph.readNodes().map(node => [node.id, node]));
    return this.uniqueById(edges
      .flatMap(edge => [nodeMap.get(edge.from), nodeMap.get(edge.to)])
      .filter(Boolean) as GauzMemNode[]);
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

  private uniqueStrings(items: string[]): string[] {
    return Array.from(new Set(items.map(item => item.trim()).filter(Boolean)));
  }

  private uniqueNumbers(items: number[]): number[] {
    return Array.from(new Set(items.filter(item => Number.isFinite(item))));
  }

  private ratio(count: number, total: number): number {
    return total > 0 ? count / total : 0;
  }

  private percent(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
  }

  private saveRun(run: GauzMemRunRecord): void {
    appendJsonl(GauzMemFiles.runs(), run);
  }

  private saveGraphSnapshot(run: GauzMemRunRecord, sessionKey?: string): string {
    const snapshotId = 'gzs_' + stableHash(`${run.runId}:graph_snapshot`);
    const nodeStates = this.graph.readNodeStates();
    const edgeStates = this.graph.readEdgeStates();
    const scopedGraph = this.filterGraphByScope(
      { nodes: this.graph.readNodes(), edges: this.graph.readEdges() },
      sessionKey,
    );
    const nodeIds = new Set(scopedGraph.nodes.map(node => node.id));
    const edgeIds = new Set(scopedGraph.edges.map(edge => edge.id));
    const stateItem = (id: string, state: { score: number; faded: boolean } | undefined) => ({
      id,
      score: state?.score ?? 0.45,
      faded: Boolean(state?.faded),
    });
    const allNodes = scopedGraph.nodes.map(node => stateItem(node.id, nodeStates.get(node.id)));
    const allEdges = scopedGraph.edges
      .filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to) && edgeIds.has(edge.id))
      .map(edge => stateItem(edge.id, edgeStates.get(edge.id)));
    const snapshot: GauzMemGraphSnapshot = {
      snapshotId,
      runId: run.runId,
      timestamp: new Date().toISOString(),
      scope: this.scope(),
      sessionKey,
      normalNodes: allNodes.filter(item => !item.faded && item.score >= SNAPSHOT_NORMAL_THRESHOLD),
      normalEdges: allEdges.filter(item => !item.faded && item.score >= SNAPSHOT_NORMAL_THRESHOLD),
      deepNodes: allNodes.filter(item => !item.faded && item.score >= SNAPSHOT_DEEP_THRESHOLD),
      deepEdges: allEdges.filter(item => !item.faded && item.score >= SNAPSHOT_DEEP_THRESHOLD),
    };
    appendJsonl(GauzMemFiles.graphSnapshots(), snapshot);
    return snapshotId;
  }

  private saveConstructArtifact(artifact: GauzMemConstructArtifact): void {
    appendJsonl(GauzMemFiles.constructArtifacts(), artifact);
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

type GauzMemBudget = {
  maxInitialSeeds: number;
};

type ConstructBatch = {
  batchTurns: ReturnType<GauzMemSourceJournal['readTurns']>;
  newTurns: ReturnType<GauzMemSourceJournal['readTurns']>;
  batchRecords: GauzMemSourceRecord[];
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
