import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadEnvFile } from '../../../scripts/lib/services.js';

export async function connectNexus() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const env = { ...loadEnvFile(path.join(root, '.env.local')), ...process.env };
  if (!env.NEXUS_MCP_URL || !env.NEXUS_MCP_TOKEN) throw new Error('Set NEXUS_MCP_URL and NEXUS_MCP_TOKEN in the project .env.local file.');
  const url = new URL(env.NEXUS_MCP_URL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Remote MCP connections require HTTPS.');
  if (url.username || url.password) throw new Error('Use the connection token, not URL credentials.');
  const client = new Client({ name: 'nexus-project-agent', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { redirect: 'error', headers: { authorization: `Bearer ${env.NEXUS_MCP_TOKEN}` } } }));
  return client;
}
