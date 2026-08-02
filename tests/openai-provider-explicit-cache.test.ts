import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import { OpenAIProvider } from '../src/providers/openai-provider';
import type { Message } from '../src/types';
import { Logger } from '../src/utils/logger';

function provider(): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: 'test-key',
    apiUrl: 'https://relay.example/v1',
    model: 'gpt-5.6-sol',
    openaiApiMode: 'responses',
  });
}

const context = {
  promptCacheContext: {
    sessionKey: 'session-alpha',
    currentEpisodeId: 'episode-2',
    phase: 'normal' as const,
    explicitCaching: true,
  },
};

function countBreakpoints(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countBreakpoints(item), 0);
  const record = value as Record<string, unknown>;
  return (record.prompt_cache_breakpoint ? 1 : 0)
    + Object.values(record).reduce((sum, item) => sum + countBreakpoints(item), 0);
}

test('Responses explicit cache emits S, A, and advancing B boundaries without persisting markers', () => {
  const messages: Message[] = [
    { role: 'system', content: 'stable system' },
    { role: 'system', content: '[transient_skills_list]\n- lookup', __cacheScope: 'stable' },
    { role: 'user', content: 'old task', __episodeId: 'episode-1' },
    { role: 'assistant', content: 'old answer', __episodeId: 'episode-1' },
    { role: 'user', content: 'root task', __episodeId: 'episode-2', __episodeInputKind: 'root' },
    {
      role: 'assistant', content: null, __episodeId: 'episode-2',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    },
    { role: 'tool', content: 'first result', tool_call_id: 'call-1', __episodeId: 'episode-2' },
    {
      role: 'assistant', content: null, __episodeId: 'episode-2',
      tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    },
    { role: 'tool', content: 'second result', tool_call_id: 'call-2', __episodeId: 'episode-2' },
    { role: 'system', content: '[transient_plan_status]\nstep two', __cacheScope: 'dynamic' },
  ];

  const body = (provider() as any).buildResponsesRequestBody(messages, [], false, context);
  assert.deepEqual(body.prompt_cache_options, { mode: 'explicit' });
  assert.match(body.instructions, /stable system/);
  assert.match(body.instructions, /transient_skills_list/);
  assert.doesNotMatch(body.instructions, /transient_plan_status/);
  assert.equal(countBreakpoints(body.input), 4);
  assert.equal(body.input[0].role, 'system');
  assert.equal(body.input.at(-3).role, 'system');
  assert.match(String(body.input.at(-3).content), /transient_plan_status/);
  assert.equal(body.input.at(-2).type, 'function_call');
  assert.equal(body.input.at(-1).type, 'function_call_output');
  assert.equal(messages.some(message => (message as any).prompt_cache_breakpoint), false);
});

