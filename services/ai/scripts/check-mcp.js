import { connectNexus } from './mcp-connection.js';
try {
  const client = await connectNexus();
  try {
    const tools = await client.listTools();
    const result = await client.callTool({ name: 'list_apps', arguments: {} });
    if (result.isError) throw new Error(result.content?.[0]?.text ?? 'Workspace lookup failed');
    const workspace = JSON.parse(result.content[0].text);
    console.log(JSON.stringify({ connected: true, tools: tools.tools.map((tool) => tool.name), company_id: workspace.company_id, apps: workspace.apps, write_access: workspace.write_access }, null, 2));
  } finally { await client.close(); }
} catch (error) {
  console.error(`MCP check failed: ${String(error.message).replace(/nx_mcp_[A-Za-z0-9_-]+/g, '[redacted]')}`);
  process.exitCode = 1;
}
