import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CatsCompanyBot } from '../src/catscompany';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { applyCloudModelRuntimeSelection } from '../src/commands/catscompany';
import { pullCloudBotModelSelection } from '../src/bot-definition/cloud-client';
import { CloudBotModelRuntimeReloadController } from '../src/bot-definition/runtime-reload';
import { createBotDefinitionSyncService } from '../src/bot-definition/service';
import { BOT_DEFINITION_SCHEMA, type BotDefinition } from '../src/bot-definition/types';
import { BotSkillBaseStore } from '../src/bot-skills/base-store';

test('post-start BotDefinition updates preserve an operator-managed Skill workspace', async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-apply-preserved-skills-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const configService = createCatsCoLocalConfigService({ runtimeRoot });
  configService.save({
    version: 1,
    endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
    account: { token: 'test-owner-token', uid: '7' },
    currentBot: { uid: '43', apiKey: 'test-bot-key', boundByUserUid: '7', bindingSource: 'test' },
  });
  const auth = configService.getAuthState();
  const definitions = createBotDefinitionSyncService({ runtimeRoot });
  const previous: BotDefinition = {
    schema: BOT_DEFINITION_SCHEMA,
    botId: '43',
    model: {
      kind: 'custom',
      protocol: 'openai-responses',
      apiBase: 'https://models.example.test/v1',
      model: 'unchanged-model',
      apiKey: 'test-model-key',
      contextWindowTokens: 128000,
    },
    prompt: { selected: 'custom', customSystemPrompt: 'Previous prompt.' },
    skills: [],
  };
  definitions.acceptCanonical(previous);
  const desired: BotDefinition = {
    ...previous,
    prompt: { selected: 'custom', customSystemPrompt: 'Updated prompt.' },
    skills: [{
      source: 'skillhub',
      skillId: 'private/cloud-only',
      version: 'sha256-cloud-only',
      contentHash: 'a'.repeat(64),
    }],
  };
  const localSkillRoot = path.join(runtimeRoot, 'skills', 'operator-local');
  const localSkillFile = path.join(localSkillRoot, 'SKILL.md');
  const localSkillText = [
    '---',
    'name: operator-local',
    'description: Operator-managed local Skill used for preservation testing.',
    '---',
    '',
    'Keep this local content unchanged.',
    '',
  ].join('\n');
  fs.mkdirSync(localSkillRoot, { recursive: true });
  fs.writeFileSync(localSkillFile, localSkillText);
  new BotSkillBaseStore(runtimeRoot).write({
    schema: 'xiaoba.bot-skill-sync-base.v2',
    botId: '43',
    definitionRevision: 6,
    skills: [],
    updatedAt: new Date().toISOString(),
  });

  const acks: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    if (url.pathname === '/api/bot/definition' && method === 'GET') {
      return Response.json({ configured: true, revision: 7, definition: desired });
    }
    if (url.pathname === '/api/bot/definition/ack' && method === 'POST') {
      acks.push(JSON.parse(String(init?.body)));
      return Response.json({ status: 'applied' });
    }
    if (url.pathname === '/api/bot/definition/default-prompt') {
      return Response.json({ status: 'stored' });
    }
    throw new Error(`Unexpected test request: ${method} ${url.pathname}`);
  });
  const oldBot = { isIdleForRuntimeReload: () => true } as CatsCompanyBot;
  const result = await applyCloudModelRuntimeSelection({
    runtimeRoot,
    env: { XIAOBA_PRESERVE_SKILLS: '1' },
    botId: '43',
    auth,
    selection: {
      kind: 'custom',
      modelId: 'unchanged-model',
      customModel: desired.model,
      revision: 7,
      definition: desired,
    },
    canApply: () => true,
    connectorConfig: {
      serverUrl: 'wss://cats.example.test/v0/channels',
      apiKey: 'test-bot-key',
      botUid: '43',
    },
    currentBot: () => oldBot,
    replaceBot: () => assert.fail('prompt-only update must not replace the connector'),
    scheduleAckRetry: () => assert.fail('ACK should succeed'),
    clearAckRetry: () => {},
  });

  assert.equal(result, 'applied');
  assert.deepEqual(acks, [{ revision: 7 }]);
  assert.equal(fs.readFileSync(localSkillFile, 'utf8'), localSkillText);
  assert.deepEqual(fs.readdirSync(localSkillRoot), ['SKILL.md']);
  assert.deepEqual(definitions.read('43')?.prompt, desired.prompt);
});

