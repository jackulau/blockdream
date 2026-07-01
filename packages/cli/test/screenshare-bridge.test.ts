// Screen-share bridge: the wire format (browser page <-> bridge) and the full pump end-to-end.
//
// 1. wire format - encode/decode round-trips + guards, and that a buffer built the SAME way the
//    capture page's inline encoder builds it decodes correctly (the page can't import the module, so
//    this locks the byte-for-byte contract).
// 2. dry-run pipeline - stand up the bridge on a free port, stream page-format frames over a real
//    WebSocket, and assert the pump decodes + paints them (real setblock/fill commands generated).
// 3. RCON relay - the same, but against a fake RCON server, proving frames actually reach "Minecraft"
//    as setblock/fill (the "sent to minecraft" wiring), reusing the Source-RCON fixture shape from
//    rcon-pipeline.test.ts.

import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import http from "node:http";
import WebSocket from "ws";
import { encodeFrameMessage, decodeFrameMessage, FRAME_HEADER_BYTES, MAX_FRAME_EDGE } from "../src/screenshare-bridge";
import { main } from "../src/screenshare-bridge-cli";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Build a frame message EXACTLY the way screenshare-page.ts does inline (DataView header + RGB),
// independently of encodeFrameMessage, so decoding it proves the page's bytes are compatible.
function pageFrame(w: number, h: number, [r, g, b]: [number, number, number]): Uint8Array {
  const msg = new Uint8Array(FRAME_HEADER_BYTES + w * h * 3);
  const dv = new DataView(msg.buffer);
  dv.setUint16(0, w, true);
  dv.setUint16(2, h, true);
  let o = FRAME_HEADER_BYTES;
  for (let i = 0; i < w * h; i++) {
    msg[o++] = r;
    msg[o++] = g;
    msg[o++] = b;
  }
  return msg;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function getJson(port: number, path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      })
      .on("error", reject);
  });
}

async function waitUp(port: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      await getJson(port, "/stats");
      return;
    } catch {
      await sleep(25);
    }
  }
  throw new Error("bridge never came up");
}

async function waitFor(fn: () => Promise<boolean>, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error("condition timed out");
}

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

// ---------------------------------------------------------------------------
// 1. wire format
// ---------------------------------------------------------------------------

describe("screen-share wire format", () => {
  it("round-trips width/height/pixels", () => {
    const rgb = new Uint8Array(4 * 3 * 3).map((_, i) => (i * 37) & 0xff);
    const msg = encodeFrameMessage(4, 3, rgb);
    expect(msg.length).toBe(FRAME_HEADER_BYTES + 4 * 3 * 3);
    const f = decodeFrameMessage(msg);
    expect(f.width).toBe(4);
    expect(f.height).toBe(3);
    expect(Array.from(f.pixels)).toEqual(Array.from(rgb));
  });

  it("decodes a buffer built the way the capture page builds it (byte-for-byte page contract)", () => {
    const fromPage = pageFrame(8, 8, [10, 200, 90]);
    const fromLib = encodeFrameMessage(8, 8, new Uint8Array(8 * 8 * 3).fill(0).map((_, i) => [10, 200, 90][i % 3]!));
    expect(Array.from(fromPage)).toEqual(Array.from(fromLib)); // page encoder == library encoder
    const f = decodeFrameMessage(fromPage);
    expect(f.width).toBe(8);
    expect(f.height).toBe(8);
    expect(f.pixels[0]).toBe(10);
    expect(f.pixels[1]).toBe(200);
    expect(f.pixels[2]).toBe(90);
  });

  it("pixels are a VIEW over the received buffer (no copy on the hot path)", () => {
    const msg = encodeFrameMessage(2, 2, new Uint8Array(2 * 2 * 3).fill(7));
    const f = decodeFrameMessage(msg);
    expect(f.pixels.buffer).toBe(msg.buffer);
  });

  it("rejects a truncated message, a length mismatch, and oversized dimensions", () => {
    expect(() => decodeFrameMessage(new Uint8Array(2))).toThrow(/header/);
    const short = encodeFrameMessage(4, 4, new Uint8Array(4 * 4 * 3));
    expect(() => decodeFrameMessage(short.subarray(0, short.length - 5))).toThrow(/!=|expected/);
    // header claims an edge past the cap, but the buffer is tiny -> the dimension guard fires first
    const huge = new Uint8Array(FRAME_HEADER_BYTES + 6);
    new DataView(huge.buffer).setUint16(0, MAX_FRAME_EDGE + 1, true);
    new DataView(huge.buffer).setUint16(2, 1, true);
    expect(() => decodeFrameMessage(huge)).toThrow(/edge/);
  });

  it("encode rejects bad sizes and mismatched pixel length", () => {
    expect(() => encodeFrameMessage(0, 4, new Uint8Array(0))).toThrow(/positive/);
    expect(() => encodeFrameMessage(4, 4, new Uint8Array(5))).toThrow(/rgb length/);
    expect(() => encodeFrameMessage(MAX_FRAME_EDGE + 1, 1, new Uint8Array((MAX_FRAME_EDGE + 1) * 3))).toThrow(/edge/);
  });
});

