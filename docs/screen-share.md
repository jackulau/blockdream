# Screen-share into Minecraft

Watch **any screen, window, or browser tab live as a block wall inside Minecraft.** You share your
screen the same way you would on a video call; the bridge relays every frame into a running vanilla
world over RCON. No mod, no datapack, no client plugin - RCON is the transport, the same one the
world-model cast (`docs/live-cast.md`) and the `--image` / `--build` casts use.

```
  browser page                 bridge (Node, one port)              vanilla server
  getDisplayMedia  --WS RGB-->  frameToWallCommands + RconPool  --setblock/fill-->  a live block wall
   (share a screen)             (delta + budget carry)             (walk up and watch)
```

## What you need

1. **A running vanilla server with RCON.** One command, prints the RCON password once:
   ```
   bash scripts/vanilla-server.sh
   ```
   (Any 1.20+ server with `enable-rcon=true` works; you just need its host/port/password.)
2. **A browser** to run the capture page (Chrome/Edge/Firefox - anything with `getDisplayMedia`).
   The page is served from `localhost`, which counts as a secure context, so screen capture is allowed.

## Run it

```
scripts/cast-screen.sh --rcon-pass <pw>
```

It prints a URL (default `http://127.0.0.1:8770`). Open it, click **"Share a screen"**, and pick a
screen / window / tab. The wall appears at `--origin` (default `10,-60,10`, ground level near a
superflat spawn) and updates live. Walk up to it in-game.

Placement and size are yours:

```
scripts/cast-screen.sh --rcon-pass <pw> --origin 100,70,-20 --facing east --setup
scripts/cast-screen.sh --rcon-pass <pw> --size 160x90 --fps 8
```

- `--origin x,y,z` - the wall's bottom-left block.
- `--facing north|south|east|west` - which plane the wall sits in.
- `--size WxH` - wall size in blocks (default `128x72`, 16:9). The page downscales your screen to
  this grid, so **match your screen's aspect ratio** to avoid squish (a full 16:9 monitor fits 128x72
  exactly). Bigger = more detail but more blocks to paint.
- `--fps n` - max paint rate (default 6). A screencast is ~97% static, so only the parts that change
  cost commands; the delta encoder makes a still screen nearly free.
- `--setup` - clear the wall volume + a few blocks of viewing clearance once before the first frame.
- `--dry-run` - serve the page and accept frames but send no RCON (prints per-frame command counts).

Everything is local: the captured frames go to a loopback port and into your own server. Nothing is
uploaded.

## How it works

- **The capture page** (`packages/cli/src/screenshare-page.ts`) is served by the bridge itself - a
  single dependency-free HTML/JS page. `getDisplayMedia` gives it a `MediaStream`; each tick it draws
  the video into a tiny `WxH` canvas (the block grid), reads the pixels, and streams them as one
  compact binary WebSocket message (`uint16 width`, `uint16 height`, then RGB). The same canvas,
  scaled up with pixelated rendering, is the live preview - what you see there is exactly the
  resolution that reaches Minecraft.
- **The wire format** (`packages/cli/src/screenshare-bridge.ts`) is one tested definition
  (`encodeFrameMessage` / `decodeFrameMessage`); the page's hand-written encoder matches it byte-for-byte.
- **The bridge** (`packages/cli/src/screenshare-bridge-cli.ts`) opens one port for both the page (HTTP)
  and the frames (WebSocket). A pump keeps the newest frame in hand and paints it at most `--fps`
  times a second as a **delta** against the last painted frame, carrying any over-budget cells to the
  next frame - the exact `frameToWallCommands` + `RconPool` contract the world-model and `--image`
  casts use, so a screencast paints byte-identically to them.

`http://127.0.0.1:8770/stats` returns live JSON (frames received / painted, connected clients, last
command count, carry backlog) if you want to watch the pipeline.

## Notes and limits

- **Aspect ratio:** the grid is fixed by `--size`; a source with a different aspect is squished into
  it. Pick a `--size` that matches what you share (16:9 monitor -> `128x72`, `160x90`, ...).
- **Audio** is not streamed (video only).
- **Rate:** the honest ceiling is the server executing `setblock`/`fill` on its main thread plus RCON
  round-trips; `--rcon-conns` parallel connections paint a frame concurrently (see `docs/fps-budget.md`).
  A static screen is nearly free; a full-screen video is the worst case.
- **Native desktop app:** not needed - `getDisplayMedia` in the browser already captures any screen,
  window, or tab, and the bridge + page is exactly the engine a native wrapper (Electron/Tauri) would
  embed. Packaging one is a clean follow-up if you want a dock icon instead of a browser tab.
