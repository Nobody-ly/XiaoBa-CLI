import { AIService } from '../utils/ai-service';
import type { Message } from '../types';
import type { ToolDefinition } from '../types/tool';
import { truncateText } from './hash';
import type {
  GauzMemEdge,
  GauzMemExtractedEvidence,
  GauzMemGraphPatch,
  GauzMemNode,
  GauzMemQueryPlan,
  GauzMemReasonerStep,
  GauzMemSourceWindow,
} from './types';

const QUERY_PLAN_TOOL = 'submit_gauzmem_query_plan';
const RELEVANCE_TOOL = 'submit_gauzmem_relevance';
const EVIDENCE_TOOL = 'submit_gauzmem_evidence';
const PARENT_TERMS_TOOL = 'submit_gauzmem_parent_terms';
const GRAPH_PATCH_TOOL = 'submit_gauzmem_graph_patch';
const MAX_TOOL_ATTEMPTS = 5;

export class GauzMemReasoner {
  readonly steps: GauzMemReasonerStep[] = [];
  private readonly ai = new AIService({ temperature: 0, maxTokens: 4096 });

  async probe(): Promise<{ ok: boolean; response?: unknown; error?: string }> {
    try {
      const result = await this.callSubmitTool('probe', 'Return rootQuery="memory" and searchTerms=["memory"].', this.queryPlanTool());
      return { ok: true, response: result };
    } catch (error: any) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  async buildQueryPlan(params: {
    userInput: string;
    previousUser?: string;
    previousAssistant?: string;
    sessionKey?: string;
    sessionType?: string;
  }): Promise<GauzMemQueryPlan> {
    const prompt = [
      'You build search queries for a long-term memory graph.',
      `Call ${QUERY_PLAN_TOOL} with the result.`,
      'Rules:',
      '- rootQuery is a concise resolved query, using recent context only to resolve references like "continue", "that", "he/she/it".',
      '- If the current input starts by naming or addressing a character/person, usually include that name when the user is roleplaying them, asking about them, observing them, or acting through them.',
      '- Do not automatically drop addressee/speaker names. Drop them only when they are pure UI routing labels and clearly irrelevant to the memory search.',
      '- Resolve pronouns such as 他/她/它/that/he/she/it from the recent context, then include the resolved name if it is central to the request.',
      '- searchTerms are literal grep anchors for a long-term memory graph, not explanations.',
      '- A good anchor is a literal word or short phrase likely to appear verbatim in memory: person/entity, place, object, rule, file/module, state, event, decision, identifier, date, number, or unique phrase.',
      '- Cover each explicit question or requested check with at least one anchor when possible.',
      '- Include core participants even if they may be frequent, because the retriever will handle high-frequency terms after grep.',
      '- Avoid obvious generic/filler words, pronouns, current-only instructions, generic verbs, and vague labels like 情况/信息/东西/问题.',
      '- Prefer atomic grep terms over combined fact phrases. Split compound phrases unless the whole phrase is a stable proper name or fixed title.',
      '- For example, prefer ["父亲", "昏迷"] over ["父亲昏迷"], and ["书房", "抽屉"] over ["书房抽屉"].',
      '- Each array item must be one standalone anchor. Do not pack multiple anchors into one item with spaces.',
      '- Include stable aliases only when likely to appear in memory; do not add broad synonyms that are unlikely to be written verbatim.',
      '- Prefer 2-3 Chinese characters for ordinary terms, unless the term is a proper name, title, file/module name, protocol, identifier, or other fixed phrase.',
      '- Prefer 1-2 English tokens for ordinary terms. Use 3+ English tokens only for stable proper names, official titles, file paths, module names, protocol names, or established identifiers likely to appear verbatim.',
      '- Prefer 4-6 search terms. Use 7-8 only when the request truly has multiple stable anchors.',
      '- Prefer a compact but sufficient set; every term should be independently useful for grep.',
      '- If unsure, prefer cleaner atomic anchors over fewer combined phrases.',
      'Bad searchTerms examples:',
      '- ["客户A 合同延期", "报价表 价格", "父亲昏迷", "书房抽屉", "劳伦 伊莲娜"]',
      'Good searchTerms examples:',
      '- ["客户A", "延期", "报价表", "价格"]',
      '- ["父亲", "昏迷", "书房", "抽屉", "劳伦", "伊莲娜"]',
      '',
      `Session: ${params.sessionType || 'unknown'} ${params.sessionKey || ''}`,
      `Current user input: ${truncateText(params.userInput, 1600)}`,
      `Previous user input: ${truncateText(params.previousUser || '', 800)}`,
      `Previous assistant final reply: ${params.previousAssistant || ''}`,
    ].join('\n');
    const json = await this.callSubmitTool('query_build', prompt, this.queryPlanTool());
    return {
      rootQuery: this.stringValue(json.rootQuery) || params.userInput,
      searchTerms: this.uniqueStrings(this.stringArray(json.searchTerms)),
    };
  }

  async extractEvidence(rootQuery: string, windows: GauzMemSourceWindow[], parent?: GauzMemNode): Promise<GauzMemExtractedEvidence[]> {
    if (windows.length === 0) return [];
    const prompt = [
      parent
        ? 'Extract only durable memory evidence that has a clear factual relationship to the parent memory.'
        : 'Extract durable memory evidence from source windows.',
      `Call ${EVIDENCE_TOOL} with the result.`,
      parent
        ? 'For node construct, every evidence item must include windowRef, text, and relationToParent.whyRelevant.'
        : 'For root construct, every evidence item must include windowRef and text.',
      'Rules:',
      '- windowRef must be copied exactly from one provided window.',
      '- text is the memory node fact: rewrite the selected window into a concise standalone factual statement.',
      '- Preserve important numbers, probabilities, dates, names, aliases, places, object names, protocol names, model names, and other searchable keywords from the window.',
      '- Do not over-summarize; keep enough concrete anchors for future grep retrieval.',
      '- The fact text must be directly supported by the referenced window and must not add facts from outside it.',
      '- Do not invent facts.',
      '- If a window is irrelevant or only procedural noise, omit it.',
      '- Do not extract task descriptions, tool arguments, file paths, run status, dashboard text, headings, or process summaries as evidence.',
      parent
        ? '- Output evidence when it has a concrete factual relationship to the parent memory, or when it is in the same plot chain and adds a constraint, cause, consequence, state, goal, or risk.'
        : '- For root construct, output durable facts related to current plot state, character state, action constraints, world facts, mission goals, unresolved risks, or facts directly useful for the root query.',
      parent
        ? '- Do not output facts that only repeat, rephrase, or merely confirm the parent memory. The fact must add new concrete information beyond the parent.'
        : '',
      parent
        ? '- relationToParent.whyRelevant must be Chinese, 20-80 characters, and state the concrete relationship between the parent fact and evidence fact.'
        : '',
      parent
        ? '- Good relation examples: 确认：导航核心可拔出并转接到猫头鹰号 / 补充：折剑号提供坐标与启动密钥 / 因果：启动第七艘船可能触发 Blackbird 人格风险。'
        : '',
      parent
        ? '- Do not use English templates like Parent fact, Evidence, This confirms, This supports, or vague relation text such as same topic, same scene, same character, related, or relevant.'
        : '',
      '',
      `Root query: ${rootQuery}`,
      parent ? `Parent memory: ${parent.text}` : '',
      'Windows:',
      JSON.stringify(windows.map((w, index) => ({
        windowRef: `w${index}`,
        blockType: w.blockType,
        matchedTerms: w.matchedTerms,
        text: truncateText(w.text, 1800),
      }))),
    ].join('\n');
    const json = await this.callSubmitTool('extract_evidence', prompt, this.evidenceTool());
    return Array.isArray(json.evidence)
      ? json.evidence
          .map((item: any) => ({
            windowRef: this.stringValue(item.windowRef),
            text: this.stringValue(item.text || item.fact),
            relationToParent: this.relationValue(item.relationToParent),
          }))
          .map((item: any) => {
            const index = /^w(\d+)$/.exec(item.windowRef || '')?.[1];
            const window = typeof index === 'string' ? windows[Number(index)] : undefined;
            if (!window || !item.text) return null;
            return {
              sourceId: window.sourceId,
              span: window.span,
              sourceSnippet: window.text,
              text: item.text,
              relationToParent: item.relationToParent,
            };
          })
          .filter(Boolean)
          .slice(0, 24)
      : [];
  }

  async buildParentSearchTerms(parent: GauzMemNode, sourceContext: string): Promise<string[]> {
    const prompt = [
      'You build grep search terms for expanding one memory node in a source journal.',
      `Call ${PARENT_TERMS_TOOL} with the result.`,
      'Rules:',
      '- Use only the parent memory and source context to choose terms; do not use the current user query.',
      '- Return grep literals, not natural-language descriptions.',
      '- Preserve multi-word proper names, protocol names, model names, object names, aliases, numbers, and codes.',
      '- Prefer terms that can find neighboring facts, causes, consequences, constraints, locations, identities, or unresolved risks related to the parent.',
      '- Avoid generic words, pronouns, standalone common English words, and terms that are too broad.',
      '- Keep 4-10 terms.',
      '',
      `Parent memory: ${parent.text}`,
      `Parent source context: ${truncateText(sourceContext, 2400)}`,
    ].join('\n');
    const json = await this.callSubmitTool('parent_terms', prompt, this.parentTermsTool());
    return this.stringArray(json.searchTerms).slice(0, 12);
  }

  async selectRelevant(params: {
    rootQuery: string;
    nodes: GauzMemNode[];
    edges: GauzMemEdge[];
  }): Promise<{
    selectedNodeIds: string[];
    selectedEdgeIds: string[];
    rejectedNodeIds: string[];
    rejectedEdgeIds: string[];
  }> {
    if (params.nodes.length === 0 && params.edges.length === 0) {
      return { selectedNodeIds: [], selectedEdgeIds: [], rejectedNodeIds: [], rejectedEdgeIds: [] };
    }
    const prompt = [
      'Judge which graph memories help answer or continue the root query.',
      `Call ${RELEVANCE_TOOL} with the result.`,
      'Rules:',
      '- Select memories that either directly answer/continue the root query, or concretely add current scene state, character state, action constraints, key world facts, unresolved risks, causes, or consequences.',
      '- Precision first, but do not reject durable background/state/constraint facts merely because they are not a direct answer.',
      '- Put only useful memory ids in selectedNodeIds/selectedEdgeIds.',
      '- Return selectedNodeIds and selectedEdgeIds in descending usefulness order.',
      '- Do not output rejectedNodeIds or rejectedEdgeIds.',
      '- Candidates omitted from selected are automatically treated as rejected by the caller.',
      '- Reject candidates that only share a character, place, tool name, file path, source window, scene, or incidental phrase.',
      '- Reject task/process/title-like memories unless the concrete fact itself helps answer or continue the root query.',
      '- Select an edge only when the edge relation text itself is useful; do not select an edge merely because one endpoint is useful.',
      '- Keep associative recall only when the association gives a concrete fact needed by the root query.',
      '- A candidate id must not appear in both selected and rejected.',
      '',
      `Root query: ${params.rootQuery}`,
      'Nodes:',
      JSON.stringify(params.nodes.map(n => ({ id: n.id, text: n.text }))),
      'Edges:',
      JSON.stringify(params.edges.map(e => ({ id: e.id, from: e.from, to: e.to, text: e.text }))),
    ].join('\n');
    const json = await this.callSubmitTool('relevance', prompt, this.relevanceTool());
    const nodeIds = new Set(params.nodes.map(n => n.id));
    const edgeIds = new Set(params.edges.map(e => e.id));
    const selectedNodeIds = this.stringArray(json.selectedNodeIds).filter(id => nodeIds.has(id));
    const selectedEdgeIds = this.stringArray(json.selectedEdgeIds).filter(id => edgeIds.has(id));
    const selectedNodeSet = new Set(selectedNodeIds);
    const selectedEdgeSet = new Set(selectedEdgeIds);
    const rejectedNodeIds: string[] = [];
    const rejectedEdgeIds: string[] = [];
    for (const id of nodeIds) {
      if (!selectedNodeSet.has(id) && !rejectedNodeIds.includes(id)) rejectedNodeIds.push(id);
    }
    for (const id of edgeIds) {
      if (!selectedEdgeSet.has(id) && !rejectedEdgeIds.includes(id)) rejectedEdgeIds.push(id);
    }
    return { selectedNodeIds, selectedEdgeIds, rejectedNodeIds, rejectedEdgeIds };
  }

  async buildGraphPatch(params: {
    sourceBatch: Array<{
      sourceId: string;
      turnId: string;
      role: string;
      blockType?: string;
      text: string;
    }>;
    graph: {
      nodes: Array<{ id: string; text: string; score?: number }>;
      edges: Array<{ id: string; from: string; to: string; text: string; score?: number }>;
    };
  }): Promise<GauzMemGraphPatch> {
    const prompt = [
      'You maintain a long-term evidence graph for an ongoing agent conversation.',
      `Call ${GRAPH_PATCH_TOOL} with a graph patch.`,
      'Task:',
      '- Read the recent source batch and add durable memory facts that will help future recall.',
      '- Link new facts to each other and to existing graph facts when there is a concrete factual relationship.',
      '- Suggest merges only when a new fact is equivalent to an existing node.',
      'Node rules:',
      '- Each node text is one standalone durable fact, not a title or process note.',
      '- Preserve names, aliases, numbers, places, object names, protocols, factions, risks, and decisions.',
      '- Chinese source should usually produce Chinese node text; preserve English proper names when useful.',
      '- Skip greetings, dashboard/process text, tool arguments, file paths, repeated summaries, and status-only text.',
      'Edge rules:',
      '- Edge text must be Chinese, 20-80 characters, and state a specific factual relation.',
      '- Good edge text examples: 因果：启动第七艘船会提高 Blackbird 人格风险 / 补充：折剑号提供坐标与启动密钥 / 约束：导航核心必须转接到猫头鹰号。',
      '- Do not create edges only because two facts share a character, place, scene, or topic.',
      'Merge rules:',
      '- Use merges only for equivalent facts, not merely related facts.',
      '- Refer to new nodes by tempId such as n1, n2. Refer to old graph nodes by their existing id.',
      '- Keep the patch compact and high-signal.',
      '',
      'Recent source batch:',
      JSON.stringify(params.sourceBatch.map(source => ({
        sourceId: source.sourceId,
        turnId: source.turnId,
        role: source.role,
        blockType: source.blockType,
        text: truncateText(source.text, 2200),
      }))),
      '',
      'Current graph:',
      JSON.stringify({
        nodes: params.graph.nodes.map(node => ({
          id: node.id,
          score: node.score,
          text: truncateText(node.text, 500),
        })),
        edges: params.graph.edges.map(edge => ({
          id: edge.id,
          from: edge.from,
          to: edge.to,
          score: edge.score,
          text: truncateText(edge.text, 350),
        })),
      }),
    ].join('\n');
    const json = await this.callSubmitTool('construct_graph_patch', prompt, this.graphPatchTool());
    return {
      batchSummary: this.stringValue(json.batchSummary),
      nodes: Array.isArray(json.nodes)
        ? json.nodes.map((node: any) => ({
            tempId: this.stringValue(node.tempId),
            text: this.stringValue(node.text),
            sourceIds: this.stringArray(node.sourceIds),
          }))
        : [],
      edges: Array.isArray(json.edges)
        ? json.edges.map((edge: any) => ({
            from: this.stringValue(edge.from),
            to: this.stringValue(edge.to),
            text: this.stringValue(edge.text),
            sourceIds: this.stringArray(edge.sourceIds),
          }))
        : [],
      merges: Array.isArray(json.merges)
        ? json.merges.map((merge: any) => ({
            tempId: this.stringValue(merge.tempId),
            existingNodeId: this.stringValue(merge.existingNodeId),
          }))
        : [],
      skipped: this.stringArray(json.skipped),
    };
  }

  private async callSubmitTool(stepName: string, prompt: string, tool: ToolDefinition): Promise<any> {
    const started = Date.now();
    try {
      const { input, preview, attempts } = await this.callSubmitToolWithRetry(stepName, prompt, tool);
      this.steps.push({
        name: stepName,
        ok: true,
        durationMs: Date.now() - started,
        inputPreview: truncateText(prompt, 600),
        outputPreview: truncateText(preview, 600),
        ...(attempts > 1 && { error: `Recovered after ${attempts} attempts` }),
      });
      return input;
    } catch (error: any) {
      const message = String(error?.message || error);
      this.steps.push({
        name: stepName,
        ok: false,
        durationMs: Date.now() - started,
        inputPreview: truncateText(prompt, 600),
        error: message,
      });
      throw new Error(message);
    }
  }

  private async callSubmitToolWithRetry(
    stepName: string,
    prompt: string,
    tool: ToolDefinition,
  ): Promise<{ input: any; preview: string; attempts: number }> {
    let lastError: any;
    let lastPreview = '';
    for (let attempt = 1; attempt <= MAX_TOOL_ATTEMPTS; attempt += 1) {
      try {
        const retryHint = attempt === 1
          ? ''
          : [
              '',
              'Previous attempt failed.',
              `Error: ${String(lastError?.message || lastError)}`,
              `Previous response preview: ${truncateText(lastPreview, 800)}`,
              `Call ${tool.name} with valid arguments only.`,
            ].join('\n');
        const messages: Message[] = [
          {
            role: 'system',
            content: [
              'You are a strict structured memory reasoner.',
              'You must call the provided submit tool exactly once.',
              'Do not answer with prose when a submit tool is available.',
            ].join(' '),
          },
          { role: 'user', content: prompt + retryHint },
        ];
        const response = await this.ai.chatStream(
          messages,
          [tool],
          undefined,
          { toolChoice: tool.name },
        );
        lastPreview = this.responsePreview(response);
        const toolCall = response.toolCalls?.find(call => call.function.name === tool.name);
        if (!toolCall) throw new Error(`GauzMem LLM did not call ${tool.name}`);
        const input = JSON.parse(toolCall.function.arguments || '{}');
        this.validateSubmitToolInput(tool.name, input);
        return { input, preview: JSON.stringify(input), attempts: attempt };
      } catch (error: any) {
        lastError = error;
        if (attempt >= MAX_TOOL_ATTEMPTS) break;
      }
    }
    throw lastError;
  }

  private responsePreview(response: { content: string | null; toolCalls?: any[] }): string {
    return JSON.stringify({
      content: response.content,
      toolCalls: response.toolCalls?.map(call => ({
        name: call.function?.name,
        arguments: truncateText(call.function?.arguments || '', 500),
      })),
    });
  }

  private validateSubmitToolInput(toolName: string, input: any): void {
    if (!input || typeof input !== 'object') throw new Error(`${toolName} returned non-object input`);
    if (toolName === QUERY_PLAN_TOOL) {
      if (!this.stringValue(input.rootQuery)) throw new Error(`${toolName} missing rootQuery`);
      if (this.stringArray(input.searchTerms).length === 0) throw new Error(`${toolName} missing searchTerms`);
    }
    if (toolName === RELEVANCE_TOOL) {
      if (!Array.isArray(input.selectedNodeIds)) throw new Error(`${toolName} missing selectedNodeIds`);
      if (!Array.isArray(input.selectedEdgeIds)) throw new Error(`${toolName} missing selectedEdgeIds`);
    }
    if (toolName === EVIDENCE_TOOL) {
      if (!Array.isArray(input.evidence)) throw new Error(`${toolName} missing evidence`);
    }
    if (toolName === PARENT_TERMS_TOOL) {
      if (this.stringArray(input.searchTerms).length === 0) throw new Error(`${toolName} missing searchTerms`);
    }
    if (toolName === GRAPH_PATCH_TOOL) {
      if (!Array.isArray(input.nodes)) throw new Error(`${toolName} missing nodes`);
      if (!Array.isArray(input.edges)) throw new Error(`${toolName} missing edges`);
      for (const node of input.nodes) {
        if (!this.stringValue(node?.tempId)) throw new Error(`${toolName} node missing tempId`);
        if (!this.stringValue(node?.text)) throw new Error(`${toolName} node missing text`);
      }
      for (const edge of input.edges) {
        if (!this.stringValue(edge?.from)) throw new Error(`${toolName} edge missing from`);
        if (!this.stringValue(edge?.to)) throw new Error(`${toolName} edge missing to`);
        if (!this.stringValue(edge?.text)) throw new Error(`${toolName} edge missing text`);
      }
    }
  }

  private stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map(item => String(item || '').trim()).filter(Boolean);
  }

