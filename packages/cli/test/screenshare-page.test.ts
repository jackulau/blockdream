// Capture-page honesty (goal 088 D13). The page is a self-contained HTML string, so instead of
// regex-only assertions these tests EXTRACT the inline <script> and execute it in a node:vm
// sandbox with a stubbed DOM/WebSocket/fetch/timers - the feature-detect gate, the /stats stall
// warning, the per-session counter reset, and the unified WS retry all run for real.
// (screenshare-bridge.test.ts covers the served page + wire format end-to-end.)

import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { capturePageHtml } from "../src/screenshare-page";

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

interface StubEl {
  textContent: string | number;
  className: string;
  disabled: boolean;
  style: { display: string };
  onclick: (() => void) | null;
  getContext?: (kind: string, opts?: unknown) => unknown;
}

interface Timer {
  id: number;
  fn: () => void;
  ms: number;
  kind: "timeout" | "interval";
  cleared: boolean;
}

interface FakeWsInstance {
  url: string;
  binaryType: string;
  readyState: number;
  sent: unknown[];
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close: () => void;
  send: (m: unknown) => void;
}

interface Harness {
  html: string;
  els: Map<string, StubEl>;
  el: (id: string) => StubEl;
  video: { muted: boolean; playsInline: boolean; srcObject: unknown; videoWidth: number; play: () => void };
  wsInstances: FakeWsInstance[];
  setWsThrow: (on: boolean) => void;
  setStats: (s: Record<string, unknown>) => void;
  fetchCalls: string[];
  timers: Timer[];
  /** Run every live interval whose delay matches once (the 1000ms one is the /stats poll). */
  runInterval: (ms: number) => void;
  /** Run + consume every pending one-shot timeout with the given delay. */
  runTimeouts: (ms: number) => number;
}

function boot(opts: { navigator?: unknown; getDisplayMedia?: () => unknown; wsThrow?: boolean } = {}): Harness {
  const html = capturePageHtml({ width: 8, height: 6, fps: 6 });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(scripts.length).toBe(1); // the page is one inline script - extraction is total
  const script = scripts[0]![1]!;

  const els = new Map<string, StubEl>();
  const el = (id: string): StubEl => {
    let e = els.get(id);
    if (!e) {
      e = { textContent: "", className: "", disabled: false, style: { display: "" }, onclick: null };
      if (id === "grid") {
        e.getContext = () => ({
          drawImage: () => {},
          getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8Array(w * h * 4).fill(120) }),
        });
      }
      els.set(id, e);
    }
    return e;
  };

  const video = { muted: false, playsInline: false, srcObject: null as unknown, videoWidth: 0, play: () => {} };

  const timers: Timer[] = [];
  let nextTimerId = 1;
  const schedule = (kind: Timer["kind"]) => (fn: () => void, ms: number): number => {
    timers.push({ id: nextTimerId, fn, ms, kind, cleared: false });
    return nextTimerId++;
  };
  const clearTimer = (id: number): void => {
    const t = timers.find((t) => t.id === id);
    if (t) t.cleared = true;
  };

  const wsInstances: FakeWsInstance[] = [];
  let wsThrow = opts.wsThrow ?? false;
  class FakeWebSocket implements FakeWsInstance {
    url: string;
    binaryType = "";
    readyState = 0;
    sent: unknown[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) {
      if (wsThrow) throw new Error("ws constructor refused");
      this.url = url;
      wsInstances.push(this);
    }
    send(m: unknown): void {
      this.sent.push(m);
    }
    close(): void {}
  }

  let statsBody: Record<string, unknown> = { framesPainted: 0, dryRun: false };
  const fetchCalls: string[] = [];
  const fetchStub = (path: string): Promise<{ json: () => Promise<Record<string, unknown>> }> => {
    fetchCalls.push(path);
    return Promise.resolve({ json: () => Promise.resolve(statsBody) });
  };

  const defaultNavigator =
    opts.navigator !== undefined
      ? opts.navigator
      : { mediaDevices: { getDisplayMedia: opts.getDisplayMedia ?? (() => Promise.resolve(null)) } };

  const ctx = vm.createContext({
    document: {
      getElementById: (id: string) => el(id),
      createElement: (tag: string) => {
        expect(tag).toBe("video");
        return video;
      },
    },
    navigator: defaultNavigator,
    location: { protocol: "http:", host: "127.0.0.1:8770", port: "8770" },
    performance: { now: () => 0 },
    WebSocket: FakeWebSocket,
    fetch: fetchStub,
    setTimeout: schedule("timeout"),
    setInterval: schedule("interval"),
    clearTimeout: clearTimer,
    clearInterval: clearTimer,
  });
  vm.runInContext(script, ctx);

  return {
    html,
    els,
    el,
    video,
    wsInstances,
    setWsThrow: (on) => {
      wsThrow = on;
    },
    setStats: (s) => {
      statsBody = s;
    },
    fetchCalls,
    timers,
    runInterval: (ms) => {
      for (const t of [...timers]) if (t.kind === "interval" && t.ms === ms && !t.cleared) t.fn();
    },
    runTimeouts: (ms) => {
      let ran = 0;
      for (const t of [...timers]) {
        if (t.kind === "timeout" && t.ms === ms && !t.cleared) {
          t.cleared = true;
          t.fn();
          ran++;
        }
      }
      return ran;
    },
  };
}

