import { Message } from '../types';
import {
  SessionSkillRuntime,
  TRANSIENT_SKILLS_LIST_PREFIX,
} from '../skills/session-skill-runtime';
import { isRuntimeFeedbackContent } from './runtime-feedback';
import { PlanRuntime } from './plan-runtime';
import {
  TRANSIENT_SUBAGENT_STATUS_PREFIX,
  buildSubAgentStatusMessage,
} from './sub-agent-observation';
import { GauzMemService } from '../gauzmem/service';

const TRANSIENT_PLAN_STATUS_PREFIX = '[transient_plan_status]';
const TRANSIENT_RUNNER_HINT_PREFIX = '[transient_runner_hint]';
const TRANSIENT_SOFT_CHECK_PREFIX = '[transient_soft_check]';
const TRANSIENT_GAUZMEM_RECALL_PREFIX = '[transient_gauzmem_recall]';
const GAUZMEM_PASSIVE_TIMEOUT_MS = Number(process.env.GAUZMEM_PASSIVE_TIMEOUT_MS || 20000);

export interface BuildTurnContextParams {
  sessionKey: string;
  sessionType?: string;
  durableMessages: Message[];
  runtimeFeedback: string[];
  skillRuntime: SessionSkillRuntime;
  planRuntime?: PlanRuntime;
}

export interface BuildTurnContextResult {
  messages: Message[];
  runtimeFeedbackForLog: string[];
}

/**
 * Builds the initial context for a single turn.
 *
 * This is provider input preparation, not durable transcript mutation.
 */
export class TurnContextBuilder {
  async build(params: BuildTurnContextParams): Promise<BuildTurnContextResult> {
    const contextMessages = [...params.durableMessages];
    this.injectRuntimeFeedback(contextMessages, params.runtimeFeedback);
    this.injectPlanStatus(contextMessages, params.planRuntime);
    this.injectSubAgentStatus(contextMessages, params.sessionKey);
    await this.injectGauzMemRecall(contextMessages, params.sessionKey, params.sessionType);

    await params.skillRuntime.reloadSkills();
    const skillsListMsg = params.skillRuntime.buildSkillsListMessage();
    if (skillsListMsg) {
      this.insertBeforeLastUser(contextMessages, skillsListMsg);
    }

    return {
      messages: contextMessages,
      runtimeFeedbackForLog: this.extractRuntimeFeedback(contextMessages),
    };
  }

  removeTransientMessages(messages: Message[]): Message[] {
    return messages.filter(msg => {
      if (msg.__runtimeFeedback) return false;
      if (msg.role !== 'system' || typeof msg.content !== 'string') return true;
      if (msg.content.startsWith(TRANSIENT_SUBAGENT_STATUS_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_PLAN_STATUS_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_RUNNER_HINT_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_SOFT_CHECK_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_GAUZMEM_RECALL_PREFIX)) return false;
      if (msg.content.startsWith(TRANSIENT_SKILLS_LIST_PREFIX)) return false;
      return true;
    });
  }

  private injectRuntimeFeedback(messages: Message[], runtimeFeedback: string[]): void {
    if (runtimeFeedback.length === 0) return;

    const runtimeFeedbackMessages: Message[] = runtimeFeedback.map(content => ({
      role: 'user',
      content,
      __injected: true,
      __runtimeFeedback: true,
    }));
    this.insertBeforeLastUser(messages, ...runtimeFeedbackMessages);
  }

  private injectPlanStatus(messages: Message[], planRuntime?: PlanRuntime): void {
    const planText = planRuntime?.formatForPrompt();
    if (!planText) return;
    this.insertBeforeLastUser(messages, {
      role: 'system',
      content: `${TRANSIENT_PLAN_STATUS_PREFIX}\n${planText}`,
    });
  }

  private injectSubAgentStatus(messages: Message[], sessionKey: string): void {
    const statusMessage = buildSubAgentStatusMessage(sessionKey);
    if (!statusMessage) return;
    this.insertBeforeLastUser(messages, statusMessage);
  }

  private async injectGauzMemRecall(messages: Message[], sessionKey: string, sessionType?: string): Promise<void> {
    const lastUser = [...messages].reverse().find(message =>
      message.role === 'user' && !message.__injected && typeof message.content === 'string'
    );
    const query = typeof lastUser?.content === 'string' ? lastUser.content.trim() : '';
    if (!query) return;

    const result = await withTimeout(GauzMemService.getInstance().recall({
      callType: 'passive',
      query,
      sessionKey,
      sessionType,
      durableMessages: messages,
    }), GAUZMEM_PASSIVE_TIMEOUT_MS);
    if (!result?.message) return;
    this.insertBeforeLastUser(messages, {
      role: 'user',
      content: result.message,
      __injected: true,
    });
  }

  private extractRuntimeFeedback(messages: Message[]): string[] {
    return messages
      .filter(message => message.__runtimeFeedback && isRuntimeFeedbackContent(message.content))
      .map(message => message.content as string);
  }

  private insertBeforeLastUser(messages: Message[], ...inserted: Message[]): void {
    const lastUserIdx = findLastIndex(messages, message => message.role === 'user');
    if (lastUserIdx < 0) {
      messages.push(...inserted);
      return;
    }
    messages.splice(lastUserIdx, 0, ...inserted);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let idx = items.length - 1; idx >= 0; idx--) {
    if (predicate(items[idx])) return idx;
  }
  return -1;
}
