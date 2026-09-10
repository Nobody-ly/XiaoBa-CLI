import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareBoundBotDefinition } from '../src/bot-definition/activation';
import { createBotDefinitionSyncService } from '../src/bot-definition/service';
import { BOT_DEFINITION_SCHEMA, type BotSkillRef } from '../src/bot-definition/types';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import {
  assertOperatorManagedSkillWorkspaceBinding,
  preserveOperatorManagedSkills,
} from '../src/bot-skills/preservation';
import { BotSkillWorkspaceService } from '../src/bot-skills/workspace';
import { BotSkillBaseStore } from '../src/bot-skills/base-store';
import { scanBotSkillWorkspace } from '../src/bot-skills/local-manifest';

describe('operator-managed Skill workspace preservation', () => {
  test('is disabled by default', () => {
    assert.equal(preserveOperatorManagedSkills({}), false);
  });

  test('accepts explicit truthy values case-insensitively', () => {
    for (const value of ['1', 'true', 'TRUE', ' yes ']) {
      assert.equal(preserveOperatorManagedSkills({ XIAOBA_PRESERVE_SKILLS: value }), true);
    }
  });

  test('does not treat unrelated values as enabled', () => {
    for (const value of ['', '0', 'false', 'no', 'enabled']) {
      assert.equal(preserveOperatorManagedSkills({ XIAOBA_PRESERVE_SKILLS: value }), false);
    }
  });

  test('requires the preserved workspace to belong to the selected Bot', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-preserved-skills-'));
    try {
      const skillsRoot = path.join(runtimeRoot, 'skills');
      fs.mkdirSync(skillsRoot, { recursive: true });
      assert.throws(
        () => assertOperatorManagedSkillWorkspaceBinding(runtimeRoot, 'bot-a'),
        /expected bot-a, found none/,
      );

      new BotSkillWorkspaceService(runtimeRoot, skillsRoot).activate('bot-a');
      assert.doesNotThrow(
        () => assertOperatorManagedSkillWorkspaceBinding(runtimeRoot, 'bot-a'),
      );
      assert.throws(
        () => assertOperatorManagedSkillWorkspaceBinding(runtimeRoot, 'bot-b'),
        /expected bot-b, found bot-a/,
      );
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  test('keeps the workspace byte-for-byte unchanged when cloud startup falls back offline', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-preserved-skills-offline-'));
    try {
      const env = { XIAOBA_PRESERVE_SKILLS: '1' } as NodeJS.ProcessEnv;
      createCatsCoLocalConfigService({ runtimeRoot, env }).save({
        version: 1,
        endpoints: {
          httpBaseUrl: 'https://cats.example.test',
          serverUrl: 'wss://cats.example.test/v0/channels',
        },
        account: { token: 'owner-token', uid: 'owner-7' },
        currentBot: {
          uid: 'bot-43',
          apiKey: 'bot-api-key',
          boundByUserUid: 'owner-7',
          bindingSource: 'test',
        },
      });
      createBotDefinitionSyncService({ runtimeRoot, env }).acceptCanonical({
        schema: BOT_DEFINITION_SCHEMA,
        botId: 'bot-43',
        model: {
          kind: 'custom',
          protocol: 'openai-responses',
          apiBase: 'https://models.example.test/v1',
          model: 'operator-model',
          apiKey: 'test-model-key',
          contextWindowTokens: 128000,
        },
        prompt: { selected: 'custom', customSystemPrompt: 'Operator prompt.' },
        skills: [],
      });
      const skillRoot = path.join(runtimeRoot, 'skills', 'operator-local');
      fs.mkdirSync(path.join(skillRoot, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
        '---',
        'name: operator-local',
        'description: Operator-managed Skill that must survive offline startup.',
        '---',
        '',
        'Keep this content.',
        '',
      ].join('\n'));
      fs.writeFileSync(path.join(skillRoot, 'scripts', 'run.mjs'), 'console.log("preserved");\n');
      const before = snapshotDirectory(path.join(runtimeRoot, 'skills'));
      const requests: string[] = [];
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        return Response.json({ error: 'temporarily unavailable' }, { status: 503 });
      }) as typeof fetch;

      const prepared = await prepareBoundBotDefinition({
        runtimeRoot,
        env,
        fetchImpl,
        acknowledgeCloudSelection: false,
        preserveSkills: true,
      });

      assert.equal(prepared?.botId, 'bot-43');
      assert.equal(prepared?.skillSync, undefined);
      assert.deepStrictEqual(snapshotDirectory(path.join(runtimeRoot, 'skills')), before);
      assert.equal(requests.includes('/api/bot/definition'), true);
      assert.equal(requests.includes('/api/bot/model-config'), true);
      assert.equal(requests.includes('/api/bot/definition/skills'), false);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  test('reuses unchanged Skill references for model/prompt startup updates without touching the workspace', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-unchanged-skills-startup-'));
    try {
      createCatsCoLocalConfigService({ runtimeRoot }).save({
        version: 1,
        endpoints: {
          httpBaseUrl: 'https://cats.example.test',
          serverUrl: 'wss://cats.example.test/v0/channels',
        },
        account: { token: 'owner-token', uid: 'owner-7' },
        currentBot: {
          uid: 'bot-43',
          apiKey: 'bot-api-key',
          boundByUserUid: 'owner-7',
          bindingSource: 'test',
        },
      });
      const previous = {
        schema: BOT_DEFINITION_SCHEMA,
        botId: 'bot-43',
        model: {
          kind: 'custom' as const,
          protocol: 'openai-responses' as const,
          apiBase: 'https://models.example.test/v1',
          model: 'previous-model',
          apiKey: 'test-model-key',
          contextWindowTokens: 128000,
        },
        prompt: { selected: 'custom' as const, customSystemPrompt: 'Unchanged prompt.' },
        skills: [TEST_SKILL_REFERENCE],
      };
      const desired = {
        ...previous,
        model: { ...previous.model, model: 'next-model' },
        prompt: { selected: 'custom' as const, customSystemPrompt: 'Updated prompt.' },
      };
      createBotDefinitionSyncService({ runtimeRoot }).acceptCanonical(previous);
      const skillRoot = path.join(runtimeRoot, 'skills', 'server-local');
      fs.mkdirSync(skillRoot, { recursive: true });
      fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
        '---',
        'name: server-local',
        'description: Server-local Skill that startup must leave unchanged.',
        '---',
        '',
        'Keep this content.',
        '',
      ].join('\n'));
      writeVerifiedSkillBase(runtimeRoot, 'bot-43', 6, TEST_SKILL_REFERENCE);
      const before = snapshotDirectory(path.join(runtimeRoot, 'skills'));
      const requests: string[] = [];
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method || 'GET';
        requests.push(`${method} ${url.pathname}`);
        if (url.pathname === '/api/bot/definition' && method === 'GET') {
          return Response.json({ configured: true, revision: 7, definition: desired });
        }
        if (url.pathname === '/api/bot/definition/default-prompt') {
          return Response.json({ status: 'stored' });
        }
        throw new Error(`Unexpected test request: ${method} ${url.pathname}`);
      }) as typeof fetch;

      const prepared = await prepareBoundBotDefinition({
        runtimeRoot,
        fetchImpl,
        acknowledgeCloudSelection: false,
      });

      assert.equal(prepared?.botId, 'bot-43');
      assert.equal(prepared?.cloudRevision, 7);
      assert.equal(prepared?.skillSync?.sync?.applyStatus, 'already_applied');
      assert.deepStrictEqual(snapshotDirectory(path.join(runtimeRoot, 'skills')), before);
      assert.equal(requests.some(request => request.includes('/api/bot/definition/skills')), false);
      assert.deepStrictEqual(prepared?.definition.model, desired.model);
      assert.deepStrictEqual(prepared?.definition.prompt, desired.prompt);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });
});

const TEST_SKILL_REFERENCE: BotSkillRef = {
  source: 'skillhub',
  skillId: 'private/server-local',
  version: 'sha256-server-local',
  contentHash: 'a'.repeat(64),
};

function writeVerifiedSkillBase(
  runtimeRoot: string,
  botId: string,
  definitionRevision: number,
  reference: BotSkillRef,
): void {
  const local = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'), { writeMarkers: false });
  assert.equal(local.length, 1);
  new BotSkillBaseStore(runtimeRoot).write({
    schema: 'xiaoba.bot-skill-sync-base.v2',
    botId,
    definitionRevision,
    skills: local.map(entry => ({
      localSkillId: entry.localSkillId,
      name: entry.name,
      installName: entry.installName,
      contentHash: entry.contentHash,
      reference,
    })),
    updatedAt: new Date().toISOString(),
  });
}

function snapshotDirectory(root: string): Array<[string, string]> {
  const snapshot: Array<[string, string]> = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        snapshot.push([`${relative}/`, 'directory']);
        visit(absolute);
      } else {
        snapshot.push([relative, fs.readFileSync(absolute).toString('hex')]);
      }
    }
  };
  visit(root);
  return snapshot;
}
