import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GauzMemGraphStore } from '../src/gauzmem/graph-store';

describe('GauzMemGraphStore', () => {
  let oldCwd: string;
  let tmp: string;

  beforeEach(() => {
    oldCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gauzmem-graph-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(oldCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('keeps selected and rejected weight updates mutually exclusive', () => {
    const store = new GauzMemGraphStore();
    const { node } = store.upsertNode('Cyrus Vance owns The Owl.', 'source-1');
    const changes = store.applySelection({
      selectedNodeIds: [node.id],
      selectedEdgeIds: [],
      rejectedNodeIds: [node.id],
      rejectedEdgeIds: [],
    });

    assert.equal(changes.length, 1);
    assert.equal(changes[0].reason, 'selected');
    assert.equal(store.readNodeStates().get(node.id)?.selectedCount, 1);
    assert.equal(store.readNodeStates().get(node.id)?.rejectedCount, 0);
  });

  test('marks repeatedly rejected memory as faded', () => {
    const store = new GauzMemGraphStore();
    const { node } = store.upsertNode('Unrelated scratch note.', 'source-1');
    for (let i = 0; i < 25; i++) {
      store.applySelection({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        rejectedNodeIds: [node.id],
        rejectedEdgeIds: [],
      });
    }

    assert.equal(store.readNodeStates().get(node.id)?.faded, true);
    assert.deepEqual(store.graphScan(['scratch']).nodes, []);
  });
});
