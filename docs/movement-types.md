# Movement types - covering all Minecraft locomotion

The world model is **conditioned on a movement type** (skill) so one model covers
every locomotion regime, selectable live in the tester. Walking is not enough -
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
   **IDM** to label actions - `docs/real-world-models.md`).
2. Build a tagged pool: `python -m blockdream_wm.data_pool --segments N --skill elytra --out ml/data/pool_elytra`
   (today this pulls from the VPT index; point it at your own clips for real elytra data).
3. Train/extend: `train_long --pools ml/data/pool_m4,ml/data/pool_elytra …` - the
   conditioned model learns each type; resume keeps prior types.

## Synthetic per-skill data (so conditioning is trainable + provable NOW)

Real boat/elytra footage is scarce, which previously left those skill embeddings
**untrained** (selecting "boat" did nothing). To make conditioning trainable and provable
without that footage, `scripts/gen_movement_data.py` generates per-skill pools with DISTINCT,
learnable dynamics (different scroll speed + colour cast + bob), in the exact on-disk format
the real trainer consumes - so real footage drops into the same layout to scale up.

```bash
# 1. generate per-skill synthetic pools (trainer-compatible: frames + actions + skill.txt)
python scripts/gen_movement_data.py --skills walk,boat,elytra,swim,pig --segments 8 --len 64 --size 64 --out data
# 2. train one conditioned model across them (resume-safe)
python -m blockdream_wm.train_long --pools data/pool_synth_walk,data/pool_synth_boat,data/pool_synth_elytra
# 3. PROVE the skill actually changes the rollout (boat != walk):
python scripts/prove_skill_conditioning.py        # → "verdict: DISTINCT", exit 0
```

`prove_skill_conditioning.py` trains the **real** `SkillRealEncoder + ARTransition` on a tiny
task and shows skill=boat vs skill=walk roll out differently and each matches its own
dynamics - the mechanism the multi-day trainer relies on, verified in seconds (also
`tests/test_skill_conditioning.py`).

## Honest status
- The conditioning + per-type pipeline is **built, tested, and proven** - selecting boat vs
  walk measurably changes the rollout (`prove_skill_conditioning.py` → DISTINCT).
- For **photoreal** boat/elytra/etc., add real footage (table above) into the same pool
  layout; the synthetic generator unblocks training + the demo today, real footage raises
  fidelity. The infra ingests either - the blocker was data, and the synthetic path removes it.
