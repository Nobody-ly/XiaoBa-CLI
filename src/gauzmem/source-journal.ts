import type { ContentBlock, Message } from '../types';
import type { RunResult } from '../core/conversation-runner';
import { appendJsonl, readJsonl, writeJsonl } from './jsonl';
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

  searchWindows(terms: string[], maxWindows = 16): GauzMemSourceWindow[] {
    const loweredTerms = terms
      .map(term => term.trim().toLowerCase())
      .filter(term => term.length > 0);
    if (loweredTerms.length === 0) return [];

    const windows: GauzMemSourceWindow[] = [];
    for (const source of this.readAll().reverse()) {
      const lower = source.text.toLowerCase();
      if (!loweredTerms.some(term => lower.includes(term))) continue;
      const window = this.toWindow(source, loweredTerms);
      windows.push(window);
      if (windows.length >= maxWindows) break;
    }

    if (windows.length > 0) {
      writeJsonl(GauzMemFiles.sourceWindows(), windows);
    }
    return windows;
  }

  private buildTurnRecords(params: AppendTurnSourceParams, timestamp: string): GauzMemSourceRecord[] {
    const records: GauzMemSourceRecord[] = [];
    const userText = this.contentToString(params.userInput);
    records.push(this.createRecord(params, timestamp, records.length, 'user', userText));

    const assistantText = params.result.response || '';
    records.push(this.createRecord(params, timestamp, records.length, 'assistant', assistantText));

    const toolCalls = this.extractToolCalls(params.result.newMessages);
    for (const toolCall of toolCalls) {
      const text = [
        `Tool: ${toolCall.name}`,
        `Arguments: ${toolCall.arguments}`,
        `Result: ${toolCall.result}`,
      ].join('\n');
      records.push(this.createRecord(params, timestamp, records.length, 'tool', text, toolCall));
    }

    return records;
  }

  private createRecord(
    params: AppendTurnSourceParams,
    timestamp: string,
    index: number,
    role: GauzMemSourceRecord['role'],
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

  private toWindow(source: GauzMemSourceRecord, terms: string[]): GauzMemSourceWindow {
    const lower = source.text.toLowerCase();
    const firstHit = terms
      .map(term => lower.indexOf(term))
      .filter(idx => idx >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, firstHit - 500);
    const end = Math.min(source.text.length, firstHit + 1200);
    const text = source.text.slice(start, end);
    return {
      windowId: 'gzw_' + stableHash(`${source.sourceId}:${start}:${end}`),
      sourceId: source.sourceId,
      sessionKey: source.sessionKey,
      sessionType: source.sessionType,
      text,
      timestamp: source.timestamp,
      sourceRef: source.sourceRef,
    };
  }

  private extractToolCalls(messages: Message[]): NonNullable<GauzMemSourceRecord['toolCall']>[] {
    return messages
      .filter(message => message.role === 'assistant' && message.tool_calls)
      .flatMap(message => message.tool_calls || [])
      .map(toolCall => {
        const resultMsg = messages.find(message =>
          message.role === 'tool' && message.tool_call_id === toolCall.id
        );
        return {
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
          result: this.messageContentToString(resultMsg?.content || ''),
        };
      });
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
}
