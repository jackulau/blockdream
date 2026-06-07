// Custom voxel viewer + replay engine over three.js. three handles the GL context; the
// engine layer is ours: it turns a VoxelVolume (or a sequence — a spin/animation) into
// instanced textured cubes (one InstancedMesh per distinct block, real goal-014 textures),
// caches a mesh group per frame, and plays them back frame-by-frame with orbit + spin.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { poseAt, type VoxelVolume } from "@blockdream/voxel";
import { meshByMaterial, type FaceDir } from "./mesh3d";
import { buildSchedule, uniformSchedule, frameAtElapsed, startOfFrame, type FrameSchedule } from "./anim";

export interface Viewer3DConfig {
  canvas: HTMLCanvasElement;
  textureFor: (mapColorId: number) => string | null; // local /blocks/<file>.png, or null
  /** Optional per-FACE texture (grass top vs side, log end-grain). Falls back to textureFor when null. */
  faceTextureFor?: (mapColorId: number, dir: FaceDir) => string | null;
  colorFor: (mapColorId: number) => number; // 0xRRGGBB fallback when no texture
  fps?: number; // fallback playback fps when frames carry no per-frame durations (default 8)
  onFrame?: (index: number, count: number) => void;
}

export class Viewer3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly root = new THREE.Group();
  private readonly texCache = new Map<string, THREE.Texture>();
  private readonly matCache = new Map<string, THREE.Material>();
  private frames: VoxelVolume[] = [];
  private groups: Array<THREE.Group | null> = [];
  private index = 0;
  private playing = false;
  private animName = "spin"; // live transform animation applied to the whole object
  private animStart = 0;
  private maxDim = 1; // largest volume dimension, scales translation-based animations
  private schedule: FrameSchedule = uniformSchedule(1, 8);
  private playStart = 0;
  private readonly fps: number;
  private raf = 0;

  constructor(private cfg: Viewer3DConfig) {
    this.fps = cfg.fps ?? 8;
    this.renderer = new THREE.WebGLRenderer({ canvas: cfg.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.scene.background = null;
    this.scene.add(this.root);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(1, 2, 1.5);
    this.scene.add(dir);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.resize();
    window.addEventListener("resize", this.resize);
    this.loop(0);
  }

  private resize = () => {
    const c = this.cfg.canvas;
    const w = c.clientWidth || 480;
    const h = c.clientHeight || 360;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private texture(url: string): THREE.Texture {
    let t = this.texCache.get(url);
    if (!t) {
      t = new THREE.TextureLoader().load(url);
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.wrapS = THREE.RepeatWrapping; // greedy quads UV-tile (0..W) → repeat the texture per cell
      t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      this.texCache.set(url, t);
    }
    return t;
  }

  // material key: the texture URL, or a `__color_<id>` sentinel for the untextured colour fallback.
  private keyOf = (id: number, dir: FaceDir): string =>
    (this.cfg.faceTextureFor?.(id, dir) ?? this.cfg.textureFor(id)) ?? `__color_${id}`;

  private materialForKey(key: string): THREE.Material {
    let m = this.matCache.get(key);
    if (!m) {
      m = key.startsWith("__color_")
        ? new THREE.MeshLambertMaterial({ color: this.cfg.colorFor(Number(key.slice(8))) })
        : new THREE.MeshLambertMaterial({ map: this.texture(key) });
      this.matCache.set(key, m);
    }
    return m;
  }

  // Greedy-meshed group: interior/occluded faces culled, coplanar same-material faces merged into
  // big quads, grouped by material key (one mesh per texture; faces of a block can differ).
  private buildGroup(v: VoxelVolume): THREE.Group {
    const g = new THREE.Group();
    for (const [key, md] of meshByMaterial(v, this.keyOf)) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(md.positions, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(md.normals, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(md.uvs, 2));
      geo.setIndex(new THREE.BufferAttribute(md.indices, 1));
      g.add(new THREE.Mesh(geo, this.materialForKey(key)));
    }
    return g;
  }

  /**
   * Load a frame sequence. `opts.durationsMs` (e.g. a GIF's real per-frame delays) makes
   * playback honor the source cadence; without it, playback falls back to a fixed fps.
   * Turntable-spin is DECOUPLED from frame playback: a multi-frame animation defaults
   * spin OFF (the frames ARE the motion — spinning on top double-rotates), a single static
   * volume defaults spin ON (turntable showcase).
   */
  setFrames(frames: VoxelVolume[], opts: { durationsMs?: Array<number | undefined | null> } = {}): void {
    this.root.clear();
    this.groups = new Array(frames.length).fill(null);
    this.frames = frames;
    this.index = 0;
    this.schedule = opts.durationsMs ? buildSchedule(opts.durationsMs) : uniformSchedule(frames.length, this.fps);
    // a single static volume turntable-spins; a multi-frame animation defaults its transform off
    // (the frames ARE the motion — a transform on top would double-animate).
    this.animName = frames.length <= 1 ? "spin" : "none";
    this.animStart = performance.now();
    this.playStart = performance.now();
    // frame the camera to the volume
    const v = frames[0];
    if (v) {
      const r = Math.max(v.sx, v.sy, v.sz);
      this.maxDim = r;
      this.camera.position.set(r * 1.4, r * 1.1, r * 1.7);
      this.controls.target.set(0, 0, 0);
    }
    this.showFrame(0);
  }

  private showFrame(i: number): void {
    if (this.frames.length === 0) return;
    const n = this.frames.length;
    const idx = ((i % n) + n) % n;
    for (const g of this.root.children) g.visible = false;
    let g = this.groups[idx] ?? null;
    if (!g) {
      g = this.buildGroup(this.frames[idx]!);
      this.groups[idx] = g;
      this.root.add(g);
    }
    g.visible = true;
    this.index = idx;
    this.cfg.onFrame?.(idx, n);
  }

  setFrame(i: number): void {
    this.showFrame(i);
    // re-anchor the clock so a subsequent play() resumes from the scrubbed frame
    this.playStart = performance.now() - startOfFrame(this.schedule, this.index);
  }
  play(): void {
    this.playing = true;
    // resume from the current frame rather than restarting at 0
    this.playStart = performance.now() - startOfFrame(this.schedule, this.index);
  }
  pause(): void {
    this.playing = false;
  }
  get isPlaying(): boolean {
    return this.playing;
  }
  /** Select the live transform animation (spin/bob/rock/tumble/pulse/orbit/none). */
  setAnim(name: string): void {
    this.animName = name;
    this.animStart = performance.now();
  }
  get anim(): string {
    return this.animName;
  }
  setSpin(on: boolean): void {
    this.setAnim(on ? "spin" : "none");
  }
  get isSpinning(): boolean {
    return this.animName !== "none";
  }
  get frameCount(): number {
    return this.frames.length;
  }

  private loop = (t: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    // apply the live transform animation as an ABSOLUTE pose (refresh-rate independent — no accumulator)
    const p = poseAt(this.animName, (t - this.animStart) / 1000, this.maxDim);
    this.root.position.set(p.px, p.py, p.pz);
    this.root.rotation.set(p.rx, p.ry, p.rz);
    this.root.scale.setScalar(p.scale);
    if (this.playing && this.frames.length > 1) {
      const idx = frameAtElapsed(this.schedule, t - this.playStart, true);
      if (idx !== this.index) this.showFrame(idx);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    this.renderer.dispose();
  }
}
