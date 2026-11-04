import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('RDP extension tools are exposed over MCP and fail closed without profile config', async () => {
 const transport = new StdioClientTransport({ command: process.execPath, args: ['server.mjs'], env: { ...process.env, ZEN_RDP_PORT: '', ZEN_RDP_PROFILE: '', ZEN_NATIVE_PORT: '', ZEN_NATIVE_PROFILE: '' }, stderr: 'pipe' });
 transport.stderr?.on('data', () => {});
 const client = new Client({ name: 'rdp-contract-test', version: '1.0.0' });
 try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert(tools.some(tool => tool.name === 'zen_extension_install'));
  assert(tools.some(tool => tool.name === 'zen_extension_status'));
  assert(tools.some(tool => tool.name === 'zen_extension_verify'));
  const result = await client.callTool({ name: 'zen_extension_status', arguments: { id: 'browserflow@example.test' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ZEN_RDP_PORT and ZEN_RDP_PROFILE/);
 } finally { await client.close(); }
});
