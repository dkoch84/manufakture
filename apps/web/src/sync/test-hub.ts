// Test only: a reference server (packages/sync) behind fake connections, delivering messages when
// the test says so, so a test decides what arrives when and what is lost.

import type { ManufaktureDocument } from '@manufakture/core';
import { ReferenceServer, type ClientMessage, type ServerMessage } from '@manufakture/sync';
import type { Connect, Transport, TransportHandlers } from './transport';

export interface FakeConnection {
  readonly handlers: TransportHandlers;
  /** Messages the client sent, not yet delivered to the server. */
  readonly outbox: ClientMessage[];
  /** Everything the client sent, delivered or not. */
  readonly sent: ClientMessage[];
  /** Server messages for this connection, not yet delivered. */
  readonly inbox: ServerMessage[];
  opened: boolean;
  closed: boolean;
}

export class Hub {
  readonly server: ReferenceServer;
  readonly connections: FakeConnection[] = [];

  constructor(document: ManufaktureDocument) {
    this.server = new ReferenceServer(document);
  }

  /** A `Connect` whose connections the test opens with `open`. */
  connect: Connect = (handlers) => {
    const c: FakeConnection = {
      handlers,
      outbox: [],
      sent: [],
      inbox: [],
      opened: false,
      closed: false,
    };
    this.connections.push(c);
    const transport: Transport = {
      get open() {
        return c.opened && !c.closed;
      },
      send(message) {
        if (!c.opened || c.closed) return false;
        c.outbox.push(message);
        c.sent.push(message);
        return true;
      },
      close() {
        if (c.closed) return;
        c.closed = true;
        handlers.onClose(1000, 'done');
      },
    };
    return transport;
  };

  /** The newest connection. */
  get last(): FakeConnection {
    const c = this.connections.at(-1);
    if (!c) throw new Error('no connection');
    return c;
  }

  open(c: FakeConnection = this.last): void {
    c.opened = true;
    c.handlers.onOpen();
  }

  /** The server goes away: the connection closes. */
  drop(c: FakeConnection = this.last): void {
    if (c.closed) return;
    c.closed = true;
    c.handlers.onClose(1006, 'gone');
  }

  /** The server handles what `c` sent; replies go to `c`'s inbox, pushes to every open one. */
  process(c: FakeConnection = this.last): void {
    for (const m of c.outbox.splice(0)) {
      const handled = this.server.handle(m);
      c.inbox.push(...handled.replies);
      if (handled.push) {
        for (const other of this.connections) {
          if (other.opened && !other.closed) other.inbox.push(handled.push);
        }
      }
    }
  }

  /** Delivers `c`'s inbox to its client. */
  deliver(c: FakeConnection = this.last): void {
    for (const m of c.inbox.splice(0)) if (!c.closed) c.handlers.onMessage(m);
  }

  /** Processes and delivers until nothing moves (for every open connection). */
  async settle(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      await flushPromises();
      let moved = false;
      for (const c of this.connections) {
        if (c.closed || !c.opened) continue;
        if (c.outbox.length > 0 || c.inbox.length > 0) moved = true;
        this.process(c);
        this.deliver(c);
      }
      await flushPromises();
      if (!moved && this.connections.every((c) => c.outbox.length === 0)) return;
    }
  }
}

/** Lets the loop's promise chain (persist, then send) run. */
export async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
