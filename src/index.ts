import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AnyActorRef, AnyEventObject } from 'xstate';
import { z } from 'zod';

export interface BridgePermissions {
  readState?: boolean;
  sendEvent?: boolean;
  reset?: boolean;
}

export interface CreateMcpBridgeOptions {
  name: string;
  actor: AnyActorRef;
  permissions?: BridgePermissions;
  maxHistory?: number;
  redactContext?: (context: any) => any;
}

export interface TransitionRecord {
  event: AnyEventObject;
  from: unknown;
  to: unknown;
  timestamp: string;
}

export type McpBridge = McpServer & {
  reset: () => void;
};

interface SnapshotLike {
  value: unknown;
  context: unknown;
  can?: (event: AnyEventObject) => boolean;
  matches?: (state: unknown) => boolean;
  _nodes?: Array<{
    transitions?: Map<string, unknown> | Record<string, unknown>;
  }>;
}

const eventSchema = z.object({ type: z.string() }).catchall(z.unknown());

function snapshotOf(actor: AnyActorRef): SnapshotLike {
  return actor.getSnapshot() as SnapshotLike;
}

function stateMatches(snapshot: SnapshotLike, state: string): boolean {
  return snapshot.value === state || snapshot.matches?.(state) === true;
}

function permissionDenied(permission: string): never {
  throw new Error(`Permission denied: ${permission}`);
}

function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function availableEvents(snapshot: SnapshotLike): string[] {
  const events = new Set<string>();
  for (const node of snapshot._nodes ?? []) {
    if (node.transitions instanceof Map) {
      for (const eventType of node.transitions.keys()) {
        events.add(eventType);
      }
    } else if (node.transitions) {
      for (const eventType of Object.keys(node.transitions)) {
        events.add(eventType);
      }
    }
  }
  return [...events];
}

export function createMcpBridge({
  name,
  actor,
  permissions = {},
  maxHistory = 1000,
  redactContext,
}: CreateMcpBridgeOptions): McpBridge {
  const canReadState = permissions.readState !== false;
  const canSendEvent = permissions.sendEvent !== false;
  const canReset = permissions.reset !== false;
  const history: TransitionRecord[] = [];
  const historyLimit = Math.max(0, maxHistory);
  let droppedCount = 0;
  let previousState: unknown = snapshotOf(actor).value;
  let pendingEvent: AnyEventObject | undefined;

  actor.subscribe((nextSnapshot) => {
    const next = nextSnapshot as SnapshotLike;
    if (next.value !== previousState) {
      history.push({
        event: pendingEvent ?? { type: 'unknown' },
        from: previousState,
        to: next.value,
        timestamp: new Date().toISOString(),
      });
      pendingEvent = undefined;
      previousState = next.value;
    }
  });

  const server = new McpServer({
    name,
    version: '1.0.0',
  });

  server.registerTool(
    'get_state',
    {
      description: 'Return the actor current state and context.',
    },
    async () => {
      if (!canReadState) permissionDenied('readState');
      const snapshot = snapshotOf(actor);
      const safeContext = redactContext ? redactContext(snapshot.context) : snapshot.context;
      return result({ state: snapshot.value, context: safeContext });
    },
  );

  server.registerTool(
    'get_capabilities',
    {
      description: "Return the machine's current state, available events, and bridge permissions.",
    },
    async () => {
      if (!canReadState) permissionDenied('readState');
      const snapshot = snapshotOf(actor);
      return result({
        machine_name: name,
        current_state: snapshot.value,
        available_events: availableEvents(snapshot),
        permissions,
      });
    },
  );

  server.registerTool(
    'send_event',
    {
      description: 'Validate and send an event to the actor.',
      inputSchema: { type: z.string() },
    },
    async (input) => {
      if (!canSendEvent) permissionDenied('sendEvent');
      const event = eventSchema.parse(input) as AnyEventObject;
      const snapshot = snapshotOf(actor);
      if (snapshot.can && !snapshot.can(event)) {
        throw new Error(`Event '${event.type}' is not valid in state '${snapshot.value}'`);
      }
      pendingEvent = event;
      actor.send(event);
      const next = snapshotOf(actor);
      return result({ state: next.value, context: next.context });
    },
  );

  server.registerTool(
    'get_history',
    {
      description: 'Return the transitions observed by the bridge.',
    },
    async () => {
      if (!canReadState) permissionDenied('readState');
      while (history.length > historyLimit) {
        history.shift();
        droppedCount += 1;
      }
      return result({
        history: [...history],
        truncated: droppedCount > 0,
        droppedCount,
      });
    },
  );

  server.registerTool(
    'wait_for_state',
    {
      description: 'Wait until the actor reaches a state or the timeout expires.',
      inputSchema: {
        state: z.string(),
        timeout: z.number().int().positive().optional(),
      },
    },
    async ({ state, timeout = 5000 }) => {
      if (!canReadState) permissionDenied('readState');
      const current = snapshotOf(actor);
      if (stateMatches(current, state)) {
        return result({ state: current.value, context: current.context });
      }

      const reached = await new Promise<SnapshotLike>((resolve, reject) => {
        let settled = false;
        let subscription: { unsubscribe: () => void } | undefined;
        const cleanup = () => {
          clearTimeout(timer);
          subscription?.unsubscribe();
        };
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error(`Timed out waiting for state: ${state}`));
          }
        }, timeout);
        subscription = actor.subscribe((nextSnapshot) => {
          const next = nextSnapshot as SnapshotLike;
          if (!settled && stateMatches(next, state)) {
            settled = true;
            cleanup();
            resolve(next);
          }
        });
        if (settled) subscription.unsubscribe();
      });
      return result({ state: reached.value, context: reached.context });
    },
  );

  const bridge = server as McpBridge;
  bridge.reset = () => {
    if (!canReset) permissionDenied('reset');
    history.length = 0;
    droppedCount = 0;
    previousState = snapshotOf(actor).value;
  };
  return bridge;
}
