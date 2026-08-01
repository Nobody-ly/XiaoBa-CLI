import * as fs from 'fs';
import * as path from 'path';
import { resolveCacheTraceDir } from './cache-trace';

export interface CacheTraceUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  freshInputTokens: number;
  outputTokens: number;
  hitRatio: number;
}

export interface CacheTraceRecord {
  schema: string;
  file: string;
  sessionId: string;
  sessionType: string;
  surface: string;
  episodeNumber: number;
  runId: string;
  timestamp: string;
  provider: string;
  model: string;
  apiType: string;
  requestSha256: string;
  stableSystemSha256: string;
  messageSha256s: string[];
  usage: CacheTraceUsage;
  diff: {
    baselineReset: boolean;
    resetReason?: 'first-record' | 'provider-model-api-changed';
    requestChanged: boolean;
    stableSystemChanged: boolean;
    changedMessageIndices: number[];
  };
}

export interface CacheTraceSessionSummary {
  sessionId: string;
  sessionType: string;
  surface: string;
  records: number;
  firstTimestamp: string;
  lastTimestamp: string;
  providers: string[];
  models: string[];
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  weightedHitRatio: number;
  anomalousRecords: number;
}

export interface CacheTraceStore {
  traceDir: string;
  scannedFiles: number;
  malformedFiles: number;
  records: CacheTraceRecord[];
  sessions: CacheTraceSessionSummary[];
}

export async function readCacheTraceStore(
  traceDir: string = resolveCacheTraceDir(),
): Promise<CacheTraceStore> {
  const files = await listJsonFiles(traceDir);
  const normalized: Omit<CacheTraceRecord, 'diff'>[] = [];
  let malformedFiles = 0;

  for (const file of files) {
    try {
      const raw = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      const record = normalizeRecord(raw, path.relative(traceDir, file));
      if (record) normalized.push(record);
      else malformedFiles++;
    } catch {
      malformedFiles++;
    }
  }

  normalized.sort((left, right) => left.timestamp.localeCompare(right.timestamp)
    || left.episodeNumber - right.episodeNumber || left.file.localeCompare(right.file));
  const records = attachDiffs(normalized);
  return {
    traceDir: path.resolve(traceDir),
    scannedFiles: files.length,
    malformedFiles,
    records,
    sessions: summarizeSessions(records),
  };
}

function normalizeRecord(raw: any, file: string): Omit<CacheTraceRecord, 'diff'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const episode = raw.episode || raw.turn || {};
  const request = raw.request || {};
  const responseUsage = raw.response_usage || raw.response?.usage || raw.usage || {};
  const session = raw.session || {};
  const sessionId = text(session.session_id || raw.session_id || raw.conversation_id || 'unknown');
  const inputTokens = number(responseUsage.input_tokens ?? responseUsage.prompt_tokens ?? responseUsage.promptTokens);
  const cacheReadTokens = number(responseUsage.cache_read_tokens ?? responseUsage.cached_read_tokens ?? responseUsage.cachedReadTokens);
  const cacheWriteTokens = number(responseUsage.cache_write_tokens ?? responseUsage.cached_write_tokens ?? responseUsage.cachedWriteTokens);
  const freshInputTokens = number(responseUsage.fresh_input_tokens ?? Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens));
  const messageHashes = request.message_sha256s || request.messages_sha256 || request.message_hashes || [];
  const timestamp = text(request.timestamp || raw.timestamp || raw.response?.timestamp || '');
  if (!timestamp) return null;
  return {
    schema: text(raw.schema || 'unknown'),
    file,
    sessionId,
    sessionType: text(session.session_type || raw.session_type || 'agent'),
    surface: text(session.surface || raw.surface || 'unknown'),
    episodeNumber: number(episode.episode_number ?? episode.turn_number ?? episode.number ?? raw.turn_number),
    runId: text(episode.run_id || raw.run_id || path.basename(file, '.json')),
    timestamp,
    provider: text(request.provider || raw.provider || 'unknown'),
    model: text(request.model || raw.model || 'unknown'),
    apiType: text(request.api_type || raw.api_type || 'unknown'),
    requestSha256: text(request.request_sha256 || request.sha256 || ''),
    stableSystemSha256: text(request.system_prompt?.stable_sha256 || request.stable_system_sha256 || ''),
    messageSha256s: Array.isArray(messageHashes) ? messageHashes.map(text) : [],
    usage: {
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      freshInputTokens,
      outputTokens: number(responseUsage.output_tokens ?? responseUsage.completion_tokens ?? responseUsage.completionTokens),
      hitRatio: ratio(cacheReadTokens, inputTokens),
    },
  };
}

