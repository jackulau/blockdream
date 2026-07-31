import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Viewer } from "../src/viewer";

// Status-pill honesty (goal 087 D7). A WebSocket that FAILS to connect fires error → close;
// the close handler used to overwrite the useful "connection failed · is the server running?"
// pill with a blank "disconnected" - the default state on a machine without the local Python
// servers. Now onclose only says "disconnected" when the socket had actually opened.

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(s: string): void {
    this.sent.push(s);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

function makeViewer(statuses: Array<{ text: string; cls: string }>): Viewer {
  const canvas = { getContext: () => ({ drawImage() {} }) } as unknown as HTMLCanvasElement;
  return new Viewer({
    url: "ws://127.0.0.1:9",
    canvas,
    pngKey: "png_b64",
    buildAction: () => ({}),
    onStatus: (text, cls) => statuses.push({ text, cls }),
  });
}

describe("viewer status ordering", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("requestAnimationFrame", () => 0); // render loop is not driven in these tests
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the error pill SURVIVES the close event when the socket never opened", () => {
    const statuses: Array<{ text: string; cls: string }> = [];
    const v = makeViewer(statuses);
    v.connect();
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.onerror!(); // connection refused …
    ws.onclose!(); // … browsers always follow with close
    expect(statuses.map((s) => s.text)).toEqual(["connecting…", "connection failed · is the server running?"]);
    expect(statuses.at(-1)).toEqual({ text: "connection failed · is the server running?", cls: "err" });
    expect(statuses.map((s) => s.text)).not.toContain("disconnected"); // the old bug
    v.disconnect();
  });

  it("a real open → close still reports disconnected", () => {
    const statuses: Array<{ text: string; cls: string }> = [];
    const v = makeViewer(statuses);
    v.connect();
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen!();
    ws.onclose!();
    expect(statuses.map((s) => s.text)).toEqual(["connecting…", "connected", "disconnected"]);
    expect(statuses.at(-1)!.cls).toBe("idle");
    v.disconnect();
  });

  it("reconnect after a failed attempt starts a fresh socket and a fresh 'connecting…' pill", () => {
    const statuses: Array<{ text: string; cls: string }> = [];
    const v = makeViewer(statuses);
    v.connect();
    FakeWebSocket.instances.at(-1)!.onerror!();
    FakeWebSocket.instances.at(-1)!.onclose!();
    v.connect(); // what the reconnect button does
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(statuses.at(-1)).toEqual({ text: "connecting…", cls: "idle" });
    // opening the SECOND socket works normally
    const ws2 = FakeWebSocket.instances.at(-1)!;
    ws2.readyState = FakeWebSocket.OPEN;
    ws2.onopen!();
    expect(statuses.at(-1)).toEqual({ text: "connected", cls: "ok" });
    expect(ws2.sent.some((m) => JSON.parse(m).type === "reset")).toBe(true); // reset seeds the rollout
    v.disconnect();
  });
});
