import * as path from 'path';
import { PathResolver } from '../utils/path-resolver';
import { BotSkillWorkspaceService } from './workspace';

/**
 * Server operators may deliberately attach XiaoBa to an already-populated
 * Skill workspace. In that mode startup and Bot binding must not reconcile or
 * bootstrap the workspace as a side effect. Explicit owner-initiated SkillHub
 * publication and deletion operations remain available.
 */
export function preserveOperatorManagedSkills(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return /^(1|true|yes)$/i.test(String(env.XIAOBA_PRESERVE_SKILLS || '').trim());
}

/**
 * Preservation is only safe when the existing active workspace is already
 * attributed to the Bot that will use it. Never adopt or switch ownership in
 * this mode: an absent or mismatched record requires explicit operator repair.
 */
export function assertOperatorManagedSkillWorkspaceBinding(
  runtimeRoot: string,
  botId: string,
): void {
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const skillsRoot = PathResolver.getRuntimeDataRoot() === resolvedRuntimeRoot
    ? PathResolver.getSkillsPath()
    : path.join(resolvedRuntimeRoot, 'skills');
  const activeBotId = new BotSkillWorkspaceService(resolvedRuntimeRoot, skillsRoot).getActiveBotId();
  if (activeBotId !== botId) {
    throw new Error(
      `Operator-managed Skill workspace ownership mismatch: expected ${botId}, found ${activeBotId || 'none'}.`,
    );
  }
}
