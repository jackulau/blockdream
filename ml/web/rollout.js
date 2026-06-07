// Browser rollout harness for the blockdream diffusion world model.
//
// Loads transition.onnx + decoder.onnx (exported by `python -m
// blockdream_wm.export_onnx`) and runs the interactive loop with onnxruntime-web
// (WebGPU when available, else WASM). The few-step Euler integration runs in JS;
// each step calls transition.onnx once, then decoder.onnx once per displayed frame.
//
//   import { createRollout } from "./rollout.js";
//   const rollout = await createRollout("/onnx/transition.onnx", "/onnx/decoder.onnx",
//       { latentChannels: 4, latentSize: 8, actionDim: 32, steps: 8 });
//   rollout.reset();
//   const png = await rollout.step({ buttons: [1,0,0,0,0,0,0,0,0], camera: [0.2,-0.1] });

import * as ort from "onnxruntime-web";

function randn(n) {
  // Box–Muller normal noise
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

export async function createRollout(transitionUrl, decoderUrl, opts) {
  const { latentChannels: C, latentSize: H, actionDim, steps = 8 } = opts;
  const ep = "gpu" in navigator ? ["webgpu", "wasm"] : ["wasm"];
  const transition = await ort.InferenceSession.create(transitionUrl, { executionProviders: ep });
  const decoder = await ort.InferenceSession.create(decoderUrl, { executionProviders: ep });
  const N = C * H * H;
  let prev = new Float32Array(N); // latent state

  function encodeAction(action) {
    // The server-side ActionEncoder is folded into training; for the browser we
    // pass a precomputed action embedding (actionDim) supplied by the host app,
    // or zeros for a no-op. Replace with an exported action-encoder if needed.
    return action.embedding ?? new Float32Array(actionDim);
  }

  async function sampleNext(actionEmb) {
    let z = randn(N);
    const dt = 1 / steps;
    for (let i = 0; i < steps; i++) {
      const feeds = {
        z_t: new ort.Tensor("float32", z, [1, C, H, H]),
        t: new ort.Tensor("float32", new Float32Array([i * dt]), [1]),
        prev: new ort.Tensor("float32", prev, [1, C, H, H]),
        action: new ort.Tensor("float32", actionEmb, [1, actionDim]),
      };
      const { velocity } = await transition.run(feeds);
      const v = velocity.data;
      const out = new Float32Array(N);
      for (let k = 0; k < N; k++) out[k] = z[k] + v[k] * dt;
      z = out;
    }
    return z;
  }

  return {
    reset() {
      prev = new Float32Array(N);
    },
    async step(action) {
      const next = await sampleNext(encodeAction(action));
      prev = next;
      const { image } = await decoder.run({ latent: new ort.Tensor("float32", next, [1, C, H, H]) });
      return image; // [1,3,h,w] in [0,1] — host draws to canvas
    },
  };
}
