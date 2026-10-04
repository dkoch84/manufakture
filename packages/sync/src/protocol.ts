import {
  FORMAT_VERSION,
  PROTOCOL_VERSION,
  SyncEntrySchema,
  type SyncEntry,
} from '@manufakture/core';
import { z } from 'zod';

/**
 * The sync protocol's messages (ADR 0009 decisions 2 and 11): what a client sends (`hello`,
 * `submit`, `pull`) and what a server answers (`welcome`, `ack`, `refuse`, the retryable
 * `predecessor-unknown`, `push`, `error`). No transport: T7.1c carries them over HTTP and a
 * WebSocket. Every inbound message is parsed with these schemas before anything reads it.
 */

/** The most entries one `submit` or `push` carries. */
export const MAX_ENTRIES_PER_MESSAGE = 1000;

/**
 * How far past the revisions it has heard of a client trusts a revision from the server: pushed
 * entries beyond `confirmedRev + PUSH_WINDOW` are not buffered (a pull fetches them), and a
 * refusal's `headRev` or an ack's `rev` is clamped to the highest revision heard of plus this.
 */
export const PUSH_WINDOW = MAX_ENTRIES_PER_MESSAGE * 16;

const seq = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
const rev = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const version = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * Why the server refused an entry: a `CoreError` code (`id-reused`, `dependency`, ...), or one of
 * the server's own: `predecessor-refused` (the entry's `prevSeq` names a refused entry) and
 * `counter-regression` (the head would have a counter below its high-water mark). Codes are open
 * strings so a newer server's code still parses; the client drops on any code but `id-reused` and
 * `predecessor-refused`.
 */
export const RefusalSchema = z.strictObject({
  code: z.string().min(1).max(64),
  message: z.string().max(2000),
});
export type Refusal = z.infer<typeof RefusalSchema>;

export const HelloSchema = z.strictObject({
  type: z.literal('hello'),
  /** `PROTOCOL_VERSION` of the client. */
  protocol: version,
  /** `FORMAT_VERSION` of the client's core. */
  format: version,
  clientId: z.string().min(1).max(128),
});

export const SubmitSchema = z
  .strictObject({
    type: z.literal('submit'),
    /** One client's entries, judged in this order. */
    entries: z.array(SyncEntrySchema).min(1).max(MAX_ENTRIES_PER_MESSAGE),
    /**
     * The client's retention floor (ADR 0009 decision 2): the lowest `clientSeq` it may still
     * name, the minimum over its in-flight entries of their `clientSeq` and `prevSeq`. The server
     * may forget de-duplication rows below the highest floor a client sent, except the client's
     * latest accepted entry.
     */
    floor: seq,
  })
  .refine((m) => m.entries.every((e) => e.clientId === m.entries[0]!.clientId), {
    message: 'every entry of a submit must come from one client',
    path: ['entries'],
  });

export const PullSchema = z.strictObject({
  type: z.literal('pull'),
  /** Entries after this revision. */
  since: rev,
});

export const ClientMessageSchema = z.union([HelloSchema, SubmitSchema, PullSchema]);
export type HelloMessage = z.infer<typeof HelloSchema>;
export type SubmitMessage = z.infer<typeof SubmitSchema>;
export type PullMessage = z.infer<typeof PullSchema>;
export type ClientMessage = HelloMessage | SubmitMessage | PullMessage;

export const WelcomeSchema = z.strictObject({
  type: z.literal('welcome'),
  protocol: version,
  format: version,
  /** The server's head revision. */
  head: rev,
});

export const AckSchema = z.strictObject({
  type: z.literal('ack'),
  clientSeq: seq,
  /** The revision the entry was accepted at. */
  rev: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
});

export const RefuseSchema = z.strictObject({
  type: z.literal('refuse'),
  clientSeq: seq,
  error: RefusalSchema,
  /**
   * The server's head revision when it answered. For `id-reused` the client pulls up to it before
   * renaming the entry, so the rename sees every id taken so far.
   */
  headRev: rev,
});

