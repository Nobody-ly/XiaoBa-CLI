import { describe, test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GauzMemGraphStore } from '../src/gauzmem/graph-store';

function ref(sourceId: string, start = 0, end = 10) {
  return {
    sourceId,
    span: { start, end },
    sourceRef: { kind: 'session_turn' as const, turnId: 'turn', role: 'assistant', index: 0 },
  };
}

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
    const { node } = store.upsertNode('Cyrus Vance owns The Owl.', ref('source-1'));
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
    const { node } = store.upsertNode('Unrelated scratch note.', ref('source-1'));
    for (let i = 0; i < 95; i++) {
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

  test('omits faded edges from graph scan and disclose', () => {
    const store = new GauzMemGraphStore();
    const first = store.upsertNode('Cyrus Vance owns The Owl.', ref('source-1')).node;
    const second = store.upsertNode('The Owl is docked near Nightport.', ref('source-1')).node;
    const edge = store.upsertEdge(first.id, second.id, 'Cyrus and The Owl are linked.', ref('source-1'))!.edge;
    for (let i = 0; i < 65; i++) {
      store.applySelection({
        selectedNodeIds: [],
        selectedEdgeIds: [],
        rejectedNodeIds: [],
        rejectedEdgeIds: [edge.id],
      });
    }

    assert.equal(store.readEdgeStates().get(edge.id)?.faded, true);
    assert.equal(store.graphScan(['linked']).edges.some(item => item.id === edge.id), false);
    assert.equal(store.disclose([first.id]).edges.some(item => item.id === edge.id), false);
  });

  test('natural decay removes stale memories from normal retrieval without deep fading them', () => {
    const store = new GauzMemGraphStore();
    const { node } = store.upsertNode('Dawn waits aboard the broken ship.', ref('source-1'));

    store.applyRecallDecay(10);

    const state = store.readNodeStates().get(node.id);
    assert.ok(state);
    assert.equal(state.faded, false);
    assert.ok(state.score < 0.1);
    assert.deepEqual(store.graphScan(['Dawn']).nodes, []);
  });

  test('deduplicates evidence nodes with quote and punctuation differences', () => {
    const store = new GauzMemGraphStore();
    const first = store.upsertNode('"坐标和密钥都在这里面。"老杰克指向投影台。', 'source-1');
    const second = store.upsertNode('坐标和密钥都在这里面。老杰克指向投影台', 'source-2');

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.node.id, first.node.id);
    assert.deepEqual(second.node.evidenceRefs.map(item => item.sourceId).sort(), ['source-1', 'source-2']);
    assert.equal(store.readNodes().length, 1);
  });

  test('deduplicates highly overlapping evidence nodes', () => {
    const store = new GauzMemGraphStore();
    const first = store.upsertNode('坐标和密钥都在这里面。老杰克指向投影台，但导航核心是独立的。', 'source-1');
    const second = store.upsertNode('坐标和密钥都在这里面。老杰克指向投影台，但导航核心是独立的——拔出来直接插到你们船上就能用。', 'source-2');

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.node.id, first.node.id);
    assert.equal(store.readNodes().length, 1);
  });

  test('normalizes verbose English edge templates before storing', () => {
    const store = new GauzMemGraphStore();
    const first = store.upsertNode('坐标在导航核心里。', 'source-1').node;
    const second = store.upsertNode('导航核心可以拔出来。', 'source-1').node;
    const edge = store.upsertEdge(
      first.id,
      second.id,
      'Parent fact: 坐标在导航核心里。 Evidence: 导航核心可以拔出来。 This evidence directly confirms that fact by adding transfer details.',
      ref('source-1'),
    )!.edge;

    assert.doesNotMatch(edge.text, /Parent fact|Evidence|This evidence/i);
    assert.ok(edge.text.length <= 120);
  });
});
