import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { readWebPage } from '../utils/web-content';

export class ReadPageTool implements Tool {
  definition: ToolDefinition = {
    name: 'read_page',
    description: [
      'Open and extract content from a specific public http(s) page URL.',
      'Use this after web_search or when the user provides a concrete URL.',
      'The tool may retry through this computer\'s supported system proxy.',
      'Use find to locate a keyword or phrase in the extracted text.',
      'If the page requires login, clicking, forms, pagination, or dynamic rendering, use agent-browser instead.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The absolute web page URL to read.',
        },
        find: {
          type: 'string',
          description: 'Optional keyword or phrase to find within the extracted page text.',
        },
        max_chars: {
          type: 'number',
          description: 'Maximum number of characters to return from page text. Defaults to 4000. Upper bound 12000.',
          default: 4000,
        },
      },
      required: ['url'],
    },
  };

  async execute(args: any, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const url = typeof args?.url === 'string' ? args.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) {
      return {
        ok: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
        message: 'url is required and must be an absolute http(s) URL',
      };
    }

    const find = typeof args?.find === 'string' ? args.find.trim() : undefined;
    const maxChars = Number.isFinite(Number(args?.max_chars)) ? Number(args.max_chars) : 4000;

    try {
      const result = await readWebPage({
        url,
        find,
        maxChars,
      });
      return {
        ok: true,
        content: JSON.stringify(result),
      };
    } catch (error: any) {
      return {
        ok: false,
        errorCode: 'TOOL_EXECUTION_ERROR',
        message: `read_page failed: ${String(error?.message || error || 'Unknown error')}`,
        retryable: true,
      };
    }
  }
}
