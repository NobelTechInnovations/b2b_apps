// Codex can spawn this bridge without putting secrets into config.toml or
// process arguments. The HTTP server still enforces the connection's scopes.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connectNexus } from './mcp-connection.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * A local agent can name a file on this computer instead of pasting base64:
 * the bridge reads it and sends the bytes on. Only upload_file gains this.
 */
export function withLocalFiles(tools) {
  return tools.map((tool) => (tool.name !== 'upload_file' ? tool : {
    ...tool,
    description: `${tool.description} From this computer, pass file_path instead of content_base64.`,
    inputSchema: {
      ...tool.inputSchema,
      required: [],
      properties: { ...tool.inputSchema.properties, name: { ...tool.inputSchema.properties.name, description: 'File name; defaults to the file_path name.' }, file_path: { type: 'string', maxLength: 4096, description: 'Path of a local file to upload (up to 10 MB).' } },
    },
  }));
}

export async function readLocalFile(args) {
  const { file_path: filePath, ...rest } = args ?? {};
  if (!filePath) return rest;
  const resolved = path.resolve(filePath.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) throw new Error(`No file at ${filePath}.`);
  if (info.size > MAX_FILE_BYTES) throw new Error('Files must be 10 MB or smaller.');
  return { ...rest, name: rest.name ?? path.basename(resolved), content_base64: (await readFile(resolved)).toString('base64') };
}

try {
  const remote = await connectNexus();
  const server = new Server({ name: 'nexus-project', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const listed = await remote.listTools();
    return { ...listed, tools: withLocalFiles(listed.tools) };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name !== 'upload_file') return remote.callTool(params);
    try {
      return await remote.callTool({ ...params, arguments: await readLocalFile(params.arguments) });
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
  const close = async () => { await Promise.allSettled([server.close(), remote.close()]); process.exit(0); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, close);
  process.stdin.on('end', close);
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(`Nexus MCP could not connect: ${String(error.message).replace(/nx_mcp_[A-Za-z0-9_-]+/g, '[redacted]')}`);
  process.exitCode = 1;
}
