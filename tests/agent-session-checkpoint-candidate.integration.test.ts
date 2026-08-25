import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSession } from '../src/core/agent-session';
import type { Message } from '../src/types';

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

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

function createInitializedSession(key: string, aiService: any): AgentSession {
  const session = new AgentSession(key, buildMockServices(aiService), 'catscompany');
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
  const previous = process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
  process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = 'true';
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED;
    else process.env.XIAOBA_CHECKPOINT_CANDIDATES_ENABLED = previous;
  }
}

async function waitFor(predicate: () => boolean, maxAttempts = 50): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met in time');
}
