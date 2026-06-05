import numpy as np

from mineworld_wm.data_pool import load_pools
from mineworld_wm.movement import skill_id


def _pool(d, skill, T=5, S=32, seed=0):
    d.mkdir(parents=True, exist_ok=True)
    (d / "skill.txt").write_text(skill)
    rng = np.random.default_rng(seed)
    np.savez_compressed(d / "seg_00000.npz",
                        frames=rng.integers(0, 255, (T, S, S, 3)).astype(np.uint8),
                        actions=np.zeros((T, 11), np.float32))


def test_combine_two_tagged_pools(tmp_path):
    _pool(tmp_path / "walk", "walk", T=5)
    _pool(tmp_path / "boat", "boat", T=4, seed=1)
    frames, actions, pairs, skills = load_pools([str(tmp_path / "walk"), str(tmp_path / "boat")])

    assert frames.shape[0] == 9
    # per-frame skill ids: first 5 = walk, next 4 = boat
    assert (skills[:5] == skill_id("walk")).all()
    assert (skills[5:] == skill_id("boat")).all()
    # within-segment pairs only: 4 (walk: 5-1) + 3 (boat: 4-1) = 7, none crossing index 4↔5
    assert len(pairs) == 7
    assert not any(p[0] == 4 and p[1] == 5 for p in pairs)
    # pairs are offset into the combined array (boat pairs reference indices ≥5)
    assert pairs.max() == 8
