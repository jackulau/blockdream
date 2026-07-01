// PURE CORE of the screen-share bridge: the wire format that streams captured screen frames from
// the browser capture page to the Node bridge. Everything here is side-effect-free data transform
// (the bridge in screenshare-bridge-cli.ts owns the sockets); unit-tested in
// test/screenshare-bridge.test.ts.
//
// A frame is ONE binary WebSocket message, little-endian:
//   [0..1] width  (uint16)   [2..3] height (uint16)   [4..] RGB bytes (width*height*3)
// The fixed 4-byte header keeps the browser encoder trivial (a DataView write) and the decode
// allocation-free (the pixels are a subarray VIEW over the received buffer, handed straight to
// frameToWallCommands as a WallFrame). The paint itself is the existing rcon-bridge core, so a
// screencast paints byte-identically to the world-model stream and the --image cast.

import type { WallFrame } from "./rcon-bridge";

/** Bytes of the fixed frame header (uint16 width + uint16 height). */
export const FRAME_HEADER_BYTES = 4;
/** Largest wall edge the bridge accepts. A uint16 caps it at 65535 anyway; this is the sane bound
 *  (a 1024-block edge is already a 1M-block wall - far past any live paint budget). */
export const MAX_FRAME_EDGE = 1024;

/**
 * Encode a captured RGB frame as one binary message (header + pixels). This mirrors the browser
 * capture page's inline encoder byte-for-byte, so the format has ONE tested definition here.
 * (The page can't import this module - it is served as a standalone string - so this function is
 * the reference the page's DataView writes must match; the round-trip test locks that.)
 */
export function encodeFrameMessage(width: number, height: number, rgb: Uint8Array): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`frame size must be positive integers (got ${width}x${height})`);
  }
  if (width > MAX_FRAME_EDGE || height > MAX_FRAME_EDGE) {
    throw new Error(`frame ${width}x${height} exceeds the ${MAX_FRAME_EDGE} px edge cap`);
  }
  if (rgb.length !== width * height * 3) {
    throw new Error(`rgb length ${rgb.length} != ${width}*${height}*3 (${width * height * 3})`);
  }
  const out = new Uint8Array(FRAME_HEADER_BYTES + rgb.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, width, true);
  dv.setUint16(2, height, true);
  out.set(rgb, FRAME_HEADER_BYTES);
  return out;
}

/**
 * Decode a binary frame message into a {@link WallFrame} the paint core consumes directly. The
 * pixels are a VIEW over `buf` (not a copy), so this is allocation-free on the hot path. Throws on a
 * truncated / oversized / length-mismatched message so the bridge can drop one bad frame and keep
 * streaming (a resized capture just arrives as a new width/height -> a fresh keyframe upstream).
 */
export function decodeFrameMessage(buf: Uint8Array): WallFrame {
  if (buf.length < FRAME_HEADER_BYTES) {
    throw new Error(`frame message ${buf.length} B is shorter than the ${FRAME_HEADER_BYTES} B header`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = dv.getUint16(0, true);
  const height = dv.getUint16(2, true);
  if (width < 1 || height < 1) throw new Error(`bad frame size ${width}x${height}`);
  if (width > MAX_FRAME_EDGE || height > MAX_FRAME_EDGE) {
    throw new Error(`frame ${width}x${height} exceeds the ${MAX_FRAME_EDGE} px edge cap`);
  }
  const need = FRAME_HEADER_BYTES + width * height * 3;
  if (buf.length !== need) throw new Error(`frame message ${buf.length} B != ${need} B expected for ${width}x${height} RGB`);
  return { width, height, pixels: buf.subarray(FRAME_HEADER_BYTES) };
}
