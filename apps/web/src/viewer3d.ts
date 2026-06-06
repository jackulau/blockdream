// Custom voxel viewer + replay engine over three.js. three handles the GL context; the
// engine layer is ours: it turns a VoxelVolume (or a sequence — a spin/animation) into
// instanced textured cubes (one InstancedMesh per distinct block, real goal-014 textures),
// caches a mesh group per frame, and plays them back frame-by-frame with orbit + spin.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EMPTY, type VoxelVolume } from "@mineworld/voxel";

export interface Viewer3DConfig {
  canvas: HTMLCanvasElement;
  textureFor: (mapColorId: number) => string | null; // local /blocks/<file>.png, or null
  colorFor: (mapColorId: number) => number; // 0xRRGGBB fallback when no texture
  fps?: number; // playback frames/sec (default 8)
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
  private spinning = true;
  private lastAdvance = 0;
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
      t.colorSpace = THREE.SRGBColorSpace;
      this.texCache.set(url, t);
    }
    return t;
  }

  private material(id: number): THREE.Material {
    const url = this.cfg.textureFor(id);
    const key = url ?? `c${id}`;
    let m = this.matCache.get(key);
    if (!m) {
      m = url
        ? new THREE.MeshLambertMaterial({ map: this.texture(url) })
        : new THREE.MeshLambertMaterial({ color: this.cfg.colorFor(id) });
      this.matCache.set(key, m);
    }
    return m;
  }

  private buildGroup(v: VoxelVolume): THREE.Group {
    const g = new THREE.Group();
    const box = new THREE.BoxGeometry(1, 1, 1);
    const byBlock = new Map<number, number[]>(); // mapColorId → flat [x,y,z,...]
    let i = 0;
    for (let z = 0; z < v.sz; z++)
      for (let y = 0; y < v.sy; y++)
        for (let x = 0; x < v.sx; x++) {
          const c = v.data[i++]!;
          if (c === EMPTY) continue;
          let arr = byBlock.get(c);
          if (!arr) byBlock.set(c, (arr = []));
          arr.push(x, y, z);
        }
    const ox = (v.sx - 1) / 2;
    const oy = (v.sy - 1) / 2;
    const oz = (v.sz - 1) / 2;
    const m4 = new THREE.Matrix4();
    for (const [id, pos] of byBlock) {
      const count = pos.length / 3;
      const inst = new THREE.InstancedMesh(box, this.material(id), count);
      for (let k = 0; k < count; k++) {
        m4.makeTranslation(pos[k * 3]! - ox, pos[k * 3 + 1]! - oy, pos[k * 3 + 2]! - oz);
        inst.setMatrixAt(k, m4);
      }
      inst.instanceMatrix.needsUpdate = true;
      g.add(inst);
    }
    return g;
  }

  setFrames(frames: VoxelVolume[]): void {
    this.root.clear();
    this.groups = new Array(frames.length).fill(null);
    this.frames = frames;
    this.index = 0;
    // frame the camera to the volume
    const v = frames[0];
    if (v) {
      const r = Math.max(v.sx, v.sy, v.sz);
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
  }
  play(): void {
    this.playing = true;
    this.lastAdvance = performance.now();
  }
  pause(): void {
    this.playing = false;
  }
  get isPlaying(): boolean {
    return this.playing;
  }
  setSpin(on: boolean): void {
    this.spinning = on;
  }
  get frameCount(): number {
    return this.frames.length;
  }

  private loop = (t: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.spinning) this.root.rotation.y += 0.01;
    if (this.playing && this.frames.length > 1 && t - this.lastAdvance >= 1000 / this.fps) {
      this.lastAdvance = t;
      this.showFrame(this.index + 1);
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
