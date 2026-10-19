import { fileURLToPath } from 'node:url';
import { createActor, createMachine } from 'xstate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpBridge } from '../src/index.js';

const orderMachine = createMachine({
  id: 'order',
  initial: 'pending',
  context: { orderId: 'order-123' },
  states: {
    pending: { on: { PAY: 'paid' } },
    paid: { on: { SHIP: 'shipped' } },
    shipped: {},
  },
});

async function startServer() {
  const actor = createActor(orderMachine).start();
  const bridge = createMcpBridge({
    name: 'order-workflow',
    actor,
    maxHistory: 5,
    permissions: { readState: true, sendEvent: true, reset: true },
  });
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await bridge.close();
    await transport.close();
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  await bridge.connect(transport);
}

async function runClient() {
  const client = new Client({ name: 'order-demo-client', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx/esm', fileURLToPath(import.meta.url), '--server'],
  });

  try {
    await client.connect(transport);

    const initialState = await client.callTool({ name: 'get_state', arguments: {} });
    console.log('get_state (initial):', initialState.structuredContent);

    const paidState = await client.callTool({
      name: 'send_event',
      arguments: { type: 'PAY' },
    });
    console.log('send_event (PAY):', paidState.structuredContent);

    const shippedState = await client.callTool({
      name: 'send_event',
      arguments: { type: 'SHIP' },
    });
    console.log('send_event (SHIP):', shippedState.structuredContent);

    try {
      const invalidState = await client.callTool({
        name: 'send_event',
        arguments: { type: 'PAY' },
      });
      if (invalidState.isError) {
        throw new Error(JSON.stringify(invalidState.content));
      }
      console.log('send_event (PAY again):', invalidState.structuredContent);
    } catch (error) {
      console.log('send_event (PAY again) error:', error instanceof Error ? error.message : error);
    }

    const history = await client.callTool({ name: 'get_history', arguments: {} });
    console.log('get_history:', history.structuredContent);
  } finally {
    await client.close();
    await transport.close();
  }
}

if (process.argv.includes('--server')) {
  await startServer();
} else {
  await runClient();
}
