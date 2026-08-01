import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import type { ChatConfig, ChatResponse, ContentBlock, Message } from '../types';
import type { ToolDefinition, ToolSurface } from '../types/tool';
import { estimateMessagesTokens, estimateToolsTokens } from '../core/token-estimator';
import { PathResolver } from '../utils/path-resolver';

export const CACHE_TRACE_SCHEMA = 'xiaoba.cache_trace.v3';

export type CacheTraceApiType = 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses';

export interface CacheTraceEntryV3 {
  schema: typeof CACHE_TRACE_SCHEMA;
  session: {
    session_id: string;
    session_type: string;
    surface: string;
  };
  episode: {
    episode_number: number;
    run_id: string;
    episode_id?: string;
  };
  request: {
    timestamp: string;
    provider: string;
    model: string;
    api_type: CacheTraceApiType;
    cache_strategy: 'anthropic-explicit-prefix' | 'openai-automatic-prefix' | 'openai-prompt-cache-key';
    system_prompt: {
      stable_sha256: string;
      stable_blocks: number;
      stable_chars: number;
      dynamic_sha256: string;
      dynamic_blocks: number;
      dynamic_chars: number;
    };
    message_count: number;
    message_sha256s: string[];
    message_roles: Message['role'][];
    estimated_tokens: number;
    tools_count: number;
    tools_sha256: string;
    request_sha256: string;
    request_snapshot?: {
      kind: 'runner-input';
      messages: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
    };
  };
  response: {
    timestamp: string;
    duration_ms: number;
    stop_reason?: string;
  };
  response_usage: {
    input_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    fresh_input_tokens: number;
    output_tokens: number;
    cache_hit_ratio: number;
    cache_write_ratio: number;
  };
}

export interface CacheTraceObservation {
  episodeNumber: number;
  messages: Message[];
  tools: ToolDefinition[];
  response: ChatResponse;
  durationMs: number;
  modelConfig: Pick<ChatConfig, 'provider' | 'model' | 'openaiApiMode'>;
}

export interface CacheTraceSink {
  observe(observation: CacheTraceObservation): void;
}

export interface CacheTraceObserverOptions {
  sessionId?: string;
  sessionType?: string;
  surface?: ToolSurface | string;
  episodeId?: string;
  env?: NodeJS.ProcessEnv;
  traceDir?: string;
  onError?: (error: unknown) => void;
  writeEntry?: (filePath: string, entry: CacheTraceEntryV3) => Promise<void>;
}

/**
 * Best-effort cache observability side channel.
 *
 * Contract:
 * - observe() never throws and never returns a promise to the reply path.
 * - no trace file is read while a conversation is running.
 * - diffing and legacy-schema compatibility belong to the dashboard reader.
 * - writes are serialized in the background and every rejection is consumed.
 */
