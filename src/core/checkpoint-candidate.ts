import { createHash } from 'node:crypto';
import type { Message } from '../types';
import type {
  CheckpointCompactionCoordinator,
  CheckpointCompactionRequest,
} from './checkpoint-compaction';
import { estimateMessagesTokens } from './token-estimator';

export type CheckpointCandidateStatus =
  | 'running'
  | 'ready'
  | 'cancelled'
  | 'stale'
  | 'committed'
  | 'failed';

export interface CheckpointSnapshot {
  readonly revision: number;
  readonly episodeId?: string;
  readonly messages: readonly Message[];
  readonly durableHash: string;
  readonly boundaryMessageCount: number;
  readonly usedTokens: number;
  readonly startedAt: number;
}

export interface CheckpointCandidateResult {
  readonly status: CheckpointCandidateStatus;
  readonly candidateId: string;
  readonly reason?: 'revision_mismatch' | 'episode_mismatch' | 'boundary_mismatch' | 'cancelled';
  readonly messages?: Message[];
}

/**
 * Pure lifecycle and compare-and-swap guard for an asynchronous checkpoint.
 * It deliberately does not call a model, mutate the parent transcript, or persist data.
 */
export class CheckpointCandidate {
  private _status: CheckpointCandidateStatus = 'running';
  private _result: Message[] | undefined;

  constructor(
    readonly id: string,
    readonly snapshot: CheckpointSnapshot,
  ) {}

  get status(): CheckpointCandidateStatus {
    return this._status;
  }

  get result(): readonly Message[] | undefined {
    return this._result;
  }

  complete(messages: Message[]): boolean {
    if (this._status !== 'running') return false;
    this._result = cloneMessages(messages);
    this._status = 'ready';
    return true;
  }

  fail(): boolean {
    if (this._status !== 'running') return false;
    this._status = 'failed';
    return true;
  }

  /** Generate a candidate without touching the parent transcript. */
  async generate(
    coordinator: Pick<CheckpointCompactionCoordinator, 'compactIfNeeded'>,
    request: Omit<CheckpointCompactionRequest, 'signal'> & { signal?: AbortSignal },
  ): Promise<boolean> {
    if (this._status !== 'running') return false;
    try {
      const result = await coordinator.compactIfNeeded([...this.snapshot.messages], {
        ...request,
        signal: request.signal,
      });
      if (this._status !== 'running') return false;
      if (!result.compacted) {
        this.fail();
        return false;
      }
      return this.complete(result.messages);
    } catch {
      this.fail();
      return false;
    }
  }

  cancel(): boolean {
    if (this._status === 'committed' || this._status === 'stale' || this._status === 'failed') return false;
    this._status = 'cancelled';
    return true;
  }

  /** Prepare a CAS result without marking it committed before persistence succeeds. */
  prepareCommit(
    currentMessages: readonly Message[],
    currentRevision: number,
    currentEpisodeId?: string,
  ): CheckpointCandidateResult {
    if (this._status === 'cancelled') {
      return this.outcome('cancelled');
    }
    if (this._status !== 'ready' || !this._result) {
      return this.outcome();
    }
    const reason = compareSnapshotBoundary(this.snapshot, currentMessages, currentRevision, currentEpisodeId);
    if (reason) {
      this._status = 'stale';
      return this.outcome(reason);
    }
    const suffix = currentMessages.slice(this.snapshot.boundaryMessageCount);
    return this.outcome(undefined, cloneMessages([...this._result, ...suffix]));
  }

  confirmCommit(): boolean {
    if (this._status !== 'ready') return false;
    this._status = 'committed';
    return true;
  }

  /** Convenience helper for callers that do not have a persistence phase. */
  tryCommit(
    currentMessages: readonly Message[],
    currentRevision: number,
    currentEpisodeId?: string,
  ): CheckpointCandidateResult {
    const prepared = this.prepareCommit(currentMessages, currentRevision, currentEpisodeId);
    if (!prepared.messages || !this.confirmCommit()) return prepared;
    return { ...prepared, status: this._status };
  }

  private outcome(
    reason?: CheckpointCandidateResult['reason'],
    messages?: Message[],
  ): CheckpointCandidateResult {
    return { status: this._status, candidateId: this.id, ...(reason ? { reason } : {}), ...(messages ? { messages } : {}) };
  }
}

export function createCheckpointSnapshot(
  messages: readonly Message[],
  options: { revision: number; episodeId?: string; startedAt?: number },
): CheckpointSnapshot {
  const copy = cloneMessages(messages);
  const frozenMessages = freezeMessages(copy);
  return Object.freeze({
    revision: options.revision,
    ...(options.episodeId ? { episodeId: options.episodeId } : {}),
    messages: frozenMessages,
    durableHash: hashMessages(frozenMessages),
    boundaryMessageCount: frozenMessages.length,
    usedTokens: estimateMessagesTokens([...frozenMessages]),
    startedAt: options.startedAt ?? Date.now(),
  });
}

export function compareSnapshotBoundary(
  snapshot: CheckpointSnapshot,
  currentMessages: readonly Message[],
  currentRevision: number,
  currentEpisodeId?: string,
): CheckpointCandidateResult['reason'] | undefined {
  if (currentRevision !== snapshot.revision) return 'revision_mismatch';
  if (currentEpisodeId !== snapshot.episodeId) return 'episode_mismatch';
  if (currentMessages.length < snapshot.boundaryMessageCount) return 'boundary_mismatch';
  const prefix = currentMessages.slice(0, snapshot.boundaryMessageCount);
  if (hashMessages(prefix) !== snapshot.durableHash) return 'boundary_mismatch';
  return undefined;
}

export function hashMessages(messages: readonly Message[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

export function hasCompleteToolExchanges(messages: readonly Message[]): boolean {
  const expected = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls || []) {
        if (!call.id || expected.has(call.id)) return false;
        expected.add(call.id);
      }
      continue;
    }
    if (message.role !== 'tool') continue;
    if (!message.tool_call_id || !expected.delete(message.tool_call_id)) return false;
  }
  return expected.size === 0;
}

function cloneMessages(messages: readonly Message[]): Message[] {
  return messages.map(message => ({
    ...message,
    ...(Array.isArray(message.content) ? {
      content: message.content.map(block => ({
        ...block,
        ...(block.type === 'image' ? { source: { ...block.source } } : {}),
      })),
    } : {}),
    ...(message.tool_calls ? {
      tool_calls: message.tool_calls.map(call => ({ ...call, function: { ...call.function } })),
    } : {}),
    ...(message.providerContent ? {
      providerContent: message.providerContent.map(block => structuredClone(block)),
    } : {}),
    ...(message.providerState ? { providerState: { ...message.providerState } } : {}),
    ...(message.__remoteContextWatermarks ? {
      __remoteContextWatermarks: { ...message.__remoteContextWatermarks },
    } : {}),
  }));
}

function freezeMessages(messages: Message[]): readonly Message[] {
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'image') Object.freeze(block.source);
        Object.freeze(block);
      }
      Object.freeze(message.content);
    }
    if (message.tool_calls) {
      for (const call of message.tool_calls) {
        Object.freeze(call.function);
        Object.freeze(call);
      }
      Object.freeze(message.tool_calls);
    }
    if (message.providerContent) {
      for (const block of message.providerContent) deepFreeze(block);
      Object.freeze(message.providerContent);
    }
    if (message.providerState) Object.freeze(message.providerState);
    if (message.__remoteContextWatermarks) Object.freeze(message.__remoteContextWatermarks);
    Object.freeze(message);
  }
  return Object.freeze(messages);
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}
