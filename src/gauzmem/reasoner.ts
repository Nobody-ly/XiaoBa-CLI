import { AIService } from '../utils/ai-service';
import type { Message } from '../types';
import { truncateText } from './hash';
import type {
  GauzMemEdge,
  GauzMemNode,
  GauzMemQueryKind,
  GauzMemQueryPlan,
  GauzMemReasonerStep,
  GauzMemSourceWindow,
} from './types';

export class GauzMemReasoner {
  readonly steps: GauzMemReasonerStep[] = [];
  private readonly ai = new AIService({ temperature: 0, maxTokens: 2048 });
  private readonly timeoutMs = Number(process.env.GAUZMEM_LLM_TIMEOUT_MS || 60000);

  async probe(): Promise<{ ok: boolean; response?: unknown; error?: string }> {
    try {
      const result = await this.callJson('probe', 'Return only valid JSON: {"ok":true,"terms":["memory"]}');
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
      'Return only valid JSON.',
      'Schema: {"rootQuery":string,"searchTerms":string[],"contextHints":string[],"queryKind":"direct|anaphora|continuation|recall|task"}',
      'Rules:',
      '- Prefer concrete entities, names, places, files, decisions, and task nouns.',
      '- Use the recent context only to resolve references like "previous reply", "continue", "that", "he/she/it".',
      '- Avoid filler terms, one-character terms, pronouns, and generic verbs.',
      '- Keep 4-10 search terms.',
      '',
      `Session: ${params.sessionType || 'unknown'} ${params.sessionKey || ''}`,
      `Current user input: ${params.userInput}`,
      `Previous user input: ${params.previousUser || ''}`,
      `Previous assistant final reply: ${truncateText(params.previousAssistant || '', 1200)}`,
    ].join('\n');
    const json = await this.callJson('query_build', prompt);
    return {
      rootQuery: this.stringValue(json.rootQuery) || params.userInput,
      searchTerms: this.stringArray(json.searchTerms).slice(0, 12),
      contextHints: this.stringArray(json.contextHints).slice(0, 8),
      queryKind: this.queryKind(json.queryKind),
    };
  }

  async extractEvidence(rootQuery: string, windows: GauzMemSourceWindow[]): Promise<Array<{ windowId: string; text: string }>> {
    if (windows.length === 0) return [];
    const prompt = [
      'Extract durable memory evidence from source windows.',
      'Return only valid JSON.',
      'Schema: {"evidence":[{"windowId":string,"text":string}]}',
      'Rules:',
      '- Evidence must be directly supported by the window.',
      '- Keep concise standalone facts useful for future recall.',
      '- Do not invent facts.',
      '- If a window is irrelevant or only procedural noise, omit it.',
      '',
      `Root query: ${rootQuery}`,
      'Windows:',
      JSON.stringify(windows.map(w => ({ windowId: w.windowId, text: truncateText(w.text, 1800) }))),
    ].join('\n');
    const json = await this.callJson('extract_evidence', prompt);
    return Array.isArray(json.evidence)
      ? json.evidence
          .map((item: any) => ({
            windowId: this.stringValue(item.windowId),
            text: this.stringValue(item.text),
          }))
          .filter((item: any) => item.windowId && item.text)
          .slice(0, 24)
      : [];
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
      'Return only valid JSON.',
      'Schema: {"selectedNodeIds":string[],"selectedEdgeIds":string[],"rejectedNodeIds":string[],"rejectedEdgeIds":string[]}',
      'Rules:',
      '- Select only memories that are topically useful for the root query or its resolved context.',
      '- Reject candidates that merely share a generic word, path fragment, tool name, or incidental phrase.',
      '- Keep useful associative recall, but do not drift into unrelated topics.',
      '- Every candidate id should appear in exactly one of selected or rejected.',
      '',
      `Root query: ${params.rootQuery}`,
      'Nodes:',
      JSON.stringify(params.nodes.map(n => ({ id: n.id, text: truncateText(n.text, 700) }))),
      'Edges:',
      JSON.stringify(params.edges.map(e => ({ id: e.id, from: e.from, to: e.to, text: truncateText(e.text, 700) }))),
    ].join('\n');
    const json = await this.callJson('relevance', prompt);
    const nodeIds = new Set(params.nodes.map(n => n.id));
    const edgeIds = new Set(params.edges.map(e => e.id));
    const selectedNodeIds = this.stringArray(json.selectedNodeIds).filter(id => nodeIds.has(id));
    const selectedEdgeIds = this.stringArray(json.selectedEdgeIds).filter(id => edgeIds.has(id));
    const selectedNodeSet = new Set(selectedNodeIds);
    const selectedEdgeSet = new Set(selectedEdgeIds);
    const rejectedNodeIds = this.stringArray(json.rejectedNodeIds)
      .filter(id => nodeIds.has(id) && !selectedNodeSet.has(id));
    const rejectedEdgeIds = this.stringArray(json.rejectedEdgeIds)
      .filter(id => edgeIds.has(id) && !selectedEdgeSet.has(id));
    for (const id of nodeIds) {
      if (!selectedNodeSet.has(id) && !rejectedNodeIds.includes(id)) rejectedNodeIds.push(id);
    }
    for (const id of edgeIds) {
      if (!selectedEdgeSet.has(id) && !rejectedEdgeIds.includes(id)) rejectedEdgeIds.push(id);
    }
    return { selectedNodeIds, selectedEdgeIds, rejectedNodeIds, rejectedEdgeIds };
  }

  private async callJson(stepName: string, prompt: string): Promise<any> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const messages: Message[] = [
        { role: 'system', content: 'You are a strict JSON-only memory reasoner. Do not include markdown.' },
        { role: 'user', content: prompt },
      ];
      let streamedText = '';
      const response = await this.ai.chatStream(
        messages,
        undefined,
        {
          onText: (text) => {
            streamedText += text;
          },
        },
        { signal: controller.signal },
      );
      const text = (streamedText || response.content || '').trim();
      const parsed = this.parseJson(text);
      this.steps.push({
        name: stepName,
        ok: true,
        durationMs: Date.now() - started,
        inputPreview: truncateText(prompt, 600),
        outputPreview: truncateText(text, 600),
      });
      return parsed;
    } catch (error: any) {
      const message = controller.signal.aborted
        ? `GauzMem reasoner timed out after ${this.timeoutMs}ms`
        : String(error?.message || error);
      this.steps.push({
        name: stepName,
        ok: false,
        durationMs: Date.now() - started,
        inputPreview: truncateText(prompt, 600),
        error: message,
      });
      throw new Error(message);
    } finally {
      clearTimeout(timer);
    }
  }

  private parseJson(text: string): any {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('GauzMem LLM returned empty response');
    try {
      return JSON.parse(trimmed);
    } catch {
      const match = trimmed.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`GauzMem LLM returned non-JSON response: ${truncateText(trimmed, 300)}`);
      return JSON.parse(match[0]);
    }
  }

  private stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map(item => String(item || '').trim()).filter(Boolean);
  }

  private stringValue(value: unknown): string {
    return String(value || '').trim();
  }

  private queryKind(value: unknown): GauzMemQueryKind {
    const text = this.stringValue(value);
    return ['direct', 'anaphora', 'continuation', 'recall', 'task'].includes(text)
      ? text as GauzMemQueryKind
      : 'direct';
  }
}
