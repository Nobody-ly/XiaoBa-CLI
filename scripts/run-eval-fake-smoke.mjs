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
const caseRoot = path.join(outputRoot, 'repo');
const evalRunRoot = path.join(outputRoot, 'xiaoba-run');
const resultPath = path.join(outputRoot, 'result.json');
const diffPath = path.join(outputRoot, 'repo.diff');
const summaryPath = path.join(outputRoot, 'summary.json');

await main();

async function main() {
  ensureCleanTarget(outputRoot);
  fs.mkdirSync(outputRoot, { recursive: true });
  copyDirectory(fixtureDir, caseRoot);

  await run('git', ['init'], { cwd: caseRoot });
  await run('git', ['add', '.'], { cwd: caseRoot });
  await run('git', ['-c', 'user.name=XiaoBa-Eval', '-c', 'user.email=eval@example.test', 'commit', '-m', 'initial-fake-repo'], { cwd: caseRoot });

  const beforeTest = await run('npm', ['test'], { cwd: caseRoot, allowFailure: true });

  const evalArgs = [
    'dist/index.js',
    'eval',
    '--cwd', caseRoot,
    '--prompt-file', path.join(caseRoot, 'task.md'),
    '--session-key', String(args['session-key'] || `eval-fake-${runId}`),
    '--run-root', evalRunRoot,
    '--output-json', resultPath,
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

  const evalResult = await run(process.execPath, evalArgs, { cwd: rootDir, allowFailure: true, inherit: true });
  const afterTest = await run('npm', ['test'], { cwd: caseRoot, allowFailure: true });
  const diffResult = await run('git', ['diff', '--', '.'], { cwd: caseRoot, allowFailure: true });
  fs.writeFileSync(diffPath, diffResult.stdout, 'utf-8');

  const resultJson = readJsonIfExists(resultPath);
  const summary = {
    ok: evalResult.code === 0 && afterTest.code === 0 && Boolean(diffResult.stdout.trim()),
    run_id: runId,
    case_root: caseRoot,
    output_root: outputRoot,
    result_json: resultPath,
    diff_path: diffPath,
    before_test_exit_code: beforeTest.code,
    eval_exit_code: evalResult.code,
    after_test_exit_code: afterTest.code,
    diff_nonempty: Boolean(diffResult.stdout.trim()),
    eval_result: resultJson,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(summary.ok ? 0 : 1);
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
