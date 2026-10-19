import { createActor, createMachine } from 'xstate';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpBridge, type CreateMcpBridgeOptions } from '../src/index.js';

type BridgeTestOptions = Pick<CreateMcpBridgeOptions, 'permissions' | 'maxHistory' | 'redactContext'>;

function setup(options: BridgeTestOptions = {}) {
  const machine = createMachine({
    id: 'test',
    initial: 'pending',
    context: { count: 0, secret: 'sensitive-value' },
    states: {
      pending: { on: { PAY: 'paid' } },
      paid: { on: { SHIP: 'shipped' } },
      shipped: {},
    },
  });
  const actor = createActor(machine).start();
  const server = createMcpBridge({ name: 'test', actor, ...options });
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
  it('get_state returns the correct initial state and context', async () => {
    const client = await connect(setup().server);
    const response = await client.callTool({ name: 'get_state', arguments: {} });
    expect(response.structuredContent).toEqual({
      state: 'pending',
      context: { count: 0, secret: 'sensitive-value' },
    });
  });

  it('send_event transitions the state from pending to paid', async () => {
    const { server, actor } = setup();
    const client = await connect(server);
    const response = await client.callTool({ name: 'send_event', arguments: { type: 'PAY' } });

    expect(response.structuredContent).toMatchObject({ state: 'paid' });
    expect(actor.getSnapshot().value).toBe('paid');
  });

  it('send_event rejects an event that is invalid in the current state', async () => {
    const client = await connect(setup().server);
    const response = await client.callTool({ name: 'send_event', arguments: { type: 'SHIP' } });

    expect(response.isError).toBe(true);
    expect(response.content).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("Event 'SHIP' is not valid in state 'pending'"),
      }),
    );
  });

  it('get_history returns the past transitions in order', async () => {
    const client = await connect(setup().server);
    await client.callTool({ name: 'send_event', arguments: { type: 'PAY' } });
    await client.callTool({ name: 'send_event', arguments: { type: 'SHIP' } });
    const response = await client.callTool({ name: 'get_history', arguments: {} });

    expect(response.structuredContent).toMatchObject({
      history: [
        expect.objectContaining({ event: { type: 'PAY' }, from: 'pending', to: 'paid' }),
        expect.objectContaining({ event: { type: 'SHIP' }, from: 'paid', to: 'shipped' }),
      ],
    });
  });

  it('permissions prevent send_event mutations', async () => {
    const { server, actor } = setup({ permissions: { readState: true, sendEvent: false } });
    const client = await connect(server);
    const response = await client.callTool({ name: 'send_event', arguments: { type: 'PAY' } });

    expect(response.isError).toBe(true);
    expect(response.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining('Permission denied: sendEvent') }),
    );
    expect(actor.getSnapshot().value).toBe('pending');
  });

  it('get_state applies redactContext before returning context', async () => {
    const { server } = setup({
      redactContext: (context: { count: number; secret: string }) => ({ count: context.count }),
    });
    const client = await connect(server);
    const response = await client.callTool({ name: 'get_state', arguments: {} });

    expect(response.structuredContent).toEqual({
      state: 'pending',
      context: { count: 0 },
    });
  });

  it('get_capabilities returns the current state, available events, and permissions', async () => {
    const permissions = { readState: true, sendEvent: false, reset: true };
    const client = await connect(setup({ permissions }).server);
    const response = await client.callTool({ name: 'get_capabilities', arguments: {} });

    expect(response.structuredContent).toEqual({
      machine_name: 'test',
      current_state: 'pending',
      available_events: ['PAY'],
      permissions,
    });
  });

  it('get_history truncates exceeded history and reports dropped items', async () => {
    const client = await connect(setup({ maxHistory: 1 }).server);
    await client.callTool({ name: 'send_event', arguments: { type: 'PAY' } });
    await client.callTool({ name: 'send_event', arguments: { type: 'SHIP' } });
    const response = await client.callTool({ name: 'get_history', arguments: {} });

    expect(response.structuredContent).toMatchObject({
      history: [expect.objectContaining({ event: { type: 'SHIP' }, from: 'paid', to: 'shipped' })],
      truncated: true,
      droppedCount: 1,
    });
  });

  it('wait_for_state cleans up its subscription when timing out', async () => {
    const machine = createMachine({
      id: 'never-reaches-target',
      initial: 'pending',
      states: {
        pending: {},
      },
    });
    const actor = createActor(machine).start();
    const originalSubscribe = actor.subscribe.bind(actor);
    const unsubscribe = vi.fn();
    vi.spyOn(actor, 'subscribe').mockImplementation(((observer: Parameters<typeof actor.subscribe>[0]) => {
      const subscription = originalSubscribe(observer);
      return {
        unsubscribe: () => {
          unsubscribe();
          subscription.unsubscribe();
        },
      };
    }) as typeof actor.subscribe);
    const server = createMcpBridge({ name: 'timeout-test', actor });
    const client = await connect(server);

    const response = await client.callTool({
      name: 'wait_for_state',
      arguments: { state: 'complete', timeout: 10 },
    });

    expect(response.isError).toBe(true);
    expect(response.content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining('Timed out waiting for state: complete') }),
    );
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
