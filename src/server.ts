import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './tools/registry.js';
import { registerAllPrompts } from './prompts/registry.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'illustrator-mcp-server',
    version: '1.8.0-local.2',
  });

  registerAllTools(server);
  registerAllPrompts(server);

  return server;
}
