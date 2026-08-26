import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { AgentSession } from '../src/core/agent-session';
import type { Message } from '../src/types';
import { CheckpointCompactionCoordinator } from '../src/core/checkpoint-compaction';

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
const OWNED_SESSION_KEYS = [
  'user:legacy-persist',
  'user:candidate-persist-race',
  'user:candidate-integration',
  'user:candidate-preempt-integration',
  'user:candidate-parent-destroyed',
];

before(cleanOwnedSessionArtifacts);
after(cleanOwnedSessionArtifacts);

test('legacy compaction persists its replacement context', async () => {
  await withCheckpointMode(false, async () => {
    const session = createInitializedSession('user:legacy-persist', {
      async chatStream() {
        return { content: 'legacy answer', toolCalls: [], usage };
      },
    });
    const original = { role: 'user', content: 'old history' } as Message;
    const compacted = { role: 'user', content: 'legacy summary' } as Message;
    (session as any).messages.push(original);
    (session as any).contextWindowManager.compactIfNeeded = async () => ({
      messages: [compacted],
      compacted: true,
    });
    const persisted: Message[][] = [];
    (session as any).lifecycleManager.saveContext = (messages: Message[]) => {
      persisted.push(messages.map(message => ({ ...message })));
      return true;
    };

    await session.handleMessage('continue');

    assert.ok(persisted.some(messages => messages.some(message => message.content === 'legacy summary')));
    assert.ok((session as any).messages.some((message: Message) => message.content === 'legacy summary'));
  });
});

test('candidate persistence race keeps memory aligned with the persisted projection', async () => {
  await withCandidateMode(async () => {
    const session = createInitializedSession('user:candidate-persist-race', {
      async chatStream() {
        return { content: 'answer', toolCalls: [], usage };
      },
    });
    (session as any).messages.push({ role: 'user', content: 'history root' });
    (session as any).getContextUsageInfo = () => ({
      usedTokens: 60,
      toolTokens: 0,
      maxTokens: 100,
      usagePercent: 60,
    });
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = noCompaction;
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => ({
      compacted: true,
      messages: [{ role: 'user', content: 'candidate summary' }],
    });
    const persisted: Message[][] = [];
    (session as any).lifecycleManager.saveContext = (messages: Message[]) => {
      persisted.push(messages.map(message => ({ ...message })));
      return true;
    };

    await session.handleMessage('start candidate');
    await waitFor(() => (session as any).checkpointCandidate?.status === 'ready');
    const candidate = (session as any).checkpointCandidate;
    candidate.confirmCommit = () => false;
    await session.handleMessage('commit candidate');

    assert.ok(persisted.some(messages => messages.some(message => message.content === 'candidate summary')));
    assert.ok((session as any).messages.some((message: Message) => message.content === 'candidate summary'));
    assert.equal(candidate.status, 'cancelled');
    assert.notEqual((session as any).checkpointCandidate, candidate);
  });
});

test('three consecutive checkpoints retain state from the previous checkpoint', async () => {
  const summaries = [
    'Completed: inspected repository. Active: edit file. Next: run tests. Constraint: do not restart server.',
    'Completed: edited file. Active: run tests. Next: fix failures. Constraint: do not restart server.',
    'Completed: tests pass. Active: report result. Next: none. Constraint: do not restart server.',
  ];
  const requests: Message[][] = [];
  const service = {
    chatStream: async (messages: Message[], _tools: unknown, callbacks: any) => {
      requests.push(messages.map(message => ({ ...message })));
      const summary = summaries[requests.length - 1];
      callbacks.onText?.(summary);
      return { content: summary, usage };
    },
  };
  const coordinator = new CheckpointCompactionCoordinator(service, {
    maxContextTokens: 200,
    compactionThreshold: 0.5,
  });
  let messages: Message[] = [
    { role: 'user', content: 'ROOT objective: inspect repository. Constraint: do not restart server.', __episodeId: 'episode-1', __episodeInputKind: 'root' },
    { role: 'assistant', content: 'old work ' + 'x'.repeat(2000), __episodeId: 'episode-1' },
  ];
  for (let index = 0; index < 3; index++) {
    const result = await coordinator.compactIfNeeded(messages, {
      sessionKey: 'three-checkpoints',
      phase: 'mid_turn',
      episodeId: 'episode-1',
    });
    assert.equal(result.compacted, true);
    messages = [...result.messages, { role: 'user', content: `follow-up ${index}`, __episodeId: 'episode-1', __episodeInputKind: 'pending' }];
  }

  assert.match(String(requests[1].map(message => message.content).join('\n')), /Completed: inspected repository/);
  assert.match(String(requests[2].map(message => message.content).join('\n')), /Completed: edited file/);
  assert.match(String(requests[2].map(message => message.content).join('\n')), /do not restart server/);
});

