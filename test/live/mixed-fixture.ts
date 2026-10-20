// Local-only stdio MCP canary and observational hooks for native-mixed-agents.ts.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [mode, log, nonce] = process.argv.slice(2);
if (!log) {
  throw new Error('Expected fixture mode and log path');
}
if (mode === 'hook') {
  appendFileSync(log, `${readFileSync(0, 'utf8').trim()}\n`);
  console.log('{}');
} else if (mode === 'mcp' && nonce) {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const request = JSON.parse(line);
    if (request.id === undefined) {
      continue;
    }
    const result = response(request.method, request.params);
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  }
} else {
  throw new Error('Unknown mixed fixture mode');
}

function response(method: string, params: { name?: string; arguments?: { stage?: string } }) {
  if (method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mixed-fixture', version: '1.0.0' },
    };
  }
  if (method === 'tools/list') {
    return {
      tools: [
        {
          name: 'context_probe',
          description: 'Return a synthetic context canary for the mixed-agent integration test.',
          inputSchema: {
            type: 'object',
            properties: { stage: { type: 'string', enum: ['claude-to-gpt', 'gpt-to-claude'] } },
            required: ['stage'],
            additionalProperties: false,
          },
        },
      ],
    };
  }
  if (method === 'tools/call' && params.name === 'context_probe') {
    const stage = params.arguments?.stage;
    if (stage !== 'claude-to-gpt' && stage !== 'gpt-to-claude') {
      throw new Error('Invalid canary stage');
    }
    const marker = `${nonce}-${stage}`;
    appendFileSync(log, `${JSON.stringify({ stage, marker })}\n`);
    return { content: [{ type: 'text', text: `MCP canary: ${marker}` }] };
  }
  return {};
}
