// A POOL of RCON connections so a world-model frame's many setblock/fill commands paint in
// PARALLEL instead of one-round-trip-at-a-time. This is the no-mod live bridge's throughput
// lever: rcon-client serializes every send on a single socket (its PromiseQueue defaults to
// maxPending:1), so `Promise.all` on one connection gives ZERO speedup - the only robust way
// to overlap the client→server→client round-trips is N independent connections (a stock
// vanilla server accepts many simultaneous RCON clients, each on its own thread). With N
// connections a frame of M commands costs ≈ ceil(M/N) round-trips instead of M, so the
// sidecar stops being the paint bottleneck and the live rate falls back to what the SERVER
// and the model can actually sustain (see docs/fps-budget.md - the server still executes
// commands on its main thread, so this lifts the client ceiling, not the server's).
//
// Pure socket plumbing: all frame→command logic stays in rcon-bridge.ts (side-effect-free)
// and the pump/loop stays in rcon-bridge-cli.ts. Each connection owns its own exponential
// backoff (1 s → 30 s cap) and drops a dead socket so the next send reconnects - the same
// resilience contract as the single-connection manager this replaces.

import { Rcon } from "rcon-client";

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One lazily-(re)connecting RCON socket with its own backoff ladder. */
class RconConn {
  private client: Rcon | null = null;
  private connecting: Promise<Rcon> | null = null;
  private backoffMs = BACKOFF_INITIAL_MS;
  private stopped = false;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly password: string,
    private readonly log: (m: string) => void,
    private readonly id: number,
  ) {}

  /** Send one command, (re)connecting with backoff first if needed. */
  async send(command: string): Promise<string> {
    const client = await this.ensure();
    return client.send(command);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const c = this.client;
    const connecting = this.connecting;
    this.client = null;
    this.connecting = null;
    if (c) await c.end().catch(() => {});
    // a connect still in flight when we stopped would otherwise orphan its socket - end it
    if (connecting) await connecting.then((rc) => rc.end()).catch(() => {});
  }

  private async ensure(): Promise<Rcon> {
    while (!this.stopped) {
      if (this.client) return this.client;
      this.connecting ??= Rcon.connect({ host: this.host, port: this.port, password: this.password });
      try {
        const client = await this.connecting;
        this.connecting = null;
        // stopped while this connect was in flight: don't store/use it, just close it
        if (this.stopped) {
          await client.end().catch(() => {});
          throw new Error("rcon pool stopped");
        }
        const drop = (why: string): void => {
          if (this.client === client) {
            this.client = null;
            if (!this.stopped) this.log(`rcon[${this.id}] connection lost (${why}) - reconnecting on next send`);
          }
        };
        client.on("error", (err) => drop(err instanceof Error ? err.message : String(err)));
        client.on("end", () => drop("closed"));
        this.client = client;
        this.backoffMs = BACKOFF_INITIAL_MS; // healthy again - next outage restarts the ladder
        this.log(`rcon[${this.id}] connected: ${this.host}:${this.port}`);
        return client;
      } catch (e) {
        this.connecting = null;
        const delay = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
        this.log(`rcon[${this.id}] connect failed (${e instanceof Error ? e.message : String(e)}) - retrying in ${delay} ms (cap ${BACKOFF_MAX_MS} ms)`);
        await sleep(delay);
      }
    }
    throw new Error("rcon pool stopped");
  }
}

/**
 * Per-shard accounting attached to a failed {@link RconPool.sendBatch} rejection as
 * `err.shards` (one entry per connection, in shard order). `sent` counts commands whose
 * RCON reply was confirmed (they LANDED in the live world); `failed` counts the rest of
 * that shard (the failing command plus everything after it - unconfirmed, needs repaint).
 */
export interface BatchShardReport {
  /** Shard / connection index. */
  index: number;
  /** Commands confirmed landed on this shard. */
  sent: number;
  /** Commands not confirmed on this shard (0 on a healthy shard). */
  failed: number;
}

export interface RconPoolOptions {
  host: string;
  port: number;
  password: string;
  /** Number of parallel connections (≥1). Default 1 = the old serial behaviour. */
  conns?: number;
  /** Optional logger (silent by default). */
  log?: (m: string) => void;
}

/**
 * A pool of N RCON connections.
 *
 * - {@link send} runs ONE command on connection 0 (pose polls / `list`) and returns the reply.
 * - {@link sendBatch} distributes commands across all N connections via a worker pool: each
 *   connection sends its share sequentially, the N shares run concurrently, so M commands cost
 *   ≈ ceil(M/N) round-trips. It resolves only when ALL commands have landed, and REJECTS if any
 *   command failed (so the caller keeps its previous wall state and lets the next delta repaint
 *   - the carry contract in rcon-bridge-cli.ts). Order WITHIN a batch is not guaranteed; a wall
 *   frame is a set of independent cells, so that is safe.
 */
export class RconPool {
  private readonly conns: RconConn[];

  constructor(opts: RconPoolOptions) {
    const log = opts.log ?? ((): void => {});
    const n = Math.max(1, Math.floor(opts.conns ?? 1));
    this.conns = Array.from({ length: n }, (_, i) => new RconConn(opts.host, opts.port, opts.password, log, i));
  }

  /** Number of connections in the pool. */
  get size(): number {
    return this.conns.length;
  }

  /** One command on connection 0 (pose polls / `list`), returns the RCON reply text. */
  send(command: string): Promise<string> {
    return this.conns[0]!.send(command);
  }

  /**
   * Send every command, sharded round-robin across the pool and run concurrently. Resolves
   * once all have been sent; rejects (after in-flight sends settle) if any failed. A partial
   * failure leaves the healthy shards' commands ALREADY APPLIED to the live world, so the
   * rejection carries per-shard accounting - the message spells out landed vs failed counts
   * per shard plus the aggregate, and `err.shards` holds {@link BatchShardReport}[] (every
   * shard, in order) for programmatic use - letting the operator tell a corrupt frame from
   * a sparse delta.
   */
  async sendBatch(commands: string[]): Promise<void> {
    if (commands.length === 0) return;
    const n = this.conns.length;
    const shards: string[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < commands.length; i++) shards[i % n]!.push(commands[i]!);
    const sent = new Array<number>(n).fill(0); // per-shard confirmed-landed counters
    const results = await Promise.allSettled(
      shards.map(async (shard, i) => {
        for (const cmd of shard) {
          await this.conns[i]!.send(cmd);
          sent[i] = sent[i]! + 1;
        }
      }),
    );
    const failedCount = results.filter((r) => r.status === "rejected").length;
    if (failedCount > 0) {
      const reports: BatchShardReport[] = shards.map((shard, i) => ({ index: i, sent: sent[i]!, failed: shard.length - sent[i]! }));
      const landedTotal = sent.reduce((a, b) => a + b, 0);
      const failedTotal = commands.length - landedTotal;
      const detail = reports
        .map((s, i) => {
          const r = results[i]!;
          return r.status === "rejected"
            ? `shard ${s.index}: ${s.sent} landed, ${s.failed} failed (${r.reason instanceof Error ? r.reason.message : String(r.reason)})`
            : `shard ${s.index}: ${s.sent} landed`;
        })
        .join("; ");
      const err = new Error(
        `rcon batch: ${failedCount}/${n} connection(s) failed, ${landedTotal}/${commands.length} command(s) landed, ${failedTotal} failed; ${detail}`,
      ) as Error & { shards: BatchShardReport[] };
      err.shards = reports;
      throw err;
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.conns.map((c) => c.stop()));
  }
}