test('post-start model-only updates reuse unchanged Skills without touching the workspace', async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-apply-unchanged-skills-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const configService = createCatsCoLocalConfigService({ runtimeRoot });
  configService.save({
    version: 1,
    endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
    account: { token: 'test-owner-token', uid: '7' },
    currentBot: { uid: '43', apiKey: 'test-bot-key', boundByUserUid: '7', bindingSource: 'test' },
  });
  const auth = configService.getAuthState();
  const definitions = createBotDefinitionSyncService({ runtimeRoot });
  const previous: BotDefinition = {
    schema: BOT_DEFINITION_SCHEMA,
    botId: '43',
    model: {
      kind: 'custom', protocol: 'openai-responses', apiBase: 'https://models.example.test/v1',
      model: 'previous-model', apiKey: 'test-model-key', contextWindowTokens: 128000,
    },
    prompt: { selected: 'custom', customSystemPrompt: 'Unchanged prompt.' },
    skills: [],
  };
  const desired: BotDefinition = {
    ...previous,
    model: { ...previous.model, model: 'next-model' },
  };
  definitions.acceptCanonical(previous);
  const localSkillRoot = path.join(runtimeRoot, 'skills', 'server-local');
  const localSkillFile = path.join(localSkillRoot, 'SKILL.md');
  fs.mkdirSync(localSkillRoot, { recursive: true });
  fs.writeFileSync(localSkillFile, [
    '---',
    'name: server-local',
    'description: Server-local Skill that a model-only update must not reconcile.',
    '---',
    '',
    'Keep this content.',
    '',
  ].join('\n'));
  const before = fs.readFileSync(localSkillFile, 'utf8');
  const requests: string[] = [];
  const acks: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    requests.push(`${method} ${url.pathname}`);
    if (url.pathname === '/api/bot/definition' && method === 'GET') {
      return Response.json({ configured: true, revision: 7, definition: desired });
    }
    if (url.pathname === '/api/bot/definition/ack' && method === 'POST') {
      acks.push(JSON.parse(String(init?.body)));
      return Response.json({ status: 'applied' });
    }
    if (url.pathname === '/api/bot/definition/default-prompt') {
      return Response.json({ status: 'stored' });
    }
    throw new Error(`Unexpected test request: ${method} ${url.pathname}`);
  });
  let stopped = 0;
  let started = 0;
  const oldBot = {
    isIdleForRuntimeReload: () => true,
    destroy: async () => { stopped += 1; },
  } as CatsCompanyBot;
  let bot = oldBot;
  t.mock.method(CatsCompanyBot.prototype, 'start', async function (this: CatsCompanyBot) {
    started += 1;
    t.after(() => this.destroy());
  });
  t.mock.method(CatsCompanyBot.prototype, 'waitUntilReady', async () => {});

  const result = await applyCloudModelRuntimeSelection({
    runtimeRoot,
    botId: '43',
    auth,
    selection: {
      kind: 'custom',
      modelId: 'next-model',
      customModel: desired.model,
      revision: 7,
      definition: desired,
    },
    canApply: () => true,
    connectorConfig: {
      serverUrl: 'wss://cats.example.test/v0/channels',
      apiKey: 'test-bot-key',
      botUid: '43',
    },
    currentBot: () => bot,
    replaceBot: next => { bot = next; },
    scheduleAckRetry: () => assert.fail('ACK should succeed'),
    clearAckRetry: () => {},
  });

  assert.equal(result, 'applied');
  assert.equal(stopped, 1);
  assert.equal(started, 1);
  assert.notEqual(bot, oldBot);
  assert.deepEqual(acks, [{ revision: 7 }]);
  assert.equal(requests.some(request => request.includes('/api/bot/definition/skills')), false);
  assert.equal(requests.some(request => request.includes('private-skill-packages')), false);
  assert.equal(fs.readFileSync(localSkillFile, 'utf8'), before);
  assert.deepEqual(definitions.read('43')?.model, desired.model);
});

