# Cushions (Minecraft Java 26.3 snapshot) — what they are, and what they are NOT

Research date: 2026-07-11. Primary source: [minecraft.wiki/w/Cushion](https://minecraft.wiki/w/Cushion)
and [minecraft.wiki/w/Java_Edition_26.3_Snapshot_3](https://minecraft.wiki/w/Java_Edition_26.3_Snapshot_3).
(The official minecraft.net changelog timed out during research; every fact below is wiki-sourced.
Facts are separated into **verified** and **not documented** — nothing here is invented.)

## The headline, first

**Cushions are ENTITIES, not blocks.** They are flat, quarter-block-tall sitting pads that can
only rest on **top** of horizontal surfaces. A vertical 16-color "cushion pixel wall" — the
RGB-wall idea — is **not buildable** in this snapshot. The closest honest use of cushions for
image visualization is a **top-down floor mosaic** (see the experimental mode below), and even
that is an entity-count stress test, not a normal block build.

## Verified facts (wiki-sourced)

| Fact | Detail | Source |
|---|---|---|
| Status | Snapshot-only: added in **Java 26.3 Snapshot 3** (2026-07-07), "Third Drop 2026" cozy-camping theme; also Bedrock Preview 26.40.30 | wiki: Cushion § History; Snapshot 3 page |
| Kind | *"A cushion is a placeable entity."* Entity ID `cushion`, entity data: `block_pos` (Int Array), `color` (String) | wiki: Cushion |
| Purpose | *"A new entity that players can interact with to sit on."* | wiki: Snapshot 3 changelog |
| Colors | **16** (full dye set). Item IDs: `white_cushion, orange_cushion, magenta_cushion, light_blue_cushion, yellow_cushion, lime_cushion, pink_cushion, gray_cushion, light_gray_cushion, cyan_cushion, purple_cushion, blue_cushion, brown_cushion, green_cushion, red_cushion, black_cushion`. One entity type; color is entity data, not per-ID block states | wiki: Cushion |
| Size | Height **0.25**, width **1.0** — a flat pad covering a full 1×1 top face | wiki: Cushion |
| Physics | No collision; cannot move (except teleport); can overlap other objects but not other cushions; breaks if support block removed / piston push / any attack; always drops itself | wiki: Cushion |
| Placement | *"Cushions can be placed on any flat surface"*, on top of virtually every block except fluids and a few invisible blocks — **horizontal top faces only, never walls** | wiki: Cushion |
| Crafting | 3 matching-color **wool slabs** (horizontal row) → 1 cushion | wiki: Cushion + Snapshot 3 |
| Formats | Snapshot 3: resource pack format **91.0**, data pack format **110.0**, data version **5001** | wiki: Snapshot 3 |

## NOT documented (unknowns — do not assume)

- **Map color: none listed.** The cushion has an entity infobox, not a block infobox; no
  map-rendering behavior is documented. Cushion art would NOT appear on in-game maps as far as
  anything published shows.
- **Light: nothing.** No luminance value, no documented interaction with `minecraft:light`
  or any light block, no glow behavior. (The "cushions on light blocks become LEDs" idea has
  **zero basis** in the snapshot changelog or wiki — see also `docs/video-import.md`'s LED
  section for the honest vanilla light-plane equivalent.)
- **Render color values:** the wiki does not publish the cushions' texture RGB values. Any
  palette below uses the corresponding **dye/wool colors as an approximation** and says so.
- Waterlogging, blast resistance, redstone interaction, bounce/slowdown: not listed. (The
  bouncy mechanic in 26.3 belongs to Shelf Mushrooms, not cushions.)
- **Summon NBT syntax** (`summon cushion … {color:"red"}`) follows the documented entity data
  fields but has **not been executed against a live 26.3 snapshot server** by this repo's e2e
  (the pinned test server is a release build). The experimental mode below is honest about this.

## What blockdream ships because of this

- `packages/palette/src/cushions.ts` — the 16 cushion colors (dye-approximated RGB, labeled as
  such), the snapshot pack/data formats, and a **floor-mosaic** command generator: one
  `summon minecraft:cushion` per pixel, laid flat on a floor plane, top-down viewing.
- Everything is gated behind an **explicit experimental opt-in** (`--cushion-mosaic` in the
  CLI). It is not part of the release version registry: registry entries stay release-only
  (snapshot formats change weekly), and the mosaic function file carries a header warning that
  it targets the 26.3 snapshot only.
- Practical ceiling: every pixel is a separate no-collision entity. A 64×48 image is 3,072
  entities — near the sane limit; the generator caps and tells you when it truncates.

**Bottom line:** for a real color *wall* on any version, the honest materials remain blocks
(the `--wall` palette build) or the TRUE-RGB `text_display` screen (`--target rgbscreen`).
Cushions are furniture-style flat pads; the mosaic mode exists as the closest honest "another
way of visualizing" they support.
