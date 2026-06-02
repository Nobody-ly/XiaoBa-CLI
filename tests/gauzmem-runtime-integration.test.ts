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