test('handleMessage starts a candidate and commits it on the next turn with suffix intact', async () => {
  await withCandidateMode(async () => {
    const modelRequests: Message[][] = [];
    let responseNumber = 0;
    const session = createInitializedSession('user:candidate-integration', {
      async chatStream(messages: Message[]) {
        modelRequests.push(messages.map(message => ({ ...message })));
        return { content: `answer-${++responseNumber}`, toolCalls: [], usage };
      },
    });
    (session as any).messages.push({ role: 'user', content: 'history root', __episodeId: 'history' });
    (session as any).getContextUsageInfo = (messages: Message[]) => {
      const compacted = messages.some(message => message.content === 'candidate summary');
      return {
        usedTokens: compacted ? 20 : 60,
        toolTokens: 0,
        maxTokens: 100,
        usagePercent: compacted ? 20 : 60,
      };
    };
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = noCompaction;
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => ({
      compacted: true,
      messages: [{ role: 'user', content: 'candidate summary', __episodeId: 'history' }],
    });
    const persisted: Message[][] = [];
    (session as any).lifecycleManager.saveContext = (messages: Message[]) => {
      persisted.push(messages.map(message => ({ ...message })));
      return true;
    };

    const first = await session.handleMessage('first suffix input');
    await waitFor(() => (session as any).checkpointCandidate?.status === 'ready');
    const second = await session.handleMessage('second input');

    assert.equal(first.text, 'answer-1');
    assert.equal(second.text, 'answer-2');
    assert.ok(modelRequests[1].some(message => message.content === 'candidate summary'));
    assert.ok(modelRequests[1].some(message => message.content === 'first suffix input'));
    assert.ok(modelRequests[1].some(message => message.content === 'answer-1'));
    assert.ok(persisted.some(messages =>
      messages.some(message => message.content === 'candidate summary')
      && messages.some(message => message.content === 'first suffix input')));
    assert.equal((session as any).checkpointCandidate, null);
  });
});

test('handleMessage preempts at 85 percent and ignores a late candidate result', async () => {
  await withCandidateMode(async () => {
    let usagePercent = 60;
    let releaseCandidate!: () => void;
    const candidateGate = new Promise<void>(resolve => { releaseCandidate = resolve; });
    const session = createInitializedSession('user:candidate-preempt-integration', {
      async chatStream() {
        return { content: 'main answer', toolCalls: [], usage };
      },
    });
    (session as any).messages.push({ role: 'user', content: 'history root' });
    (session as any).getContextUsageInfo = () => ({
      usedTokens: usagePercent,
      toolTokens: 0,
      maxTokens: 100,
      usagePercent,
    });
    let serialInput: Message[] | undefined;
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = async (messages: Message[]) => {
      if (usagePercent === 85) serialInput = messages.map(message => ({ ...message }));
      return noCompaction(messages);
    };
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => {
      await candidateGate;
      return { compacted: true, messages: [{ role: 'user', content: 'late candidate summary' }] };
    };

    await session.handleMessage('start candidate');
    const candidate = (session as any).checkpointCandidate;
    assert.equal(candidate.status, 'running');

    usagePercent = 85;
    await session.handleMessage('trigger high water');
    releaseCandidate();
    await new Promise(resolve => setImmediate(resolve));

    assert.ok(serialInput?.some(message => message.content === 'start candidate'));
    assert.ok(serialInput?.some(message => message.content === 'main answer'));
    assert.equal(candidate.status, 'cancelled');
    assert.equal(candidate.result, undefined);
    assert.equal((session as any).checkpointCandidate, null);
    assert.equal(JSON.stringify((session as any).messages).includes('late candidate summary'), false);
  });
});

