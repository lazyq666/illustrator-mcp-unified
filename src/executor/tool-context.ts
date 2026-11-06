import { AsyncLocalStorage } from 'node:async_hooks';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Which MCP tool started the current native execution; recorded in the lease for diagnosis. */
const context = new AsyncLocalStorage<{ tool: string }>();

export function currentTool(): string | undefined {
  return context.getStore()?.tool;
}

export function runInToolContext<T>(tool: string, action: () => T): T {
  return context.run({ tool }, action);
}

const registered: string[] = [];

/** Names registered through trackToolNames, so a client can compare with the tool list it cached. */
export function registeredToolNames(): readonly string[] {
  return registered;
}

/** Wrap registerTool so every handler runs with its tool name in context. */
export function trackToolNames(server: McpServer): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as { registerTool: unknown }).registerTool = (name: string, config: unknown, handler: (...args: unknown[]) => unknown) => {
    if (!registered.includes(name)) registered.push(name);
    return register(name, config, (...args: unknown[]) => runInToolContext(name, () => handler(...args)));
  };
}
