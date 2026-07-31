// Proves sendBatch's partial-failure accounting: the pool shards a frame round-robin across
// N connections, so a mid-batch failure on one connection leaves the OTHER shards' commands
// already applied to the live world. The rejection must therefore say, per shard, how many
// commands landed vs failed (plus the aggregate) - both in the message and as a structured
// `err.shards` field - so the operator can tell a corrupt frame from a sparse delta.
//
// Transport is faked at the rcon-client boundary (no TCP): each fake connection confirms a
// send unless the COMMAND is on the fail list, which makes the failing shard deterministic
// (round-robin puts command i on shard i % n) without depending on connect ordering.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { RconPool, type BatchShardReport } from "../src/rcon-pool";

const state = vi.hoisted(() => ({
  failOn: new Set<string>(), // commands whose send rejects (simulates a shard dying mid-batch)
  landed: [] as string[], // commands the fake server confirmed, across all connections
}));

vi.mock("rcon-client", () => ({
  Rcon: {
    connect: async (): Promise<unknown> => ({
      send: async (cmd: string): Promise<string> => {
        await Promise.resolve(); // yield once, like a real round-trip
        if (state.failOn.has(cmd)) throw new Error(`socket died on ${cmd}`);
        state.landed.push(cmd);
        return "ok";
      },
      end: async (): Promise<void> => {},
      on: (): void => {},
    }),
  },
}));

// 10 commands over 4 conns, round-robin:
//   shard 0: c0 c4 c8   shard 1: c1 c5 c9   shard 2: c2 c6   shard 3: c3 c7
const CMDS = Array.from({ length: 10 }, (_, i) => `c${i}`);

const newPool = (): RconPool => new RconPool({ host: "127.0.0.1", port: 25575, password: "pw", conns: 4 });

const rejectionOf = async (p: Promise<void>): Promise<Error & { shards: BatchShardReport[] }> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(Error); // a NORMAL Error - existing catch sites keep working
    return e as Error & { shards: BatchShardReport[] };
  }
  throw new Error("expected sendBatch to reject");
};

beforeEach(() => {
  state.failOn.clear();
  state.landed.length = 0;
});

describe("RconPool.sendBatch partial-failure accounting", () => {
  it("one shard rejecting mid-batch reports per-shard landed/failed counts and the aggregate", async () => {
    state.failOn.add("c5"); // shard 1's SECOND command: c1 lands, then c5 and c9 fail
    const pool = newPool();
    const err = await rejectionOf(pool.sendBatch(CMDS));

    // aggregate: 1 of 4 connections failed, 8 of 10 commands landed
    expect(err.message).toContain("1/4 connection(s) failed");
    expect(err.message).toContain("8/10 command(s) landed, 2 failed");
    // per-shard counts in the message, failing shard with its reason
    expect(err.message).toContain("shard 1: 1 landed, 2 failed (socket died on c5)");
    expect(err.message).toContain("shard 0: 3 landed");
    expect(err.message).toContain("shard 2: 2 landed");
    expect(err.message).toContain("shard 3: 2 landed");

    // structured field: every shard accounted for, successful shards' counts accurate
    expect(err.shards).toEqual([
      { index: 0, sent: 3, failed: 0 },
      { index: 1, sent: 1, failed: 2 },
      { index: 2, sent: 2, failed: 0 },
      { index: 3, sent: 2, failed: 0 },
    ]);

    // the accounting matches what the fake transport actually confirmed
    expect(new Set(state.landed)).toEqual(new Set(["c0", "c4", "c8", "c1", "c2", "c6", "c3", "c7"]));
    await pool.stop();
  });

  it("multiple failing shards: indices are identifiable and a first-command failure lands zero", async () => {
    state.failOn.add("c3"); // shard 3's FIRST command: nothing lands on shard 3
    state.failOn.add("c5"); // shard 1 fails after landing c1
    const pool = newPool();
    const err = await rejectionOf(pool.sendBatch(CMDS));

    expect(err.message).toContain("2/4 connection(s) failed");
    expect(err.message).toContain("6/10 command(s) landed, 4 failed");
    expect(err.message).toContain("shard 3: 0 landed, 2 failed (socket died on c3)");

    expect(err.shards).toEqual([
      { index: 0, sent: 3, failed: 0 },
      { index: 1, sent: 1, failed: 2 },
      { index: 2, sent: 2, failed: 0 },
      { index: 3, sent: 0, failed: 2 },
    ]);
    expect(err.shards.filter((s) => s.failed > 0).map((s) => s.index)).toEqual([1, 3]);
    await pool.stop();
  });

  it("a fully successful batch resolves with every command landed (no error, no accounting)", async () => {
    const pool = newPool();
    await pool.sendBatch(CMDS);
    expect(new Set(state.landed)).toEqual(new Set(CMDS));
    expect(state.landed).toHaveLength(CMDS.length);
    await pool.stop();
  });
});