test('post-start prompt-only updates reuse unchanged Skills without restarting the connector', async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-apply-unchanged-skills-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const configService = createCatsCoLocalConfigService({ runtimeRoot });
  configService.save({
    version: 1,
    endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
    account: { token: 'test-owner-token', uid: '7' },
    currentBot: { uid: '43', apiKey: 'test-bot-key', boundByUserUid: '7', bindingSource: 'test' },
  });
  const auth = configService.getAuthState();
  const definitions = createBotDefinitionSyncService({ runtimeRoot });
  const previous: BotDefinition = {
    schema: BOT_DEFINITION_SCHEMA,
    botId: '43',
    model: {
      kind: 'custom', protocol: 'openai-responses', apiBase: 'https://models.example.test/v1',
      model: 'unchanged-model', apiKey: 'test-model-key', contextWindowTokens: 128000,
    },
    prompt: { selected: 'custom', customSystemPrompt: 'Previous prompt.' },
    skills: [],
  };
  const desired: BotDefinition = {
    ...previous,
    prompt: { selected: 'custom', customSystemPrompt: 'Updated prompt.' },
  };
  definitions.acceptCanonical(previous);
  const localSkillRoot = path.join(runtimeRoot, 'skills', 'server-local');
  fs.mkdirSync(localSkillRoot, { recursive: true });
  fs.writeFileSync(path.join(localSkillRoot, 'SKILL.md'), 'operator content\n');
  const requests: string[] = [];
  const acks: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    requests.push(`${method} ${url.pathname}`);
    if (url.pathname === '/api/bot/definition' && method === 'GET') {
      return Response.json({ configured: true, revision: 7, definition: desired });
    }
    if (url.pathname === '/api/bot/definition/ack' && method === 'POST') {
      acks.push(JSON.parse(String(init?.body)));
      return Response.json({ status: 'applied' });
    }
    if (url.pathname === '/api/bot/definition/default-prompt') {
      return Response.json({ status: 'stored' });
    }
    throw new Error(`Unexpected test request: ${method} ${url.pathname}`);
  });
  const oldBot = { isIdleForRuntimeReload: () => true } as CatsCompanyBot;

  const result = await applyCloudModelRuntimeSelection({
    runtimeRoot,
    botId: '43',
    auth,
    selection: {
      kind: 'custom', modelId: 'unchanged-model', customModel: desired.model,
      revision: 7, definition: desired,
    },
    canApply: () => true,
    connectorConfig: {
      serverUrl: 'wss://cats.example.test/v0/channels', apiKey: 'test-bot-key', botUid: '43',
    },
    currentBot: () => oldBot,
    replaceBot: () => assert.fail('prompt-only update must not replace the connector'),
    scheduleAckRetry: () => assert.fail('ACK should succeed'),
    clearAckRetry: () => {},
  });

  assert.equal(result, 'applied');
  assert.deepEqual(acks, [{ revision: 7 }]);
  assert.equal(requests.some(request => request.includes('/api/bot/definition/skills')), false);
  assert.equal(fs.readFileSync(path.join(localSkillRoot, 'SKILL.md'), 'utf8'), 'operator content\n');
  assert.deepEqual(definitions.read('43')?.prompt, desired.prompt);
});

