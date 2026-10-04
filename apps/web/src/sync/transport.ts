// The sync connection (ADR 0009 decision 11): one WebSocket per syncing document, carrying the
// protocol messages both ways and the server's pushes. The token and the client key travel as
// subprotocols (`bearer.<token>`, `client.<key>`), since a browser cannot set a WebSocket's
// headers. What arrives is handed on as parsed JSON and validated by `SyncClient.handle`; nothing
// here trusts it. Kept free of React.

import type { ClientMessage } from '@manufakture/sync';

/** The most bytes one message from the server may have before it is refused unread. */
export const MAX_INBOUND_BYTES = 16 * 1024 * 1024;

export interface TransportHandlers {
  onOpen(): void;
  /** One message, parsed from JSON (anything: the client validates it). */
  onMessage(message: unknown): void;
  /** The connection is gone (or never came up); `code` and `reason` as the socket gave them. */
  onClose(code: number, reason: string): void;
}

export interface Transport {
  /** Sends one message; false when the connection is not open (nothing is queued). */
  send(message: ClientMessage): boolean;
  readonly open: boolean;
  close(): void;
}

/** Opens a connection; its events go to `handlers`. */
export type Connect = (handlers: TransportHandlers) => Transport;

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((this: SocketLike, ev: Event) => unknown) | null;
  onmessage: ((this: SocketLike, ev: MessageEvent) => unknown) | null;
  onclose: ((this: SocketLike, ev: CloseEvent) => unknown) | null;
  onerror: ((this: SocketLike, ev: Event) => unknown) | null;
}

/** A `Connect` over a WebSocket to `url`, offering `protocols`. */
export function webSocketConnect(
  url: string,
  protocols: readonly string[],
  make: (url: string, protocols: string[]) => SocketLike = (u, p) =>
    new WebSocket(u, p) as unknown as SocketLike,
): Connect {
  return (handlers) => {
    let closed = false;
    const socket = make(url, [...protocols]);
    const finish = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      handlers.onClose(code, reason);
    };
    socket.onopen = () => handlers.onOpen();
    socket.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string' || ev.data.length > MAX_INBOUND_BYTES) {
        socket.close(1003, 'text messages only');
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(ev.data);
      } catch {
        return; // not JSON: ignored, as the client would refuse it anyway
      }
      handlers.onMessage(message);
    };
    socket.onclose = (ev: CloseEvent) => finish(ev.code, ev.reason);
    socket.onerror = () => undefined; // a close follows
    return {
      get open() {
        return !closed && socket.readyState === 1;
      },
      send(message) {
        if (closed || socket.readyState !== 1) return false;
        socket.send(JSON.stringify(message));
        return true;
      },
      close() {
        if (closed) return;
        socket.close(1000, 'done');
        finish(1000, 'done');
      },
    };
  };
}
