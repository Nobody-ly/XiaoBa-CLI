import * as fs from 'fs';
import * as path from 'path';
import { RuntimeFactory } from '../runtime/runtime-factory';
import { resolveRuntimeProfileFromConfig } from '../runtime/runtime-profile-config';
import { Logger } from '../utils/logger';
import { startRuntimeCommandSupport, stopRuntimeCommandSupport } from '../utils/runtime-command-support';
import { createExecutionScopeFromRoute, createSessionRoute } from '../core/session-router';
import type { DeviceGrantOperation, ExecutionScope, ScopedLocalDeviceGrant } from '../types/session-identity';
import type { ToolCall, ToolExecutionConfirmationRequest, ToolExecutionConfirmationResult, ToolResult } from '../types/tool';

export interface EvalCommandOptions {
  cwd?: string;
  promptFile?: string;
  message?: string;
  sessionKey?: string;
  runRoot?: string;
  envFile?: string;
  modelSource?: string;
  outputJson?: string;
  maxMinutes?: string;
  autoApproveTools?: string | boolean;
  noInteractive?: boolean;
  noDashboard?: boolean;
  streaming?: boolean;
}

export interface EvalResultJson {
  ok: boolean;
  status: 'completed' | 'timeout' | 'agent_error' | 'startup_error';
  session_key?: string;
  cwd?: string;
  run_root?: string;
  duration_ms: number;
  final_text?: string;
  error: string | null;
}

const DEFAULT_MAX_MINUTES = 20;
const EVAL_ACTOR_USER_ID = 'xiaoba_eval_user';
const EVAL_AGENT_ID = 'xiaoba_eval_agent';
const EVAL_BODY_ID = 'xiaoba-eval-body';
const EVAL_INSTALLATION_ID = 'xiaoba-eval-installation';
const EVAL_DEVICE_ID = 'xiaoba-eval-local-device';

const LOW_RISK_TOOL_NAMES = new Set([
  'read_file',
  'glob',
  'grep',
  'resolve_common_directory',
  'common_directory',
  'update_plan',
  'record_decision',
  'check_subagent',
  'stop_subagent',
  'resume_subagent',
  'ask_parent',
  'skill',
  'memory_search',
  'memory_read_turn',
  'memory_neighbors',
  'finish_memory_search',
]);

const MUTATING_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'execute_shell',
  'send_file',
  'send_text',
  'spawn_subagent',
  'share_skillhub_skill',
]);

const TOOL_NAME_ALIASES: Record<string, string> = {
  Bash: 'execute_shell',
  bash: 'execute_shell',
  Shell: 'execute_shell',
  shell: 'execute_shell',
  execute_bash: 'execute_shell',
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
};