test('Responses keeps a continuation checkpoint before its retained historical evidence', () => {
  const messages: Message[] = [
    { role: 'system', content: 'stable system' },
    {
      role: 'user',
      content: 'CONTINUATION_CHECKPOINT',
      __checkpointSummary: true,
      __episodeId: 'episode-2',
    },
    { role: 'user', content: 'retained old evidence', __episodeId: 'episode-1' },
    { role: 'assistant', content: 'retained old answer', __episodeId: 'episode-1' },
    { role: 'user', content: 'current root task', __episodeId: 'episode-2', __episodeInputKind: 'root' },
    {
      role: 'assistant', content: null, __episodeId: 'episode-2',
      tool_calls: [{ id: 'call-current', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    },
    { role: 'tool', content: 'latest result', tool_call_id: 'call-current', __episodeId: 'episode-2' },
    { role: 'system', content: '[transient_plan_status]\ncurrent step', __cacheScope: 'dynamic' },
  ];

  const body = (provider() as any).buildResponsesRequestBody(messages, [], false, context);
  const checkpointIndex = body.input.findIndex((item: any) => item.content === 'CONTINUATION_CHECKPOINT');
  const oldEvidenceIndex = body.input.findIndex((item: any) => item.content === 'retained old evidence');
  const rootIndex = body.input.findIndex((item: any) => item.content === 'current root task');
  const planIndex = body.input.findIndex((item: any) => String(item.content).includes('transient_plan_status'));
  const callIndex = body.input.findIndex((item: any) => item.type === 'function_call' && item.call_id === 'call-current');
  const breakpointIndexes = body.input
    .map((item: any, index: number) => countBreakpoints(item) > 0 ? index : -1)
    .filter((index: number) => index >= 0);

  assert.equal(breakpointIndexes.length, 3);
  assert.ok(breakpointIndexes[0] < checkpointIndex);
  assert.ok(checkpointIndex < oldEvidenceIndex);
  assert.ok(oldEvidenceIndex < breakpointIndexes[1]);
  assert.ok(breakpointIndexes[1] < rootIndex);
  assert.ok(rootIndex < breakpointIndexes[2]);
  assert.ok(breakpointIndexes[2] < planIndex);
  assert.ok(planIndex < callIndex);
});

test('Responses cache key is isolated by session without exposing the session id', () => {
  const messages: Message[] = [{ role: 'system', content: 'stable' }, { role: 'user', content: 'hello' }];
  const first = (provider() as any).buildResponsesRequestBody(messages, [], false, context);
  const second = (provider() as any).buildResponsesRequestBody(messages, [], false, {
    promptCacheContext: { ...context.promptCacheContext, sessionKey: 'session-beta' },
  });
  assert.notEqual(first.prompt_cache_key, second.prompt_cache_key);
  assert.doesNotMatch(first.prompt_cache_key, /session-alpha/);
});

test('Responses breakpoints never rewrite parallel function calls or outputs', () => {
  const messages: Message[] = [
    { role: 'system', content: 'stable system' },
    { role: 'user', content: 'root task', __episodeId: 'episode-2', __episodeInputKind: 'root' },
    {
      role: 'assistant', content: null, __episodeId: 'episode-2',
      tool_calls: [
        { id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"id":"a"}' } },
        { id: 'call-b', type: 'function', function: { name: 'lookup', arguments: '{"id":"b"}' } },
      ],
    },
    { role: 'tool', content: 'result-a', tool_call_id: 'call-a', __episodeId: 'episode-2' },
    { role: 'tool', content: 'result-b', tool_call_id: 'call-b', __episodeId: 'episode-2' },
    { role: 'assistant', content: 'finished', __episodeId: 'episode-2' },
  ];

  const body = (provider() as any).buildResponsesRequestBody(messages, [], false, context);
  const callA = body.input.findIndex((item: any) => item.type === 'function_call' && item.call_id === 'call-a');
  const callB = body.input.findIndex((item: any) => item.type === 'function_call' && item.call_id === 'call-b');
  const outputA = body.input.findIndex((item: any) => item.type === 'function_call_output' && item.call_id === 'call-a');
  const outputB = body.input.findIndex((item: any) => item.type === 'function_call_output' && item.call_id === 'call-b');
  const boundaryAfterTools = body.input.findIndex((item: any, index: number) => (
    index > outputB && countBreakpoints(item) > 0
  ));

  assert.ok(callA < callB && callB < outputA && outputA < outputB);
  assert.ok(outputB < boundaryAfterTools);
  assert.equal(body.input[outputA].output, 'result-a');
  assert.equal(body.input[outputB].output, 'result-b');
  assert.equal(JSON.stringify(messages).includes('prompt_cache_breakpoint'), false);
});

test('Responses explicit cache is not sent to older models', () => {
  const oldProvider = new OpenAIProvider({
    apiKey: 'test-key',
    apiUrl: 'https://relay.example/v1',
    model: 'gpt-5.5-sol',
    openaiApiMode: 'responses',
  });
  const body = (oldProvider as any).buildResponsesRequestBody(
    [{ role: 'user', content: 'hello', __episodeId: 'episode-2' }],
    [],
    false,
    context,
  );
  assert.equal(body.prompt_cache_options, undefined);
  assert.equal(countBreakpoints(body.input), 0);
});

test('legacy checkpoint boundary is filtered but ordinary discussion is preserved', () => {
  const messages: Message[] = [
    { role: 'system', content: '[checkpoint_compaction_boundary]\nphase=mid_turn' },
    { role: 'user', content: 'Please explain checkpoint_compaction_boundary behavior.', __episodeId: 'episode-2' },
  ];
  const body = (provider() as any).buildResponsesRequestBody(messages, [], false, context);
  const serialized = JSON.stringify(body.input);
  assert.doesNotMatch(serialized, /phase=mid_turn/);
  assert.match(serialized, /Please explain checkpoint_compaction_boundary behavior/);
});

test('unsupported explicit fields retry once and pin the provider to compatibility mode', async () => {
  const originalPost = axios.post;
  const bodies: any[] = [];
  (axios as any).post = async (_url: string, body: any) => {
    bodies.push(body);
    if (bodies.length === 1) {
      throw Object.assign(new Error('unknown field prompt_cache_options'), {
        response: { status: 400, data: { error: { message: 'prompt_cache_breakpoint is unsupported' } } },
      });
    }
    return { data: { status: 'completed', output: [] } };
  };
  try {
    const instance = provider();
    await instance.chat([{ role: 'user', content: 'hello', __episodeId: 'episode-2' }], [], context);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0].prompt_cache_options, { mode: 'explicit' });
    assert.equal(bodies[1].prompt_cache_options, undefined);
    assert.equal(countBreakpoints(bodies[1].input), 0);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('Responses cache usage is recorded without prompt content', async () => {
  const originalPost = axios.post;
  const originalRuntimeEvent = Logger.runtimeEvent;
  const events: any[] = [];
  (axios as any).post = async () => ({
    data: {
      status: 'completed',
      output: [],
      usage: {
        input_tokens: 1200,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 900, cache_write_tokens: 200 },
      },
    },
  });
  (Logger as any).runtimeEvent = (_level: string, _message: string, event: any) => events.push(event);
  try {
    await provider().chat([{ role: 'user', content: 'hello', __episodeId: 'episode-2' }], [], context);
    const usage = events.find(event => event.type === 'responses_cache_usage');
    assert.ok(usage);
    assert.deepEqual(usage.payload, {
      mode: 'explicit',
      cache_key_hash: usage.payload.cache_key_hash,
      input_tokens: 1200,
      cached_tokens: 900,
      cache_write_tokens: 200,
    });
    assert.equal(JSON.stringify(usage).includes('hello'), false);
  } finally {
    (axios as any).post = originalPost;
    (Logger as any).runtimeEvent = originalRuntimeEvent;
  }
});
