// Driving world-model tester: drive the recursive multimodal model with the
// keyboard; render generated RGB + LiDAR BEV + telemetry HUD.

import { controlFromKeys } from "./driveAction";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const rgbCanvas = $<HTMLCanvasElement>("rgb");
const bevCanvas = $<HTMLCanvasElement>("bev");
const rgbCtx = rgbCanvas.getContext("2d")!;
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

let ws: WebSocket | null = null;
let running = false;
let sentAt = 0;
let fps = 0;
let fpsCount = 0;
let fpsLast = 0;

function setStatus(t: string, cls: string) {
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
    const ang = (2 * Math.PI * k) / lidar.length; // 0 = forward (up)
    const d = lidar[k]! * (S / 2 - 2);
    const x = cx + d * Math.sin(ang);
    const y = cy - d * Math.cos(ang);
    bevCtx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 2, 2);
  }
  bevCtx.fillStyle = "#33d94e"; // car
  bevCtx.fillRect(cx - 1, cy - 2, 3, 4);
}

function onFrame(msg: { rgb_png_b64: string; lidar: number[]; telemetry: number[] }) {
  const now = performance.now();
  const latency = now - sentAt;
  fpsCount++;
  if (now - fpsLast >= 500) {
    fps = (fpsCount * 1000) / (now - fpsLast);
    fpsCount = 0;
    fpsLast = now;
  }
  const img = new Image();
  img.onload = () => {
    rgbCanvas.width = img.width;
    rgbCanvas.height = img.height;
    rgbCtx.drawImage(img, 0, 0);
  };
  img.src = `data:image/png;base64,${msg.rgb_png_b64}`;
  drawBev(msg.lidar);

  const t = msg.telemetry;
  const speed = (t[3] ?? 0) * 30;
  const c = controlFromKeys(held);
  hud.textContent =
    `${fps.toFixed(0)} fps · ${latency.toFixed(0)} ms\n` +
    `speed ${speed.toFixed(1)} m/s   yaw-rate ${(t[2] ?? 0).toFixed(2)}\n` +
    `vx ${((t[0] ?? 0) * 30).toFixed(1)}  vy ${((t[1] ?? 0) * 15).toFixed(1)}\n` +
    `control  steer ${c[0]}  throttle ${c[1]}  brake ${c[2]}`;
  if (running) requestAnimationFrame(sendAction);
}

function sendAction() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  sentAt = performance.now();
  ws.send(JSON.stringify({ type: "action", control: controlFromKeys(held) }));
}

function connect() {
  if (ws) ws.close();
  setStatus("connecting…", "idle");
  ws = new WebSocket(urlInput.value);
  ws.onopen = () => {
    setStatus("connected", "ok");
    running = true;
    fpsLast = performance.now();
    ws!.send(JSON.stringify({ type: "reset" }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "frame") onFrame(msg);
    else if (msg.type === "error") setStatus(`server error: ${msg.message}`, "err");
  };
  ws.onclose = () => { running = false; setStatus("disconnected", "idle"); };
  ws.onerror = () => setStatus("connection failed — is the driving server running?", "err");
}

$<HTMLButtonElement>("connect").addEventListener("click", connect);
$<HTMLButtonElement>("reset").addEventListener("click", () => {
  ws?.send(JSON.stringify({ type: "reset" }));
  if (running) requestAnimationFrame(sendAction);
});
