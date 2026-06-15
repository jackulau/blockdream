// render-probe - proves prismarine-viewer actually meshes + renders textured TERRAIN (not just sky).
// Root cause of the earlier blank frames: prismarine-viewer 1.33's worldrenderer.addColumn only marks
// sections y=0..255 dirty, so a 1.18+ world (superflat ground at y≈-60, negative-Y section) is never
// meshed. A pre-1.18 world (1.16.5: ground at y≈4, positive Y) IS meshed. This probe renders one frame
// on the connected server and reports NONBLANK (mesh has vertices + the PNG has real detail) or BLANK.
//   node render-probe.mjs [--version 1.16.5] [--out /tmp/probe.png]
import mineflayer from 'mineflayer'
import * as THREE from 'three'
import { Worker } from 'worker_threads'
import { writeFileSync } from 'node:fs'
import canvasWebgl from 'node-canvas-webgl'
const { createCanvas } = canvasWebgl
import pvViewer from 'prismarine-viewer/viewer/index.js'

global.THREE = THREE
global.Worker = Worker
const { Viewer, WorldView } = pvViewer

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d }
const VERSION = arg('version', '1.16.5')
const OUT = arg('out', '/tmp/probe.png')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'probe', auth: 'offline', version: VERSION })
let tex = 0
process.on('uncaughtException', e => { if (/texImage2D/.test(e.message)) tex++; else console.log('UNCAUGHT', e.message.slice(0, 160)) })

bot.once('spawn', async () => {
  await sleep(3500)
  const W = 256, H = 256
  const canvas = createCanvas(W, H)
  const renderer = new THREE.WebGLRenderer({ canvas })
  const viewer = new Viewer(renderer)
  viewer.setVersion(VERSION)
  const wv = new WorldView(bot.world, 4, bot.entity.position)
  viewer.listen(wv)
  await wv.init(bot.entity.position)
  // pump update+render so the worker finishes meshing
  for (let i = 0; i < 200; i++) {
    const p = bot.entity.position
    // set camera DIRECTLY (setFirstPersonCamera tweens over 50ms; re-calling it every frame restarts
    // the tween so it never reaches the bot - camera stuck at origin). Eye = pos.y + playerHeight.
    viewer.camera.position.set(p.x, p.y + 1.6, p.z)
    viewer.camera.rotation.set(0.2, bot.entity.yaw, 0, 'ZYX') // pitch slightly down at the ground
    viewer.update()
    renderer.render(viewer.scene, viewer.camera)
    await sleep(15)
  }
  let meshes = 0, verts = 0
  viewer.scene.traverse(o => { if (o.isMesh) { meshes++; const p = o.geometry?.attributes?.position; if (p) verts += p.count } })
  writeFileSync(OUT, canvas.toBuffer('image/png'))
  const { statSync } = await import('node:fs')
  const bytes = statSync(OUT).size
  console.log(`version=${VERSION} meshes=${meshes} verts=${verts} png=${bytes}B texImg2dErrs=${tex} → ${OUT}`)
  console.log(verts > 1000 && bytes > 2500 ? 'NONBLANK' : 'BLANK')
  bot.quit(); process.exit(0)
})
bot.on('error', e => { console.log('bot error:', e.message.slice(0, 120)); process.exit(1) })