// ---------------------------------------------------------------------------
// 2. dry-run pipeline: page-format frames -> WS -> pump -> commands (no RCON)
// ---------------------------------------------------------------------------

describe("screen-share bridge - dry-run pipeline", () => {
  it("serves the capture page and live stats on its one port", async () => {
    const port = await getFreePort();
    const done = main(["--dry-run", "--port", String(port), "--size", "8x8", "--fps", "60", "--frames", "1"]);
    await waitUp(port);
    const html = await new Promise<string>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/" }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve(b));
        })
        .on("error", reject);
    });
    expect(html).toContain("getDisplayMedia");
    expect(html).toContain("Share a screen");
    const stats = await getJson(port, "/stats");
    expect(stats["size"]).toBe("8x8");
    expect(stats["dryRun"]).toBe(true);
    // let it finish so the port is released (no frame sent -> paint nothing -> still need to stop it)
    const ws = await openWs(`ws://127.0.0.1:${port}`);
    ws.send(pageFrame(8, 8, [1, 2, 3]));
    await done;
    ws.close();
  });

  it("decodes streamed page frames and paints them as real commands", async () => {
    const port = await getFreePort();
    const done = main(["--dry-run", "--port", String(port), "--size", "8x8", "--fps", "60", "--frames", "2"]);
    await waitUp(port);
    const ws = await openWs(`ws://127.0.0.1:${port}`);

    ws.send(pageFrame(8, 8, [200, 30, 30])); // keyframe
    await waitFor(async () => Number((await getJson(port, "/stats"))["framesPainted"]) >= 1);
    const mid = await getJson(port, "/stats");
    expect(Number(mid["framesReceived"])).toBeGreaterThanOrEqual(1);
    expect(Number(mid["lastCommands"])).toBeGreaterThan(0); // the frame->wall transform produced setblock/fill

    ws.send(pageFrame(8, 8, [30, 200, 30])); // a second, different frame -> second paint -> --frames 2 reached
    const code = await done; // resolves only once 2 frames are painted
    expect(code).toBe(0);
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// 3. RCON relay: frames actually reach "Minecraft" as setblock/fill
// ---------------------------------------------------------------------------

// Minimal fake Source-RCON server (same wire shape as rcon-pipeline.test.ts): auth (type 3) replies
// type 2 echoing the id (success); command (type 2) records the body and replies type 0.
function rconEncode(id: number, type: number, payload: string): Buffer {
  const body = Buffer.from(payload, "utf-8");
  const buf = Buffer.alloc(body.length + 14);
  buf.writeInt32LE(body.length + 10, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  body.copy(buf, 12);
  return buf;
}

interface FakeRcon {
  port: number;
  received: string[];
  close: () => Promise<void>;
}

function startFakeRcon(): Promise<FakeRcon> {
  const received: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) break;
        const size = buf.readInt32LE(0);
        if (buf.length < 4 + size) break;
        const frame = buf.subarray(0, 4 + size);
        buf = buf.subarray(4 + size);
        const id = frame.readInt32LE(4);
        const type = frame.readInt32LE(8);
        const payload = frame.subarray(12, size + 2).toString("utf-8");
        if (type === 3) socket.write(rconEncode(id, 2, "")); // auth ok
        else {
          received.push(payload);
          socket.write(rconEncode(id, 0, "")); // command ack
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        received,
        close: () =>
          new Promise<void>((res) => {
            for (const s of sockets) s.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}

describe("screen-share bridge - RCON relay", () => {
  let fake: FakeRcon | null = null;
  afterEach(async () => {
    await fake?.close();
    fake = null;
  });

  it("relays a captured frame into the world as setblock/fill over RCON", async () => {
    fake = await startFakeRcon();
    const port = await getFreePort();
    const done = main([
      "--port", String(port),
      "--rcon-pass", "test",
      "--rcon-port", String(fake.port),
      "--rcon-conns", "2",
      "--size", "6x6",
      "--fps", "60",
      "--frames", "1",
    ]);
    await waitUp(port);
    const ws = await openWs(`ws://127.0.0.1:${port}`);
    ws.send(pageFrame(6, 6, [20, 180, 120]));
    const code = await done;
    expect(code).toBe(0);
    ws.close();
    await sleep(50); // let the last acks settle
    expect(fake.received.length).toBeGreaterThan(0);
    expect(fake.received.some((c) => /^(setblock|fill)\b/.test(c))).toBe(true);
  });
});