export async function evalCommand(options: EvalCommandOptions): Promise<void> {
  const startedAt = Date.now();
  let result: EvalResultJson | undefined;
  let logOpened = false;

  try {
    const normalized = normalizeEvalOptions(options);
    fs.mkdirSync(normalized.runRoot, { recursive: true });
    applyEvalEnvironment(normalized);
    process.chdir(normalized.runRoot);
    Logger.openLogFile('eval', normalized.sessionKey, true);
    logOpened = true;
    await startRuntimeCommandSupport();

    const prompt = readPrompt(normalized);
    const profile = resolveRuntimeProfileFromConfig({
      surface: 'catscompany',
      workingDirectory: normalized.cwd,
    }).profile;
    const runtime = await RuntimeFactory.createSession({
      profile,
      sessionKey: normalized.sessionKey,
      sessionType: 'catscompany',
      loadSkills: profile.skills.enabled,
    });

    installEvalToolGuard(runtime.services.toolManager, normalized.autoApproveTools);

    const route = createSessionRoute({
      source: 'catscompany',
      topicId: normalized.sessionKey,
      topicType: 'p2p',
      actorUserId: EVAL_ACTOR_USER_ID,
      agentId: EVAL_AGENT_ID,
      agentBodyId: EVAL_BODY_ID,
      identityTrust: 'server_canonical',
      identitySource: 'xiaoba_eval',
      legacySessionKey: `cc_user:${normalized.sessionKey}`,
    });
    const executionScope = createExecutionScopeFromRoute(route);
    const localDeviceGrant = createEvalLocalDeviceGrant(executionScope, normalized.autoApproveTools);

    const timeoutMs = normalized.maxMinutes * 60 * 1000;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      runtime.session.requestInterrupt();
    }, timeoutMs);

    try {
      const response = await runtime.session.handleMessage(prompt, {
        sessionRoute: route,
        executionScope,
        localDeviceGrant,
        streaming: normalized.streaming,
        callbacks: {
          confirmToolExecution: createEvalToolConfirmer(normalized.autoApproveTools),
        },
      });
      result = {
        ok: !timedOut,
        status: timedOut ? 'timeout' : 'completed',
        session_key: normalized.sessionKey,
        cwd: normalized.cwd,
        run_root: normalized.runRoot,
        duration_ms: Date.now() - startedAt,
        final_text: response.text || '',
        error: timedOut ? `Timed out after ${normalized.maxMinutes} minute(s).` : null,
      };
    } finally {
      clearTimeout(timeout);
      await runtime.session.cleanup({ stopSubAgents: true, subAgentStopReason: 'eval complete' });
    }
  } catch (error: any) {
    const status = result?.status === 'timeout' ? 'timeout' : 'startup_error';
    result = {
      ok: false,
      status,
      duration_ms: Date.now() - startedAt,
      error: String(error?.message || error || 'unknown error'),
    };
  } finally {
    try {
      await stopRuntimeCommandSupport();
    } catch {
      // Best-effort cleanup.
    }
    if (logOpened) {
      Logger.closeLogFile();
    }
  }

  const output = result ?? {
    ok: false,
    status: 'agent_error',
    duration_ms: Date.now() - startedAt,
    error: 'Eval command ended without a result.',
  };
  writeEvalResult(options.outputJson, output);
  if (!output.ok) {
    process.exitCode = output.status === 'timeout' ? 124 : 1;
  }
}

export function parseAutoApproveTools(value: string | boolean | undefined): Set<string> {
  if (value === undefined || value === false) return new Set();
  if (value === true) {
    return new Set(['read_file', 'glob', 'grep', 'write_file', 'edit_file', 'execute_shell']);
  }
  const items = value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  if (items.some(item => item.toLowerCase() === 'all')) {
    return new Set([...LOW_RISK_TOOL_NAMES, ...MUTATING_TOOL_NAMES]);
  }
  return new Set(items.map(normalizeToolName));
}

export function normalizeEvalOptions(options: EvalCommandOptions): {
  cwd: string;
  promptFile?: string;
  message?: string;
  sessionKey: string;
  runRoot: string;
  envFile?: string;
  modelSource: 'env' | 'custom' | 'relay';
  outputJson?: string;
  maxMinutes: number;
  autoApproveTools: Set<string>;
  streaming?: boolean;
} {
  const cwd = path.resolve(options.cwd || process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`--cwd must be an existing directory: ${cwd}`);
  }

  const promptFile = options.promptFile ? path.resolve(options.promptFile) : undefined;
  if (promptFile && (!fs.existsSync(promptFile) || !fs.statSync(promptFile).isFile())) {
    throw new Error(`--prompt-file must be an existing file: ${promptFile}`);
  }
  if (!promptFile && !options.message) {
    throw new Error('Either --prompt-file or --message is required.');
  }

  const maxMinutes = Number(options.maxMinutes ?? DEFAULT_MAX_MINUTES);
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) {
    throw new Error('--max-minutes must be a positive number.');
  }

  const sessionKey = sanitizeSessionKey(options.sessionKey || `eval-${Date.now()}`);
  const runRoot = path.resolve(options.runRoot || path.join(cwd, '.xiaoba-eval-runs', sessionKey));
  const envFile = options.envFile ? path.resolve(options.envFile) : undefined;
  if (envFile && (!fs.existsSync(envFile) || !fs.statSync(envFile).isFile())) {
    throw new Error(`--env-file must be an existing file: ${envFile}`);
  }
  const outputJson = options.outputJson ? path.resolve(options.outputJson) : undefined;
  return {
    cwd,
    promptFile,
    message: options.message,
    sessionKey,
    runRoot,
    envFile,
    modelSource: parseModelSource(options.modelSource),
    outputJson,
    maxMinutes,
    autoApproveTools: parseAutoApproveTools(options.autoApproveTools),
    streaming: options.streaming,
  };
}

