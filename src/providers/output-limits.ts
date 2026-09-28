import { ChatConfig } from '../types';
import { isCatsRelayApiBase } from '../utils/catsco-domains';

const DEFAULT_MAX_TOKENS = 8192;
// Relay-backed models used by Saturday support a larger single-response budget.
// Keep this as a request ceiling: the provider still stops earlier when the
// response is complete, and explicit per-bot maxTokens continues to win.
const DEFAULT_RELAY_MAX_TOKENS = 128 * 1024;

export function resolveMaxTokens(config: ChatConfig): number {
  let maxTokens: number;
  if (Number.isFinite(config.maxTokens) && Number(config.maxTokens) > 0) {
    maxTokens = Math.floor(Number(config.maxTokens));
  } else {
    const apiUrl = (config.apiUrl || '').toLowerCase();
    const model = (config.model || '').toLowerCase();
    maxTokens = isCatsRelayApiBase(apiUrl) || model.includes('minimax-m2.7') || model.includes('minimax-m3')
      ? DEFAULT_RELAY_MAX_TOKENS
      : DEFAULT_MAX_TOKENS;
  }

  const contextWindow = Number(config.contextWindowTokens);
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    const contextBound = Math.max(1, Math.floor(contextWindow * 0.25));
    return Math.min(maxTokens, contextBound);
  }

  return maxTokens;
}
