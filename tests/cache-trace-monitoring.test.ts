import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import express, { Router } from 'express';
import type { Server } from 'http';
import { ConversationRunner } from '../src/core/conversation-runner';
import { CacheTraceObserver, isCacheTraceEnabledForSession } from '../src/observability/cache-trace';
import { readCacheTraceStore } from '../src/observability/cache-trace-reader';
import { registerCacheTraceRoutes } from '../src/dashboard/routes/cache-trace';
import type { Message } from '../src/types';
import type { ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../src/types/tool';

class EmptyTools implements ToolExecutor {
  getToolDefinitions(): ToolDefinition[] { return []; }
  async executeTool(_call: ToolCall): Promise<ToolResult> { throw new Error('not used'); }
}

function oneReplyAI() {
  return {
    getConfig: () => ({ provider: 'openai', model: 'gpt-test', openaiApiMode: 'responses', contextWindowTokens: 32000 }),
    isToolCallingSupported: () => true,
    async chatStream(_messages: Message[]): Promise<any> {
      return { content: 'normal reply', toolCalls: [], usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedReadTokens: 4 } };
    },
  };
}

test('a throwing cache trace sink cannot interrupt ConversationRunner', async () => {
  const runner = new ConversationRunner(oneReplyAI() as any, new EmptyTools(), {
    enableCompression: false,
    cacheTraceSink: { observe: () => { throw new Error('trace exploded'); } },
  });
  const result = await runner.run([{ role: 'user', content: 'hello' }]);
  assert.equal(result.response, 'normal reply');
});

test('observer consumes an asynchronous writer rejection', async () => {
  let errors = 0;
  const observer = new CacheTraceObserver({
    sessionId: 'cache:test',
    env: { XIAOBA_CACHE_TRACE: 'true' },
    writeEntry: async () => { throw new Error('ENOSPC'); },
    onError: () => { errors++; },
  });
  observer.observe({
    episodeNumber: 1,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    response: { content: 'ok', usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } },
    durationMs: 5,
    modelConfig: { provider: 'openai', model: 'gpt-test', openaiApiMode: 'responses' },
  });
  await observer.drain();
  assert.equal(errors, 1);
});

test('session allow-list enables only the selected session', () => {
  const env = { XIAOBA_CACHE_TRACE: 'true', XIAOBA_CACHE_TRACE_SESSIONS: 'one,two' };
  assert.equal(isCacheTraceEnabledForSession('one', env), true);
  assert.equal(isCacheTraceEnabledForSession('three', env), false);
  assert.equal(new CacheTraceObserver({ sessionId: 'two', env }).enabled, true);
});

