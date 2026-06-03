import type { ContentBlock, Message } from '../types';
import type { RunResult } from '../core/conversation-runner';
import { appendJsonl, readJsonl } from './jsonl';
import { GauzMemFiles, ensureGauzMemDirs } from './paths';
import { normalizeMemoryText, stableHash, truncateText } from './hash';
import type { GauzMemSourceRecord, GauzMemSourceWindow } from './types';

export interface AppendTurnSourceParams {
  sessionKey: string;
  sessionType?: string;
  turnId: string;
  userInput: string | ContentBlock[];
  result: RunResult;
}

export interface GauzMemSourceTurn {
  turnKey: string;
  sessionKey: string;
  sessionType?: string;
  turnId: string;
  timestamp: string;
  records: GauzMemSourceRecord[];
}

export class GauzMemSourceJournal {
  appendTurn(params: AppendTurnSourceParams): GauzMemSourceRecord[] {
    ensureGauzMemDirs();
    const existingIds = new Set(this.readAll().map(source => source.sourceId));
    const timestamp = new Date().toISOString();
    const records = this.buildTurnRecords(params, timestamp)
      .filter(record => record.text.trim().length > 0)
      .filter(record => !existingIds.has(record.sourceId));

    for (const record of records) {
      appendJsonl(GauzMemFiles.sources(), record);
    }
    return records;
  }

  readAll(): GauzMemSourceRecord[] {
    const rows = readJsonl<GauzMemSourceRecord>(GauzMemFiles.sources());
    const deduped = new Map<string, GauzMemSourceRecord>();
    for (const row of rows) deduped.set(row.sourceId, row);
    return Array.from(deduped.values());
  }

