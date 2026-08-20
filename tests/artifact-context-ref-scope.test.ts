import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ShellTool } from '../src/tools/bash-tool';
import {
  CATSCO_ARTIFACT_CONTEXT_REF_ENV,
  normalizeArtifactContextRef,
  withArtifactContextRefEnvironment,
} from '../src/utils/artifact-context-ref';

const firstRef = `acr_${'a'.repeat(43)}`;
const secondRef = `acr_${'b'.repeat(43)}`;

describe('Artifact context ref tool scope', () => {
  test('normalizes only the opaque ref contract', () => {
    assert.equal(normalizeArtifactContextRef(firstRef), firstRef);
    assert.equal(normalizeArtifactContextRef(` ${firstRef}`), undefined);
    assert.equal(normalizeArtifactContextRef('acr_short'), undefined);
    assert.equal(normalizeArtifactContextRef(42), undefined);
  });

  test('copies the child environment, replaces inherited refs, and never mutates the parent', () => {
    const parent = {
      PATH: 'test-path',
      catsco_artifact_context_ref: firstRef,
    };

    const withCurrent = withArtifactContextRefEnvironment(parent, secondRef);
    const withoutCurrent = withArtifactContextRefEnvironment(parent, undefined);

    assert.notEqual(withCurrent, parent);
    assert.equal(withCurrent[CATSCO_ARTIFACT_CONTEXT_REF_ENV], secondRef);
    assert.equal(withoutCurrent[CATSCO_ARTIFACT_CONTEXT_REF_ENV], undefined);
    assert.equal(parent.catsco_artifact_context_ref, firstRef);
  });

  test('injects the ref only into the local shell child process and scrubs stale parent state', async () => {
    const previous = process.env[CATSCO_ARTIFACT_CONTEXT_REF_ENV];
    process.env[CATSCO_ARTIFACT_CONTEXT_REF_ENV] = firstRef;
    const command = `node -e "process.stdout.write(process.env.${CATSCO_ARTIFACT_CONTEXT_REF_ENV} || 'missing')"`;

    try {
      const shell = new ShellTool();
      const withCurrent = await shell.execute({ command }, {
        workingDirectory: process.cwd(),
        conversationHistory: [],
        artifactContextRef: secondRef,
      });
      const withoutCurrent = await shell.execute({ command }, {
        workingDirectory: process.cwd(),
        conversationHistory: [],
      });

      assert.equal(withCurrent.ok, true);
      assert.match(String(withCurrent.ok ? withCurrent.content : withCurrent.message), new RegExp(secondRef));
      assert.equal(withoutCurrent.ok, true);
      assert.match(String(withoutCurrent.ok ? withoutCurrent.content : withoutCurrent.message), /missing/);
      assert.doesNotMatch(String(withoutCurrent.ok ? withoutCurrent.content : withoutCurrent.message), new RegExp(firstRef));
      assert.equal(process.env[CATSCO_ARTIFACT_CONTEXT_REF_ENV], firstRef);
    } finally {
      if (previous === undefined) delete process.env[CATSCO_ARTIFACT_CONTEXT_REF_ENV];
      else process.env[CATSCO_ARTIFACT_CONTEXT_REF_ENV] = previous;
    }
  });
});
