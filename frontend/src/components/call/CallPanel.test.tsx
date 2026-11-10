import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from '@linka/shared';
import type { CallsContextValue, CallState } from '../../hooks/useCalls';
import { FakeMediaStream, FakeTrack } from '../../test/webrtc';
import { CallPanel, COMPACT_SCREEN_QUERY } from './CallPanel';

/**
 * Layout of the call panel across screen sizes. jsdom has no layout engine, so these tests check
 * the layout contract (which arrangement a screen gets, no cropping, height caps, wrapping, touch
 * sizes, safe areas); the pixel results are measured in a real browser at each viewport.
 */

const call = (type: 'voice' | 'video', status: Call['status'] = 'active'): Call => ({
  id: '11111111-1111-4111-8111-111111111111',
  conversationId: '22222222-2222-4222-8222-222222222222',
  initiatorId: null,
  type,
  status,
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  endedAt: null,
  createdAt: new Date(Date.now() - 65_000).toISOString(),
  participants: [],
});

const camera = () => new FakeMediaStream([new FakeTrack('video')]) as unknown as MediaStream;

function fakeCalls(overrides: Partial<CallsContextValue> & { state: CallState }): CallsContextValue {
  const noop = () => undefined;
  const asyncNoop = async () => undefined;
  return {
    busy: true,
    muted: false,
    peerMuted: false,
    cameraEnabled: false,
    peerCameraEnabled: true,
    localPreview: null,
    mediaError: null,
    remoteStream: null,
    startCall: asyncNoop,
    continueAudioOnly: noop,
    cancelCameraFallback: noop,
    accept: asyncNoop,
    decline: asyncNoop,
    hangUp: asyncNoop,
    rejoin: asyncNoop,
    toggleMute: noop,
    toggleCamera: asyncNoop,
    dismiss: noop,
    handleCallUpdate: noop,
    resync: noop,
    ...overrides,
  };
}

const videoCall = (): Partial<CallsContextValue> & { state: CallState } => ({
  state: { phase: 'connected', call: call('video') },
  remoteStream: camera(),
  localPreview: camera(),
  cameraEnabled: true,
  peerCameraEnabled: true,
});

/** Pretends the screen is a phone (or a phone on its side) or not, and can change that later. */
function screenSize(compact: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    matches: compact,
    media: COMPACT_SCREEN_QUERY,
    addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
  };
  const matchMedia = vi.fn((query: string) => ({ ...media, matches: query === COMPACT_SCREEN_QUERY && media.matches }));
  vi.stubGlobal('matchMedia', matchMedia);
  return {
    matchMedia,
    change(next: boolean) {
      media.matches = next;
      act(() => {
        for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
      });
    },
  };
}

const peer = { name: 'Jonas Lindqvist', avatarUrl: null };
const panel = (name: 'Video call' | 'Call') => screen.getByRole('region', { name });
const classes = (element: Element) => element.className.split(/\s+/);

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined);
});

describe('video is never cropped', () => {
  it("shows the whole of the other person's picture, whatever its shape", () => {
    screenSize(false);
    render(<CallPanel calls={fakeCalls(videoCall())} peer={peer} />);

    const theirs = screen.getByLabelText("Jonas Lindqvist's video");
    expect(classes(theirs)).toContain('object-contain');
    expect(classes(theirs)).not.toContain('object-cover');
  });

  it('keeps the shape of your own camera preview (no forced 16:9)', () => {
    screenSize(false);
    render(<CallPanel calls={fakeCalls(videoCall())} peer={peer} />);

    const mine = screen.getByLabelText('Your camera preview');
    expect(classes(mine)).not.toContain('aspect-video');
    expect(classes(mine)).not.toContain('object-cover');
    expect(classes(mine)).toContain('h-auto');
  });
});

describe('phones and short screens', () => {
  it('matches phones in portrait and phones on their side', () => {
    expect(COMPACT_SCREEN_QUERY).toBe('(max-width: 639px), (max-height: 499px)');
  });

  it('show a connected video call full screen, padded clear of the notch and home indicator', () => {
    screenSize(true);
    render(<CallPanel calls={fakeCalls(videoCall())} peer={peer} />);

    const section = panel('Video call');
    expect(section).toHaveAttribute('data-layout', 'fullscreen');
    expect(classes(section)).toEqual(expect.arrayContaining(['fixed', 'inset-0']));
    const padding = section.className;
    expect(padding).toContain('env(safe-area-inset-top)');
    expect(padding).toContain('env(safe-area-inset-bottom)');
    expect(padding).toContain('env(safe-area-inset-left)');
    expect(padding).toContain('env(safe-area-inset-right)');
    // Never wider or taller than the screen.
    expect(classes(section)).toEqual(expect.arrayContaining(['overflow-hidden']));
  });

  it.each([
    ['an incoming voice call', { state: { phase: 'incoming', call: call('voice', 'ringing'), answering: false, error: null, cameraError: null } } as const, 'Call'],
    ['a voice call', { state: { phase: 'connected', call: call('voice') } } as const, 'Call'],
    ['an incoming video call', { state: { phase: 'incoming', call: call('video', 'ringing'), answering: false, error: null, cameraError: null } } as const, 'Video call'],
  ])('show %s at the top, leaving the message box at the bottom free', (_label, overrides, name) => {
    screenSize(true);
    render(<CallPanel calls={fakeCalls(overrides)} peer={peer} />);

    const section = panel(name as 'Call' | 'Video call');
    expect(section).toHaveAttribute('data-layout', 'top');
    expect(section.className).toContain('env(safe-area-inset-top)');
    expect(section.className).toContain('max-h-[calc(100dvh');
  });
});

