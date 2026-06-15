"""Boat (and every movement type) is REALLY conditioned, not a dead embedding:
 1. the synthetic per-skill data generator makes skill-distinct clips (boat is bluer than walk);
 2. a short train of the real SkillRealEncoder + ARTransition makes the rollout for skill=boat
    differ from skill=walk AND each match its own skill's dynamics.
"""

import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import gen_movement_data as gmd  # noqa: E402
import prove_skill_conditioning as psc  # noqa: E402


def test_generator_makes_skill_distinct_data():
    walk_f, walk_a = gmd.gen_sequence("walk", length=24, size=24, seed=1)
    boat_f, boat_a = gmd.gen_sequence("boat", length=24, size=24, seed=1)
    assert walk_f.shape == (24, 24, 24, 3) and walk_f.dtype == np.uint8
    assert walk_a.shape == (24, gmd.ACTION_DIM)
    # boat's colour cast is water-blue, walk's is grass-green → mean channels differ in the right way
    assert boat_f[..., 2].mean() > walk_f[..., 2].mean(), "boat should be bluer"
    assert walk_f[..., 1].mean() > boat_f[..., 1].mean(), "walk should be greener"
    # the two regimes are not the same pixels
    assert not np.array_equal(walk_f, boat_f)


def test_writes_trainer_compatible_pools(tmp_path):
    path = gmd.write_pool(str(tmp_path), "boat", segments=2, length=8, size=16)
    p = Path(path)
    assert (p / "skill.txt").read_text() == "boat"
    segs = sorted(p.glob("seg_*.npz"))
    assert len(segs) == 2
    d = np.load(segs[0])
    assert d["frames"].shape == (8, 16, 16, 3) and d["actions"].shape == (8, gmd.ACTION_DIM)


def test_skill_conditioning_changes_the_rollout():
    # short but sufficient: the per-skill token shift is trivially learnable
    enc, ar = psc.train(steps=300, batch=32, seed=0)
    torch.manual_seed(7)
    prev = torch.randint(0, psc.K, (1, psc.N))
    gen_walk = psc.rollout(enc, ar, prev, "walk")
    gen_boat = psc.rollout(enc, ar, prev, "boat")
    differ = (gen_walk != gen_boat).float().mean().item()
    acc_walk = (gen_walk == psc._next(prev.view(-1), "walk")).float().mean().item()
    acc_boat = (gen_boat == psc._next(prev.view(-1), "boat")).float().mean().item()
    cross = (gen_boat == psc._next(prev.view(-1), "walk")).float().mean().item()
    assert differ >= 0.5, f"boat and walk rollouts barely differ ({differ:.2f}) - conditioning not learned"
    assert acc_walk >= 0.6 and acc_boat >= 0.6, f"rollouts don't match their skill dynamics ({acc_walk:.2f},{acc_boat:.2f})"
    assert acc_boat > cross + 0.2, "boat rollout follows walk dynamics - skill is being ignored"
