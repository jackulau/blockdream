# Movement types — covering all Minecraft locomotion

The world model is **conditioned on a movement type** (skill) so one model covers
every locomotion regime, selectable live in the tester. Walking is not enough —
elytra glide, boat steering, pig mount, and swimming have distinct dynamics.

Types (`movement.py`): `general, walk, sprint, jump, swim, boat, elytra, pig, minecart`.

## How conditioning works
- Each **training pool is tagged** with a movement type (`data_pool --skill <type>` →
  `pool/skill.txt`). `train_long --pools poolA,poolB,…` combines tagged pools and
  conditions every sample on its pool's type (`SkillRealEncoder` = action encoder +
  a learned per-type embedding).
- The server/tester select the type at runtime (the tester's demo dropdown →
  `{skill: "elytra"}` in each message → `session.skill`). One checkpoint, all types.

## The data reality (the hard part)
A model only learns a movement type it has **data** for. Our current VPT
`all_10xx` contractor data is **early-game walking/mining** (measured: forward 37%,
sprint 19%, attack 45%, **no elytra/boat/pig**). So each type needs its own footage:

| Type | Where to get footage | Notes |
|---|---|---|
| general / walk / sprint / jump | **VPT `all_10xx`** (have it) | contractor early-game; the running pool |
| swim | VPT (water segments) or YouTube | sparse in contractor data |
| **boat** | YouTube "minecraft boat" + IDM-label, or VPT broad web data | not in 10xx |
| **elytra** | YouTube "minecraft elytra flying" + IDM-label | end-game; absent from contractor |
| **pig / mount** | YouTube "minecraft pig/horse riding" + IDM-label | rare |
| minecart | YouTube "minecraft minecart" + IDM-label | rare |

**Pipeline to add a type:**
1. Get clips of that movement (download to mp4 + actions, or YouTube + the VPT
   **IDM** to label actions — `docs/real-world-models.md`).
2. Build a tagged pool: `python -m mineworld_wm.data_pool --segments N --skill elytra --out ml/data/pool_elytra`
   (today this pulls from the VPT index; point it at your own clips for real elytra data).
3. Train/extend: `train_long --pools ml/data/pool_m4,ml/data/pool_elytra …` — the
   conditioned model learns each type; resume keeps prior types.

## Honest status
- The conditioning + per-type pipeline is **built and tested**. The conditioned
  multi-day run trains the `general`/`walk` regime from VPT.
- `boat`/`elytra`/`pig`/etc. will only generate well **once you add their footage**
  — VPT contractor data doesn't contain them. The infra is ready to ingest it; the
  blocker is data, not code.
