// Custom voxel viewer + replay engine over three.js. three handles the GL context; the
// engine layer is ours: it turns a VoxelVolume (or a sequence - a spin/animation) into
// instanced textured cubes (one InstancedMesh per distinct block, real goal-014 textures),
// caches a mesh group per frame, and plays them back frame-by-frame with orbit + spin.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EMPTY, getVoxel, poseAt, type VoxelVolume } from "@blockdream/voxel";
import { meshByMaterial, type FaceDir } from "./mesh3d";
import { buildSchedule, uniformSchedule, frameAtElapsed, startOfFrame, type FrameSchedule } from "./anim";
import { rayGroundHit, dragTo, type SceneObjectId, type GroundVec, type DragSession } from "./canvas-mod";

/** A snapshot of the arrange state emitted to the host UI after a drag (positions in ground XZ). */
export interface ArrangeSnapshot {
  selected: SceneObjectId;
  build: GroundVec;
  music: GroundVec;
  showMusic: boolean;
}

export interface Viewer3DConfig {
  canvas: HTMLCanvasElement;
  textureFor: (mapColorId: number) => string | null; // local /blocks/<file>.png, or null
  /** Optional per-FACE texture (grass top vs side, log end-grain). Falls back to textureFor when null. */
  faceTextureFor?: (mapColorId: number, dir: FaceDir) => string | null;
  colorFor: (mapColorId: number) => number; // 0xRRGGBB fallback when no texture
  fps?: number; // fallback playback fps when frames carry no per-frame durations (default 8)
  onFrame?: (index: number, count: number) => void;
  /** Hover picking: fired on mousemove with the voxel under the cursor (null = none). */
  onPick?: (pick: VoxelPick | null, ev: MouseEvent) => void;
}

export interface VoxelPick {
  /** mapColorId of the hovered voxel. */
  id: number;
  x: number;
  y: number;
  z: number;
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
  // canvas mod: the build sits under an arrange anchor (drag offset) so the live animation pose on
  // `root` and the drag translation never fight; the music area is its own draggable group.
  private readonly buildAnchor = new THREE.Group();
  private readonly musicGroup = new THREE.Group();
  private arrangeMode = false;
  private selected: SceneObjectId = "build";
  private drag: DragSession | null = null;
  private showMusicFlag = true;
  private onArrangeChange?: (s: ArrangeSnapshot) => void;