test('reader accepts turn and episode records, skips bad JSON, and resets diff on model switch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cache-reader-'));
  try {
    fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({
      schema: 'xiaoba.cache_trace.v2',
      session: { session_id: 'session-a', session_type: 'agent', surface: 'cli' },
      turn: { turn_number: 1, run_id: 'old-run' },
      request: { timestamp: '2026-08-01T01:00:00.000Z', provider: 'openai', model: 'old-model', api_type: 'openai-chat-completions', request_sha256: 'a', message_sha256s: ['m1'] },
      response_usage: { input_tokens: 100, cache_read_tokens: 20, output_tokens: 10 },
    }));
    fs.writeFileSync(path.join(dir, 'new.json'), JSON.stringify({
      schema: 'xiaoba.cache_trace.v3',
      session: { session_id: 'session-a', session_type: 'agent', surface: 'cli' },
      episode: { episode_number: 2, run_id: 'new-run' },
      request: { timestamp: '2026-08-01T01:01:00.000Z', provider: 'anthropic', model: 'new-model', api_type: 'anthropic-messages', request_sha256: 'b', message_sha256s: ['m2'] },
      response_usage: { input_tokens: 200, cache_read_tokens: 100, cache_write_tokens: 10, output_tokens: 20 },
    }));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');

    const store = await readCacheTraceStore(dir);
    assert.equal(store.scannedFiles, 3);
    assert.equal(store.malformedFiles, 1);
    assert.equal(store.records.length, 2);
    assert.equal(store.records[0].runId, 'old-run');
    assert.equal(store.records[1].diff.baselineReset, true);
    assert.equal(store.records[1].diff.resetReason, 'provider-model-api-changed');
    assert.equal(store.sessions[0].weightedHitRatio, 0.4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('observer writes v3 metadata without content by default', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cache-write-'));
  try {
    const observer = new CacheTraceObserver({
      sessionId: 'cache:write',
      traceDir: dir,
      env: { XIAOBA_CACHE_TRACE: 'true' },
    });
    observer.observe({
      episodeNumber: 7,
      messages: [{ role: 'user', content: 'secret content must not be stored' }],
      tools: [],
      response: { content: 'ok', usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11, cachedReadTokens: 4 } },
      durationMs: 3,
      modelConfig: { provider: 'openai', model: 'gpt-test', openaiApiMode: 'responses' },
    });
    await observer.drain();
    const files = listJsonFiles(dir);
    assert.equal(files.length, 1);
    const entry = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    assert.equal(entry.schema, 'xiaoba.cache_trace.v3');
    assert.equal(entry.episode.episode_number, 7);
    assert.equal(entry.response_usage.cache_read_tokens, 4);
    assert.equal(entry.request.request_snapshot, undefined);
    assert.doesNotMatch(JSON.stringify(entry), /secret content/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard exposes a discoverable cache trace page', () => {
  const root = path.resolve(__dirname, '..');
  const index = fs.readFileSync(path.join(root, 'dashboard', 'index.html'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'dashboard', 'cache-trace.html'), 'utf8');
  assert.match(index, /href="cache-trace\.html"/);
  assert.match(page, /缓存命中监控/);
  assert.match(page, /catsco\.dashboardApiKey/);
  assert.match(page, /采集 Cache Trace/);
  assert.match(page, /\/api\/cache-trace\/config/);
  assert.match(page, /\/api\/cache-trace\/sessions/);
});

test('dashboard persists the cache trace switch and restarts a running connector', async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cache-config-'));
  const env: NodeJS.ProcessEnv = {};
  let restarts = 0;
  const serviceManager = {
    getService: () => ({ status: 'running' as const }),
    restart: () => { restarts++; return { status: 'running' as const }; },
  };
  const app = express();
  app.use(express.json());
  const router = Router();
  registerCacheTraceRoutes(router, { runtimeRoot, env, serviceManager: serviceManager as any });
  app.use('/api', router);
  const server = await listen(app);

  try {
    const before = await fetchJson(server, '/api/cache-trace/config');
    assert.equal(before.enabled, false);
    assert.equal(before.dashboardAvailable, true);

    const response = await fetchJson(server, '/api/cache-trace/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(response.enabled, true);
    assert.equal(response.connectorRestarted, true);
    assert.equal(env.XIAOBA_CACHE_TRACE, 'true');
    assert.equal(restarts, 1);
    const savedEnv = dotenv.parse(fs.readFileSync(path.join(runtimeRoot, '.env'), 'utf8'));
    assert.equal(savedEnv.XIAOBA_CACHE_TRACE, 'true');
  } finally {
    await close(server);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('cache trace switch waits for the next Agent start when the connector is stopped', async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cache-config-stopped-'));
  const app = express();
  app.use(express.json());
  const router = Router();
  registerCacheTraceRoutes(router, {
    runtimeRoot,
    env: {},
    serviceManager: {
      getService: () => ({ status: 'stopped' } as any),
      restart: () => { throw new Error('must not restart'); },
    },
  });
  app.use('/api', router);
  const server = await listen(app);

  try {
    const response = await fetchJson(server, '/api/cache-trace/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(response.connectorRestarted, false);
    assert.equal(response.appliesOnNextStart, true);
  } finally {
    await close(server);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

function listJsonFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(root, entry.name);
    return entry.isDirectory() ? listJsonFiles(full) : entry.isFile() && entry.name.endsWith('.json') ? [full] : [];
  });
}

function listen(app: express.Express): Promise<Server> {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

async function fetchJson(server: Server, pathname: string, init?: RequestInit): Promise<any> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, init);
  assert.equal(response.status, 200);
  return response.json();
}
