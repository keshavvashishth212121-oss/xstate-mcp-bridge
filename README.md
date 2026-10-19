# xstate-mcp-bridge

[![CI](https://github.com/keshavvashishth212121-oss/xstate-mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/keshavvashishth212121-oss/xstate-mcp-bridge/actions/workflows/ci.yml)

Expose a running XState actor through controlled Model Context Protocol tools.

## Verify in 60 Seconds

```bash
git clone https://github.com/keshavvashishth212121-oss/xstate-mcp-bridge.git
cd xstate-mcp-bridge
npm install
npm test
npx tsx examples/demo.ts
```

The demo starts an MCP server over stdio, connects an MCP client, walks an
order through `pending`, `paid`, and `shipped`, rejects an invalid transition,
and prints the transition history.

## Why this exists

AI clients increasingly need to observe and advance business workflows, but
they should not bypass the transition rules, guards, or context owned by the
application. This bridge exposes a narrow MCP interface around a running
XState actor so clients can request state, submit events, and wait for
transitions while the state machine remains the source of truth.

## Architecture

```text
MCP Client  ->  xstate-mcp-bridge  ->  XState Actor
                  (permissions,          (state, guards,
                   validation,             transitions, context)
                   history)
```

The bridge is transport-agnostic. Connect the returned MCP server to stdio,
HTTP, or another supported MCP transport.

## Tools

| Tool | Input | Description |
| --- | --- | --- |
| `get_state` | None | Returns the actor's current state value and context, optionally redacted. |
| `send_event` | `{ type: string, ... }` | Validates the event with `can()`, sends it, and returns the resulting state. |
| `get_history` | None | Returns recent observed transitions and truncation metadata. |
| `wait_for_state` | `{ state: string, timeout?: number }` | Waits for a matching state and cleans up its subscription on completion or timeout. |
| `get_capabilities` | None | Returns the bridge name, current state, available event types, and permissions. |

## Safety model

- **Permissions:** `readState`, `sendEvent`, and `reset` can be restricted
  independently. Permissions default to enabled unless explicitly set to
  `false`.
- **Transition validation:** `send_event` checks the actor snapshot's XState
  `can()` method before sending, so invalid events are rejected explicitly.
- **Context redaction:** Provide `redactContext` to remove secrets such as API
  keys before context is returned by `get_state`.
- **Bounded history:** Transition history is limited by `maxHistory`, which
  defaults to `1000`. When entries are dropped, `get_history` reports
  `truncated` and `droppedCount`.

## Limitations

- There is no built-in authentication or authorization beyond bridge
  permissions.
- The bridge does not provide process isolation; it runs in the host
  application's process.
- Transition history is in-memory and is lost when the process exits.

### Deployment responsibility

Bridge permissions are application-level capability controls, not client authentication. This library does not authenticate MCP callers, authorize users, isolate the actor process, or make context and tool output trustworthy. Applications exposing the bridge over a network must provide transport-level authentication, authorization, network restrictions, and any required approval workflow or process isolation.

## Use cases

- **Approvals:** An AI assistant can request or observe approvals, but cannot skip `pending -> approved` guards.
- **Deployments:** An operator can expose build, test, approval, and deploy states without allowing an MCP client to jump directly to `deployed`.
- **Incident runbooks:** An agent can advance a remediation workflow while the application retains authority over valid transitions.

## Non-goals

- This is not an MCP authentication server.
- This is not a durable event store.
- This is not a replacement for XState.
- This does not provide process isolation.

## API reference

```ts
interface CreateMcpBridgeOptions {
  name: string;
  actor: AnyActorRef;
  permissions?: {
    readState?: boolean;
    sendEvent?: boolean;
    reset?: boolean;
  };
  maxHistory?: number;
  redactContext?: (context: any) => any;
}

function createMcpBridge(options: CreateMcpBridgeOptions): McpBridge;
```

The returned `McpBridge` is an `McpServer` with an additional
`reset(): void` method. The actor must be started by the application before
creating the bridge.

## Development

```bash
npm install
npm test
npm run build
npm run example
npx tsx examples/demo.ts
```

## Relationship to DevCompanion AI

This library was extracted from the state-machine integration work in
DevCompanion AI. It is now a standalone, open-source bridge with no runtime
dependency on DevCompanion AI, its application, prompts, storage, or user
interface. It can be used independently in any TypeScript project that
already owns an XState actor.

DevCompanion AI was the first real consumer of this bridge, not a runtime dependency. The reusable boundary is the running XState actor: applications own their machines, guards, context, and business rules; this library adds a controlled MCP interface without importing application-specific prompts, storage, sandbox logic, or UI.

## Package status

The repository is the source release for the current hackathon submission. An
npm package release is planned after the API stabilizes.

## Security Warning

> **Note:** Mutating permissions (`sendEvent`, `reset`) default to enabled for ease of use in local development. For externally reachable MCP servers, explicitly configure permissions to deny mutations unless required, rather than relying on defaults.

## Roadmap

- Add optional persistence adapters for transition history.
- Support richer matching for deeply nested state values.
- Add examples for HTTP and WebSocket MCP transports.
