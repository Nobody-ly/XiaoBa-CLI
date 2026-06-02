import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('TurnContextBuilder injects and removes GauzMem transient recall', () => {
  const source = readFileSync(join(process.cwd(), 'src/core/turn-context-builder.ts'), 'utf-8');
  assert.match(source, /\[transient_gauzmem_recall\]/);
  assert.match(source, /injectGauzMemRecall/);
  assert.match(source, /startsWith\(TRANSIENT_GAUZMEM_RECALL_PREFIX\)/);
});

test('AgentTurnController records GauzMem source near turn logging', () => {
  const source = readFileSync(join(process.cwd(), 'src/core/agent-turn-controller.ts'), 'utf-8');
  assert.match(source, /turnLogRecorder\.recordTurn/);
  assert.match(source, /recordTurnSource/);
});

test('GauzMem records source then schedules background construct without awaiting it', () => {
  const source = readFileSync(join(process.cwd(), 'src/gauzmem/service.ts'), 'utf-8');
  assert.match(source, /recordTurnSource/);
  assert.match(source, /this\.sources\.appendTurn\(params\)/);
  assert.match(source, /this\.scheduleConstruct\(\)/);
  assert.match(source, /setTimeout\(\(\) =>/);
});

test('GauzMem recall is retrieval-only and does not invoke construct processors', () => {
  const source = readFileSync(join(process.cwd(), 'src/gauzmem/service.ts'), 'utf-8');
  const recallBody = source.slice(source.indexOf('async recall('), source.indexOf('recordTurnSource('));
  assert.match(recallBody, /graphScan/);
  assert.match(recallBody, /disclose/);
  assert.match(recallBody, /selectRelevant/);
  assert.doesNotMatch(recallBody, /processRootConstruct/);
  assert.doesNotMatch(recallBody, /processNodeConstruct/);
});

test('GauzMem reasoner exposes a graph patch submit tool for construct', () => {
  const source = readFileSync(join(process.cwd(), 'src/gauzmem/reasoner.ts'), 'utf-8');
  assert.match(source, /submit_gauzmem_graph_patch/);
  assert.match(source, /buildGraphPatch/);
  assert.match(source, /Edge text must be Chinese/);
  assert.match(source, /tempId/);
  assert.match(source, /existingNodeId/);
});

test('GauzMem graph patch apply treats merges and bad edges as warnings', () => {
  const source = readFileSync(join(process.cwd(), 'src/gauzmem/service.ts'), 'utf-8');
  assert.match(source, /applyGraphPatch/);
  assert.match(source, /mergeByTemp/);
  assert.match(source, /appendNodeEvidence/);
  assert.match(source, /construct_warning/);
  assert.match(source, /construct_skipped_edge/);
});

test('GauzMem query build uses full previous assistant reply and addressee guidance', () => {
  const source = readFileSync(join(process.cwd(), 'src/gauzmem/reasoner.ts'), 'utf-8');
  assert.match(source, /treat those names as addressees/);
  assert.match(source, /Previous assistant final reply: \$\{params\.previousAssistant \|\| ''\}/);
});