const STATS_POLL_MS = 1000;
const TICK_MS = 167; // Math.max(16, round(1000 / 6)) for the fps=6 harness page

/** Boot a supported page, start a share, and get the WS flowing (frames sendable). */
async function bootSharing(): Promise<Harness> {
  const stream = {
    getVideoTracks: () => [{ addEventListener: () => {} }],
    getTracks: () => [{ stop: () => {} }],
  };
  const h = boot({ getDisplayMedia: () => Promise.resolve(stream) });
  h.el("shareBtn").onclick!();
  await flush(); // getDisplayMedia promise resolves -> session started
  h.video.videoWidth = 8;
  const ws = h.wsInstances[0]!;
  ws.readyState = 1;
  ws.onopen!(); // connected
  return h;
}

describe("capture page: feature detect (secure-origin gate)", () => {
  it("disables the share button and explains the fix when mediaDevices is missing (plain http on a LAN host)", () => {
    const h = boot({ navigator: {} });
    expect(h.el("shareBtn").disabled).toBe(true);
    expect(String(h.el("status").textContent)).toMatch(/secure origin/);
    expect(String(h.el("status").textContent)).toContain("http://127.0.0.1:8770");
  });

  it("disables the button when mediaDevices exists but getDisplayMedia does not (iOS Safari shape)", () => {
    const h = boot({ navigator: { mediaDevices: {} } });
    expect(h.el("shareBtn").disabled).toBe(true);
    expect(String(h.el("status").textContent)).toMatch(/secure origin/);
  });

  it("leaves the button enabled when getDisplayMedia is available", () => {
    const h = boot();
    expect(h.el("shareBtn").disabled).toBe(false);
    expect(h.el("status").textContent).toBe(""); // default hint stays (the script does not overwrite it)
  });

  it("share() catches a synchronous getDisplayMedia throw instead of dying silently", () => {
    const h = boot({
      getDisplayMedia: () => {
        throw new TypeError("boom");
      },
    });
    expect(() => h.el("shareBtn").onclick!()).not.toThrow();
    expect(String(h.el("status").textContent)).toContain("boom");
    expect(String(h.el("status").textContent)).toContain("http://127.0.0.1:8770");
  });
});