  constructor(private cfg: Viewer3DConfig) {
    this.fps = cfg.fps ?? 8;
    this.renderer = new THREE.WebGLRenderer({ canvas: cfg.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.scene.background = null;
    this.buildAnchor.add(this.root); // root carries the animation pose; the anchor carries the drag offset
    this.scene.add(this.buildAnchor);
    this.scene.add(this.musicGroup);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(1, 2, 1.5);
    this.scene.add(dir);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.resize();
    window.addEventListener("resize", this.resize);
    if (cfg.onPick) {
      cfg.canvas.addEventListener("mousemove", this.onMouseMove);
      cfg.canvas.addEventListener("mouseleave", this.onMouseLeave);
    }
    // arrange-mode drag (gated by this.arrangeMode inside the handlers, so they're inert otherwise)
    cfg.canvas.addEventListener("pointerdown", this.onPointerDown);
    cfg.canvas.addEventListener("pointermove", this.onPointerDrag);
    window.addEventListener("pointerup", this.onPointerUp);
    // a touch interaction can end with pointercancel (palm rejection / system gesture) and no
    // pointerup — without this, a drag could leave OrbitControls stuck disabled.
    window.addEventListener("pointercancel", this.onPointerUp);
    this.loop(0);
  }

  // --- hover picking: ray → merged greedy-quad mesh → voxel cell → id from the volume ---
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  private onMouseMove = (ev: MouseEvent): void => {
    this.cfg.onPick?.(this.pick(ev), ev);
  };
  private onMouseLeave = (ev: MouseEvent): void => {
    this.cfg.onPick?.(null, ev);
  };

  /** The voxel under a mouse event, or null. Robust to the live transform animation because
   *  the intersected mesh's world matrix carries the root pose. */
  pick(ev: MouseEvent): VoxelPick | null {
    const v = this.frames[this.index];
    const g = this.groups[this.index];
    if (!v || !g) return null;
    const r = this.cfg.canvas.getBoundingClientRect();
    this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(g.children, false)[0];
    if (!hit?.face) return null;
    // local-space hit point sits ON a face plane; step half a cell INTO the solid along the
    // (local) face normal, then un-center to volume coordinates.
    const local = (hit.object as THREE.Mesh).worldToLocal(hit.point.clone());
    const n = hit.face.normal;
    const x = Math.floor(local.x - n.x * 0.5 + v.sx / 2);
    const y = Math.floor(local.y - n.y * 0.5 + v.sy / 2);
    const z = Math.floor(local.z - n.z * 0.5 + v.sz / 2);
    const id = getVoxel(v, x, y, z);
    return id === EMPTY ? null : { id, x, y, z };
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
   * spin OFF (the frames ARE the motion - spinning on top double-rotates), a single static
   * volume defaults spin ON (turntable showcase).
   */
  setFrames(frames: VoxelVolume[], opts: { durationsMs?: Array<number | undefined | null> } = {}): void {
    this.disposeGroups(); // free the previous frames' geometries (materials/textures stay cached)
    this.groups = new Array(frames.length).fill(null);
    this.frames = frames;
    this.index = 0;
    this.schedule = opts.durationsMs ? buildSchedule(opts.durationsMs) : uniformSchedule(frames.length, this.fps);
    // a single static volume turntable-spins; a multi-frame animation defaults its transform off
    // (the frames ARE the motion - a transform on top would double-animate).
    this.animName = frames.length <= 1 ? "spin" : "none";
    this.animStart = performance.now();
    this.playStart = performance.now();
    // frame the camera to the volume: fit the bounding SPHERE for the current FOV, and pull back further
    // on a narrow canvas (aspect < 1) so a wide/flat volume doesn't overflow horizontally.
    const v = frames[0];
    if (v) {
      this.maxDim = Math.max(v.sx, v.sy, v.sz);
      const radius = 0.5 * Math.hypot(v.sx, v.sy, v.sz);
      const aspect = this.camera.aspect || 1;
      const fitH = radius / Math.tan((this.camera.fov * Math.PI) / 360);
      const dist = Math.max(fitH, fitH / Math.max(0.0001, aspect)) * 1.3;
      this.camera.position.copy(new THREE.Vector3(0.6, 0.5, 0.8).normalize().multiplyScalar(dist));
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

  // --- canvas mod: drag the build (animation) + the note-block "music area" on the ground plane ---

  /** (Re)build the visible note-block "music area": one small coloured cube per distinct pitch. */
  setMusicArea(notes: ReadonlyArray<{ note: number }>): void {
    this.clearMusicGroup();
    const distinct = [...new Set(notes.map((n) => n.note))].sort((a, b) => a - b);
    const geo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
    distinct.forEach((note, i) => {
      const hue = (Math.max(0, Math.min(24, note)) / 24) * 0.8; // pitch → hue (low=red, high=violet)
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(hue, 0.65, 0.55) }));
      mesh.position.set(i - (distinct.length - 1) / 2, 0, 0); // a centered row of note blocks
      this.musicGroup.add(mesh);
    });
    this.musicGroup.visible = this.showMusicFlag && distinct.length > 0;
  }

  /** Show/hide (include/exclude) the note-block music area. */
  setShowMusic(on: boolean): void {
    this.showMusicFlag = on;
    this.musicGroup.visible = on && this.musicGroup.children.length > 0;
  }
  get showsMusic(): boolean {
    return this.showMusicFlag;
  }

  /** Toggle "Arrange" mode. While on, an object drag suspends OrbitControls; release restores it. */
  setArrangeEnabled(on: boolean): void {
    this.arrangeMode = on;
    if (!on) this.endDrag();
  }
  get isArranging(): boolean {
    return this.arrangeMode;
  }

  /** Which object a drag moves ("build" = the animation, "music" = the note blocks). */
  selectObject(id: SceneObjectId): void {
    this.selected = id;
  }

  /** Set an object's ground position (XZ). build → the arrange anchor (kept ⊥ the animation pose). */
  setObjectPosition(id: SceneObjectId, x: number, z: number): void {
    const g = id === "build" ? this.buildAnchor : this.musicGroup;
    g.position.x = x;
    g.position.z = z;
  }

  /** Subscribe to arrange changes (fired while dragging) — the host UI mirrors positions into export. */
  onArrange(cb: (s: ArrangeSnapshot) => void): void {
    this.onArrangeChange = cb;
  }

  private clearMusicGroup(): void {
    this.musicGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[];
        (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose());
      }
    });
    this.musicGroup.clear();
  }

  /** The ground-plane (y=0) point under a pointer event, via the same raycaster as picking. */
  private groundHit(ev: PointerEvent): GroundVec | null {
    const r = this.cfg.canvas.getBoundingClientRect();
    this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const o = this.raycaster.ray.origin;
    const d = this.raycaster.ray.direction;
    return rayGroundHit({ x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z }, 0);
  }

  private onPointerDown = (ev: PointerEvent): void => {
    if (!this.arrangeMode) return;
    const hit = this.groundHit(ev);
    if (!hit) return;
    const g = this.selected === "build" ? this.buildAnchor : this.musicGroup;
    this.drag = { id: this.selected, grab: hit, origin: { x: g.position.x, z: g.position.z } };
    this.controls.enabled = false; // suspend orbit while dragging the object
  };
  private onPointerDrag = (ev: PointerEvent): void => {
    if (!this.drag) return;
    const hit = this.groundHit(ev);
    if (!hit) return;
    const to = dragTo(this.drag, hit);
    this.setObjectPosition(this.drag.id, to.x, to.z);
    this.emitArrange();
  };
  private onPointerUp = (): void => {
    this.endDrag();
  };
  private endDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.controls.enabled = true; // restore orbit
  }
  private emitArrange(): void {
    this.onArrangeChange?.({
      selected: this.selected,
      build: { x: this.buildAnchor.position.x, z: this.buildAnchor.position.z },
      music: { x: this.musicGroup.position.x, z: this.musicGroup.position.z },
      showMusic: this.showMusicFlag,
    });
  }

  private loop = (t: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    // apply the live transform animation as an ABSOLUTE pose (refresh-rate independent - no accumulator)
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

  /** Dispose every mesh geometry under the root (the leak: BufferGeometries held GPU buffers
   *  across setFrames calls - re-importing animations grew GPU memory unboundedly). */
  private disposeGroups(): void {
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
    });
    this.root.clear();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    this.cfg.canvas.removeEventListener("mousemove", this.onMouseMove);
    this.cfg.canvas.removeEventListener("mouseleave", this.onMouseLeave);
    this.cfg.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.cfg.canvas.removeEventListener("pointermove", this.onPointerDrag);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    this.clearMusicGroup();
    this.disposeGroups();
    for (const m of this.matCache.values()) m.dispose();
    for (const t of this.texCache.values()) t.dispose();
    this.matCache.clear();
    this.texCache.clear();
    this.controls.dispose(); // OrbitControls owns pointer/wheel/contextmenu listeners - free them too
    this.renderer.dispose();
  }
}
