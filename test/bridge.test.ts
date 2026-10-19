import { createActor, createMachine } from 'xstate';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpBridge } from '../src/index.js';

function setup(permissions?: Parameters<typeof createMcpBridge>[0]['permissions']) {
  const machine = createMachine({
    id: 'test',
    initial: 'pending',
    context: { count: 0 },
    states: {
      pending: { on: { PAY: 'paid' } },
      paid: { on: { SHIP: 'shipped' } },
      shipped: {},
    },
  });
  const actor = createActor(machine).start();
  const server = createMcpBridge({ name: 'test', actor, permissions });
  return { actor, server };
}

async function connect(server: ReturnType<typeof createMcpBridge>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('xstate-mcp-bridge', () => {
  it('get_state works', async () => {
    const client = await connect(setup().server);
    const response = await client.callTool({ name: 'get_state', arguments: {} });
    expect(response.structuredContent).toMatchObject({ state: 'pending', context: { count: 0 } });
  });

  it('send_event triggers a transition', async () => {
    const { server, actor } = setup();
    const client = await connect(server);
    await client.callTool({ name: 'send_event', arguments: { type: 'PAY' } });
    expect(actor.getSnapshot().value).toBe('paid');
  });

  it('invalid event throws an error', async () => {
    const client = await connect(setup().server);
    const response = await client.callTool({ name: 'send_event', arguments: { type: 'SHIP' } });
    expect(response.isError).toBe(true);
    expect(response.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining('Invalid event') }));
  });

  it('get_history tracks transitions', async () => {
    const client = await connect(setup().server);
    await client.callTool({ name: 'send_event', arguments: { type: 'PAY' } });
    const response = await client.callTool({ name: 'get_history', arguments: {} });
    expect(response.structuredContent).toMatchObject({
      history: [expect.objectContaining({ from: 'pending', to: 'paid' })],
    });
  });

  it('permissions prevent mutating actions', async () => {
    const { server, actor } = setup({ readState: true, sendEvent: false });
    const client = await connect(server);
    const response = await client.callTool({ name: 'send_event', arguments: { type: 'PAY' } });
    expect(response.isError).toBe(true);
    expect(actor.getSnapshot().value).toBe('pending');
  });
});
