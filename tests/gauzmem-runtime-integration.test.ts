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

test('GauzMem session allowlist gates recall, source recording, and construct batches', () => {
  const source = readFileSync(join(process.cwd(), 'src/gauzmem/service.ts'), 'utf-8');
  assert.match(source, /GAUZMEM_SESSION_ALLOWLIST/);
  assert.match(source, /GAUZMEM_SESSION_TYPE_ALLOWLIST/);
  assert.match(source, /isSessionAllowed\(params\.sessionKey, params\.sessionType\)/);
  assert.match(source, /filter\(turn => this\.isSessionAllowed\(turn\.sessionKey, turn\.sessionType\)\)/);
});

test('GauzMem prompt injection setting gates only passive prompt injection', () => {
  const source = readFileSync(join(process.cwd(), 'src/gauzmem/service.ts'), 'utf-8');
  assert.match(source, /promptInjectionEnabled/);
  assert.match(source, /GAUZMEM_PROMPT_INJECTION/);
  assert.match(source, /params\.callType === 'passive' && !this\.isPromptInjectionEnabled\(\)/);
  assert.match(source, /return \{ run \}/);
});

test('GauzMem dashboard exposes memory assist settings without user-facing enabled switch', () => {
  const routeSource = readFileSync(join(process.cwd(), 'src/dashboard/routes/gauzmem.ts'), 'utf-8');
  const dashboardSource = readFileSync(join(process.cwd(), 'dashboard/gauzmem.html'), 'utf-8');
  assert.match(routeSource, /router\.get\('\/gauzmem\/settings'/);
  assert.match(routeSource, /router\.post\('\/gauzmem\/settings'/);
  assert.match(dashboardSource, /toggleMemoryAssist/);
  assert.match(dashboardSource, /retriever \$\{escapeHtml\(String\(run\.stats\?\.durationMs/);
  assert.doesNotMatch(dashboardSource, /scope:/);
  assert.doesNotMatch(dashboardSource, /sessionAllowlist/);
});
