import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "..");
const workflow = fs.readFileSync(
  path.join(root, ".github", "workflows", "worker-app-update.yml"),
  "utf8",
);

test("worker app update workflow exists and is gated by stable tags", () => {
  // Stable-tag trigger with the kill-switch repo var
  assert.match(workflow, /on:\s*\n\s*push:\s*\n\s*tags:/);
  assert.match(workflow, /- "v\*"/);
  // Manual dispatch must be opt-in (default false) and only from main
  assert.match(workflow, /update_workers:/);
  assert.match(workflow, /default: false/);
  assert.match(workflow, /github\.ref == ['"]refs\/heads\/main['"]/);
  assert.match(workflow, /vars\.CTYUN_WORKER_APP_UPDATE == ['"]true['"]/);
});

test("worker app update workflow has minimal permissions and no plaintext secrets", () => {
  // Least-privilege permissions
  assert.match(workflow, /permissions:\s*\n\s*contents: read\s*\n\s*actions: read/);
  // Secret referenced by name only
  assert.match(workflow, /\$\{\{\s*secrets\.WORKER_SSH_KEY\s*\}\}/);
  // Never embed key material
  assert.doesNotMatch(workflow, /BEGIN (OPENSSH|RSA|EC) PRIVATE KEY/);
  assert.doesNotMatch(workflow, /ssh-rsa AAAA/);
});

test("worker app update workflow serializes deployments and uses a prod environment", () => {
  // One job deploying serially through the dispatcher
  assert.match(workflow, /deploy-worker-artifact\.mjs/);
  assert.match(workflow, /build-linux-worker-artifact\.mjs/);
  assert.match(workflow, /npm ci --prefer-offline/);
  // Prod environment gate for SSH access
  assert.match(workflow, /environment: release-prod/);
  // Concurrency guard prevents overlapping deployments
  assert.match(workflow, /group: worker-app-update/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("worker app update workflow pins runner and node toolchain", () => {
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /NODE_VERSION: ["']22\.23\.1["']/);
  assert.match(workflow, /setup-node@/);
  assert.match(workflow, /node-version: \$\{\{\s*env\.NODE_VERSION\s*\}\}/);
});
