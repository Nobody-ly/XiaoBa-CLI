import { BaseTool, ToolDefinition, ToolExecutionContext } from '../types/tool';
import { GauzMemService } from '../gauzmem/service';

export class GauzMemSearchTool extends BaseTool {
  definition: ToolDefinition = {
    name: 'gauzmem_search',
    description: 'Search the GauzMem long-term graph memory when past conversation facts, decisions, or context may help.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The memory search query. Include concrete names, topics, or the unresolved reference.',
        },
      },
      required: ['query'],
    },
  };

  async executeImpl(args: { query?: string }, context: ToolExecutionContext): Promise<string> {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query is required');
    const result = await GauzMemService.getInstance().recall({
      callType: 'active',
      query,
      sessionKey: context.sessionId,
      durableMessages: context.conversationHistory as any,
    });
    if (!result) return 'GauzMem is disabled. Set GAUZMEM_ENABLED=true to enable memory search.';
    if (result.run.status === 'error') {
      return `GauzMem search failed.\nRun: ${result.run.runId}\nError: ${result.run.error}`;
    }
    return result.message || `GauzMem found no relevant memory.\nRun: ${result.run.runId}`;
  }
}