for (const failure of [502, 503, 504, 429, 'timeout', 'reset', 'shutdown'] as const) {
for (const failureRead of [3, 4]) {
test(`cloud recheck ${failure} at read ${failureRead} preserves the old connector`, async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-apply-retry-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const configService = createCatsCoLocalConfigService({ runtimeRoot });
  configService.save({
    version: 1,
    endpoints: { httpBaseUrl: 'https://cats.example.test', serverUrl: 'wss://cats.example.test/v0/channels' },
    account: { token: 'test-owner-token', uid: '7' },
    currentBot: { uid: '43', apiKey: 'test-bot-key', boundByUserUid: '7', bindingSource: 'test' },
  });
  const auth = configService.getAuthState();
  const definitions = createBotDefinitionSyncService({ runtimeRoot });
  const previous: BotDefinition = {
    schema: BOT_DEFINITION_SCHEMA, botId: '43',
    model: {
      kind: 'custom', protocol: 'openai-responses', apiBase: 'https://models.example.test/v1',
      apiKey: 'test-model-key', model: 'previous-model', contextWindowTokens: 128000,
    },
    prompt: { selected: 'custom', customSystemPrompt: 'Test prompt.' },
  };
  definitions.acceptCanonical(previous);
  const desired = { ...previous, model: { ...previous.model, model: 'next-model' }, skills: [] };
  fs.mkdirSync(path.join(runtimeRoot, 'skills'), { recursive: true });
  new BotSkillBaseStore(runtimeRoot).write({
    schema: 'xiaoba.bot-skill-sync-base.v2', botId: '43', definitionRevision: 6,
    skills: [], updatedAt: new Date().toISOString(),
  });

  let reads = 0;
  let failedOnce = false;
  let active = true;
  const acks: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method || 'GET';
    if (url.pathname === '/api/bot/definition' && method === 'GET') {
      reads += 1;
      // Poll, revision check, startup reconciliation, then Skill recheck.
      if (reads === failureRead) {
        failedOnce = true;
        if (failure === 'shutdown') active = false;
        else if (failure === 'timeout') throw new DOMException('Test timeout', 'TimeoutError');
        else if (failure === 'reset') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
        else return Response.json({ error: 'temporary outage' }, { status: failure });
      }
      return Response.json({ configured: true, revision: 7, definition: desired });
    }
    if (url.pathname === '/api/bot/definition/ack' && method === 'POST') {
      acks.push(JSON.parse(String(init?.body)));
      return Response.json({ status: 'applied' });
    }
    if (url.pathname === '/api/bot/definition/default-prompt') return Response.json({ status: 'stored' });
    throw new Error(`Unexpected test request: ${method} ${url.pathname}`);
  });
  let stopped = 0;
  let started = 0;
  let ready = 0;
  const oldBot = { isIdleForRuntimeReload: () => true, destroy: async () => { stopped += 1; } } as CatsCompanyBot;
  let bot = oldBot;
  t.mock.method(CatsCompanyBot.prototype, 'start', async function (this: CatsCompanyBot) {
    started += 1;
    t.after(() => this.destroy());
  });
  t.mock.method(CatsCompanyBot.prototype, 'waitUntilReady', async () => { ready += 1; });
  t.mock.method(CatsCompanyBot.prototype, 'isIdleForRuntimeReload', () => true);
  const errors: unknown[] = [];
  let now = 0;
  const controller = new CloudBotModelRuntimeReloadController({
    now: () => now, random: () => 0,
    initialRevision: 6,
    pullSelection: () => pullCloudBotModelSelection({ botId: '43', auth }),
    isIdle: () => true,
    applySelection: selection => applyCloudModelRuntimeSelection({
      runtimeRoot, botId: '43', auth, selection, canApply: () => active,
      connectorConfig: { serverUrl: 'wss://cats.example.test/v0/channels', apiKey: 'test-bot-key', botUid: '43' },
      currentBot: () => bot, replaceBot: next => { bot = next; },
      scheduleAckRetry: () => assert.fail('ACK should succeed'), clearAckRetry: () => {},
    }),
    onError: error => errors.push(error),
  });
  await controller.pollOnce();
  assert.equal(failedOnce, true);
  assert.deepEqual(acks, []);
  assert.equal(bot, oldBot);
  assert.equal(stopped, 0);
  assert.deepEqual(definitions.read('43')?.model, previous.model);

  if (failure === 'shutdown') {
    await controller.pollOnce();
    assert.equal(started, 0);
    assert.deepEqual(acks, []);
    assert.deepEqual(errors, []);
    return;
  }
  now = 5000;
  await controller.pollOnce();
  assert.notEqual(bot, oldBot);
  assert.equal(stopped, 1);
  assert.equal(started, 1);
  assert.equal(ready, 1);
  assert.deepEqual(acks, [{ revision: 7 }]);
  assert.deepEqual(definitions.read('43')?.model, desired.model);
  await controller.pollOnce();
  assert.equal(started, 1);
  assert.deepEqual(errors, []);
});

}
}
