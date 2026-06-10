// Server-free, in-browser diffusion world-model engine. Loads the ONNX exported by
// `python -m blockdream_wm.export_onnx --checkpoint ...` (transition.onnx + decoder.onnx) and runs
// the few-step Euler loop in JS — the >=30fps route (the whole frame's latent is denoised in
// parallel, unlike the AR server's token-by-token decode).
//
// onnxruntime-web is loaded from a CDN at runtime (a heavy WASM dep we don't want in the main
// bundle) — so this stays a zero-cost optional feature: if the ONNX or the runtime is unavailable,
// createBrowserRollout() returns null and the demo falls back to the WebSocket server engine.

export interface RolloutOpts {
  latentChannels: number;
  latentSize: number;
  actionDim: number;
  steps?: number;
  ortUrl?: string;
  transitionUrl?: string;
  decoderUrl?: string;
}

export interface BrowserRollout {
  reset(): void;
  step(actionEmbedding?: Float32Array): Promise<Float32Array>; // returns [1,3,h,w] image data in [0,1]
  readonly imageSize: number;
}

const DEFAULT_ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.mjs";

function randn(n: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const u = Math.random() || 1e-9;
    const v = Math.random();
    const r = Math.sqrt(-2 * Math.log(u));
    a[i] = r * Math.cos(2 * Math.PI * v);
    if (i + 1 < n) a[i + 1] = r * Math.sin(2 * Math.PI * v);
  }
  return a;
}

/** Probe whether an exported diffusion model is present (so the UI can show/hide the engine). */
export async function hasBrowserModel(transitionUrl = "/onnx/transition.onnx"): Promise<boolean> {
  try {
    const r = await fetch(transitionUrl, { method: "HEAD" });
    return r.ok;
  } catch {
    return false;
  }
}

/** Create the browser rollout, or null if the ONNX / runtime can't be loaded (caller falls back). */
export async function createBrowserRollout(opts: RolloutOpts): Promise<BrowserRollout | null> {
  const { latentChannels: C, latentSize: H, actionDim, steps = 8 } = opts;
  const transitionUrl = opts.transitionUrl ?? "/onnx/transition.onnx";
  const decoderUrl = opts.decoderUrl ?? "/onnx/decoder.onnx";
  if (!(await hasBrowserModel(transitionUrl))) return null;
  let ort: any;
  try {
    ort = await import(/* @vite-ignore */ opts.ortUrl ?? DEFAULT_ORT);
  } catch {
    return null; // runtime unavailable (offline) — fall back to the server engine
  }
  const ep = "gpu" in navigator ? ["webgpu", "wasm"] : ["wasm"];
  const transition = await ort.InferenceSession.create(transitionUrl, { executionProviders: ep });
  const decoder = await ort.InferenceSession.create(decoderUrl, { executionProviders: ep });
  const N = C * H * H;
  let prev: Float32Array = new Float32Array(N);

  async function sampleNext(actionEmb: Float32Array): Promise<Float32Array> {
    let z = randn(N);
    const dt = 1 / steps;
    for (let i = 0; i < steps; i++) {
      const { velocity } = await transition.run({
        z_t: new ort.Tensor("float32", z, [1, C, H, H]),
        t: new ort.Tensor("float32", new Float32Array([i * dt]), [1]),
        prev: new ort.Tensor("float32", prev, [1, C, H, H]),
        action: new ort.Tensor("float32", actionEmb, [1, actionDim]),
      });
      const v = velocity.data as Float32Array;
      const out = new Float32Array(N);
      for (let k = 0; k < N; k++) out[k] = z[k]! + v[k]! * dt;
      z = out;
    }
    return z;
  }

  return {
    imageSize: H,
    reset() {
      prev = new Float32Array(N);
    },
    async step(actionEmbedding?: Float32Array): Promise<Float32Array> {
      const next = await sampleNext(actionEmbedding ?? new Float32Array(actionDim));
      prev = next;
      const { image } = await decoder.run({ latent: new ort.Tensor("float32", next, [1, C, H, H]) });
      return image.data as Float32Array;
    },
  };
}
