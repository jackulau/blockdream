// Shim for node-canvas-webgl built on the (working) `canvas` + `gl` packages.
// node-canvas-webgl's own native build fails on this machine, but canvas (3.x) + headless-gl (8.x)
// both build + run, so we bridge them: prismarine-viewer's headless renderer asks for createCanvas,
// renders the THREE scene into a headless-gl WebGL1 context, then encodes via node-canvas's
// createJPEGStream — so we readPixels from gl and blit (vertically flipped) onto the 2D surface
// before each encode. Faithful to the API prismarine-viewer/lib/headless.js uses (createCanvas,
// canvas.getContext('webgl'), canvas.createJPEGStream, canvas.toBuffer, loadImage).
const Canvas = require('canvas')
const createGL = require('gl')

// Extract RGBA pixels from a texture source (ImageData | node-canvas Canvas | Image) so headless-gl's
// raw texImage2D overload can consume it — headless-gl has no DOM, so the (…, source) overload throws.
function toPixels (source) {
  if (!source) return { width: 0, height: 0, data: new Uint8Array(0) }
  if (source.data && source.width != null) { // ImageData
    return { width: source.width, height: source.height, data: new Uint8Array(source.data.buffer || source.data) }
  }
  const w = source.width, h = source.height
  const c = Canvas.createCanvas(w, h)
  const ctx = c.getContext('2d')
  ctx.drawImage(source, 0, 0) // Canvas/Image → 2D surface
  return { width: w, height: h, data: new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer) }
}

function patchTextures (gl) {
  const tex = gl.texImage2D.bind(gl)
  gl.texImage2D = function (...a) {
    if (a.length === 6) { // (target, level, internalformat, format, type, source) DOM overload
      const [t, l, ifmt, fmt, type, src] = a
      const p = toPixels(src)
      return tex(t, l, ifmt, p.width, p.height, 0, fmt, type, p.data)
    }
    return tex(...a)
  }
  const sub = gl.texSubImage2D.bind(gl)
  gl.texSubImage2D = function (...a) {
    if (a.length === 7) { // (target, level, xoff, yoff, format, type, source) DOM overload
      const [t, l, xo, yo, fmt, type, src] = a
      const p = toPixels(src)
      return sub(t, l, xo, yo, p.width, p.height, fmt, type, p.data)
    }
    return sub(...a)
  }
}

function createCanvas (width, height) {
  const canvas = Canvas.createCanvas(width, height)
  const gl = createGL(width, height, { preserveDrawingBuffer: true })
  patchTextures(gl)

  const native2d = canvas.getContext.bind(canvas)
  canvas.getContext = function (type, attrs) {
    if (type === 'webgl' || type === 'experimental-webgl') {
      gl.canvas = canvas
      return gl
    }
    if (type === 'webgl2') return null // headless-gl is WebGL1 → let THREE fall back to webgl1
    return native2d(type, attrs)
  }
  // THREE's WebGLRenderer registers context-loss listeners on the canvas.
  canvas.addEventListener = canvas.addEventListener || (() => {})
  canvas.removeEventListener = canvas.removeEventListener || (() => {})

  // gl renders bottom-up RGBA → flip onto the node-canvas 2D surface so JPEG/PNG encode the frame.
  function blit () {
    const ctx = native2d('2d')
    const px = new Uint8Array(width * height * 4)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px)
    const img = ctx.createImageData(width, height)
    const row = width * 4
    for (let y = 0; y < height; y++) {
      img.data.set(px.subarray((height - 1 - y) * row, (height - y) * row), y * row)
    }
    ctx.putImageData(img, 0, 0)
  }

  const jpeg = canvas.createJPEGStream.bind(canvas)
  canvas.createJPEGStream = function (opts) { blit(); return jpeg(opts) }
  const png = canvas.createPNGStream.bind(canvas)
  canvas.createPNGStream = function (opts) { blit(); return png(opts) }
  const toBuffer = canvas.toBuffer.bind(canvas)
  canvas.toBuffer = function (...a) { blit(); return toBuffer(...a) }
  return canvas
}

module.exports = { createCanvas, loadImage: Canvas.loadImage, Canvas: Canvas.Canvas, Image: Canvas.Image }
