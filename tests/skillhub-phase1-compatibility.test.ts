import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolExecutionContext } from '../src/types/tool';
import { EditTool } from '../src/tools/edit-tool';
import { GlobTool } from '../src/tools/glob-tool';
import { GrepTool } from '../src/tools/grep-tool';
import { uploadImportFileSource } from '../src/tools/import-file-tool';
import { ReadTool } from '../src/tools/read-tool';
import { SendFileTool } from '../src/tools/send-file-tool';
import { ShellTool } from '../src/tools/bash-tool';
import { WriteTool } from '../src/tools/write-tool';

let runtimeRoot = '';
let skillsRoot = '';
let skillFile = '';
let originalUserDataDir: string | undefined;

beforeEach(() => {
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-phase1-compat-'));
  skillsRoot = path.join(runtimeRoot, 'skills');
  skillFile = path.join(skillsRoot, 'phase1-compat', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, '# Phase 1\ncompat-before\n', 'utf8');
  originalUserDataDir = process.env.XIAOBA_USER_DATA_DIR;
  process.env.XIAOBA_USER_DATA_DIR = runtimeRoot;
});

afterEach(() => {
  if (originalUserDataDir === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
  else process.env.XIAOBA_USER_DATA_DIR = originalUserDataDir;
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

test('CatsCo chat keeps formal Skill read, write, edit, search, export, import, and shell access', async () => {
  let sentPath = '';
  const context: ToolExecutionContext = {
    workingDirectory: runtimeRoot,
    workspaceRoot: runtimeRoot,
    conversationHistory: [],
    sessionId: 'session:v2:catscompany:p2p:p2p_7_42:agent:usr42',
    surface: 'catscompany',
    executionScope: {
      source: 'catscompany',
      sessionKey: 'session:v2:catscompany:p2p:p2p_7_42:agent:usr42',
      topicId: 'p2p_7_42',
      topicType: 'p2p',
      actorUserId: 'usr7',
      agentId: 'usr42',
      agentBodyId: 'body-42',
      identityTrust: 'server_canonical',
      isTrusted: true,
    },
    localDeviceGrant: {
      kind: 'catscompany_body',
      source: 'catscompany',
      ownerUserId: 'usr42',
      bodyId: 'body-42',
      installationId: 'install-42',
      deviceId: 'install-42',
      createdAt: Date.now(),
    },
    channel: {
      chatId: 'p2p_7_42',
      reply: async () => undefined,
      sendFile: async (_chatId, filePath) => {
        sentPath = filePath;
      },
    },
  };

  const writeResult = await new WriteTool().execute({
    file_path: skillFile,
    content: '# Phase 1\ncompat-written\n',
  }, context);
  assert.equal(writeResult.ok, true);

  const editResult = await new EditTool().execute({
    file_path: skillFile,
    old_string: 'compat-written',
    new_string: 'compat-edited',
  }, context);
  assert.equal(editResult.ok, true);

  const readResult = await new ReadTool().execute({ file_path: skillFile }, context);
  assert.equal(readResult.ok, true);
  assert.match(readResult.ok ? readResult.content as string : '', /compat-edited/);

  const globResult = await new GlobTool().execute({
    path: skillsRoot,
    pattern: '**/SKILL.md',
  }, context);
  assert.equal(globResult.ok, true);
  assert.match(globResult.ok ? globResult.content as string : '', /phase1-compat/);

  const grepResult = await new GrepTool().execute({
    path: skillsRoot,
    pattern: 'compat-edited',
    output_mode: 'content',
  }, context);
  assert.equal(grepResult.ok, true);
  assert.match(grepResult.ok ? grepResult.content as string : '', /compat-edited/);

  const sendResult = await new SendFileTool().execute({
    file_path: skillFile,
    file_name: 'SKILL.md',
  }, context);
  assert.equal(sendResult.ok, true);
  assert.equal(sentPath, skillFile);

  const importResult = await uploadImportFileSource({
    file_path: skillFile,
    file_name: 'SKILL.md',
  }, context, async (filePath, fileName) => ({
    url: 'https://app.catsco.cc/uploads/phase1-skill',
    name: fileName,
    size: fs.statSync(filePath).size,
  }));
  assert.equal(importResult.ok, true);

  const shellResult = await new ShellTool().execute({
    command: `node -e "console.log('phase1-shell-ok')"`,
  }, context);
  assert.equal(shellResult.ok, true);
  assert.match(shellResult.ok ? shellResult.content as string : '', /phase1-shell-ok/);
});