  readTurns(): GauzMemSourceTurn[] {
    const groups = new Map<string, GauzMemSourceRecord[]>();
    for (const source of this.readAll()) {
      const turnKey = `${source.sessionKey}:${source.turnId}`;
      const records = groups.get(turnKey) || [];
      records.push(source);
      groups.set(turnKey, records);
    }
    return Array.from(groups.entries())
      .map(([turnKey, records]) => {
        const sorted = [...records].sort((a, b) => a.sourceRef.index - b.sourceRef.index);
        const first = sorted[0];
        const timestamp = sorted
          .map(record => record.timestamp)
          .sort()[sorted.length - 1] || first.timestamp;
        return {
          turnKey,
          sessionKey: first.sessionKey,
          sessionType: first.sessionType,
          turnId: first.turnId,
          timestamp,
          records: sorted,
        };
      })
      .sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        || a.turnKey.localeCompare(b.turnKey)
      );
  }

  searchWindows(terms: string[], maxWindows = 12, maxWindowChars = 500): GauzMemSourceWindow[] {
    const normalizedTerms = terms
      .map((term, index) => ({ term: term.trim(), lowered: term.trim().toLowerCase(), index }))
      .filter(item => item.lowered.length > 0);
    if (normalizedTerms.length === 0) return [];

    const windowMap = new Map<string, GauzMemSourceWindow>();
    for (const source of this.readAll().reverse()) {
      const lower = source.text.toLowerCase();
      const hits: Array<{ start: number; end: number }> = [];
      for (const term of normalizedTerms) {
        let fromIndex = 0;
        while (fromIndex < lower.length) {
          const hit = lower.indexOf(term.lowered, fromIndex);
          if (hit < 0) break;
          hits.push({ start: hit, end: hit + term.lowered.length });
          fromIndex = hit + Math.max(1, term.lowered.length);
        }
      }
      for (const span of this.groupHitSpans(hits, source.text, maxWindowChars)) {
        const window = this.toWindowForSpan(source, span, normalizedTerms);
        windowMap.set(window.windowId, window);
      }
    }

    const windows = Array.from(windowMap.values())
      .sort((a, b) =>
        b.distinctTermCount - a.distinctTermCount
        || a.firstMatchedTermIndex - b.firstMatchedTermIndex
        || new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        || a.windowId.localeCompare(b.windowId)
      )
      .slice(0, maxWindows);

    return windows;
  }

  private buildTurnRecords(params: AppendTurnSourceParams, timestamp: string): GauzMemSourceRecord[] {
    const records: GauzMemSourceRecord[] = [];
    const userText = this.contentToString(params.userInput);
    records.push(this.createRecord(params, timestamp, records.length, 'user', 'user_text', userText));

    for (const message of params.result.newMessages) {
      if (message.__injected) continue;
      if (message.role === 'user') {
        records.push(this.createRecord(
          params,
          timestamp,
          records.length,
          'user',
          'user_text',
          this.messageContentToString(message.content),
        ));
        continue;
      }
      if (message.role === 'assistant') {
        const assistantText = this.messageContentToString(message.content);
        if (assistantText.trim()) {
          records.push(this.createRecord(params, timestamp, records.length, 'assistant', 'assistant_text', assistantText));
        }
        for (const toolCall of message.tool_calls || []) {
          records.push(this.createRecord(
            params,
            timestamp,
            records.length,
            'assistant',
            'tool_call',
            this.toolCallToText(toolCall),
            {
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
              result: '',
            },
          ));
        }
        continue;
      }
      if (message.role === 'tool') {
        const toolCall = this.toolResultMetadata(message, params.result.newMessages);
        records.push(this.createRecord(
          params,
          timestamp,
          records.length,
          'tool',
          'tool_result',
          this.messageContentToString(message.content),
          toolCall,
        ));
      }
    }

    const assistantText = params.result.response || '';
    if (assistantText.trim() && !records.some(record =>
      record.role === 'assistant'
      && record.blockType === 'assistant_text'
      && normalizeMemoryText(record.text) === normalizeMemoryText(assistantText)
    )) {
      records.push(this.createRecord(params, timestamp, records.length, 'assistant', 'assistant_text', assistantText));
    }

    return records;
  }

  private createRecord(
    params: AppendTurnSourceParams,
    timestamp: string,
    index: number,
    role: GauzMemSourceRecord['role'],
    blockType: NonNullable<GauzMemSourceRecord['blockType']>,
    text: string,
    toolCall?: GauzMemSourceRecord['toolCall'],
  ): GauzMemSourceRecord {
    const normalized = normalizeMemoryText(text);
    const sourceId = 'gzs_' + stableHash(`${params.sessionKey}:${params.turnId}:${role}:${index}:${normalized}`);
    return {
      sourceId,
      sessionKey: params.sessionKey,
      sessionType: params.sessionType,
      turnId: params.turnId,
      role,
      blockType,
      text: truncateText(text, 6000),
      timestamp,
      ...(toolCall && { toolCall }),
      sourceRef: {
        kind: 'session_turn',
        turnId: params.turnId,
        role,
        index,
      },
    };
  }

  private toWindow(
    source: GauzMemSourceRecord,
    hitStart: number,
    hitEnd: number,
    terms: Array<{ term: string; lowered: string; index: number }>,
    maxWindowChars: number,
  ): GauzMemSourceWindow {
    const span = this.blockSpanForHit(source.text, hitStart, hitEnd, maxWindowChars);
    const text = source.text.slice(span.start, span.end).trim();
    const lower = text.toLowerCase();
    const matched = terms.filter(term => lower.includes(term.lowered));
    const matchedTerms = matched.map(term => term.term);
    const firstMatchedTermIndex = matched.reduce(
      (min, term) => Math.min(min, term.index),
      Number.POSITIVE_INFINITY,
    );
    return {
      windowId: 'gzw_' + stableHash(`${source.sourceId}:${span.start}:${span.end}`),
      sourceId: source.sourceId,
      sessionKey: source.sessionKey,
      sessionType: source.sessionType,
      text,
      timestamp: source.timestamp,
      sourceRef: source.sourceRef,
      blockType: source.blockType || this.blockTypeFromRole(source.role),
      matchedTerms,
      distinctTermCount: matchedTerms.length,
      firstMatchedTermIndex: Number.isFinite(firstMatchedTermIndex) ? firstMatchedTermIndex : terms.length,
      span,
    };
  }

  private toWindowForSpan(
    source: GauzMemSourceRecord,
    span: { start: number; end: number },
    terms: Array<{ term: string; lowered: string; index: number }>,
  ): GauzMemSourceWindow {
    const text = source.text.slice(span.start, span.end).trim();
    const lower = text.toLowerCase();
    const matched = terms.filter(term => lower.includes(term.lowered));
    const matchedTerms = matched.map(term => term.term);
    const firstMatchedTermIndex = matched.reduce(
      (min, term) => Math.min(min, term.index),
      Number.POSITIVE_INFINITY,
    );
    return {
      windowId: 'gzw_' + stableHash(`${source.sourceId}:${span.start}:${span.end}`),
      sourceId: source.sourceId,
      sessionKey: source.sessionKey,
      sessionType: source.sessionType,
      text,
      timestamp: source.timestamp,
      sourceRef: source.sourceRef,
      blockType: source.blockType || this.blockTypeFromRole(source.role),
      matchedTerms,
      distinctTermCount: matchedTerms.length,
      firstMatchedTermIndex: Number.isFinite(firstMatchedTermIndex) ? firstMatchedTermIndex : terms.length,
      span,
    };
  }

  private groupHitSpans(
    hits: Array<{ start: number; end: number }>,
    text: string,
    maxChars: number,
  ): Array<{ start: number; end: number }> {
    if (hits.length === 0) return [];
    const sorted = [...hits].sort((a, b) => a.start - b.start || a.end - b.end);
    const groups: Array<{ start: number; end: number }> = [];
    let current = { ...sorted[0] };
    for (const hit of sorted.slice(1)) {
      const mergedStart = Math.min(current.start, hit.start);
      const mergedEnd = Math.max(current.end, hit.end);
      if (mergedEnd - mergedStart <= maxChars) {
        current = { start: mergedStart, end: mergedEnd };
      } else {
        groups.push(current);
        current = { ...hit };
      }
    }
    groups.push(current);
    return this.mergeExpandedSpans(groups.map(group => this.blockSpanForRange(text, group.start, group.end, maxChars)));
  }

  private mergeExpandedSpans(spans: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
    if (spans.length <= 1) return spans;
    const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: Array<{ start: number; end: number }> = [];
    let current = { ...sorted[0] };
    for (const span of sorted.slice(1)) {
      if (span.start <= current.end) {
        current = { start: current.start, end: Math.max(current.end, span.end) };
      } else {
        merged.push(current);
        current = { ...span };
      }
    }
    merged.push(current);
    return merged;
  }

  private blockSpanForHit(text: string, hitStart: number, hitEnd: number, maxChars: number): { start: number; end: number } {
    return this.blockSpanForRange(text, hitStart, hitEnd, maxChars);
  }

  private blockSpanForRange(text: string, hitStart: number, hitEnd: number, maxChars: number): { start: number; end: number } {
    let start = 0;
    let end = text.length;

    if (text.length > maxChars) {
      const hitLength = Math.min(maxChars, Math.max(1, hitEnd - hitStart));
      const side = Math.max(0, Math.floor((maxChars - hitLength) / 2));
      start = Math.max(0, hitStart - side);
      end = Math.min(text.length, start + maxChars);
      if (end < hitEnd) {
        end = Math.min(text.length, hitEnd);
        start = Math.max(0, end - maxChars);
      }
      start = this.trimLeftToBoundary(text, start);
      end = this.trimRightToBoundary(text, end);
    }

    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    return { start, end };
  }

  private trimLeftToBoundary(text: string, start: number): number {
    for (let i = start; i < text.length; i += 1) {
      if (/\s/.test(text[i])) continue;
      return i;
    }
    return start;
  }

  private trimRightToBoundary(text: string, end: number): number {
    for (let i = end; i > 0; i -= 1) {
      if (/\s/.test(text[i - 1])) continue;
      return i;
    }
    return end;
  }

  private toolCallToText(toolCall: NonNullable<Message['tool_calls']>[number]): string {
    return [
      `Tool call: ${toolCall.function.name}`,
      `Arguments: ${toolCall.function.arguments}`,
    ].join('\n');
  }

  private toolResultMetadata(
    message: Message,
    messages: Message[],
  ): NonNullable<GauzMemSourceRecord['toolCall']> | undefined {
    const toolCallId = message.tool_call_id;
    if (!toolCallId) return undefined;
    const assistantToolCall = messages
      .filter(candidate => candidate.role === 'assistant')
      .flatMap(candidate => candidate.tool_calls || [])
      .find(toolCall => toolCall.id === toolCallId);
    return {
      id: toolCallId,
      name: message.name || assistantToolCall?.function.name || '',
      arguments: assistantToolCall?.function.arguments || '',
      result: this.messageContentToString(message.content),
    };
  }

  private contentToString(content: string | ContentBlock[]): string {
    if (typeof content === 'string') return content;
    return content
      .filter(block => block.type === 'text')
      .map(block => (block as any).text)
      .join('');
  }

  private messageContentToString(content: Message['content']): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(block => block.type === 'text' ? block.text : '[image]').join('');
  }

  private blockTypeFromRole(role: GauzMemSourceRecord['role']): NonNullable<GauzMemSourceRecord['blockType']> {
    if (role === 'user') return 'user_text';
    if (role === 'assistant') return 'assistant_text';
    return 'tool_result';
  }
}