  private uniqueStrings(values: string[]): string[] {
    return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
  }

  private stringValue(value: unknown): string {
    return String(value || '').trim();
  }

  private relationValue(value: any): GauzMemExtractedEvidence['relationToParent'] | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const whyRelevant = this.stringValue(value.whyRelevant);
    if (!whyRelevant) return undefined;
    const normalized = this.normalizeRelationText(whyRelevant);
    if (!normalized) return undefined;
    if (this.isVagueRelation(normalized)) return undefined;
    return { whyRelevant: normalized };
  }

  private isVagueRelation(value: string): boolean {
    const normalized = value.toLowerCase().replace(/\s+/g, '');
    const vagueTerms = [
      '同主题',
      '同一主题',
      '同场景',
      '同一场景',
      '同角色',
      '同一角色',
      '有关',
      '相关',
      '相关联',
      'relevant',
      'related',
      'sametopic',
      'samescene',
      'samecharacter',
    ];
    return vagueTerms.some(term => normalized === term || normalized.includes(`只是${term}`) || normalized.includes(`仅${term}`));
  }

  private normalizeRelationText(value: string): string {
    let text = value
      .replace(/Parent fact\s*:?\s*/gi, '')
      .replace(/Evidence\s*:?\s*/gi, '')
      .replace(/This evidence (directly )?(confirms|supports|explains)[^.。]*[.。]?\s*/gi, '')
      .replace(/The evidence (directly )?(confirms|supports|explains)[^.。]*[.。]?\s*/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    if (/^[\x00-\x7F\s.,:;'"!?()-]+$/.test(text)) return '';
    if (text.length > 120) text = text.slice(0, 117).trimEnd() + '...';
    return text;
  }

  private queryPlanTool(): ToolDefinition {
    return {
      name: QUERY_PLAN_TOOL,
      description: 'Submit a short memory search plan with one resolved query and a compact list of literal keywords.',
      parameters: {
        type: 'object',
        required: ['rootQuery', 'searchTerms'],
        properties: {
          rootQuery: {
            type: 'string',
              description: 'A concise natural-language summary of what the user wants to recall or continue. Do not write keywords here.',
            },
            searchTerms: {
              type: 'array',
              description: 'Return 4-6 standalone literal keywords for substring search. Use 7-8 only for clearly separate stable anchors. Prefer short names, places, objects, states, identifiers, and numbers. Do not output sentence-like descriptions or pack multiple anchors into one item.',
              items: {
                type: 'string',
                description: 'One standalone keyword. Prefer 父亲 and 昏迷 as separate items instead of 父亲昏迷; keep fixed proper names such as Lady Blackbird intact.',
              },
            },
        },
      },
    };
  }

  private relevanceTool(): ToolDefinition {
    return {
      name: RELEVANCE_TOOL,
      description: 'Submit selected graph memory ids in usefulness order.',
      parameters: {
        type: 'object',
        required: ['selectedNodeIds', 'selectedEdgeIds'],
        properties: {
          selectedNodeIds: { type: 'array', items: { type: 'string' } },
          selectedEdgeIds: { type: 'array', items: { type: 'string' } },
        },
      },
    };
  }

  private evidenceTool(): ToolDefinition {
    return {
      name: EVIDENCE_TOOL,
      description: 'Submit source-backed memory facts extracted from source windows.',
      parameters: {
        type: 'object',
        required: ['evidence'],
        properties: {
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              required: ['windowRef', 'text'],
              properties: {
                windowRef: { type: 'string' },
                text: { type: 'string' },
                relationToParent: {
                  type: 'object',
                  properties: {
                    whyRelevant: { type: 'string' },
                  },
                  required: ['whyRelevant'],
                } as any,
              },
            },
          },
        },
      },
    };
  }

  private parentTermsTool(): ToolDefinition {
    return {
      name: PARENT_TERMS_TOOL,
      description: 'Submit grep terms for expanding one parent memory node.',
      parameters: {
        type: 'object',
        required: ['searchTerms'],
        properties: {
          searchTerms: { type: 'array', items: { type: 'string' } },
        },
      },
    };
  }

  private graphPatchTool(): ToolDefinition {
    return {
      name: GRAPH_PATCH_TOOL,
      description: 'Submit a compact graph patch for GauzMem construct.',
      parameters: {
        type: 'object',
        required: ['batchSummary', 'nodes', 'edges'],
        properties: {
          batchSummary: { type: 'string' },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['tempId', 'text', 'sourceIds'],
              properties: {
                tempId: { type: 'string' },
                text: { type: 'string' },
                sourceIds: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              required: ['from', 'to', 'text'],
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                text: { type: 'string' },
                sourceIds: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          merges: {
            type: 'array',
            items: {
              type: 'object',
              required: ['tempId', 'existingNodeId'],
              properties: {
                tempId: { type: 'string' },
                existingNodeId: { type: 'string' },
              },
            },
          },
          skipped: { type: 'array', items: { type: 'string' } },
        },
      },
    };
  }

}
