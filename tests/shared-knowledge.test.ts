import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SkillManager } from '../src/skills/skill-manager';
import { SkillTool } from '../src/tools/skill-tool';
import { SessionSkillRuntime } from '../src/skills/session-skill-runtime';
import { TurnSkillSnapshotStore } from '../src/skills/turn-skill-snapshot';
import { PromptComposer } from '../src/runtime/prompt-composer';
import { DEFAULT_PROMPTS_DIR } from '../src/utils/prompt-template';
import { ToolManager } from '../src/tools/tool-manager';

const helper = path.resolve(__dirname, '../prompts/skills/xiaoba-knowledge/scripts/knowledge.cjs');
const { KnowledgeStore } = require(helper);
const run = promisify(execFile);
const request = (overrides: Record<string, unknown> = {}) => ({
  expectedRevision: null, title: '部署流程', summary: '发布与验证', category: 'procedures',
  sources: ['用户明确约定；测试环境验证记录'], change: '记录发布流程', body: '# 部署\n\n运行测试再发布。', ...overrides,
});

describe('instance shared knowledge', () => {
  let temp: string;
  let root: string;
  let originalDataRoot: string | undefined;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-knowledge-'));
    root = path.join(temp, '共享 知识');
    originalDataRoot = process.env.XIAOBA_USER_DATA_DIR;
    process.env.XIAOBA_USER_DATA_DIR = temp;
  });
  afterEach(() => {
    if (originalDataRoot === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = originalDataRoot;
    fs.rmSync(temp, { recursive: true, force: true });
  });

  test('reads an empty library without creating it, and isolates separate runtime roots', async () => {
    const store = new KnowledgeStore(root);
    assert.deepEqual(store.index().items, []);
    assert.equal(fs.existsSync(root), false);
    const created = await store.put(request());
    assert.equal(new KnowledgeStore(root).read(created.id).body, request().body);
    assert.equal(new KnowledgeStore(path.join(temp, 'other')).index().total, 0);
  });

  test('preserves IDs and history, rejects stale writes, and skips unchanged content', async () => {
    const first = new KnowledgeStore(root);
    const second = new KnowledgeStore(root);
    const initial = await first.put(request());
    const updated = await second.put(request({ id: initial.id, expectedRevision: initial.revision, body: '修正后的流程', change: '核验并修正' }));
    assert.equal(updated.id, initial.id);
    assert.notEqual(updated.revision, initial.revision);
    await assert.rejects(first.put(request({ id: initial.id, expectedRevision: initial.revision, body: '过期写入' })), { code: 'REVISION_CONFLICT' });
    assert.equal(first.read(initial.id).body, '修正后的流程');
    assert.match(fs.readFileSync(path.join(root, '.history', initial.id, `${initial.revision}.md`), 'utf8'), /运行测试再发布/);
    assert.match(fs.readFileSync(path.join(root, 'changes.md'), 'utf8'), /核验并修正/);
    assert.match(fs.readFileSync(path.join(root, 'changes.md'), 'utf8'), /记录发布流程/);
    const unchanged = await second.put(request({ id: initial.id, expectedRevision: updated.revision, body: '修正后的流程' }));
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.revision, updated.revision);
  });

  test('independent processes serialize writes and keep a complete shared index', async () => {
    const writes = Array.from({ length: 4 }, (_, i) => {
      const input = path.join(temp, `请求 ${i}.json`);
      fs.writeFileSync(input, JSON.stringify(request({ title: `项目 ${i}` })));
      return run(process.execPath, [helper, '--root', root, 'put', input]);
    });
    const results = await Promise.all(writes);
    const ids = results.map(result => JSON.parse(result.stdout).id);
    assert.equal(new Set(ids).size, 4);
    const store = new KnowledgeStore(root);
    assert.equal(store.index().total, 4);
    for (const id of ids) assert.ok(fs.readFileSync(path.join(root, 'index.md'), 'utf8').includes(id));
    assert.equal(fs.existsSync(path.join(root, '.write.lock')), false);
  });

  test('two concurrent edits of the same revision cannot both succeed', async () => {
    const store = new KnowledgeStore(root);
    const initial = await store.put(request());
    const results = await Promise.allSettled(['A', 'B'].map(body => {
      const input = path.join(temp, `update-${body}.json`);
      fs.writeFileSync(input, JSON.stringify(request({ id: initial.id, expectedRevision: initial.revision, body })));
      return run(process.execPath, [helper, '--root', root, 'put', input]);
    }));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(JSON.parse(rejected.reason.stderr).code, 'REVISION_CONFLICT');
  });

  test('bounds reads, searches full bodies, and rebuilds index after manual edits', async () => {
    const store = new KnowledgeStore(root);
    const body = '文'.repeat(13000) + '特殊配置';
    const created = await store.put(request({ body }));
    const first = store.read(created.id);
    const next = store.read(created.id, first.nextOffset);
    assert.equal(first.body + next.body, body);
    assert.equal(first.revision, next.revision);
    assert.equal(store.index('特殊配置').items[0].id, created.id);
    const file = path.join(root, 'documents', `${created.id}.md`);
    fs.appendFileSync(file, '\n手动补充');
    await assert.rejects(store.put(request({ id: created.id, expectedRevision: created.revision })), { code: 'REVISION_CONFLICT' });
    fs.unlinkSync(path.join(root, 'index.md'));
    await store.reindex();
    assert.ok(fs.existsSync(path.join(root, 'index.md')));
    assert.equal(store.index('手动补充').total, 1);
  });

  test('rejects missing versions, path traversal, and directory links', async () => {
    const store = new KnowledgeStore(root);
    await assert.rejects(store.put(request({ expectedRevision: undefined })), { code: 'INVALID_INPUT' });
    assert.throws(() => store.read('../secret'), { code: 'INVALID_ID' });
    fs.mkdirSync(root);
    const outside = path.join(temp, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'documents'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.put(request()), { code: 'UNSAFE_PATH' });
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  test('reports a committed document when index repair fails, without duplicating the document', async () => {
    const store = new KnowledgeStore(root);
    fs.mkdirSync(path.join(root, 'index.md'), { recursive: true });
    const created = await store.put(request());
    assert.equal(created.saved, true);
    assert.match(created.warning, /reindex/);
    assert.equal(store.read(created.id).title, '部署流程');
    fs.rmdirSync(path.join(root, 'index.md'));
    await store.reindex();
    assert.equal(store.index().total, 1);
  });

  test('discoverable without installed Skills, including immutable turn snapshots; knowledge changes leave prompt and listing stable', async () => {
    const manager = new SkillManager(path.join(temp, 'missing-skills'));
    await manager.loadSkills();
    assert.ok(manager.getSkill('xiaoba-knowledge'));
    assert.equal(fs.existsSync(path.join(temp, 'knowledge')), false);
    const runtime = new SessionSkillRuntime(manager, 'bot-A');
    const listing = runtime.buildSkillsListMessage();
    const prompt = () => PromptComposer.composeSystemPrompt({ promptsDir: DEFAULT_PROMPTS_DIR, now: new Date('2026-09-07T00:00:00Z') });
    const beforePrompt = prompt();
    const store = new KnowledgeStore(path.join(temp, 'knowledge'));
    await store.put(request());
    await manager.loadSkills();
    assert.deepEqual(runtime.buildSkillsListMessage(), listing);
    assert.equal(prompt(), beforePrompt);
    assert.ok(!String(listing?.content).includes(temp));

    const skillsRoot = path.join(temp, 'skills');
    fs.mkdirSync(skillsRoot);
    const snapshots = new TurnSkillSnapshotStore({ runtimeRoot: temp, skillsRoot });
    const lease = await snapshots.acquire();
    try {
      const snapshotManager = new SkillManager(lease.snapshot.rootPath);
      await snapshotManager.loadSkills();
      const result = await new SkillTool().execute({ skill: 'xiaoba-knowledge' }, {
        workingDirectory: temp, conversationHistory: [], turnSkillSnapshot: lease,
        runtimeServices: { aiService: {} as any, skillManager: snapshotManager },
      });
      assert.equal(result.ok, true);
      const content = String((result as any).content);
      assert.ok(content.includes(path.join(temp, 'knowledge')));
      assert.ok(content.includes(process.execPath));
      assert.doesNotMatch(content, /<KNOWLEDGE_ROOT>|<KNOWLEDGE_NODE>|<SKILL_DIR>/);
      assert.equal(lease.snapshot.fileCount, 0);
    } finally { await lease.release(); }
  });

  test('preserves an explicitly installed same-name Skill', async () => {
    const skills = path.join(temp, 'custom');
    const directory = path.join(skills, 'override');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'SKILL.md'), '---\nname: xiaoba-knowledge\ndescription: Custom knowledge workflow\n---\nUser workflow.');
    const manager = new SkillManager(skills);
    await manager.loadSkills();
    assert.equal(manager.getSkill('xiaoba-knowledge')?.content, 'User workflow.');
  });

  test('actual Skill, write_file and execute_shell tools share knowledge across bot sessions', async () => {
    const botA = new ToolManager(temp, { surface: 'catscompany', sessionId: 'knowledge-bot-A' });
    const botB = new ToolManager(temp, { surface: 'catscompany', sessionId: 'knowledge-bot-B' });
    const call = (manager: ToolManager, name: string, args: Record<string, unknown>) => manager.executeTool({
      id: `test-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
    });
    const loaded = await call(botA, 'skill', { skill: 'xiaoba-knowledge' });
    assert.equal(loaded.ok, true);
    const sharedRoot = path.join(temp, 'knowledge');
    assert.ok(String(loaded.content).includes(sharedRoot));
    const input = path.join(temp, '工具链 请求.json');
    const written = await call(botA, 'write_file', { file_path: input, content: JSON.stringify(request()) });
    assert.equal(written.ok, true);
    const quote = (value: string) => process.platform === 'win32'
      ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, "'\\''")}'`;
    const command = (...args: string[]) => `${process.platform === 'win32' ? '& ' : ''}${[process.execPath, helper, '--root', sharedRoot, ...args].map(quote).join(' ')}`;
    const saved = await call(botA, 'execute_shell', { command: command('put', input) });
    assert.equal(saved.ok, true, String(saved.content));
    const created = new KnowledgeStore(sharedRoot).index().items[0];
    const read = await call(botB, 'execute_shell', { command: command('read', created.id) });
    assert.equal(read.ok, true, String(read.content));
    assert.ok(String(read.content).includes(created.id));
    assert.ok(String(read.content).includes('运行测试再发布'));
  });
});