/** Retryable, never recorded: the entry's `prevSeq` has no outcome yet. */
export const PredecessorUnknownSchema = z.strictObject({
  type: z.literal('predecessor-unknown'),
  clientSeq: seq,
});

export const PushedEntrySchema = z.strictObject({
  rev: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  entry: SyncEntrySchema,
});
export type PushedEntry = { readonly rev: number; readonly entry: SyncEntry };

/** Accepted entries in revision order, from the push stream or as the answer to a pull. */
export const PushSchema = z.strictObject({
  type: z.literal('push'),
  entries: z.array(PushedEntrySchema).max(MAX_ENTRIES_PER_MESSAGE),
});

export const PROTOCOL_ERRORS = [
  /** The other side speaks another `PROTOCOL_VERSION`. */
  'protocol-version',
  /** The other side's core has another `FORMAT_VERSION`. */
  'format-version',
  /** The message does not match its schema. */
  'invalid-message',
  /**
   * A `clientSeq` below the client's retention floor that the server no longer knows: a late copy
   * of an entry the client has already resolved (a duplicate, or a resend overtaken by its
   * verdict). Never judged again, so it cannot apply twice; the client ignores the answer.
   */
  'below-floor',
  /**
   * Raised by the client, never sent: the server's log disagrees with the client (a confirmed
   * entry does not apply, or the client's own entry came back changed). The client stops syncing.
   */
  'server-fault',
] as const;
export type ProtocolErrorCode = (typeof PROTOCOL_ERRORS)[number];

export const ProtocolErrorSchema = z.strictObject({
  type: z.literal('error'),
  code: z.enum(PROTOCOL_ERRORS),
  message: z.string().max(2000),
  /** For `below-floor`: the entry. */
  clientSeq: seq.exactOptional(),
});

export const ServerMessageSchema = z.discriminatedUnion('type', [
  WelcomeSchema,
  AckSchema,
  RefuseSchema,
  PredecessorUnknownSchema,
  PushSchema,
  ProtocolErrorSchema,
]);
export type WelcomeMessage = z.infer<typeof WelcomeSchema>;
export type AckMessage = z.infer<typeof AckSchema>;
export type RefuseMessage = z.infer<typeof RefuseSchema>;
export type PredecessorUnknownMessage = z.infer<typeof PredecessorUnknownSchema>;
export type PushMessage = { readonly type: 'push'; readonly entries: readonly PushedEntry[] };
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;
export type ServerMessage =
  | WelcomeMessage
  | AckMessage
  | RefuseMessage
  | PredecessorUnknownMessage
  | PushMessage
  | ProtocolError;

/** What one side runs: `PROTOCOL_VERSION` and `FORMAT_VERSION`. */
export interface Versions {
  readonly protocol: number;
  readonly format: number;
}

export const CURRENT_VERSIONS: Versions = { protocol: PROTOCOL_VERSION, format: FORMAT_VERSION };

/**
 * Whether a client and a server can sync (ADR 0009 decision 3): both versions must match. An older
 * client is told to update the app; a newer one that the server must be upgraded first.
 */
export function checkVersions(client: Versions, server: Versions): ProtocolError | undefined {
  const pairs = [
    ['protocol', 'protocol-version', client.protocol, server.protocol],
    ['format', 'format-version', client.format, server.format],
  ] as const;
  for (const [what, code, c, s] of pairs) {
    if (c === s) continue;
    const name = what === 'protocol' ? 'sync protocol' : 'document format';
    return {
      type: 'error',
      code,
      message:
        c > s
          ? `This app uses ${name} ${c}, newer than the server's ${s}: upgrade the server to sync.`
          : `This app uses ${name} ${c}, older than the server's ${s}: update the app to sync.`,
    };
  }
  return undefined;
}

/** A zod error as one line, for `invalid-message` answers. */
export function describeIssues(error: z.ZodError): string {
  const first = error.issues[0];
  if (first === undefined) return 'invalid message';
  return `${first.message} at ${first.path.map(String).join('.') || '(root)'}`;
}
