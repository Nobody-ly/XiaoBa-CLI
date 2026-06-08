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
  assert.match(recallBody, /grepQueryPlan/);
  assert.match(recallBody, /buildPromptBundle/);
  assert.doesNotMatch(recallBody, /selectRelevanceCandidates/);
  assert.doesNotMatch(recallBody, /relevance_candidates/);
  assert.doesNotMatch(recallBody, /disclose_grep/);
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

test('GauzMem query build uses full previous assistant reply and atomic participant guidance', () => {
  const source = readFileSync(join(process.cwd(), 'src/gauzmem/reasoner.ts'), 'utf-8');
  assert.match(source, /Do not automatically drop addressee\/speaker names/);
  assert.match(source, /Previous assistant final reply: \$\{params\.previousAssistant \|\| ''\}/);
  assert.match(source, /required: \['rootQuery', 'searchTerms'\]/);
  assert.match(source, /literal grep anchors/);
  assert.match(source, /Prefer atomic grep terms/);
  assert.doesNotMatch(source, /queryGroupsValue/);
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

test('GauzMem recall runs in background when prompt injection is disabled', () => {
  const source = readFileSync(join(process.cwd(), 'src/core/turn-context-builder.ts'), 'utf-8');
  const serviceSource = readFileSync(join(process.cwd(), 'src/gauzmem/service.ts'), 'utf-8');
  assert.match(source, /!gauzMem\.isPromptInjectionEnabled\(\)/);
  assert.match(source, /gauzMem\.enqueueRecall\(recallParams\)/);
  assert.match(source, /await withTimeout\(gauzMem\.recall\(recallParams\)/);
  assert.match(serviceSource, /private recallQueue: Promise<void> = Promise\.resolve\(\)/);
  assert.match(serviceSource, /enqueueRecall\(params: GauzMemRecallParams\)/);
});

test('GauzMem runs by default unless explicitly disabled', () => {
  const source = readFileSync(join(process.cwd(), 'src/gauzmem/service.ts'), 'utf-8');
  assert.match(source, /GAUZMEM_ENABLED/);
  assert.match(source, /0\|false\|no\|off/);
  assert.doesNotMatch(source, /\^\(1\|true\|yes\)\$/);
});

test('GauzMem dashboard exposes memory assist settings without user-facing enabled switch', () => {
  const routeSource = readFileSync(join(process.cwd(), 'src/dashboard/routes/gauzmem.ts'), 'utf-8');
  const dashboardSource = readFileSync(join(process.cwd(), 'dashboard/gauzmem.html'), 'utf-8');
  assert.match(routeSource, /router\.get\('\/gauzmem\/settings'/);
  assert.match(routeSource, /router\.post\('\/gauzmem\/settings'/);
  assert.match(dashboardSource, /toggleMemoryAssist/);
  assert.match(dashboardSource, /function durationLabel\(run\)/);
  assert.match(dashboardSource, /formatDuration\(run\.stats\?\.durationMs\)/);
  assert.doesNotMatch(dashboardSource, /scope:/);
  assert.doesNotMatch(dashboardSource, /sessionAllowlist/);
});

test('GauzMem run logs reference graph snapshots and construct artifacts', () => {
  const pathSource = readFileSync(join(process.cwd(), 'src/gauzmem/paths.ts'), 'utf-8');
  const typeSource = readFileSync(join(process.cwd(), 'src/gauzmem/types.ts'), 'utf-8');
  const serviceSource = readFileSync(join(process.cwd(), 'src/gauzmem/service.ts'), 'utf-8');
  assert.match(pathSource, /graph_snapshots\.jsonl/);
  assert.match(pathSource, /construct_artifacts\.jsonl/);
  assert.match(typeSource, /snapshotId\?: string/);
  assert.match(typeSource, /artifactId\?: string/);
  assert.match(typeSource, /interface GauzMemGraphSnapshot/);
  assert.match(typeSource, /interface GauzMemConstructArtifact/);
  assert.match(serviceSource, /run\.snapshotId = this\.saveGraphSnapshot/);
  assert.match(serviceSource, /appendJsonl\(GauzMemFiles\.graphSnapshots\(\), snapshot\)/);
  assert.match(serviceSource, /run\.artifactId = artifact\.artifactId/);
  assert.match(serviceSource, /artifact\.patch = patch/);
  assert.match(serviceSource, /artifact\.applyResult =/);
  assert.match(serviceSource, /appendJsonl\(GauzMemFiles\.constructArtifacts\(\), artifact\)/);
});

test('GauzMem dashboard run replay is simplified for recall and construct', () => {
  const dashboardSource = readFileSync(join(process.cwd(), 'dashboard/gauzmem.html'), 'utf-8');
  assert.match(dashboardSource, /function renderConstructRun\(run\)/);
  assert.match(dashboardSource, /<h2>Selected Memory<\/h2>/);
  assert.match(dashboardSource, /<h2>Prompt<\/h2>/);
  assert.match(dashboardSource, /<h2>Created<\/h2>/);
  assert.match(dashboardSource, /<h2>Merged<\/h2>/);
  assert.match(dashboardSource, /Skipped \/ Warnings/);
});

test('GauzMem construct failures advance the batch cursor and do not block later batches', () => {
  const source = readFileSync(join(process.cwd(), 'src/gauzmem/service.ts'), 'utf-8');
  const cursorBlock = source.slice(source.indexOf('const latestCompleted'), source.indexOf('const startIndex'));
  assert.match(cursorBlock, /run\.kind === 'construct'/);
  assert.match(cursorBlock, /run\.stats\.constructBatchEnd/);
  assert.doesNotMatch(cursorBlock, /run\.status === 'ok'/);
  assert.match(source, /run\.status = 'error'/);
  assert.match(source, /constructBatchEnd: batch\.newTurns\[batch\.newTurns\.length - 1\]\?\.turnKey/);
  assert.match(source, /recordErrorTurnSource/);
  assert.match(source, /this\.scheduleConstruct\(\)/);
});
