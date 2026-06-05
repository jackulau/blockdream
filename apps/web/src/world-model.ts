// Interactive world-model tester (drift-sim style): drive the model with the
// keyboard, stream generated frames from the WS rollout server into a canvas.

import { actionFromKeys, N_BUTTONS } from "./action";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const screen = $<HTMLCanvasElement>("screen");
const ctx = screen.getContext("2d")!;
const hud = $<HTMLDivElement>("hud");
const statusEl = $<HTMLDivElement>("status");
const demoSel = $<HTMLSelectElement>("demo");
const urlInput = $<HTMLInputElement>("url");
const connectBtn = $<HTMLButtonElement>("connect");
const resetBtn = $<HTMLButtonElement>("reset");

void N_BUTTONS;
const held = new Set<string>();

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  held.add(k);
  if (k.startsWith("arrow") || k === " ") e.preventDefault();
});
window.addEventListener("keyup", (e) => held.delete(e.key.toLowerCase()));

let ws: WebSocket | null = null;
let running = false;
let sentAt = 0;
let fpsCount = 0;
let fpsLast = 0;
let fps = 0;
let latency = 0;

function setStatus(text: string, cls: "ok" | "err" | "idle") {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
}

function sendReset() {
  ws?.send(JSON.stringify({ type: "reset" }));
}

function sendAction() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const a = actionFromKeys(held);
  sentAt = performance.now();
  ws.send(JSON.stringify({ type: "action", buttons: a.buttons, camera: a.camera }));
}

function onFrame(msg: { shape: number[]; png_b64: string }) {
  const now = performance.now();
  latency = now - sentAt;
  fpsCount++;
  if (now - fpsLast >= 500) {
    fps = (fpsCount * 1000) / (now - fpsLast);
    fpsCount = 0;
    fpsLast = now;
  }
  const [, h, w] = msg.shape;
  if (screen.width !== w || screen.height !== h) {
    screen.width = w!;
    screen.height = h!;
  }
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0);
  img.src = `data:image/png;base64,${msg.png_b64}`;
  const a = actionFromKeys(held);
  hud.textContent = `${fps.toFixed(0)} fps · ${latency.toFixed(0)} ms · btn[${a.buttons.join("")}] cam[${a.camera.join(",")}]`;
  if (running) requestAnimationFrame(sendAction); // pump the next step
}

function connect() {
  if (ws) ws.close();
  setStatus("connecting…", "idle");
  ws = new WebSocket(urlInput.value);
  ws.onopen = () => {
    setStatus(`connected · ${demoSel.value}`, "ok");
    running = true;
    fpsLast = performance.now();
    sendReset();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "frame") onFrame(msg);
    else if (msg.type === "error") setStatus(`server error: ${msg.message}`, "err");
  };
  ws.onclose = () => {
    running = false;
    setStatus("disconnected", "idle");
  };
  ws.onerror = () => setStatus("connection failed — is the server running?", "err");
}

connectBtn.addEventListener("click", connect);
resetBtn.addEventListener("click", () => {
  sendReset();
  if (running) requestAnimationFrame(sendAction);
});