export function parseModelSource(value: string | undefined): 'env' | 'custom' | 'relay' {
  const text = String(value || 'env').trim().toLowerCase();
  if (!text || text === 'env' || text === 'current') return 'env';
  if (text === 'custom') return 'custom';
  if (text === 'relay') return 'relay';
  throw new Error(`--model-source must be one of env, custom, relay. Received: ${value}`);
}

export function applyEvalEnvironment(options: {
  envFile?: string;
  modelSource: 'env' | 'custom' | 'relay';
}): void {
  if (options.envFile) {
    const loaded = loadEnvFile(options.envFile);
    for (const [key, value] of Object.entries(loaded)) {
      process.env[key] = value;
    }
  }
  if (options.modelSource === 'env') return;

  const prefix = options.modelSource === 'custom'
    ? 'CATSCO_CUSTOM_LLM'
    : 'CATSCO_RELAY_LLM';
  const provider = readNonEmptyEnv(`${prefix}_PROVIDER`);
  const apiBase = readNonEmptyEnv(`${prefix}_API_BASE`);
  const model = readNonEmptyEnv(`${prefix}_MODEL`);
  const apiKey = readNonEmptyEnv(`${prefix}_API_KEY`);
  const contextWindow = readNonEmptyEnv(`${prefix}_CONTEXT_WINDOW_TOKENS`);
  const missing = [
    !provider && `${prefix}_PROVIDER`,
    !apiBase && `${prefix}_API_BASE`,
    !model && `${prefix}_MODEL`,
    !apiKey && `${prefix}_API_KEY`,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`--model-source ${options.modelSource} is incomplete. Missing: ${missing.join(', ')}`);
  }
  if (provider !== 'openai' && provider !== 'anthropic') {
    throw new Error(`${prefix}_PROVIDER must be "openai" or "anthropic"; got "${provider}".`);
  }

  process.env.CATSCO_MODEL_SOURCE = options.modelSource;
  process.env.GAUZ_LLM_PROVIDER = provider;
  process.env.GAUZ_LLM_API_BASE = apiBase;
  process.env.GAUZ_LLM_MODEL = model;
  process.env.GAUZ_LLM_API_KEY = apiKey;
  if (contextWindow) {
    process.env.GAUZ_LLM_CONTEXT_WINDOW_TOKENS = contextWindow;
  }
}

export function isDangerousShellCommand(value: string): boolean {
  const text = value.toLowerCase();
  if (!text.trim()) return false;
  return /\brm\s+-rf\b/.test(text)
    || /\bremove-item\b[\s\S]*-recurse\b/.test(text)
    || /\bdel\s+\/[sq]\b/.test(text)
    || /\bformat\s+[a-z]:/.test(text)
    || /\bshutdown\b/.test(text)
    || /\breboot\b/.test(text)
    || /(curl|wget|irm|iwr)[\s\S]*(\||;)\s*(sh|bash|powershell|pwsh|cmd)\b/.test(text);
}

function readPrompt(options: { promptFile?: string; message?: string }): string {
  const prompt = options.promptFile
    ? fs.readFileSync(options.promptFile, 'utf-8')
    : String(options.message || '');
  if (!prompt.trim()) {
    throw new Error('Prompt is empty.');
  }
  return prompt;
}

