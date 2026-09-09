import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertOperatorManagedSkillWorkspaceBinding,
  preserveOperatorManagedSkills,
} from '../src/bot-skills/preservation';
import { BotSkillWorkspaceService } from '../src/bot-skills/workspace';

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
});
