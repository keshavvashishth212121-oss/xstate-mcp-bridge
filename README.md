# xstate-mcp-bridge

[![CI](https://github.com/keshavvashishth212121-oss/xstate-mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/keshavvashishth212121-oss/xstate-mcp-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Expose [XState](https://stately.ai/docs/xstate) actors as tools for the
[Model Context Protocol](https://modelcontextprotocol.io/).

## Why?

State machines are a reliable way to model workflows, but an AI client needs a
well-defined interface for observing and advancing them. `xstate-mcp-bridge`
provides that interface without changing the machine or coupling it to a
particular MCP transport.

## Quick Start

```ts
import { createActor, createMachine } from 'xstate';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpBridge } from 'xstate-mcp-bridge';

const machine = createMachine({
  id: 'order',
  initial: 'pending',
  states: {
    pending: { on: { PAY: 'paid' } },
    paid: { on: { SHIP: 'shipped' } },
    shipped: {},
  },
});

const actor = createActor(machine).start();
const server = createMcpBridge({
  name: 'order-workflow',
  actor,
  permissions: { readState: true, sendEvent: true, reset: false },
});

await server.connect(new StdioServerTransport());
```

The actor must be started by the application. The returned MCP server can be
connected to any supported MCP transport. `server.reset()` clears the
bridge's in-memory transition history when the `reset` permission is enabled.

## Demo Output

```text
$ npx tsx examples/demo.ts

send_event (PAY): { state: 'paid', context: { orderId: 'order-123' } }
send_event (SHIP): { state: 'shipped', context: { orderId: 'order-123' } }
send_event (PAY again) error: Event 'PAY' is not valid in state 'shipped'
get_history: {
  history: [
    { event: 'PAY', from: 'pending', to: 'paid', timestamp: '...' },
    { event: 'SHIP', from: 'paid', to: 'shipped', timestamp: '...' }
  ]
}
```

## Tools Exposed

| Tool | Input | Description |
| --- | --- | --- |
| `get_state` | None | Returns the actor's current state value and context. |
| `send_event` | `{ type: string, ... }` | Validates an event against the current state, sends it, and returns the new state. |
| `get_history` | None | Returns transitions observed since bridge creation or the last reset. |
| `wait_for_state` | `{ state: string, timeout?: number }` | Waits for a matching state, failing when the timeout expires. |

## Security Model

Permissions default to enabled and can be restricted per bridge:

```ts
{
  readState: true,  // get_state, get_history, wait_for_state
  sendEvent: false, // send_event
  reset: false,     // server.reset()
}
```

Disabled operations fail explicitly. `send_event` also checks the actor
snapshot's `can()` method before sending, so events that are not valid in the
current state are rejected.

## Security & Limitations

History is currently in-memory and bounded by maxHistory (default 1000).

Context redaction can be enabled via the redactContext option to prevent
leaking secrets (e.g., API keys).

send_event strictly validates events against the XState can() method before
sending.

## Testing

Run npm test to execute the Vitest suite. The 6 tests cover valid transitions,
invalid event rejection, permission restrictions, and context redaction.

## Relationship to DevCompanion AI

This library was extracted from the state-machine integration work in
DevCompanion AI. It is now a standalone, open-source bridge with no dependency
on DevCompanion's application, prompts, storage, or user interface. It can be
used independently in any TypeScript project that already owns an XState actor.

## Roadmap

- Add optional persistence adapters for transition history.
- Support richer state matching for deeply nested state values.
- Provide adapters and examples for HTTP and WebSocket MCP transports.