function attachDiffs(records: Omit<CacheTraceRecord, 'diff'>[]): CacheTraceRecord[] {
  const previousBySession = new Map<string, Omit<CacheTraceRecord, 'diff'>>();
  return records.map(record => {
    const previous = previousBySession.get(record.sessionId);
    const sameSegment = previous && segment(previous) === segment(record);
    const changedMessageIndices: number[] = [];
    if (sameSegment && previous) {
      const count = Math.max(previous.messageSha256s.length, record.messageSha256s.length);
      for (let index = 0; index < count; index++) {
        if (previous.messageSha256s[index] !== record.messageSha256s[index]) changedMessageIndices.push(index);
      }
    }
    previousBySession.set(record.sessionId, record);
    return {
      ...record,
      diff: {
        baselineReset: !sameSegment,
        ...(!previous ? { resetReason: 'first-record' as const }
          : !sameSegment ? { resetReason: 'provider-model-api-changed' as const } : {}),
        requestChanged: Boolean(sameSegment && previous && previous.requestSha256 !== record.requestSha256),
        stableSystemChanged: Boolean(sameSegment && previous && previous.stableSystemSha256 !== record.stableSystemSha256),
        changedMessageIndices,
      },
    };
  });
}

function summarizeSessions(records: CacheTraceRecord[]): CacheTraceSessionSummary[] {
  const groups = new Map<string, CacheTraceRecord[]>();
  for (const record of records) groups.set(record.sessionId, [...(groups.get(record.sessionId) || []), record]);
  return [...groups.entries()].map(([sessionId, items]) => {
    const inputTokens = sum(items, item => item.usage.inputTokens);
    const cacheReadTokens = sum(items, item => item.usage.cacheReadTokens);
    return {
      sessionId,
      sessionType: items.at(-1)?.sessionType || 'agent',
      surface: items.at(-1)?.surface || 'unknown',
      records: items.length,
      firstTimestamp: items[0]?.timestamp || '',
      lastTimestamp: items.at(-1)?.timestamp || '',
      providers: unique(items.map(item => item.provider)),
      models: unique(items.map(item => item.model)),
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens: sum(items, item => item.usage.cacheWriteTokens),
      weightedHitRatio: ratio(cacheReadTokens, inputTokens),
      anomalousRecords: items.filter(item => !item.diff.baselineReset && item.diff.stableSystemChanged).length,
    };
  }).sort((left, right) => right.lastTimestamp.localeCompare(left.lastTimestamp));
}

async function listJsonFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async entry => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) output.push(full);
    }));
  };
  await walk(root);
  return output.sort();
}

function segment(record: Pick<CacheTraceRecord, 'provider' | 'model' | 'apiType'>): string {
  return `${record.provider}\u0000${record.model}\u0000${record.apiType}`;
}
function number(value: unknown): number { const parsed = Number(value ?? 0); return Number.isFinite(parsed) && parsed > 0 ? parsed : 0; }
function text(value: unknown): string { return value === undefined || value === null ? '' : String(value); }
function ratio(numerator: number, denominator: number): number { return denominator > 0 ? Math.round((numerator / denominator) * 10000) / 10000 : 0; }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function sum<T>(values: T[], select: (value: T) => number): number { return values.reduce((total, value) => total + select(value), 0); }
