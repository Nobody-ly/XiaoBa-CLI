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
  GauzMemEdge,
  GauzMemEvidenceRef,
  GauzMemGraphPatch,
  GauzMemNode,
  GauzMemRecallResult,
  GauzMemRunRecord,
  GauzMemSourceRecord,
} from './types';

const CONSTRUCT_NEW_TURN_COUNT = 1;
const CONSTRUCT_CONTEXT_TURN_COUNT = 2;
type GauzMemScope = 'global' | 'session';

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
  private constructScheduled = false;
  private constructRunning = false;

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
    const budget = this.budgetFor(params.callType);

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

      let finalSelection = this.emptySelection();
      const graphRounds = 1;
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

      const graphScan = this.filterGraphByScope(this.graph.graphScan(queryPlan.searchTerms), params.sessionKey);
      run.trace.push({
        step: 'graph_scan',
        nodeIds: graphScan.nodes.map(node => node.id),
        edgeIds: graphScan.edges.map(edge => edge.id),
      });

      const initialSeedNodes = graphScan.nodes.slice(0, budget.maxInitialSeeds);
      const graphSeedNodeIds = this.uniqueStrings([
        ...initialSeedNodes.map(node => node.id),
        ...graphScan.edges.flatMap(edge => [edge.from, edge.to]),
      ]).slice(0, budget.maxInitialSeeds);
      const disclosed = this.filterGraphByScope(this.graph.disclose(graphSeedNodeIds), params.sessionKey);
      const candidateNodes = this.uniqueById([
        ...initialSeedNodes,
        ...this.nodesForEdges(graphScan.edges),
        ...disclosed.nodes,
      ]);
      const candidateEdges = this.uniqueById([...graphScan.edges, ...disclosed.edges]);
      run.trace.push({
        step: 'disclose_initial',
        nodeIds: disclosed.nodes.map(node => node.id),
        edgeIds: disclosed.edges.map(edge => edge.id),
      });

      const initialSelection = await reasoner.selectRelevant({
        rootQuery: queryPlan.rootQuery,
        nodes: candidateNodes,
        edges: candidateEdges,
      });
      run.trace.push({
        step: 'relevance_graph_initial',
        detail: `selected ${initialSelection.selectedNodeIds.length}/${initialSelection.selectedEdgeIds.length}, rejected ${initialSelection.rejectedNodeIds.length}/${initialSelection.rejectedEdgeIds.length}`,
        nodeIds: initialSelection.selectedNodeIds,
        edgeIds: initialSelection.selectedEdgeIds,
      });
      finalSelection = this.mergeSelection(finalSelection, initialSelection);

      const weightChanges = [
        ...decayChanges,
        ...this.graph.applySelection({ ...finalSelection, currentTurn: memoryTurn }),
      ];
      const faded = this.graph.getFadedIds();

      run.selectedNodeIds = finalSelection.selectedNodeIds;
      run.selectedEdgeIds = finalSelection.selectedEdgeIds;
      run.rejectedNodeIds = finalSelection.rejectedNodeIds;
      run.rejectedEdgeIds = finalSelection.rejectedEdgeIds;
      run.fadedNodeIds = faded.nodeIds;
      run.fadedEdgeIds = faded.edgeIds;
      run.weightChanges = weightChanges;
      run.promptBundle = this.buildPromptBundle(run.selectedNodeIds, run.selectedEdgeIds);
      run.status = 'ok';
      run.stats = {
        sourceCount: this.sources.readAll().length,
        graphNodeCount: this.graph.readNodes().length,
        graphEdgeCount: this.graph.readEdges().length,
        sourceWindowCount: 0,
        evidenceCount: 0,
        durationMs: Date.now() - started,
        frontierSteps: graphRounds,
        rootConstructCount: 0,
        nodeConstructCount: 0,
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
        const patch = await reasoner.buildGraphPatch({
          sourceBatch: batch.batchRecords.map(source => ({
            sourceId: source.sourceId,
            turnId: source.turnId,
            role: source.role,
            blockType: source.blockType,
            text: source.text,
          })),
          graph: constructGraph,
        });
        const applied = this.applyGraphPatch(patch, batch.batchRecords, run);
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
        this.saveRun(run);
      } catch (error: any) {
        run.status = 'error';
        run.error = String(error?.message || error);
        run.reasonerSteps = reasoner.steps;
        run.stats.durationMs = Date.now() - started;
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
        && run.status === 'ok'
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

  private scope(): GauzMemScope {
    return String(process.env.GAUZMEM_SCOPE || 'global').toLowerCase() === 'session' ? 'session' : 'global';
  }

  private isPromptInjectionEnabled(): boolean {
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
