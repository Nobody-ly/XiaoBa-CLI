import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const releaseWorkflow = fs.readFileSync(
  path.join(root, '.github', 'workflows', 'release.yml'),
  'utf8',
);
const artifactBuilder = fs.readFileSync(
  path.join(root, 'scripts', 'build-linux-worker-artifact.mjs'),
  'utf8',
);

test('stable releases publish a versioned worker artifact and manifest', () => {
  assert.match(releaseWorkflow, /build-worker:/);
  assert.match(releaseWorkflow, /npm run --silent worker:artifact/);
  assert.match(releaseWorkflow, /release\/worker\/manifest\.json/);
  assert.match(releaseWorkflow, /release-worker\/\*/);
  assert.match(releaseWorkflow, /update\/worker\/%s\/%s/);
  assert.match(releaseWorkflow, /needs: \[build-mac, build-win, build-linux, build-worker\]/);
});

test('worker artifacts carry the updater used by the cloud control plane', () => {
  assert.match(artifactBuilder, /scripts\/update-worker-artifact\.sh/);
});
