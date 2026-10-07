// Codex can spawn this bridge without putting secrets into config.toml or
// process arguments. The HTTP server still enforces the connection's scopes.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connectNexus } from './mcp-connection.js';
try {
  const remote = await connectNexus();
  const server = new Server({ name: 'nexus-project', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => remote.listTools());
  server.setRequestHandler(CallToolRequestSchema, ({ params }) => remote.callTool(params));
  const close = async () => { await Promise.allSettled([server.close(), remote.close()]); process.exit(0); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, close);
  process.stdin.on('end', close);
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(`Nexus MCP could not connect: ${String(error.message).replace(/nx_mcp_[A-Za-z0-9_-]+/g, '[redacted]')}`);
  process.exitCode = 1;
}
