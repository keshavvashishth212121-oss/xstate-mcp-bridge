import { createActor, createMachine } from 'xstate';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpBridge } from '../src/index.js';

const orderMachine = createMachine({
  id: 'order',
  initial: 'pending',
  context: { orderId: 'order-123' },
  states: {
    pending: { on: { PAY: 'paid' } },
    paid: { on: { SHIP: 'shipped' } },
    shipped: { on: { DELIVER: 'delivered' } },
    delivered: {},
  },
});

const actor = createActor(orderMachine).start();
const bridge = createMcpBridge({
  name: 'order-workflow',
  actor,
  permissions: { readState: true, sendEvent: true, reset: true },
});

await bridge.connect(new StdioServerTransport());
