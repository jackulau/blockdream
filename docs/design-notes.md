# Blockdream — design notes

The web demo's visual language, grounded in Japanese design tradition. This is the *why* behind the
tokens in [`apps/web/src/style.css`](../apps/web/src/style.css). The goal is restraint — a quiet,
crafted product page, not a loud "AI-slop technical demo" (generic gradients, competing accents,
cramped boxes).

## Principles → moves

| Principle | Source | What it means | Move on Blockdream |
|---|---|---|---|
| **Emptiness (ku 空) + restraint** | Kenya Hara, art director of MUJI — design by pruning anything extraneous; "emptiness" invites rather than decorates ([Dezeen interview](https://www.dezeen.com/2017/12/13/kenya-hara-exclusive-interview-muji-us-expansion-brand-aesthetic/), [blakecrosley](https://blakecrosley.com/blog/design-philosophy-kenya-hara)) | Beauty by subtraction; leave room. | Remove the blue radial-glow background; drop the second (cyan) accent so there is exactly one; let the work (the blocks) be the focus, not the chrome. |
| **Ma (間) — negative space** | A core pillar of Japanese minimalism; negative space is an *active* element that prevents cognitive overload ([shizenstyle](https://www.shizenstyle.com/post/the-three-pillars-of-japanese-minimalism-beyond-the-trends), [fireart](https://fireart.studio/blog/japanese-minimalism-in-ui-design-for-digital-products/)) | Intervals and breathing room carry meaning. | A real spacing scale (`--space-*`, 8px base) widening to large section rhythm (`--space-9/10`); generous line-height (1.65); a bounded measure (~68ch) so text breathes. |
| **Kanso (簡素) — simplicity** | "Things expressed plain, simple, natural"; one clear focus, generous whitespace ([presentationzen](https://presentationzen.com/blog/7-japanese-aesthetic-principles-to-change-your-thinking)) | Eliminate clutter. | Hairline borders over filled boxes; flat BOM rows separated by rules, not zebra-striped cards; one primary action per section. |
| **Shibui (渋い) — understated elegance** | Quiet, refined taste; subdued palettes ([shizenstyle](https://www.shizenstyle.com/post/the-three-pillars-of-japanese-minimalism-beyond-the-trends)) | Sophistication without shouting. | Jade accent `#63bd84` instead of neon GitHub-green `#56d364`; muted ink-dim greys for secondary text. |
| **Wabi-sabi** | Beauty in natural, imperfect, weathered things ([silphiumdesign](https://silphiumdesign.com/wabi-sabi-web-design-understanding-imp-prin/)) | Natural over synthetic. | Warm-neutral *sumi* ink ground and a warm off-white *washi* ink (`#ecebe6`, not pure `#fff`); subtle warm vignette, not a cold tech-navy. |
| **Motion modeled on the natural world** | Yugo Nakamura / tha ltd — interactions feel familiar because their behavior is modeled on natural complexity ([Wikipedia](https://en.wikipedia.org/wiki/Yugo_Nakamura), [tha.jp](https://tha.jp/)) | Restrained, physical, purposeful motion. | Natural `ease-out` curves; short durations (120–480ms); reveal-on-scroll is a small fade+rise, hover is a 1px lift — nothing bounces or autoplays; honors `prefers-reduced-motion`. |

## Tokens (reference)

**Color — sumi ink ground, washi-paper ink, one jade accent**
- `--bg #0f0f11` · `--surface #16171b` · `--surface-2 #1b1d22` — three quiet layers, near-black, faintly warm.
- `--line #24262c` · `--line-2 #30333a` — low-contrast hairlines (restraint; structure without weight).
- `--ink #ecebe6` (≈16:1 on `--bg`) · `--ink-dim #a4a39c` (≈8:1, body-safe) · `--ink-faint #74736c` (≈3.6:1 — meta/large only).
- `--accent #63bd84` (≈7:1 on `--bg`) · `--accent-2 #7ccf99` (hover) · `--accent-soft` (focus/selection bed). **One** accent — the old cyan `--link` now folds into it.

**Type — system sans + mono, modular ~1.25 scale**
- `--font-sans` (system-ui first → no webfont cost) for UI/headings; `--font-mono` for the technical bits (HUD, BOM counts, block ids, section numbers).
- Sizes `--text-xs … --text-3xl` (12 → 48px). Headings `--leading-tight` (1.15) + `--tracking-tight`; small labels/mono get `--tracking-wide` (+0.08em). Body `--leading` 1.65.

**Spacing (Ma) — 8px base** `--space-1 … --space-10` (4 → 160px). `--measure` 68ch, `--container` 1080px.

**Form/radius** small radii only (`--radius-sm 3`, `--radius 6`, `--radius-lg 10`) — crafted, not bubbly.

**Motion** `--ease-out` / `--ease-in-out` / `--ease-spring`; `--dur-fast/–/–slow` (120/240/480ms).

## Top changes (ranked by visual impact)

1. **Kill the blue radial glow.** Replace the cold navy `radial-gradient(... #18222e ...)` with a calm warm-neutral vignette — the single biggest "stop looking AI-generated" move.
2. **One accent, not two.** Fold the cyan `--link` into the jade `--accent`; recolor it from neon `#56d364` to a quieter `#63bd84`.
3. **Breathe (Ma).** Raise section rhythm to `--space-9` and give the hero `--space-10` of headroom; cap text at `--measure`.
4. **Hairlines, not boxes.** Cards/sections lose heavy 12px-radius filled panels in favor of hairline rules + whitespace; BOM loses zebra stripes for hairline-separated rows.
5. **Typographic hierarchy.** Apply the modular scale; tighten heading tracking; set the section number ("01") as small `--tracking-wide` mono in the accent above a larger ink title, with a hairline rule under the header.
6. **Crafted controls.** Buttons/inputs/selects: `--surface-2` wells, hairline borders, small radii, custom select caret, an accent focus ring; hover is a subtle accent border + 1px lift, no transform circus.
7. **Restrained motion.** Reveal sections on scroll (fade + small rise, `--ease-out`); confine the only "spring" to a single deliberate moment; respect reduced-motion.
8. **Mono for the technical voice.** Keep mono strictly for machine output (HUD, counts, ids, code) so the sans/mono contrast itself signals "human copy vs machine data".
