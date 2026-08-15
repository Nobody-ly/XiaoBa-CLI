import * as fs from 'fs';
import * as path from 'path';
import type { ToolExecutionContext } from '../types/tool';
import { PathResolver } from '../utils/path-resolver';

export type FormalBotSkillAccess = 'read' | 'write';

export type FormalBotSkillAccessDecision =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Formal Bot Skills are materialized Cloud state. Generic tools never write
 * them. Chat-triggered tools also cannot read or export their source; local
 * CLI use remains readable for development and recovery.
 */
export function checkFormalBotSkillPathAccess(
  context: ToolExecutionContext,
  candidatePath: string,
  access: FormalBotSkillAccess,
): FormalBotSkillAccessDecision {
  const resolved = path.resolve(candidatePath);
  if (!isFormalBotSkillPath(resolved)) return { ok: true };
  if (access === 'read' && !isChatTriggeredContext(context)) return { ok: true };
  return {
    ok: false,
    reason: access === 'write'
      ? 'Formal Bot Skills are Cloud-managed and cannot be changed by generic tools.'
      : 'Chat-triggered tools cannot read or export formal Bot Skill source files.',
  };
}

/**
 * A broad chat search may contain a protected subtree even though the search
 * root itself is outside it. Callers must filter each traversed path instead
 * of sending the root to an unfiltered external search process.
 */
export function requiresFormalBotSkillSearchFiltering(
  context: ToolExecutionContext,
  searchRoot: string,
): boolean {
  if (!isChatTriggeredContext(context)) return false;
  const resolved = path.resolve(searchRoot);
  return formalBotSkillSearchPaths().some(candidate => pathsIntersect(resolved, candidate));
}

export function isChatTriggeredContext(context: ToolExecutionContext): boolean {
  return Boolean(
    context.deviceRpcReceiver
    || context.surface === 'catscompany'
    || context.executionScope?.source === 'catscompany',
  );
}

function isFormalBotSkillPath(candidatePath: string): boolean {
  const candidate = path.resolve(candidatePath);
  if (formalBotSkillPaths().some(root => pathContains(root, candidate))) return true;
  return isRestoreWorkingPath(candidate);
}

function formalBotSkillPaths(): string[] {
  const runtimeRoot = PathResolver.getRuntimeDataRoot();
  return uniquePaths([
    PathResolver.getSkillsPath(),
    path.join(runtimeRoot, 'data', 'bot-skills'),
  ]);
}

function formalBotSkillSearchPaths(): string[] {
  return [
    ...formalBotSkillPaths(),
    ...existingRestoreWorkingPaths(),
  ];
}

function existingRestoreWorkingPaths(): string[] {
  const parent = path.dirname(PathResolver.getSkillsPath());
  if (!fs.existsSync(parent)) return [];
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter(entry => (
        entry.isDirectory()
        && (entry.name.startsWith('.bot-skills-stage-') || entry.name.startsWith('.bot-skills-backup-'))
      ))
      .map(entry => path.join(parent, entry.name));
  } catch {
    return [];
  }
}

function isRestoreWorkingPath(candidatePath: string): boolean {
  const parent = path.dirname(PathResolver.getSkillsPath());
  const relative = path.relative(parent, path.resolve(candidatePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const first = relative.split(path.sep)[0];
  return first.startsWith('.bot-skills-stage-') || first.startsWith('.bot-skills-backup-');
}

function pathsIntersect(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

function pathContains(parentPath: string, candidatePath: string): boolean {
  const parent = comparablePath(parentPath);
  const candidate = comparablePath(candidatePath);
  if (candidate === parent || candidate.startsWith(`${parent}${path.sep}`)) return true;

  const realParent = comparablePath(realPathWithMissingTail(parentPath));
  const realCandidate = comparablePath(realPathWithMissingTail(candidatePath));
  return realCandidate === realParent || realCandidate.startsWith(`${realParent}${path.sep}`);
}

function realPathWithMissingTail(value: string): string {
  const resolved = path.resolve(value);
  let existing = resolved;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync.native(existing), ...tail);
  } catch {
    return resolved;
  }
}

function uniquePaths(values: string[]): string[] {
  const result = new Map<string, string>();
  for (const value of values) {
    const resolved = path.resolve(value);
    result.set(comparablePath(resolved), resolved);
  }
  return [...result.values()];
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
