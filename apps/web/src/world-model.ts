// Interactive Minecraft world-model tester — now decoupled: a smooth render loop
// (Viewer) shows the latest generated frame while generation runs flat-out underneath.

import { Viewer } from "./viewer";
import { actionFromKeys } from "./action";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const screen = $<HTMLCanvasElement>("screen");
const hud = $<HTMLDivElement>("hud");
const statusEl = $<HTMLDivElement>("status");
const demoSel = $<HTMLSelectElement>("demo");
const urlInput = $<HTMLInputElement>("url");
const connectBtn = $<HTMLButtonElement>("connect");
const resetBtn = $<HTMLButtonElement>("reset");

const held = new Set<string>();
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  held.add(k);
  if (k.startsWith("arrow") || k === " ") e.preventDefault();
});
window.addEventListener("keyup", (e) => held.delete(e.key.toLowerCase()));

// demo selector → movement-type (skill) the conditioned model understands
const DEMO_SKILL: Record<string, string> = {
  walking: "walk", boat: "boat", elytra: "elytra", world: "general", gameplay: "general",
};
const skill = () => DEMO_SKILL[demoSel.value] ?? "general";

function setStatus(text: string, cls: "ok" | "err" | "idle") {
  statusEl.textContent = cls === "ok" ? `connected · ${demoSel.value}` : text;
  statusEl.className = `status ${cls}`;
}

const viewer = new Viewer({
  url: urlInput.value,
  canvas: screen,
  pngKey: "png_b64",
  buildAction: () => {
    const a = actionFromKeys(held);
    return { buttons: a.buttons, camera: a.camera, skill: skill() };
  },
  buildReset: () => ({ skill: skill() }),
  onStats: ({ displayFps, genFps, latencyMs }) => {
    const a = actionFromKeys(held);
    hud.textContent =
      `display ${displayFps.toFixed(0)} fps · gen ${genFps.toFixed(1)} fps · ${latencyMs.toFixed(0)} ms\n` +
      `btn[${a.buttons.join("")}] cam[${a.camera.join(",")}]`;
  },
  onStatus: setStatus,
});

connectBtn.addEventListener("click", () => {
  viewer.setUrl(urlInput.value);
  viewer.connect();
});
resetBtn.addEventListener("click", () => viewer.reset());
demoSel.addEventListener("change", () => {
  if (viewer.connected) viewer.reset();
});
