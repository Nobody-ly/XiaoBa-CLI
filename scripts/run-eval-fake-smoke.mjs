#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const args = parseArgs(process.argv.slice(2));
const runId = String(args['run-id'] || new Date().toISOString().replace(/[:.]/g, '-'));
const fixtureDir = resolveFromRoot(String(args.fixture || 'tests/fixtures/eval-fake-repo'));
const defaultOutputRoot = path.resolve(rootDir, '..', 'tmp', 'xiaoba-eval-smoke', runId);
const outputRoot = args['output-root'] ? resolveFromRoot(String(args['output-root'])) : defaultOutputRoot;
const summaryPath = path.join(outputRoot, 'summary.json');
const maxInfraRetries = parseRetryLimit(args['max-infra-retries'] ?? args['max-attempts'] ?? '6');
const retryDelayMs = numberOption(args['retry-delay-ms'], 3000);

await main();

async function main() {
  ensureCleanTarget(outputRoot);
  fs.mkdirSync(outputRoot, { recursive: true });

  const infraTries = [];
  let tryNumber = 1;
  while (maxInfraRetries === null || tryNumber <= maxInfraRetries + 1) {
    const infraTry = await runInfraTry(tryNumber);
    infraTries.push(infraTry);
    writeSummary({
      ok: infraTry.ok,
      infra_tries: infraTries,
      final_try: infraTry,
    });
    if (infraTry.ok) {
      process.exit(0);
    }
    if (!infraTry.retryable) {
      break;
    }
    if (maxInfraRetries !== null && tryNumber > maxInfraRetries) break;
    await sleep(retryDelayMs);
    tryNumber++;
  }

  process.exit(1);
}

async function runInfraTry(tryNumber) {
  const tryId = `infra-try-${String(tryNumber).padStart(2, '0')}`;
  const tryRoot = path.join(outputRoot, tryId);
  const caseRoot = path.join(tryRoot, 'repo');
  const evalRunRoot = path.join(tryRoot, 'xiaoba-run');
  const resultPath = path.join(tryRoot, 'result.json');
  const diffPath = path.join(tryRoot, 'repo.diff');

  fs.rmSync(tryRoot, { recursive: true, force: true });
  fs.mkdirSync(tryRoot, { recursive: true });
  copyDirectory(fixtureDir, caseRoot);

  await run('git', ['init'], { cwd: caseRoot });
  await run('git', ['add', '.'], { cwd: caseRoot });
  await run('git', ['-c', 'user.name=XiaoBa-Eval', '-c', 'user.email=eval@example.test', 'commit', '-m', 'initial-fake-repo'], { cwd: caseRoot });

  const beforeTest = await run('npm', ['test'], { cwd: caseRoot, allowFailure: true });
  const evalResult = await run(process.execPath, buildEvalArgs({
    tryNumber,
    caseRoot,
    evalRunRoot,
    resultPath,
  }), { cwd: rootDir, allowFailure: true });
  const resultJson = readJsonIfExists(resultPath);
  const retryReason = getRetryReason({ evalResult, resultJson });
  const afterTest = retryReason
    ? { code: null, stdout: '', stderr: '' }
    : await run('npm', ['test'], { cwd: caseRoot, allowFailure: true });
  const diffResult = retryReason
    ? { code: null, stdout: '', stderr: '' }
    : await run('git', ['diff', '--', '.'], { cwd: caseRoot, allowFailure: true });
  fs.writeFileSync(diffPath, diffResult.stdout, 'utf-8');

  const ok = !retryReason && evalResult.code === 0 && afterTest.code === 0 && Boolean(diffResult.stdout.trim());
  return {
    ok,
    retryable: !ok && Boolean(retryReason),
    retry_reason: ok ? null : retryReason,
    eval_round: 1,
    infra_try: tryNumber,
    try_root: tryRoot,
    case_root: caseRoot,
    result_json: resultPath,
    diff_path: diffPath,
    before_test_exit_code: beforeTest.code,
    eval_exit_code: evalResult.code,
    after_test_exit_code: afterTest.code,
    diff_nonempty: Boolean(diffResult.stdout.trim()),
    eval_result: resultJson,
    eval_stdout_tail: tail(evalResult.stdout),
    eval_stderr_tail: tail(evalResult.stderr),
  };
}

