import * as path from 'path';

export function resolveRuntimeRoot(): string {
  return path.resolve(process.env.XIAOBA_RUNTIME_ROOT || process.cwd());
}

export function resolveRuntimePath(...segments: string[]): string {
  return path.resolve(resolveRuntimeRoot(), ...segments);
}

export function resolveSessionDataDir(): string {
  return path.resolve(process.env.XIAOBA_SESSION_DIR || resolveRuntimePath('data', 'sessions'));
}

export function resolveSessionStateDir(): string {
  return path.resolve(process.env.XIAOBA_SESSION_STATE_DIR || resolveRuntimePath('data', 'session-state'));
}

export function resolveSessionLogDir(): string {
  return path.resolve(process.env.XIAOBA_SESSION_LOG_DIR || resolveRuntimePath('logs', 'sessions'));
}

export function resolveBranchLogDir(): string {
  return path.resolve(process.env.XIAOBA_BRANCH_LOG_DIR || resolveRuntimePath('logs', 'branches'));
}

export function resolveProviderMessagesLogDir(): string {
  return path.resolve(process.env.XIAOBA_PROVIDER_MESSAGES_LOG_DIR || resolveRuntimePath('logs', 'provider-messages'));
}