export class CacheTraceObserver implements CacheTraceSink {
  readonly enabled: boolean;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessionId: string;
  private readonly sessionType: string;
  private readonly surface: string;
  private readonly episodeId?: string;
  private readonly traceDir?: string;
  private readonly onError?: (error: unknown) => void;
  private readonly writeEntry: (filePath: string, entry: CacheTraceEntryV3) => Promise<void>;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: CacheTraceObserverOptions = {}) {
    this.env = options.env ?? process.env;
    this.sessionId = options.sessionId || 'unknown';
    this.enabled = isCacheTraceEnabledForSession(this.sessionId, this.env);
    this.sessionType = options.sessionType || inferSessionType(this.sessionId);
    this.surface = String(options.surface || 'unknown');
    this.episodeId = options.episodeId;
    this.traceDir = options.traceDir;
    this.onError = options.onError;
    this.writeEntry = options.writeEntry ?? writeEntryAtomically;
  }

  observe(observation: CacheTraceObservation): void {
    if (!this.enabled) return;

    try {
      const entry = this.buildEntry(observation);
      const filePath = this.resolveFilePath(entry);
      this.writeChain = this.writeChain
        .then(() => this.writeEntry(filePath, entry))
        .catch(error => {
          this.reportError(error);
        });
    } catch (error) {
      this.reportError(error);
    }
  }

  /** Test and shutdown seam. ConversationRunner never awaits this. */
  async drain(): Promise<void> {
    try {
      await this.writeChain;
    } catch (error) {
      this.reportError(error);
    }
  }

  private buildEntry(observation: CacheTraceObservation): CacheTraceEntryV3 {
    const now = new Date();
    const provider = observation.modelConfig.provider || 'openai';
    const apiType = resolveApiType(observation.modelConfig);
    const system = summarizeSystemPrompt(observation.messages);
    const messageSha256s = observation.messages.map(message => hashMessage(message));
    const toolsCanonical = observation.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    const toolsSha256 = sha256(stableSerialize(toolsCanonical));
    const requestSha256 = sha256(stableSerialize({
      provider,
      model: observation.modelConfig.model || 'unknown',
      apiType,
      system,
      messageSha256s,
      toolsSha256,
    }));
    const usage = observation.response.usage;
    const inputTokens = finiteNonNegative(usage?.promptTokens);
    const cacheReadTokens = finiteNonNegative(usage?.cachedReadTokens);
    const cacheWriteTokens = finiteNonNegative(usage?.cachedWriteTokens);
    const outputTokens = finiteNonNegative(usage?.completionTokens);
    const freshInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
    const includeContent = /^(1|true|yes|on)$/i.test(this.env.XIAOBA_CACHE_TRACE_CONTENT || '');
    const runId = createCacheTraceRunId();

    return {
      schema: CACHE_TRACE_SCHEMA,
      session: {
        session_id: this.sessionId,
        session_type: this.sessionType,
        surface: this.surface,
      },
      episode: {
        episode_number: observation.episodeNumber,
        run_id: runId,
        ...(this.episodeId ? { episode_id: this.episodeId } : {}),
      },
      request: {
        timestamp: now.toISOString(),
        provider,
        model: observation.modelConfig.model || 'unknown',
        api_type: apiType,
        cache_strategy: resolveCacheStrategy(apiType),
        system_prompt: system,
        message_count: observation.messages.length,
        message_sha256s: messageSha256s,
        message_roles: observation.messages.map(message => message.role),
        estimated_tokens: estimateMessagesTokens(observation.messages) + estimateToolsTokens(observation.tools),
        tools_count: observation.tools.length,
        tools_sha256: toolsSha256,
        request_sha256: requestSha256,
        ...(includeContent ? {
          request_snapshot: {
            kind: 'runner-input' as const,
            messages: observation.messages.map(snapshotMessage),
            tools: toolsCanonical.map(tool => sanitizeForSnapshot(tool) as Record<string, unknown>),
          },
        } : {}),
      },
      response: {
        timestamp: now.toISOString(),
        duration_ms: finiteNonNegative(observation.durationMs),
        ...(observation.response.stopReason ? { stop_reason: observation.response.stopReason } : {}),
      },
      response_usage: {
        input_tokens: inputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
        fresh_input_tokens: freshInputTokens,
        output_tokens: outputTokens,
        cache_hit_ratio: ratio(cacheReadTokens, inputTokens),
        cache_write_ratio: ratio(cacheWriteTokens, inputTokens),
      },
    };
  }

  private resolveFilePath(entry: CacheTraceEntryV3): string {
    const root = this.traceDir
      || String(this.env.XIAOBA_CACHE_TRACE_DIR || '').trim()
      || PathResolver.getLogsPath('cache-trace');
    const timestamp = new Date(entry.request.timestamp);
    const date = Number.isFinite(timestamp.getTime()) ? timestamp : new Date();
    const dateSegment = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
    const safeSession = sanitizeFileSegment(this.sessionId);
    const turn = String(entry.episode.episode_number).padStart(3, '0');
    return path.join(path.resolve(root), dateSegment, safeSession, `T${turn}_${entry.episode.run_id}.json`);
  }

  private reportError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Diagnostics about diagnostics are deliberately discarded.
    }
  }
}

export function isCacheTraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.XIAOBA_CACHE_TRACE || '');
}

export function isCacheTraceEnabledForSession(
  sessionId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isCacheTraceEnabled(env)) return false;
  const sessions = String(env.XIAOBA_CACHE_TRACE_SESSIONS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return sessions.length === 0 || sessions.includes(sessionId || 'unknown');
}

export function resolveCacheTraceDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.XIAOBA_CACHE_TRACE_DIR || '').trim();
  return path.resolve(explicit || PathResolver.getLogsPath('cache-trace'));
}

