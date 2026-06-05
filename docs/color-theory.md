# mineworld — color palette & matching theory

Research-grounded decisions for matching arbitrary images/video onto Minecraft's
fixed, gamut-limited color set. (Sources at the bottom.)

## Pipeline (per source pixel)
1. sRGB 8-bit → **linear** (gamma decode).
2. linear RGB → **OKLab** (perceptual).
3. **Gamut-map** in OKLCh — hold hue, compress chroma toward what the palette can reach.
4. **Nearest-palette match** by OKLab distance (with a hue penalty — see Decision 2).
5. **Diffuse residual error** in linear/OKLab (never sRGB).
6. Emit palette index (Minecraft block/map id). Gamma re-encode only for previews.

The crux: steps 3–4 must cooperate. Plain nearest-match on a saturated input
picks a muddy, **wrong-hue** color. Pinning hue forces the search onto the right
hue line, sacrificing chroma instead of hue.

## Decision 1 — Perceptual space / ΔE: **OKLab Euclidean**
`ΔE = √(ΔL² + Δa² + Δb²)` on OKLab coords. Optionally weight lightness
(`wL·ΔL² + Δa² + Δb²`, `wL≈1.5–2`) if lightness banding appears.
- **Why not CIEDE2000:** it was validated only for *small* color differences, has
  three mathematical discontinuities, and is expensive. In a matching loop where
  many inputs are far from every palette entry, it extrapolates outside its domain
  and can pick different colors for near-identical inputs → spatial/temporal
  instability. Kept only as an offline benchmark metric.
- **Why not CIELAB ΔE76:** CIELAB's hue non-linearity (blues bend to purple) shifts
  hue exactly where we don't want it.
- OKLab is hue-linear, cheap, continuous for small *and* large diffs.
- **Benchmark result (measured):** matching with OKLab lands within ~15% of CIEDE2000-optimal by the ΔE00 gold standard on saturated content, with no discontinuities — confirming OKLab as the default; CIEDE2000 is kept only as an offline quality metric (`ciede2000`, `deltaE2000Srgb`).

## Decision 2 — Gamut mapping: **OKLCh hold-hue, hue-penalized nearest match**
Convert target to OKLCh `(L, C, h)`. Match by minimizing
`penalty(p) = ΔE_oklab(p, target) + λ_h · wrapHue(h_p − h)²`,
relaxing the hue penalty toward neutral inputs (where `C→0` makes hue meaningless).
- This *is* soft chroma compression: with hue pinned, the closest reachable palette
  point is necessarily lower-chroma → saturated magenta stays magenta, just duller.
- Alternative (smoother gradients, more work): Ottosson adaptive-L₀ chroma
  compression (α=0.05) to the palette's per-hue max chroma, then plain nearest.
- Keep in-gamut colors **exact** — only out-of-gamut inputs get compressed.

OKLCh: `C=√(a²+b²)`, `h=atan2(b,a)`; back: `a=C·cos h`, `b=C·sin h`.

## Decision 3 — Dithering: **serpentine FS (stills) / STBN (video)**
- Stills: **serpentine** Floyd–Steinberg (alternate row direction) — kills the
  directional "worm" artifacts of raster FS, nearly free. Error diffused in
  linear/OKLab. (Already implemented.)
- Video: per-frame FS *boils/crawls* (temporally unstable); independent blue-noise
  flickers. **Spatiotemporal blue noise (STBN)** — a 3D blue-noise mask sliced per
  frame — is spatially blue-noise *and* temporally stable under motion. Preferred
  for moving footage. (Bayer + temporal hysteresis is the current cheaper stand-in.)

## Decision 4 — Gamma: **decode to linear up front**
Decode sRGB→linear (piecewise, threshold 0.04045, exp 2.4) before any averaging or
error diffusion; match in OKLab; encode back only for preview. Light-conserving
operations are only correct in linear space. (Already implemented.)

## Decision 5 — Palette: **map-244 (map path) + 303-block solid set (build path)**
- **Map path** (filled maps): the 244 map-item colors (61 bases × 4 shades) — the
  widest gamut for that surface, tint-free when authored directly.
- **Block-build path:** widen far beyond the 16 concrete using the full
  biome-independent opaque solid set (~303 blocks) from `Joshuadobson/minecraft-tools`
  `blocks.json` (523 blocks, `avg_lab` + flags, ~1.21.5). Filter:
  `full_block && building_block && !transparent && !leaves && !glass`. Colors are
  CIELAB → convert to sRGB. Cross-edition: nearly all solid building blocks exist
  on both editions.
- Both editions: biome-tinted blocks (grass/foliage/water) excluded — their stored
  average is the untinted gray and is wrong for build color.

### Inherent limit (documented, not a bug)
Minecraft blocks are naturally **desaturated** — even 244+303 colors can't reach
pure sRGB primaries (saturated magenta/cyan/yellow). Those get dithered or
hue-compressed. In-gamut content renders excellently; this is the gamut of the
medium, not a defect.

## Sources
- Ottosson, OKLab: https://bottosson.github.io/posts/oklab/
- Ottosson, sRGB gamut clipping (hue-preserving chroma compression): https://bottosson.github.io/posts/gamutclipping/
- Ottosson, Okhsv/Okhsl (OKLCh): https://bottosson.github.io/posts/colorpicker/
- Sharma et al., CIEDE2000 implementation notes: https://hajim.rochester.edu/ece/sites/gsharma/papers/CIEDE2000CRNAFeb05.pdf
- Color difference (ΔE76/94/00): https://en.wikipedia.org/wiki/Color_difference
- Error diffusion / serpentine / blue noise: https://en.wikipedia.org/wiki/Error_diffusion
- Wolfe et al., Spatiotemporal Blue Noise (EGSR 2022): https://arxiv.org/abs/2112.09629
- Block colors data: https://github.com/Joshuadobson/minecraft-tools (`docs/data/blocks.json`)
- RGB fallback: https://github.com/RandomGamingDev/mc_block_color_mapper
- Biome tint reference: https://minecraft.wiki/w/Block_colors