function buildEvalArgs(input) {
  const evalArgs = [
    'dist/index.js',
    'eval',
    '--cwd', input.caseRoot,
    '--prompt-file', path.join(input.caseRoot, 'task.md'),
    '--session-key', String(args['session-key'] || `eval-fake-${runId}`),
    '--run-root', input.evalRunRoot,
    '--output-json', input.resultPath,
    '--max-minutes', String(args['max-minutes'] || '10'),
    '--auto-approve-tools', String(args['auto-approve-tools'] || 'read_file,glob,grep,write_file,edit_file,execute_shell'),
    '--model-source', String(args['model-source'] || 'env'),
    '--no-interactive',
    '--no-dashboard',
  ];
  if (args['env-file']) {
    evalArgs.push('--env-file', path.resolve(String(args['env-file'])));
  }
  if (args['no-streaming'] === true) {
    evalArgs.push('--no-streaming');
  }
  return evalArgs;
}

function writeSummary(extra) {
  const summary = {
    ok: Boolean(extra.ok),
    run_id: runId,
    output_root: outputRoot,
    eval_rounds: 1,
    max_infra_retries: maxInfraRetries === null ? 'infinite' : maxInfraRetries,
    retry_delay_ms: retryDelayMs,
    infra_tries: extra.infra_tries,
    infra_retries_used: Math.max(0, extra.infra_tries.length - 1),
    final_try: extra.final_try,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    i++;
  }
  return parsed;
}

function parseRetryLimit(value) {
  const text = String(value).trim().toLowerCase();
  if (text === 'infinite' || text === 'inf' || text === 'while' || text === 'forever') {
    return null;
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--max-infra-retries must be a non-negative integer or "infinite": ${value}`);
  }
  return parsed;
}

function numberOption(value, defaultValue) {
  if (value === undefined || value === true) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative number, got: ${value}`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(rootDir, value);
}

function ensureCleanTarget(target) {
  const resolved = path.resolve(target);
  const allowedRoots = [
    path.resolve(rootDir, '.dev-user-data'),
    path.resolve(rootDir, '..', 'tmp', 'xiaoba-eval-smoke'),
  ];
  if (!allowedRoots.some(root => isWithin(resolved, root))) {
    throw new Error(`Refusing to recreate output outside allowed smoke roots: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function copyDirectory(source, target) {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`Fixture directory does not exist: ${source}`);
  }
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return undefined;
  }
}

function getRetryReason({ evalResult, resultJson }) {
  const text = [
    evalResult.stdout,
    evalResult.stderr,
    resultJson?.error,
    resultJson?.final_text,
  ].filter(Boolean).join('\n');

  if (isRetryableInfraText(text)) {
    return 'retryable-infra-error';
  }
  return null;
}

function isRetryableInfraText(text) {
  return /connection error|network error|fetch failed|socket hang up|premature close|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timeout|timed out|429|rate limit|temporarily unavailable|service unavailable|bad gateway|gateway timeout|502|503|504|520|524|529|服务临时异常|临时异常|请求失败/i.test(String(text || ''));
}

function tail(text, maxLength = 8000) {
  const value = String(text || '');
  return value.length > maxLength ? value.slice(-maxLength) : value;
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const useCmdShim = process.platform === 'win32' && !path.isAbsolute(command);
    const spawnCommand = useCmdShim ? 'cmd.exe' : command;
    const spawnArgs = useCmdShim
      ? ['/d', '/s', '/c', quoteCommand([command, ...commandArgs])]
      : commandArgs;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: options.cwd || rootDir,
      shell: false,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (!options.inherit) {
      child.stdout.on('data', chunk => {
        stdout += chunk;
        process.stdout.write(chunk);
      });
      child.stderr.on('data', chunk => {
        stderr += chunk;
        process.stderr.write(chunk);
      });
    }
    child.on('error', reject);
    child.on('exit', code => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && !options.allowFailure) {
        reject(new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${result.code}`));
        return;
      }
      resolve(result);
    });
  });
}

function isWithin(targetPath, parentPath) {
  const relative = path.relative(parentPath, targetPath);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function quoteCommand(parts) {
  return parts.map(part => {
    const text = String(part);
    if (/^[A-Za-z0-9_./:=@\\-]+$/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
  }).join(' ');
}