function summarizeSystemPrompt(messages: Message[]): CacheTraceEntryV3['request']['system_prompt'] {
  const stable: string[] = [];
  const dynamic: string[] = [];

  for (const message of messages) {
    if (message.role !== 'system') continue;
    const text = contentToString(message.content);
    if (!text) continue;
    if (isDynamicSystemMessage(message, text)) dynamic.push(text);
    else stable.push(text);
  }

  const stableText = stable.join('\n\n');
  const dynamicText = dynamic.join('\n\n');
  return {
    stable_sha256: sha256(stableText),
    stable_blocks: stable.length,
    stable_chars: stable.reduce((sum, value) => sum + value.length, 0),
    dynamic_sha256: sha256(dynamicText),
    dynamic_blocks: dynamic.length,
    dynamic_chars: dynamic.reduce((sum, value) => sum + value.length, 0),
  };
}

function isDynamicSystemMessage(message: Message, text: string): boolean {
  if (message.__cacheScope === 'dynamic') return true;
  if (message.__cacheScope === 'stable') return false;
  return /^\[(?:transient_[^\]]+|compact_boundary)\]/.test(text);
}

function resolveApiType(config: CacheTraceObservation['modelConfig']): CacheTraceApiType {
  if (config.provider === 'anthropic') return 'anthropic-messages';
  return config.openaiApiMode === 'responses' ? 'openai-responses' : 'openai-chat-completions';
}

function resolveCacheStrategy(apiType: CacheTraceApiType): CacheTraceEntryV3['request']['cache_strategy'] {
  if (apiType === 'anthropic-messages') return 'anthropic-explicit-prefix';
  if (apiType === 'openai-responses') return 'openai-prompt-cache-key';
  return 'openai-automatic-prefix';
}

function hashMessage(message: Message): string {
  return sha256(stableSerialize({
    role: message.role,
    content: contentToHashable(message.content),
    name: message.name,
    tool_call_id: message.tool_call_id,
    tool_calls: message.tool_calls,
    cache_scope: message.__cacheScope,
    provider_content: message.providerContent,
  }));
}

function snapshotMessage(message: Message): Record<string, unknown> {
  return sanitizeForSnapshot({
    role: message.role,
    content: message.content,
    name: message.name,
    tool_call_id: message.tool_call_id,
    tool_calls: message.tool_calls,
    cache_scope: message.__cacheScope,
  }) as Record<string, unknown>;
}

function sanitizeForSnapshot(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);
  if (Array.isArray(value)) return value.map(item => sanitizeForSnapshot(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:authorization|api[_-]?key|token|secret|password)$/i.test(key)) {
      output[key] = '[redacted-secret]';
    } else {
      output[key] = sanitizeForSnapshot(item, seen);
    }
  }
  return output;
}

function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted-secret]')
    .replace(/cats_svc_[A-Za-z0-9_-]+/g, '[redacted-secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted-token]');
}

function contentToHashable(content: Message['content']): unknown {
  if (!Array.isArray(content)) return content ?? '';
  return content.map(block => block.type === 'text'
    ? { type: 'text', text: block.text }
    : {
      type: 'image',
      media_type: block.source.media_type,
      bytes_sha256: sha256(block.source.data),
      bytes_chars: block.source.data.length,
    });
}

function contentToString(content: string | ContentBlock[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map(block => block.type === 'text' ? block.text : '[image]').join('');
}

function stableSerialize(value: unknown): string {
  const seen = new WeakSet<object>();
  const visit = (current: unknown): unknown => {
    if (current === null || current === undefined) return current;
    if (typeof current === 'number' || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current !== 'object') return String(current);
    if (seen.has(current as object)) return '[circular]';
    seen.add(current as object);
    if (Array.isArray(current)) return current.map(visit);
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, visit(item)]),
    );
  };
  return JSON.stringify(visit(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function finiteNonNegative(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[:<>"|?*\\/]/g, '_').slice(0, 160) || 'unknown';
}

function inferSessionType(sessionId: string): string {
  if (sessionId.startsWith('subagent:')) return 'subagent';
  if (sessionId.startsWith('branch:')) return 'branch';
  return 'agent';
}

function createCacheTraceRunId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

async function writeEntryAtomically(filePath: string, entry: CacheTraceEntryV3): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8', mode: 0o600 });
    await fs.promises.rename(temporary, filePath);
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
}
