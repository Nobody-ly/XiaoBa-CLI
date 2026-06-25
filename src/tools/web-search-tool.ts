import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { searchWeb, SearchFreshness } from '../utils/web-content';

const FRESHNESS_ENUM: SearchFreshness[] = ['any', 'day', 'week', 'month', 'year'];

export class WebSearchTool implements Tool {
  definition: ToolDefinition = {
    name: 'web_search',
    description: [
      'Search the public web for up-to-date information and candidate sources.',
      'Use this when the user asks to search, verify, check latest/current information, or gather external sources.',
      'The tool automatically tries configured search providers and may retry through this computer\'s supported system proxy.',
      'Use allowed_domains only when the task requires source boundaries, such as official docs, GitHub, papers, or a known website.',
      'Use freshness only for latest/recent/today/current-version queries; it is a best-effort recency filter.',
      'If results are empty, retry with a broader query or without allowed_domains.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to look up on the public web.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return. Defaults to 5. Range 1-10.',
          default: 5,
        },
        freshness: {
          type: 'string',
          description: 'Optional best-effort recency filter. Use only for latest, recent, today, or current-version queries.',
          enum: FRESHNESS_ENUM,
          default: 'any',
        },
        allowed_domains: {
          type: 'array',
          description: 'Optional domains to restrict results to, such as official docs or GitHub.',
          items: {
            type: 'string',
          },
        },
      },
      required: ['query'],
    },
  };

  async execute(args: any, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: 'query is required',
      };
    }

    const limit = Number.isFinite(Number(args?.limit)) ? Number(args.limit) : 5;
    const freshness = typeof args?.freshness === 'string' && FRESHNESS_ENUM.includes(args.freshness)
      ? args.freshness as SearchFreshness
      : 'any';
    const allowedDomainsInput = Array.isArray(args?.allowed_domains)
      ? args.allowed_domains
      : args?.domain_allowlist;
    const allowedDomains = Array.isArray(allowedDomainsInput)
      ? allowedDomainsInput.map((item: unknown) => String(item || ''))
      : undefined;

    try {
      const result = await searchWeb({
        query,
        limit,
        freshness,
        allowedDomains,
      });
      return {
        ok: true,
        content: JSON.stringify(result),
      };
    } catch (error: any) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `web_search failed: ${String(error?.message || error || 'Unknown error')}`,
        retryable: true,
      };
    }
  }
}
