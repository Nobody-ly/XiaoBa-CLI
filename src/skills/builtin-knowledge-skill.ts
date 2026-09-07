import * as path from 'path';
import { DEFAULT_PROMPTS_DIR } from '../utils/prompt-template';
import { PathResolver } from '../utils/path-resolver';
import { SkillParser } from './skill-parser';
import { Skill } from '../types/skill';

export const KNOWLEDGE_SKILL_NAME = 'xiaoba-knowledge';
export const KNOWLEDGE_SKILL_FILE = path.join(DEFAULT_PROMPTS_DIR, 'skills', KNOWLEDGE_SKILL_NAME, 'SKILL.md');

export function loadBuiltinKnowledgeSkill(): Skill {
  return SkillParser.parse(KNOWLEDGE_SKILL_FILE);
}

// Resolve runtime paths only on invocation, never in the cached Skill listing.
export function renderKnowledgePaths(skill: Skill): Skill {
  if (skill.filePath !== KNOWLEDGE_SKILL_FILE) return skill;
  return {
    ...skill,
    content: skill.content
      .replace(/<KNOWLEDGE_ROOT>/g, () => path.join(PathResolver.getRuntimeDataRoot(), 'knowledge'))
      .replace(/<KNOWLEDGE_NODE>/g, () => process.env.XIAOBA_NODE_EXECUTABLE?.trim() || process.execPath),
  };
}
