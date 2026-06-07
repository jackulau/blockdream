import torch

from blockdream_wm.demos import DEMOS, build_demo_session


def test_five_demos_registered():
    assert set(DEMOS) == {"walking", "boat", "elytra", "world", "gameplay"}


def test_demo_action_subsets_and_backbones():
    # boat/elytra expose fewer buttons than the general models
    assert len(DEMOS["boat"].active_buttons) < len(DEMOS["world"].active_buttons)
    assert len(DEMOS["elytra"].active_buttons) < len(DEMOS["walking"].active_buttons)
    # browser lineage vs server lineage
    assert DEMOS["walking"].kind == "diffusion" and DEMOS["boat"].kind == "diffusion" and DEMOS["elytra"].kind == "diffusion"
    assert DEMOS["world"].kind == "ar" and DEMOS["gameplay"].kind == "ar"


def test_every_demo_instantiates_and_steps_once():
    for name in DEMOS:
        session, spec = build_demo_session(name, seed=1)
        session.reset()
        buttons = torch.ones(spec_n_buttons := 9)  # full input; the demo masks inactive ones
        camera = torch.tensor([0.3, -0.2])
        res = session.step(buttons, camera)
        assert res.step == 1
        assert res.frame.shape == (3, 32, 32), f"{name} frame shape {tuple(res.frame.shape)}"
        assert torch.isfinite(res.frame).all(), f"{name} produced non-finite frame"


def test_skill_conditioning_changes_action_embedding():
    # two demos with the same buttons/camera should still differ via the skill bias
    s_world, _ = build_demo_session("world", seed=2)
    s_play, _ = build_demo_session("gameplay", seed=2)
    b = torch.ones(1, 9)
    c = torch.zeros(1, 2)
    e_world = s_world.enc(b, c)
    e_play = s_play.enc(b, c)
    assert not torch.allclose(e_world, e_play)
