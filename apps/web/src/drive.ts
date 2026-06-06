// Driving world-model tester — decoupled: smooth RGB render loop (Viewer) + LiDAR BEV
// and telemetry HUD updated per generated frame.

import { Viewer } from "./viewer";
import { controlFromKeys } from "./driveAction";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const rgbCanvas = $<HTMLCanvasElement>("rgb");
const bevCanvas = $<HTMLCanvasElement>("bev");
const bevCtx = bevCanvas.getContext("2d")!;
const hud = $<HTMLDivElement>("hud");
const statusEl = $<HTMLDivElement>("status");
const urlInput = $<HTMLInputElement>("url");

const held = new Set<string>();
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  held.add(k);
  if (k.startsWith("arrow")) e.preventDefault();
});
window.addEventListener("keyup", (e) => held.delete(e.key.toLowerCase()));

function setStatus(t: string, cls: "ok" | "err" | "idle") {
  statusEl.textContent = t;
  statusEl.className = `status ${cls}`;
}

function drawBev(lidar: number[]) {
  const S = bevCanvas.width;
  const cx = S / 2;
  const cy = S / 2;
  bevCtx.fillStyle = "#05070c";
  bevCtx.fillRect(0, 0, S, S);
  bevCtx.fillStyle = "#cdd6ff";
  for (let k = 0; k < lidar.length; k++) {
    const ang = (2 * Math.PI * k) / lidar.length;
    const d = lidar[k]! * (S / 2 - 2);
    bevCtx.fillRect(Math.round(cx + d * Math.sin(ang)) - 1, Math.round(cy - d * Math.cos(ang)) - 1, 2, 2);
  }
  bevCtx.fillStyle = "#33d94e";
  bevCtx.fillRect(cx - 1, cy - 2, 3, 4);
}

let tel: number[] = [];

const viewer = new Viewer({
  url: urlInput.value,
  canvas: rgbCanvas,
  pngKey: "rgb_png_b64",
  buildAction: () => ({ control: controlFromKeys(held) }),
  onFrame: (msg) => {
    drawBev((msg.lidar as number[]) ?? []);
    tel = (msg.telemetry as number[]) ?? tel;
  },
  onStats: ({ displayFps, genFps, latencyMs }) => {
    const c = controlFromKeys(held);
    const speed = (tel[3] ?? 0) * 30;
    hud.textContent =
      `display ${displayFps.toFixed(0)} fps · gen ${genFps.toFixed(0)} fps · ${latencyMs.toFixed(0)} ms\n` +
      `speed ${speed.toFixed(1)} m/s   yaw-rate ${(tel[2] ?? 0).toFixed(2)}\n` +
      `control  steer ${c[0]}  throttle ${c[1]}  brake ${c[2]}`;
  },
  onStatus: setStatus,
});

$<HTMLButtonElement>("connect").addEventListener("click", () => {
  viewer.setUrl(urlInput.value);
  viewer.connect();
});
$<HTMLButtonElement>("reset").addEventListener("click", () => viewer.reset());
