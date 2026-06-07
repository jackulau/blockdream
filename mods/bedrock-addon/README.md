# blockdream Block-Art Player — Bedrock addon (Script API)

Bedrock's **best-available "native" real-time** path. The Bedrock Script API
cannot paint map items, so true video-on-maps is not reachable in vanilla
Bedrock; this drives the **solid-block wall** instead, with smoother scheduling
and batching than raw command blocks (the `behaviorpack` target).

## Status
**Code complete; operator-import.** Not runnable in the blockdream CI sandbox
(no Bedrock client). To use:

1. Generate the pack from any GIF/video:
   ```
   blockdream render clip.gif --target bedrock-script --grid 64x64 --out my_addon/
   ```
   → `behavior_pack/{manifest.json, scripts/main.js, scripts/frames.js}`
2. Zip `behavior_pack/` as a `.mcpack` (or drop into
   `behavior_packs/`), enable it on a world with the **Beta APIs** experiment on.
3. Build the block wall area, then in chat: `!mw start` (`!mw stop`, `!mw reset`).

## Files
- `behavior_pack/manifest.json` — script module + `@minecraft/server` dependency.
- `behavior_pack/scripts/main.js` — `system.runInterval` loop applying per-frame
  delta cells via `block.setPermutation`. Mirrors
  `@blockdream/emit-commands` `BEDROCK_PLAYER_JS` (the generator's source of truth).
- `behavior_pack/scripts/frames.js` — **example** `POOL` data; regenerate per clip.

> The static files here are a runnable example. The canonical generator is
> `generateBedrockScriptAddon` in `@blockdream/emit-commands`.
