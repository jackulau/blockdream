// Proves the no-mod live bridge's THROUGHPUT lever headless: a pool of N RCON connections
// paints a frame's commands concurrently, so M commands cost ~ceil(M/N) round-trips instead
// of M. We stand up a fake RCON server (real TCP, the exact Source-RCON wire format
// rcon-client speaks) that adds artificial per-command latency, then show a 4-connection
// pool finishes a batch far faster than a single serial connection while delivering every
// command - and that a failed batch rejects (so the caller keeps its wall state to repaint).
//
// This is the headless half of the live path; the JVM/server live run stays operator-gated
// (BLOCKDREAM_E2E in verify-all.sh). No Minecraft needed here.
//
// Teardown note: net.Server.close() waits for open connections to drain, so the fake server's
// close() force-destroys client sockets, and afterEach stops the pools BEFORE the servers -
// otherwise a still-open pool connection would wedge close().

import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { RconPool } from "../src/rcon-pool";

// ---------------------------------------------------------------------------
// Fake RCON server - byte-for-byte the format in rcon-client/lib/packet.js:
//   request/reply = [int32LE size=payload+10][int32LE id][int32LE type][payload][2 nul]
//   type 3 = Auth (reply type 2, echo id = success), 2 = Command (reply type 0, echo id)
// ---------------------------------------------------------------------------

interface FakeRcon {
  port: number;
  received: string[]; // command bodies seen (type 2), across all connections
  peakConcurrent: () => number; // max simultaneously in-flight commands (proves parallelism)
  connections: () => number; // distinct sockets that authed
  close: () => Promise<void>;
}

function encode(id: number, type: number, payload: string): Buffer {
  const body = Buffer.from(payload, "utf-8");
  const buf = Buffer.alloc(body.length + 14);
  buf.writeInt32LE(body.length + 10, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  body.copy(buf, 12);
  return buf; // last 2 bytes stay 0 (the nul pad)
}

function startFakeRcon(opts: { perCommandDelayMs: number; failCommands?: boolean }): Promise<FakeRcon> {
  const received: string[] = [];
  const sockets = new Set<net.Socket>();
  let inFlight = 0;
  let peak = 0;
  let conns = 0;

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
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
        if (type === 3) {
          conns++;
          socket.write(encode(id, 2, "")); // auth ok (echo id, type AuthResponse)
        } else if (type === 2) {
          received.push(payload);
          if (opts.failCommands) {
            socket.destroy(); // simulate a mid-batch failure
            return;
          }
          inFlight++;
          peak = Math.max(peak, inFlight);
          setTimeout(() => {
            inFlight--;
            if (!socket.destroyed) socket.write(encode(id, 0, "ok"));
          }, opts.perCommandDelayMs);
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        port,
        received,
        peakConcurrent: () => peak,
        connections: () => conns,
        close: () =>
          new Promise<void>((res) => {
            for (const s of sockets) s.destroy(); // don't wait for clients to drain
            server.close(() => res());
          }),
      });
    });
  });
}

const PASS = "testpw";
const pools: RconPool[] = [];
const servers: FakeRcon[] = [];

const newPool = (port: number, conns: number): RconPool => {
  const p = new RconPool({ host: "127.0.0.1", port, password: PASS, conns });
  pools.push(p);
  return p;
};
const track = (s: FakeRcon): FakeRcon => {
  servers.push(s);
  return s;
};

// stop pools first (closes client sockets), THEN close servers
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.stop().catch(() => {})));
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => {})));
});

describe("RconPool: pooled sends beat serial against a latency-injecting fake server", () => {
  const DELAY = 40; // ms server-side per command
  const M = 8;
  const cmds = Array.from({ length: M }, (_, i) => `setblock ${i} 64 0 minecraft:stone`);

  it("a 4-connection pool paints a batch much faster than a single serial connection", async () => {
    const srv = track(await startFakeRcon({ perCommandDelayMs: DELAY }));

    const solo = newPool(srv.port, 1);
    const t1 = performance.now();
    await solo.sendBatch(cmds);
    const soloMs = performance.now() - t1;

    const pool = newPool(srv.port, 4);
    const t2 = performance.now();
    await pool.sendBatch(cmds);
    const poolMs = performance.now() - t2;

    // serial ≈ M*DELAY = 320ms; pooled ≈ ceil(M/4)*DELAY = 80ms
    expect(soloMs).toBeGreaterThan(M * DELAY * 0.6); // genuinely serialized
    expect(poolMs).toBeLessThan(soloMs * 0.6); // pool is clearly faster
    expect(srv.peakConcurrent()).toBeGreaterThanOrEqual(2); // commands overlapped server-side
    expect(pool.size).toBe(4);
  });

  it("delivers every command in the batch (no drops, order-independent)", async () => {
    const srv = track(await startFakeRcon({ perCommandDelayMs: 1 }));
    const pool = newPool(srv.port, 4);
    await pool.sendBatch(cmds);
    expect(new Set(srv.received)).toEqual(new Set(cmds));
    expect(srv.received).toHaveLength(M);
  });

  it("an empty batch is a no-op (no connection opened)", async () => {
    const srv = track(await startFakeRcon({ perCommandDelayMs: 1 }));
    const pool = newPool(srv.port, 4);
    await pool.sendBatch([]);
    expect(srv.connections()).toBe(0);
  });

  it("single send() (pose-poll style) uses one connection and returns the reply", async () => {
    const srv = track(await startFakeRcon({ perCommandDelayMs: 1 }));
    const pool = newPool(srv.port, 4);
    const reply = await pool.send("data get entity Steve Pos");
    expect(reply).toBe("ok");
    expect(srv.received).toEqual(["data get entity Steve Pos"]);
  });

  it("a failed batch REJECTS so the caller can keep its wall state and repaint next delta", async () => {
    const srv = track(await startFakeRcon({ perCommandDelayMs: 1, failCommands: true }));
    const pool = newPool(srv.port, 4);
    await expect(pool.sendBatch(cmds)).rejects.toThrow(/rcon batch/i);
  });
});
