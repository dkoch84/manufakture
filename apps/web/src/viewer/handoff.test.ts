import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HANDOFF_PARAM,
  acceptViewSource,
  handoffToken,
  offerSource,
  receiveSource,
  resetHandoffForTests,
  type ChannelFactory,
  type ChannelLike,
} from './handoff';

const TOKEN = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** An in-memory BroadcastChannel: a message reaches every other channel of the same name. */
function bus(): ChannelFactory & { open: () => number } {
  const channels = new Set<ChannelLike & { name: string }>();
  const factory = ((name: string) => {
    const ch: ChannelLike & { name: string } = {
      name,
      onmessage: null,
      postMessage(message) {
        for (const other of channels) {
          if (other !== ch && other.name === name) {
            const data = structuredClone(message);
            queueMicrotask(() => other.onmessage?.({ data }));
          }
        }
      },
      close() {
        channels.delete(ch);
      },
    };
    channels.add(ch);
    return ch;
  }) as unknown as ChannelFactory & { open: () => number };
  factory.open = () => channels.size;
  return factory;
}

describe('handoffToken', () => {
  it('reads a well-formed token and nothing else', () => {
    expect(handoffToken(`#${HANDOFF_PARAM}=${TOKEN}`)).toBe(TOKEN);
    expect(handoffToken(`#${HANDOFF_PARAM}=${TOKEN}x`)).toBeNull();
    expect(handoffToken(`#${HANDOFF_PARAM}=../../etc`)).toBeNull();
    expect(handoffToken('#src=https://example.com/a')).toBeNull();
    expect(handoffToken('')).toBeNull();
  });
});

describe('offerSource and receiveSource', () => {
  it('opens the app with the token and hands the bytes over once', async () => {
    const channel = bus();
    const open = vi.fn();
    offerSource('Bracket', new Uint8Array([1, 2, 3]), {
      appUrl: 'https://app.example/base/',
      channel,
      open,
      token: TOKEN,
    });
    expect(open).toHaveBeenCalledWith(`https://app.example/base/#${HANDOFF_PARAM}=${TOKEN}`);
    const got = await receiveSource(TOKEN, { maxBytes: 100, channel });
    expect(got.name).toBe('Bracket');
    expect([...got.bytes]).toEqual([1, 2, 3]);
    // The offer is over: a second request gets no answer.
    expect(channel.open()).toBe(0);
    await expect(receiveSource(TOKEN, { maxBytes: 100, channel, receiveMs: 20 })).rejects.toThrow(
      /did not answer/,
    );
  });

  it('ignores requests for another token', async () => {
    const channel = bus();
    offerSource('A', new Uint8Array([1]), {
      appUrl: 'https://app.example/',
      channel,
      open: () => {},
      token: TOKEN,
    });
    await expect(
      receiveSource('11111111-2222-4333-8444-555555555555', {
        maxBytes: 100,
        channel,
        receiveMs: 20,
      }),
    ).rejects.toThrow(/did not answer/);
  });

  it('refuses an answer over the size limit', async () => {
    const channel = bus();
    offerSource('A', new Uint8Array(10), {
      appUrl: 'https://app.example/',
      channel,
      open: () => {},
      token: TOKEN,
    });
    await expect(receiveSource(TOKEN, { maxBytes: 5, channel })).rejects.toThrow(/larger/);
  });

  it('stops offering after its time', async () => {
    vi.useFakeTimers();
    try {
      const channel = bus();
      offerSource('A', new Uint8Array(1), {
        appUrl: 'https://app.example/',
        channel,
        open: () => {},
        token: TOKEN,
        offerMs: 1000,
      });
      expect(channel.open()).toBe(1);
      vi.advanceTimersByTime(1000);
      expect(channel.open()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('acceptViewSource', () => {
  beforeEach(() => resetHandoffForTests());
  afterEach(() => resetHandoffForTests());

  function fakeLocation(hash: string) {
    const href = `https://app.example/?doc=d1#${hash}`;
    return {
      location: { hash: `#${hash}`, href } as Location,
      history: { state: null, replaceState: vi.fn() } as unknown as History,
    };
  }

  it('clears the token from the address, imports the bytes and reports', async () => {
    const channel = bus();
    offerSource('My <b>model</b>\u202e', new Uint8Array([9]), {
      appUrl: 'https://app.example/',
      channel,
      open: () => {},
      token: TOKEN,
    });
    const { location, history } = fakeLocation(`${HANDOFF_PARAM}=${TOKEN}`);
    const importFile = vi.fn(async () => ({ ok: true, message: 'Imported.' }));
    const report = vi.fn();
    acceptViewSource(importFile, report, { maxBytes: 100, channel, location, history });
    expect(history.replaceState).toHaveBeenCalledWith(null, '', 'https://app.example/?doc=d1');
    await vi.waitFor(() => expect(report).toHaveBeenCalled());
    const file = (importFile.mock.calls[0] as unknown as [{ name: string; bytes: Uint8Array }])[0];
    expect(file.name).toBe('My bmodelb.mfk');
    expect([...file.bytes]).toEqual([9]);
    expect(report).toHaveBeenCalledWith({ error: false, text: 'Imported.' });
    // Once per page load, whatever React does with effects.
    acceptViewSource(importFile, report, { maxBytes: 100, channel, location, history });
    expect(importFile).toHaveBeenCalledTimes(1);
  });

  it('reports when the viewer does not answer', async () => {
    const { location, history } = fakeLocation(`${HANDOFF_PARAM}=${TOKEN}`);
    const report = vi.fn();
    acceptViewSource(vi.fn(), report, {
      maxBytes: 100,
      channel: bus(),
      location,
      history,
      receiveMs: 10,
    });
    await vi.waitFor(() =>
      expect(report).toHaveBeenCalledWith({
        error: true,
        text: expect.stringMatching(/did not answer/),
      }),
    );
  });

  it('does nothing without a token', () => {
    const { location, history } = fakeLocation('src=https://example.com/a');
    const importFile = vi.fn();
    acceptViewSource(importFile, vi.fn(), { maxBytes: 100, channel: bus(), location, history });
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(importFile).not.toHaveBeenCalled();
  });
});