function createEvalLocalDeviceGrant(
  executionScope: ExecutionScope,
  autoApproveTools: Set<string>,
): ScopedLocalDeviceGrant | undefined {
  if (autoApproveTools.size === 0) return undefined;
  const capabilities = Array.from(autoApproveTools)
    .filter(isDeviceGrantOperation) as DeviceGrantOperation[];
  return {
    kind: 'catscompany_body',
    source: 'catscompany',
    ownerUserId: executionScope.actorUserId,
    bodyId: EVAL_BODY_ID,
    installationId: EVAL_INSTALLATION_ID,
    deviceId: EVAL_DEVICE_ID,
    capabilities,
    createdAt: Date.now(),
  };
}

function createEvalToolConfirmer(
  autoApproveTools: Set<string>,
): (request: ToolExecutionConfirmationRequest) => Promise<ToolExecutionConfirmationResult> {
  return async (request) => {
    const toolName = normalizeToolName(request.toolName);
    if (LOW_RISK_TOOL_NAMES.has(toolName) || autoApproveTools.has(toolName)) {
      if (toolName === 'execute_shell' && isDangerousShellCommand(shellCommandFromArgs(request.args))) {
        return { approved: false, reason: 'Eval blocked a dangerous shell command.' };
      }
      return { approved: true };
    }
    return {
      approved: false,
      reason: `Eval did not auto-approve ${toolName}. Pass --auto-approve-tools ${toolName} to allow it.`,
    };
  };
}

function installEvalToolGuard(toolManager: any, autoApproveTools: Set<string>): void {
  if (!toolManager || typeof toolManager.executeTool !== 'function') return;
  const originalExecuteTool = toolManager.executeTool.bind(toolManager);
  toolManager.executeTool = async (
    toolCall: ToolCall,
    conversationHistory?: any[],
    contextOverrides?: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const requestedName = String(toolCall?.function?.name || '');
    const toolName = normalizeToolName(requestedName);
    if (MUTATING_TOOL_NAMES.has(toolName) && !autoApproveTools.has(toolName)) {
      return deniedToolResult(toolCall, requestedName, `Eval blocked ${toolName}; it is not in --auto-approve-tools.`);
    }
    if (toolName === 'execute_shell') {
      const args = parseToolArgs(toolCall);
      const command = shellCommandFromArgs(args);
      if (isDangerousShellCommand(command)) {
        return deniedToolResult(toolCall, requestedName, 'Eval blocked a dangerous shell command.');
      }
    }
    return originalExecuteTool(toolCall, conversationHistory, contextOverrides);
  };
}

function deniedToolResult(toolCall: ToolCall, name: string, content: string): ToolResult {
  return {
    tool_call_id: toolCall?.id,
    role: 'tool',
    name,
    content,
    ok: false,
    errorCode: 'PERMISSION_DENIED',
    retryable: false,
  };
}

function writeEvalResult(outputJson: string | undefined, result: EvalResultJson): void {
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (outputJson) {
    fs.mkdirSync(path.dirname(outputJson), { recursive: true });
    fs.writeFileSync(outputJson, text, 'utf-8');
  }
  process.stdout.write(text);
}

function sanitizeSessionKey(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || `eval-${Date.now()}`;
}

function normalizeToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] ?? name;
}

function parseToolArgs(toolCall: ToolCall): unknown {
  try {
    return JSON.parse(toolCall?.function?.arguments || '{}');
  } catch {
    return {};
  }
}

function shellCommandFromArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  const value = record.command ?? record.cmd ?? record.script;
  return typeof value === 'string' ? value : '';
}

function loadEnvFile(filePath: string): Record<string, string> {
  const values: Record<string, string> = {};
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const equalsIndex = normalized.indexOf('=');
    if (equalsIndex <= 0) continue;
    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = normalized.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readNonEmptyEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value || undefined;
}

function isDeviceGrantOperation(value: string): value is DeviceGrantOperation {
  return [
    'read_file',
    'resolve_common_directory',
    'write_file',
    'edit_file',
    'send_file',
    'execute_shell',
    'glob',
    'grep',
    'browser_control',
    'desktop_control',
  ].includes(value);
}