describe("capture page: /stats polling (bridge truth)", () => {
  it("polls /stats and shows painted next to sent, and surfaces dry-run mode", async () => {
    const h = boot();
    h.setStats({ framesPainted: 5, dryRun: true });
    h.runInterval(STATS_POLL_MS);
    await flush();
    await flush();
    expect(h.fetchCalls).toContain("/stats");
    expect(h.el("painted").textContent).toBe(5);
    expect(String(h.el("mode").textContent)).toContain("dry-run");
  });

  it("warns after 3 polls with sends flowing but painted stalled, and recovers when painted advances", async () => {
    const h = await bootSharing();
    const poll = async (): Promise<void> => {
      h.runInterval(STATS_POLL_MS);
      await flush();
      await flush();
    };
    h.setStats({ framesPainted: 7, dryRun: false });
    await poll(); // baseline: painted "advanced" from unseen -> 7, no stall counted
    for (let i = 0; i < 3; i++) {
      h.runInterval(TICK_MS); // a frame goes out over the WS...
      await poll(); // ...but painted never moves
    }
    expect(Number(h.el("sent").textContent)).toBeGreaterThanOrEqual(3);
    expect(String(h.el("status").textContent)).toContain("not reaching the server");
    expect(String(h.el("status").textContent)).toMatch(/RCON password/);
    // bridge comes back: painted advances -> the warning clears back to the sharing status
    h.setStats({ framesPainted: 8, dryRun: false });
    h.runInterval(TICK_MS);
    await poll();
    expect(String(h.el("status").textContent)).toContain("Sharing live to Minecraft");
  });

  it("does not warn when nothing is being sent (no share in progress)", async () => {
    const h = boot();
    h.setStats({ framesPainted: 0, dryRun: false });
    for (let i = 0; i < 5; i++) {
      h.runInterval(STATS_POLL_MS);
      await flush();
      await flush();
    }
    expect(String(h.el("status").textContent)).not.toContain("not reaching");
  });
});

describe("capture page: per-session counters", () => {
  it("stop() resets framesSent (and the sent readout) so the next session starts at 0", async () => {
    const h = await bootSharing();
    h.runInterval(TICK_MS);
    h.runInterval(TICK_MS);
    expect(h.el("sent").textContent).toBe(2);
    expect(h.wsInstances[0]!.sent.length).toBe(2);
    h.el("stopBtn").onclick!();
    expect(h.el("sent").textContent).toBe(0);
    expect(h.el("rate").textContent).toBe(0);
    expect(h.el("shareBtn").disabled).toBe(false);
    expect(h.el("stopBtn").disabled).toBe(true);
    // ticks after stop are inert (interval cleared): the counter stays at 0
    h.runInterval(TICK_MS);
    expect(h.el("sent").textContent).toBe(0);
  });
});

describe("capture page: WebSocket retry", () => {
  it("a constructor throw takes the SAME 1s retry as onclose (no dead 'failed' state)", () => {
    const h = boot({ wsThrow: true });
    expect(h.wsInstances.length).toBe(0);
    expect(String(h.el("ws").textContent)).toBe("reconnecting"); // not a terminal 'failed'
    h.setWsThrow(false);
    expect(h.runTimeouts(1000)).toBe(1); // the scheduled retry exists at the onclose cadence
    expect(h.wsInstances.length).toBe(1);
    h.wsInstances[0]!.onopen!();
    expect(String(h.el("ws").textContent)).toBe("connected");
    expect(h.el("wsdot").className).toBe("dot on");
  });

  it("onclose retries connect after 1s with the same cadence", () => {
    const h = boot();
    expect(h.wsInstances.length).toBe(1);
    h.wsInstances[0]!.onclose!();
    expect(String(h.el("ws").textContent)).toBe("reconnecting");
    expect(h.runTimeouts(1000)).toBe(1);
    expect(h.wsInstances.length).toBe(2);
  });
});

describe("capture page: static structure", () => {
  it("keeps the stats row (sent + painted), the dry-run slot, and a project footer link", () => {
    const { html } = boot();
    expect(html).toContain('id="painted"');
    expect(html).toContain('id="mode"');
    expect(html).toContain("github.com/jackulau/blockdream");
    expect(html).toMatch(/<footer>/);
  });
});