describe('safe areas (notch, rounded corners, home indicator)', () => {
  // `npm test` runs from the frontend folder; running vitest from the repository root also works.
  const frontendDir = existsSync(resolve(process.cwd(), 'index.html')) ? process.cwd() : resolve(process.cwd(), 'frontend');
  const frontendFile = (path: string) => readFileSync(resolve(frontendDir, path), 'utf8');

  it('lets the page reach the screen edges, so the call view can pad by the real safe-area insets', () => {
    expect(frontendFile('index.html')).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover/);
  });

  it('keeps the rest of the app clear of the notch in landscape, as before', () => {
    const css = frontendFile('src/index.css');
    expect(css).toContain('padding-left: env(safe-area-inset-left)');
    expect(css).toContain('padding-right: env(safe-area-inset-right)');
  });
});

describe('tablets and desktops', () => {
  it('float the panel and cap it, and its video, to the visible screen height', () => {
    screenSize(false);
    render(<CallPanel calls={fakeCalls(videoCall())} peer={peer} />);

    const section = panel('Video call');
    expect(section).toHaveAttribute('data-layout', 'floating');
    expect(section.className).toContain('max-h-[calc(100dvh');
    const stage = screen.getByTestId('call-video-stage');
    expect(stage.className).toContain('max-h-[calc(100dvh');
  });

  it('keep the compact card for voice calls', () => {
    screenSize(false);
    render(<CallPanel calls={fakeCalls({ state: { phase: 'connected', call: call('voice') } })} peer={peer} />);

    expect(panel('Call')).toHaveAttribute('data-layout', 'floating');
    expect(screen.queryByTestId('call-video-stage')).not.toBeInTheDocument();
  });
});

describe('when the camera is unavailable', () => {
  it('shows no empty video area, only the choice to continue with voice', () => {
    screenSize(false);
    render(
      <CallPanel
        calls={fakeCalls({ state: { phase: 'camera-fallback', conversationId: '22222222-2222-4222-8222-222222222222', message: 'Your camera is blocked.' } })}
        peer={peer}
      />,
    );

    expect(screen.queryByTestId('call-video-stage')).not.toBeInTheDocument();
    expect(screen.queryByText('Waiting for video…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with voice' })).toBeInTheDocument();
  });
});

describe('controls', () => {
  it.each([
    ['in a call', videoCall(), ['Mute', 'Turn camera off', 'End']],
    [
      'when a call rings',
      { state: { phase: 'incoming', call: call('video', 'ringing'), answering: false, error: null, cameraError: 'No camera.' } } as const,
      ['Decline', 'Accept', 'Accept without camera'],
    ],
  ])('wrap onto another line instead of squeezing, and are at least 44 px tall (%s)', (_label, overrides, names) => {
    screenSize(true);
    render(<CallPanel calls={fakeCalls(overrides)} peer={peer} />);

    const buttons = names.map((name) => screen.getByRole('button', { name }));
    expect(classes(buttons[0]!.parentElement!)).toEqual(expect.arrayContaining(['flex', 'flex-wrap']));
    for (const button of buttons) {
      expect(classes(button)).toEqual(expect.arrayContaining(['h-auto', 'min-h-11', 'whitespace-nowrap']));
    }
  });
});

describe('what must not change', () => {
  it('keeps the same audio element (the other person stays audible) when the screen size changes', () => {
    const size = screenSize(false);
    const { container } = render(<CallPanel calls={fakeCalls(videoCall())} peer={peer} />);
    const audio = container.querySelector('audio');

    size.change(true);

    expect(panel('Video call')).toHaveAttribute('data-layout', 'fullscreen');
    expect(container.querySelector('audio')).toBe(audio);
  });

  it('attaches both streams again when the layout changes', () => {
    const size = screenSize(false);
    const calls = fakeCalls(videoCall());
    render(<CallPanel calls={calls} peer={peer} />);

    size.change(true);

    expect((screen.getByLabelText("Jonas Lindqvist's video") as HTMLVideoElement).srcObject).toBe(calls.remoteStream);
    expect((screen.getByLabelText('Your camera preview') as HTMLVideoElement).srcObject).toBe(calls.localPreview);
  });

  it('works without matchMedia (older browsers): the floating layout', () => {
    vi.stubGlobal('matchMedia', undefined);
    render(<CallPanel calls={fakeCalls(videoCall())} peer={peer} />);
    expect(panel('Video call')).toHaveAttribute('data-layout', 'floating');
  });

  it('keeps every accessible name of the controls', () => {
    screenSize(true);
    render(<CallPanel calls={fakeCalls({ ...videoCall(), muted: true, cameraEnabled: false })} peer={peer} />);

    expect(screen.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Turn camera on' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'End' })).toBeInTheDocument();
  });
});
