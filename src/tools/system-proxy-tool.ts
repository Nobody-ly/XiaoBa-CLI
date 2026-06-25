import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '../types/tool';
import { resolveSystemProxy } from '../utils/system-proxy';

export class ResolveSystemProxyTool implements Tool {
  definition: ToolDefinition = {
    name: 'resolve_system_proxy',
    description: [
      'Read this computer\'s current OS proxy configuration for network troubleshooting.',
      'Use this only when web_search or read_page reports network/proxy access problems.',
      'This tool is local-only, read-only, and does not test connectivity or change settings.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {},
    },
  };

  async execute(_args: any, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    return resolveSystemProxyToolArgs();
  }
}

export function resolveSystemProxyToolArgs(): ToolExecutionResult {
  return {
    ok: true,
    content: JSON.stringify(resolveSystemProxy()),
  };
}
