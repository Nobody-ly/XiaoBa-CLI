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
  assert.match(releaseWorkflow, /path: release-worker/);
  assert.match(releaseWorkflow, /find release-worker -maxdepth 1 -type f -print0/);
  assert.match(releaseWorkflow, /TOS_WORKER_BUCKET: catsco-worker-release/);
  assert.match(releaseWorkflow, /VOLC_TOS_WORKER_PUBLISH_ACCESS_KEY_ID/);
  assert.match(releaseWorkflow, /retention-days: 7/);
  assert.match(releaseWorkflow, /aws configure set default\.s3\.addressing_style virtual/);
  assert.match(releaseWorkflow, /WORKER_PREFIX="update\/worker\/\$\{WORKER_VERSION\}"/);
  assert.match(releaseWorkflow, /--acl private/);
  assert.match(releaseWorkflow, /Private worker manifest unexpectedly returned HTTP/);
  assert.match(releaseWorkflow, /needs: \[build-mac, build-win, build-linux, build-worker\]/);
});

test('worker artifacts never enter the public release paths', () => {
  const publicSourceUpload = releaseWorkflow.match(
    /- name: Upload release payloads to Hong Kong source bucket[\s\S]*?- name: Wait for Guangzhou bucket replication/,
  )?.[0] || '';
  const githubRelease = releaseWorkflow.match(
    /- name: Create draft GitHub Release[\s\S]*?- name: Publish latest metadata/,
  )?.[0] || '';

  assert.doesNotMatch(publicSourceUpload, /release-worker/);
  assert.doesNotMatch(githubRelease, /release-worker/);
});

test('worker artifacts carry the updater used by the cloud control plane', () => {
  assert.match(artifactBuilder, /scripts\/update-worker-artifact\.sh/);
});
