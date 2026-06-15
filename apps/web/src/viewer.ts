// Decoupled world-model viewer: the DISPLAY (a requestAnimationFrame render loop that
// redraws the latest frame every screen refresh) is fully separate from GENERATION (a
// "pump" that requests the next frame only once the previous one arrives). So the canvas
// is buttery-smooth regardless of how fast the model generates - a slow 256-token
// Minecraft frame can't freeze it; a fast driving model just shows fresher content.

export interface Stats {
  displayFps: number; // canvas redraws/sec (locked to refresh - always smooth)
  genFps: number; // model frames/sec (content freshness)
  latencyMs: number; // last action→frame round-trip
}

export interface ViewerConfig {
  url: string;
  canvas: HTMLCanvasElement;
  pngKey: string; // frame field holding the base64 PNG ("png_b64" | "rgb_png_b64")
  buildAction: () => Record<string, unknown>; // merged into { type: "action" }
  buildReset?: () => Record<string, unknown>; // merged into { type: "reset" }
  onFrame?: (msg: Record<string, unknown>) => void; // side panels (lidar/telemetry HUD)
  onStats?: (s: Stats) => void;
  onStatus?: (text: string, cls: "ok" | "err" | "idle") => void;
}

interface FpsWindow {
  n: number;
  t0: number;
  fps: number;
}

export class Viewer {
  private ws: WebSocket | null = null;
  private ctx: CanvasRenderingContext2D;
  private latest: HTMLImageElement | null = null;
  private inflight = false;
  private running = false;
  private raf = 0;
  private sentAt = 0;
  private latencyMs = 0;
  private disp: FpsWindow = { n: 0, t0: 0, fps: 0 };
  private gen: FpsWindow = { n: 0, t0: 0, fps: 0 };

  constructor(private cfg: ViewerConfig) {
    this.ctx = cfg.canvas.getContext("2d")!;
  }

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  setUrl(url: string): void {
    this.cfg.url = url;
  }

  connect(): void {
    this.disconnect();
    this.cfg.onStatus?.("connecting…", "idle");
    const ws = new WebSocket(this.cfg.url);
    this.ws = ws;
    ws.onopen = () => {
      this.cfg.onStatus?.("connected", "ok");
      this.running = true;
      const now = performance.now();
      this.disp = { n: 0, t0: now, fps: 0 };
      this.gen = { n: 0, t0: now, fps: 0 };
      // reset seeds the rollout; its returned frame kicks off the generation pump
      ws.send(JSON.stringify({ type: "reset", ...(this.cfg.buildReset?.() ?? {}) }));
      this.startRenderLoop();
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data));
    ws.onclose = () => {
      this.running = false;
      this.cfg.onStatus?.("disconnected", "idle");
    };
    ws.onerror = () => this.cfg.onStatus?.("connection failed · is the server running?", "err");
  }

  reset(): void {
    if (this.connected) this.ws!.send(JSON.stringify({ type: "reset", ...(this.cfg.buildReset?.() ?? {}) }));
  }

  disconnect(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    if (msg.type === "error") {
      this.cfg.onStatus?.(`server error: ${String(msg.message)}`, "err");
      return;
    }
    if (msg.type !== "frame") return;
    this.inflight = false;
    this.latencyMs = performance.now() - this.sentAt;
    this.tick(this.gen);
    const b64 = msg[this.cfg.pngKey] as string | undefined;
    if (b64) {
      const img = new Image();
      img.onload = () => {
        this.latest = img;
      };
      img.src = `data:image/png;base64,${b64}`;
    }
    this.cfg.onFrame?.(msg);
    this.pump(); // request the next frame immediately - generation runs flat-out
  }

  // GENERATION: one request in flight at a time, as fast as the server produces frames
  private pump(): void {
    if (!this.connected || !this.running || this.inflight) return;
    this.inflight = true;
    this.sentAt = performance.now();
    this.ws!.send(JSON.stringify({ type: "action", ...this.cfg.buildAction() }));
  }

  // DISPLAY: redraw the latest available frame every screen refresh, independent of generation
  private startRenderLoop(): void {
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (this.latest) {
        const c = this.cfg.canvas;
        if (c.width !== this.latest.width || c.height !== this.latest.height) {
          c.width = this.latest.width;
          c.height = this.latest.height;
        }
        this.ctx.drawImage(this.latest, 0, 0);
      }
      this.tick(this.disp);
      this.cfg.onStats?.({ displayFps: this.disp.fps, genFps: this.gen.fps, latencyMs: this.latencyMs });
      if (this.running) this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private tick(w: FpsWindow): void {
    w.n++;
    const now = performance.now();
    if (now - w.t0 >= 500) {
      w.fps = (w.n * 1000) / (now - w.t0);
      w.n = 0;
      w.t0 = now;
    }
  }
}