test('cleared parent session discards a candidate result that returns after deletion', async () => {
  await withCandidateMode(async () => {
    let releaseCandidate!: () => void;
    const candidateGate = new Promise<void>(resolve => { releaseCandidate = resolve; });
    const session = createInitializedSession('user:candidate-parent-destroyed', {
      async chatStream() {
        return { content: 'main answer', toolCalls: [], usage };
      },
    });
    (session as any).messages.push({ role: 'user', content: 'history root' });
    (session as any).getContextUsageInfo = () => ({
      usedTokens: 60,
      toolTokens: 0,
      maxTokens: 100,
      usagePercent: 60,
    });
    (session as any).checkpointCompactionCoordinator.compactIfNeeded = noCompaction;
    (session as any).checkpointCandidateCoordinator.compactIfNeeded = async () => {
      await candidateGate;
      return { compacted: true, messages: [{ role: 'user', content: 'discarded candidate summary' }] };
    };
    let persistCalls = 0;
    (session as any).lifecycleManager.saveContext = () => {
      persistCalls++;
      return true;
    };

    await session.handleMessage('start candidate before parent deletion');
    const candidate = (session as any).checkpointCandidate;
    assert.equal(candidate.status, 'running');

    assert.equal(session.clear(), true);
    assert.equal((session as any).checkpointCandidate, null);
    assert.deepEqual((session as any).messages, []);
    const persistCallsAfterClear = persistCalls;

    releaseCandidate();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(candidate.status, 'cancelled');
    assert.equal(candidate.result, undefined);
    assert.equal((session as any).checkpointCandidate, null);
    assert.deepEqual((session as any).messages, []);
    assert.equal(persistCalls, persistCallsAfterClear);
  });
});

function cleanOwnedSessionArtifacts(): void {
  for (const key of OWNED_SESSION_KEYS) {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    fs.rmSync(path.join(process.cwd(), 'data', 'sessions', `${safeKey}.jsonl`), { force: true });
    fs.rmSync(path.join(process.cwd(), 'data', 'session-state', `${safeKey}.json`), { force: true });
  }
  const logsRoot = path.join(process.cwd(), 'logs', 'sessions', 'catscompany');
  if (!fs.existsSync(logsRoot)) return;
  const ownedNames = new Set(OWNED_SESSION_KEYS.map(key => (
    `catscompany_${key.replace(/[:<>"|?*]/g, '_')}.jsonl`
  )));
  for (const dateEntry of fs.readdirSync(logsRoot, { withFileTypes: true })) {
    if (!dateEntry.isDirectory()) continue;
    const dateDir = path.join(logsRoot, dateEntry.name);
    for (const filename of fs.readdirSync(dateDir)) {
      if (ownedNames.has(filename)) fs.rmSync(path.join(dateDir, filename), { force: true });
    }
  }
}

function createInitializedSession(key: string, aiService: any): AgentSession {
  const session = new AgentSession(key, buildMockServices(aiService), 'catscompany');
  const lifecycleManager = (session as any).lifecycleManager;
  lifecycleManager.saveContext = () => true;
  lifecycleManager.saveCurrentDirectory = () => {};
  lifecycleManager.clear = () => ({ initialized: false, lastActiveAt: Date.now(), persisted: true });
  (session as any).turnLogRecorder.recordTurn = () => {};
  (session as any).sessionTurnLogger.logPromptTrace = () => {};
  (session as any).sessionTurnLogger.logSubAgentEvent = () => {};
  (session as any).initialized = true;
  (session as any).messages = [{ role: 'system', content: 'system prompt' }];
  return session;
}

function buildMockServices(aiService: any): any {
  return {
    aiService,
    toolManager: {
      getToolDefinitions() { return []; },
      executeTool() { throw new Error('not expected'); },
      getWorkspaceRoot() { return process.cwd(); },
    },
    skillManager: {
      getSkill() { return undefined; },
      getUserInvocableSkills() { return []; },
      getAutoInvocableSkills() { return []; },
      findAutoInvocableSkillByText() { return undefined; },
      loadSkills: async () => {},
    },
  };
}

async function noCompaction(messages: Message[]): Promise<any> {
  return {
    messages,
    compacted: false,
    usedTokens: 60,
    toolTokens: 0,
    maxTokens: 100,
    usagePercent: 60,
  };
}

async function withCandidateMode(run: () => Promise<void>): Promise<void> {
  await withCheckpointMode(true, run);
}

async function withCheckpointMode(enabled: boolean, run: () => Promise<void>): Promise<void> {
  const previousCandidates = process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
  const previousCheckpoint = process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED;
  process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = 'true';
  process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED = enabled ? 'true' : 'false';
  try {
    await run();
  } finally {
    if (previousCandidates === undefined) delete process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
    else process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = previousCandidates;
    if (previousCheckpoint === undefined) delete process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED;
    else process.env.XIAOBA_CHECKPOINT_COMPACTION_ENABLED = previousCheckpoint;
  }
}

async function waitFor(predicate: () => boolean, maxAttempts = 50): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met in time');
}
