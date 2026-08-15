import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkFormalBotSkillPathAccess,
  requiresFormalBotSkillSearchFiltering,
} from '../src/bot-skills/formal-workspace-policy';
import { EditTool } from '../src/tools/edit-tool';
import { GlobTool } from '../src/tools/glob-tool';
import { GrepTool } from '../src/tools/grep-tool';
import { uploadImportFileSource } from '../src/tools/import-file-tool';
import { ReadTool } from '../src/tools/read-tool';
import { SendFileTool } from '../src/tools/send-file-tool';
import { WriteTool } from '../src/tools/write-tool';
import type { ToolExecutionContext } from '../src/types/tool';

describe('formal Bot Skill workspace boundary', () => {
  let workspaceRoot: string;
  let runtimeRoot: string;
  let skillsRoot: string;
  let skillFile: string;
  let safeFile: string;
  let dataFile: string;
  let stageFile: string;
  let aliasRoot: string;
  const previousEnv = {
    userData: process.env.XIAOBA_USER_DATA_DIR,
    skills: process.env.XIAOBA_SKILLS_DIR,
  };

  before(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-skill-boundary-'));
    runtimeRoot = path.join(workspaceRoot, '.dev-user-data');
    skillsRoot = path.join(runtimeRoot, 'skills');
    skillFile = path.join(skillsRoot, 'secret-skill', 'SKILL.md');
    safeFile = path.join(workspaceRoot, 'src', 'safe.ts');
    dataFile = path.join(runtimeRoot, 'data', 'bot-skills', 'bot-1', 'base.json');
    stageFile = path.join(runtimeRoot, '.bot-skills-stage-test', 'secret-skill', 'SKILL.md');
    aliasRoot = path.join(workspaceRoot, 'linked-skills');

    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.mkdirSync(path.dirname(safeFile), { recursive: true });
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.mkdirSync(path.dirname(stageFile), { recursive: true });
    fs.writeFileSync(skillFile, 'shared-boundary-marker\nformal source\n', 'utf8');
    fs.writeFileSync(safeFile, 'export const marker = "shared-boundary-marker";\n', 'utf8');
    fs.writeFileSync(dataFile, '{"skill":"secret-skill"}\n', 'utf8');
    fs.writeFileSync(stageFile, 'staged formal source\n', 'utf8');
    fs.symlinkSync(skillsRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');

    process.env.XIAOBA_USER_DATA_DIR = runtimeRoot;
    delete process.env.XIAOBA_SKILLS_DIR;
  });

  after(() => {
    restoreEnv('XIAOBA_USER_DATA_DIR', previousEnv.userData);
    restoreEnv('XIAOBA_SKILLS_DIR', previousEnv.skills);
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test('recognizes formal, working-copy, missing-child, and symlinked paths', () => {
    const cli = cliContext();
    const cats = catsContext();

    assert.equal(checkFormalBotSkillPathAccess(cli, skillFile, 'write').ok, false);
    assert.equal(checkFormalBotSkillPathAccess(cli, path.join(skillsRoot, 'new-skill', 'SKILL.md'), 'write').ok, false);
    assert.equal(checkFormalBotSkillPathAccess(cli, dataFile, 'write').ok, false);
    assert.equal(checkFormalBotSkillPathAccess(cli, stageFile, 'write').ok, false);
    assert.equal(checkFormalBotSkillPathAccess(cli, path.join(aliasRoot, 'secret-skill', 'SKILL.md'), 'write').ok, false);
    assert.equal(checkFormalBotSkillPathAccess(cli, safeFile, 'write').ok, true);

    assert.equal(checkFormalBotSkillPathAccess(cli, skillFile, 'read').ok, true);
    assert.equal(checkFormalBotSkillPathAccess(cats, skillFile, 'read').ok, false);
    assert.equal(checkFormalBotSkillPathAccess({ ...cli, deviceRpcReceiver: true }, skillFile, 'read').ok, false);
    assert.equal(requiresFormalBotSkillSearchFiltering(cats, workspaceRoot), true);
    assert.equal(requiresFormalBotSkillSearchFiltering(cli, workspaceRoot), false);
  });

  test('generic write and edit tools cannot mutate formal Skills', async () => {
    const newFile = path.join(skillsRoot, 'new-skill', 'SKILL.md');
    const write = await new WriteTool().execute({ file_path: newFile, content: 'new' }, cliContext());
    assert.equal(write.ok, false);
    assert.equal(write.ok ? '' : write.errorCode, 'PERMISSION_DENIED');
    assert.equal(fs.existsSync(newFile), false);

    const before = fs.readFileSync(skillFile, 'utf8');
    const edit = await new EditTool().execute({
      file_path: skillFile,
      old_string: 'formal source',
      new_string: 'mutated source',
    }, cliContext());
    assert.equal(edit.ok, false);
    assert.equal(edit.ok ? '' : edit.errorCode, 'PERMISSION_DENIED');
    assert.equal(fs.readFileSync(skillFile, 'utf8'), before);
  });

  test('CLI can inspect formal Skills but CatsCo read and send paths cannot', async () => {
    const cliRead = await new ReadTool().execute({ file_path: skillFile }, cliContext());
    assert.equal(cliRead.ok, true);
    assert.match(cliRead.ok ? String(cliRead.content) : '', /formal source/);

    const catsRead = await new ReadTool().execute({ file_path: skillFile }, catsContext());
    assert.equal(catsRead.ok, false);
    assert.equal(catsRead.ok ? '' : catsRead.errorCode, 'PERMISSION_DENIED');
    assert.match(catsRead.ok ? '' : catsRead.message, /cannot read or export/);

    let sends = 0;
    const send = await new SendFileTool().execute({ file_path: skillFile, file_name: 'SKILL.md' }, catsContext({
      channel: {
        chatId: 'chat-1',
        reply: async () => {},
        sendFile: async () => { sends += 1; },
      },
    }));
    assert.equal(send.ok, false);
    assert.equal(send.ok ? '' : send.errorCode, 'PERMISSION_DENIED');
    assert.equal(sends, 0);
  });

  test('broad CatsCo glob and grep keep project results while filtering formal Skill sources', async () => {
    const glob = await new GlobTool().execute({
      pattern: '**/*.{md,ts}',
      path: workspaceRoot,
      include_hidden: true,
    }, catsContext());
    assert.equal(glob.ok, true);
    assert.match(glob.ok ? String(glob.content) : '', /src\/safe\.ts/);
    assert.doesNotMatch(glob.ok ? String(glob.content) : '', /secret-skill|SKILL\.md/);

    const grep = await new GrepTool().execute({
      pattern: 'shared-boundary-marker',
      path: workspaceRoot,
      output_mode: 'files',
    }, catsContext());
    assert.equal(grep.ok, true);
    assert.match(grep.ok ? String(grep.content) : '', /src\/safe\.ts/);
    assert.doesNotMatch(grep.ok ? String(grep.content) : '', /secret-skill|SKILL\.md/);

    const direct = await new GrepTool().execute({
      pattern: 'shared-boundary-marker',
      path: skillsRoot,
      output_mode: 'files',
    }, catsContext());
    assert.equal(direct.ok, false);
    assert.equal(direct.ok ? '' : direct.errorCode, 'PERMISSION_DENIED');
  });

  test('Device RPC import cannot upload a formal Skill source file', async () => {
    let uploads = 0;
    const result = await uploadImportFileSource({
      file_path: skillFile,
      file_name: 'SKILL.md',
    }, {
      ...cliContext(),
      deviceRpcReceiver: true,
    }, async () => {
      uploads += 1;
      return { url: '/uploads/SKILL.md', name: 'SKILL.md', size: 1, type: 'file' };
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.errorCode, 'PERMISSION_DENIED');
    assert.equal(uploads, 0);
  });

  function cliContext(): ToolExecutionContext {
    return {
      workingDirectory: workspaceRoot,
      workspaceRoot,
      conversationHistory: [],
      surface: 'cli',
    };
  }

  function catsContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
    return {
      ...cliContext(),
      surface: 'catscompany',
      executionScope: {
        source: 'catscompany',
        sessionKey: 'session-1',
        topicId: 'topic-1',
        topicType: 'p2p',
        actorUserId: 'user-1',
        agentId: 'bot-1',
        identityTrust: 'server_canonical',
        isTrusted: true,
      },
      localDeviceGrant: {
        kind: 'local_device_grant',
        source: 'catscompany',
        bodyId: 'body-1',
        installationId: 'installation-1',
        ownerUserId: 'user-1',
      } as ToolExecutionContext['localDeviceGrant'],
      ...overrides,
    };
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
