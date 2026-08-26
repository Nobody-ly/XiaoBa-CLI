import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillManager } from '../src/skills/skill-manager';
import { TurnSkillSnapshotStore } from '../src/skills/turn-skill-snapshot';

describe('turn Skill snapshot store', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  test('publishes an immutable full-tree snapshot without changing the live workspace', async () => {
    const root = createRuntimeRoot(roots);
    const skillsRoot = path.join(root, 'skills');
    writeSkill(skillsRoot, 'image-skill', 'before');
    fs.mkdirSync(path.join(skillsRoot, 'image-skill', 'assets', 'empty'), { recursive: true });
    const before = treeFingerprint(skillsRoot);
    const store = new TurnSkillSnapshotStore({ runtimeRoot: root, skillsRoot });

    const lease = await store.acquire();
    assert.deepEqual(treeFingerprint(skillsRoot), before);
    fs.writeFileSync(path.join(skillsRoot, 'image-skill', 'body.txt'), 'after');

    assert.deepEqual(treeFingerprint(skillsRoot).filter(item => item.path !== 'image-skill/body.txt'),
      before.filter(item => item.path !== 'image-skill/body.txt'));
    assert.equal(
      fs.readFileSync(path.join(lease.snapshot.rootPath, 'image-skill', 'body.txt'), 'utf8'),
      'before',
    );
    assert.equal(fs.existsSync(path.join(lease.snapshot.rootPath, 'image-skill', 'assets', 'empty')), true);
    await lease.release();
  });

  test('deduplicates identical content and creates a new revision after a local edit', async () => {
    const root = createRuntimeRoot(roots);
    const skillsRoot = path.join(root, 'skills');
    writeSkill(skillsRoot, 'stable-skill', 'one');
    const store = new TurnSkillSnapshotStore({ runtimeRoot: root, skillsRoot });

    const first = await store.acquire();
    const second = await store.acquire();
    assert.equal(first.snapshot.snapshotId, second.snapshot.snapshotId);
    assert.equal(first.snapshot.deduplicated, false);
    assert.equal(second.snapshot.deduplicated, true);

    fs.writeFileSync(path.join(skillsRoot, 'stable-skill', 'body.txt'), 'two');
    const third = await store.acquire();
    assert.notEqual(third.snapshot.snapshotId, first.snapshot.snapshotId);
    assert.equal(third.snapshot.deduplicated, false);

    await first.release();
    await second.release();
    await third.release();
  });

  test('retained child leases protect a snapshot until every claimant releases it', async () => {
    const root = createRuntimeRoot(roots);
    const skillsRoot = path.join(root, 'skills');
    writeSkill(skillsRoot, 'background-skill', 'one');
    let now = new Date('2026-08-26T00:00:00.000Z');
    const store = new TurnSkillSnapshotStore({ runtimeRoot: root, skillsRoot, now: () => now });
    const parent = await store.acquire();
    const child = await parent.retain();
    await parent.release();
    now = new Date('2026-08-28T00:00:00.000Z');

    const whileChildRuns = await store.collectGarbage({ minAgeMs: 0 });
    assert.deepEqual(whileChildRuns.preservedLeased, [child.snapshot.snapshotId]);
    assert.equal(fs.existsSync(child.snapshot.rootPath), true);

    await child.release();
    const afterChild = await store.collectGarbage({ minAgeMs: 0 });
    assert.deepEqual(afterChild.removed, [child.snapshot.snapshotId]);
    assert.equal(fs.existsSync(child.snapshot.rootPath), false);
  });

  test('keeps recent unleased snapshots until the GC age threshold expires', async () => {
    const root = createRuntimeRoot(roots);
    const skillsRoot = path.join(root, 'skills');
    writeSkill(skillsRoot, 'recent-skill', 'one');
    let now = new Date('2026-08-26T00:00:00.000Z');
    const store = new TurnSkillSnapshotStore({ runtimeRoot: root, skillsRoot, now: () => now });
    const lease = await store.acquire();
    const snapshotId = lease.snapshot.snapshotId;
    await lease.release();

    now = new Date('2026-08-26T00:30:00.000Z');
    const recent = await store.collectGarbage({ minAgeMs: 60 * 60_000 });
    assert.deepEqual(recent.preservedRecent, [snapshotId]);
    now = new Date('2026-08-26T02:00:00.000Z');
    const expired = await store.collectGarbage({ minAgeMs: 60 * 60_000 });
    assert.deepEqual(expired.removed, [snapshotId]);
  });

  test('supports an absent Skill workspace as a verified empty revision', async () => {
    const root = createRuntimeRoot(roots);
    const store = new TurnSkillSnapshotStore({
      runtimeRoot: root,
      skillsRoot: path.join(root, 'missing-skills'),
    });
    const lease = await store.acquire();
    assert.equal(lease.snapshot.fileCount, 0);
    assert.equal(lease.snapshot.totalBytes, 0);
    assert.deepEqual(fs.readdirSync(lease.snapshot.rootPath), []);
    await lease.release();
  });

  test('rejects workspace links instead of snapshotting content outside the root', async (t) => {
    const root = createRuntimeRoot(roots);
    const skillsRoot = path.join(root, 'skills');
    writeSkill(skillsRoot, 'safe-skill', 'one');
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'outside');
    try {
      fs.symlinkSync(outside, path.join(skillsRoot, 'safe-skill', 'outside-link'), 'file');
    } catch (error: any) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(String(error?.code))) {
        t.skip('Windows symlink creation is unavailable for this user');
        return;
      }
      throw error;
    }

    const store = new TurnSkillSnapshotStore({ runtimeRoot: root, skillsRoot });
    await assert.rejects(() => store.acquire(), /symbolic link/i);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  });

  test('detects snapshot tampering and preserves the evidence from GC', async () => {
    const root = createRuntimeRoot(roots);
    const skillsRoot = path.join(root, 'skills');
    writeSkill(skillsRoot, 'audited-skill', 'one');
    const store = new TurnSkillSnapshotStore({ runtimeRoot: root, skillsRoot });
    const lease = await store.acquire();
    const snapshotId = lease.snapshot.snapshotId;
    await lease.release();
    fs.writeFileSync(path.join(lease.snapshot.rootPath, 'audited-skill', 'body.txt'), 'tampered');

    await assert.rejects(() => store.inspect(snapshotId), /no longer matches/i);
    const gc = await store.collectGarbage({ minAgeMs: 0 });
    assert.deepEqual(gc.preservedInvalid, [snapshotId]);
    assert.equal(fs.existsSync(lease.snapshot.rootPath), true);
  });

  test('loads a fixed snapshot root without changing the default SkillManager behavior', async () => {
    const root = createRuntimeRoot(roots);
    const firstRoot = path.join(root, 'first');
    const secondRoot = path.join(root, 'second');
    writeSkill(firstRoot, 'first-skill', 'one');
    writeSkill(secondRoot, 'second-skill', 'two');
    const manager = new SkillManager(firstRoot);
    const previousSkillsDirectory = process.env.XIAOBA_SKILLS_DIR;

    try {
      await manager.loadSkills();
      process.env.XIAOBA_SKILLS_DIR = secondRoot;
      await manager.reload();

      assert.deepEqual(manager.getAllSkills().map(skill => skill.metadata.name), ['first-skill']);
    } finally {
      if (previousSkillsDirectory === undefined) delete process.env.XIAOBA_SKILLS_DIR;
      else process.env.XIAOBA_SKILLS_DIR = previousSkillsDirectory;
    }
  });

  test('rejects a workspace configuration that would recursively snapshot the store', () => {
    const root = createRuntimeRoot(roots);
    assert.throws(() => new TurnSkillSnapshotStore({
      runtimeRoot: root,
      skillsRoot: root,
    }), /cannot contain the turn Skill snapshot store/i);
  });
});

function createRuntimeRoot(roots: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-turn-snapshot-'));
  roots.push(root);
  return root;
}

function writeSkill(skillsRoot: string, name: string, body: string): string {
  const skillRoot = path.join(skillsRoot, name);
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(
    path.join(skillRoot, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Turn snapshot test Skill\n---\n`,
  );
  fs.writeFileSync(path.join(skillRoot, 'body.txt'), body);
  return skillRoot;
}

function treeFingerprint(root: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push({
        path: path.relative(root, absolute).replace(/\\/g, '/'),
        content: fs.readFileSync(absolute).toString('base64'),
      });
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
