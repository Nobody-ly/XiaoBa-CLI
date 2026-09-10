import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/types';
import {
  CHECKPOINT_SUMMARY_PREFIX,
  CheckpointCompactionCoordinator,
} from '../src/core/checkpoint-compaction';
import { estimateMessagesTokens } from '../src/core/token-estimator';

const CONTEXT_WINDOW_TOKENS = 256_000;
const TOOL_SCHEMA_TOKENS = 8_000;
const SUMMARY_TOKENS = 4_000;

function englishText(tokenCount: number, prefix = ''): string {
  return `${prefix}${'x'.repeat(Math.max(0, tokenCount * 4))}`;
}

function createSummaryService(requests: Message[][]): any {
  return {
    chatStream: async (
      messages: Message[],
      _tools: unknown,
      callbacks: { onText?: (text: string) => void },
    ) => {
      requests.push(messages.map(message => ({ ...message })));
      const summary = englishText(SUMMARY_TOKENS, [
        'Objective: continue the verified task.',
        'Completed: prior work was summarized at a stable boundary.',
        'Next: continue without repeating completed work.',
        '',
      ].join('\n'));
      callbacks.onText?.(summary);
      return {
        content: summary,
        usage: {
          promptTokens: estimateMessagesTokens(messages),
          completionTokens: SUMMARY_TOKENS,
          totalTokens: estimateMessagesTokens(messages) + SUMMARY_TOKENS,
        },
      };
    },
  };
}

function createCoordinator(requests: Message[][]): {
  coordinator: CheckpointCompactionCoordinator;
  contextWindowTokens: number;
  triggerTokens: number;
} {
  return {
    coordinator: new CheckpointCompactionCoordinator(
      createSummaryService(requests),
      { maxContextTokens: CONTEXT_WINDOW_TOKENS },
    ),
    contextWindowTokens: CONTEXT_WINDOW_TOKENS,
    triggerTokens: Math.floor(CONTEXT_WINDOW_TOKENS * 0.85) + 1,
  };
}

test('256K pre-turn scenario compacts old completed history and restores large headroom', async () => {
  const requests: Message[][] = [];
  const { coordinator, contextWindowTokens, triggerTokens } = createCoordinator(requests);
  const messages: Message[] = [
    { role: 'system', content: englishText(8_000, 'Stable system prompt.\n') },
    { role: 'user', content: englishText(110_000, 'Old objective.\n'), __episodeId: 'old-1' },
    { role: 'assistant', content: englishText(95_000, 'Old completed work.\n'), __episodeId: 'old-1' },
    { role: 'user', content: englishText(4_000, 'Most recent user correction.\n'), __episodeId: 'old-2' },
  ];
  const beforeTokens = estimateMessagesTokens(messages) + TOOL_SCHEMA_TOKENS;

  assert.equal(contextWindowTokens, 256_000);
  assert.equal(triggerTokens, 217_601);
  assert.ok(beforeTokens >= triggerTokens);

  const result = await coordinator.compactIfNeeded(messages, {
    sessionKey: 'scenario-pre-turn-256k',
    phase: 'pre_turn',
    toolTokens: TOOL_SCHEMA_TOKENS,
  });
  const afterTokens = estimateMessagesTokens(result.messages) + TOOL_SCHEMA_TOKENS;

  assert.equal(result.compacted, true);
  assert.ok(afterTokens < contextWindowTokens * 0.25);
  assert.ok(result.messages.some(message =>
    String(message.content).includes('Most recent user correction.')));
  assert.equal(result.messages.some(message =>
    String(message.content).includes('Old completed work.')), false);
  assert.ok(result.messages.some(message =>
    String(message.content).startsWith(CHECKPOINT_SUMMARY_PREFIX)));
});

test('256K mid-turn scenario waits for tool completion and keeps the active request', async () => {
  const requests: Message[][] = [];
  const { coordinator, contextWindowTokens, triggerTokens } = createCoordinator(requests);
  const messages: Message[] = [
    { role: 'system', content: englishText(8_000, 'Stable system prompt.\n') },
    { role: 'user', content: englishText(95_000, 'Earlier history.\n'), __episodeId: 'old-1' },
    { role: 'assistant', content: englishText(85_000, 'Earlier answer.\n'), __episodeId: 'old-1' },
    {
      role: 'user',
      content: englishText(3_000, 'Active long-task objective.\n'),
      __episodeId: 'active-episode',
      __episodeInputKind: 'root',
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-complete',
        type: 'function',
        function: { name: 'execute_shell', arguments: '{"command":"verify"}' },
      }],
      __episodeId: 'active-episode',
    },
    {
      role: 'tool',
      name: 'execute_shell',
      tool_call_id: 'call-complete',
      content: englishText(26_000, 'Complete tool result.\n'),
      __episodeId: 'active-episode',
    },
  ];
  const beforeTokens = estimateMessagesTokens(messages) + TOOL_SCHEMA_TOKENS;

  assert.ok(beforeTokens >= triggerTokens);

  const result = await coordinator.compactIfNeeded(messages, {
    sessionKey: 'scenario-mid-turn-256k',
    phase: 'mid_turn',
    toolTokens: TOOL_SCHEMA_TOKENS,
  });
  const afterTokens = estimateMessagesTokens(result.messages) + TOOL_SCHEMA_TOKENS;

  assert.equal(result.compacted, true);
  assert.ok(afterTokens < contextWindowTokens * 0.25);
  assert.ok(result.messages.some(message =>
    String(message.content).includes('Active long-task objective.')));
  assert.equal(result.messages.some(message => message.role === 'tool'), true);
  const summaryInputTool = requests[0].find(message => message.role === 'tool');
  assert.equal(summaryInputTool, undefined);
});

test('256K restore scenario creates a checkpoint that requires runtime re-verification', async () => {
  const requests: Message[][] = [];
  const { coordinator, contextWindowTokens, triggerTokens } = createCoordinator(requests);
  const messages: Message[] = [
    { role: 'system', content: englishText(8_000, 'Stable system prompt.\n') },
    { role: 'user', content: englishText(110_000, 'Restored historical request.\n') },
    { role: 'assistant', content: englishText(100_000, 'Restored visible answer.\n') },
  ];
  const beforeTokens = estimateMessagesTokens(messages) + TOOL_SCHEMA_TOKENS;

  assert.ok(beforeTokens >= triggerTokens);

  const result = await coordinator.compactIfNeeded(messages, {
    sessionKey: 'scenario-restore-256k',
    phase: 'restore',
    toolTokens: TOOL_SCHEMA_TOKENS,
  });
  const afterTokens = estimateMessagesTokens(result.messages) + TOOL_SCHEMA_TOKENS;
  const checkpointPrompt = String(requests[0][0]?.content || '');

  assert.equal(result.compacted, true);
  assert.ok(afterTokens < contextWindowTokens * 0.2);
  assert.match(checkpointPrompt, /unknown until reverified/i);
  assert.match(checkpointPrompt, /processes, ports, files, devices/i);
});
