"""Unit tests for the skill-divergence aux loss (goal 034, the 128px skill-collapse fix).

Pure CPU tensor math - no model, no MPS, runs in milliseconds. Locks the contract that the
training loop relies on: the term is OFF by default, penalizes a model whose wrong-skill
prediction is not sufficiently worse than the true-skill one, and its gradient pushes the
wrong-skill CE up (i.e. forces the movement-type embedding to matter).
"""
import torch

from blockdream_wm.train_long import skill_divergence_loss


def test_off_by_default_returns_plain_ce():
    ce_true, ce_wrong = torch.tensor(2.0), torch.tensor(1.0)
    # weight 0 -> plain CE, regardless of ce_wrong (backward-compatible: existing runs unchanged)
    assert torch.allclose(skill_divergence_loss(ce_true, ce_wrong, 0.0, 0.5), ce_true)
    assert torch.allclose(skill_divergence_loss(ce_true, ce_wrong, -1.0, 0.5), ce_true)


def test_full_penalty_when_wrong_skill_predicts_equally_well():
    # ce_wrong == ce_true -> the skill embedding is being ignored -> full margin penalty
    ce_true = ce_wrong = torch.tensor(2.0)
    # 2.0 + 1.0 * relu(0.5 - 0.0) = 2.5
    assert torch.allclose(skill_divergence_loss(ce_true, ce_wrong, 1.0, 0.5), torch.tensor(2.5))


def test_no_penalty_once_wrong_skill_is_worse_by_margin():
    # wrong skill worse by > margin -> hinge saturates to 0 -> total == ce_true (goal achieved)
    ce_true, ce_wrong = torch.tensor(2.0), torch.tensor(2.6)  # gap 0.6 > margin 0.5
    assert torch.allclose(skill_divergence_loss(ce_true, ce_wrong, 1.0, 0.5), ce_true)


def test_weight_scales_the_penalty():
    ce_true = ce_wrong = torch.tensor(2.0)
    # SKILL_DIV=3.0 (goal 034's stronger push) -> 2.0 + 3.0 * 0.5 = 3.5
    assert torch.allclose(skill_divergence_loss(ce_true, ce_wrong, 3.0, 0.5), torch.tensor(3.5))


def test_gradient_pushes_wrong_skill_ce_up():
    # minimizing the loss must drive ce_wrong AWAY from ce_true (make the wrong skill predict worse),
    # which is exactly "use the movement-type embedding". In the active hinge region d(loss)/d(ce_wrong) < 0.
    ce_true = torch.tensor(2.0, requires_grad=True)
    ce_wrong = torch.tensor(2.0, requires_grad=True)
    skill_divergence_loss(ce_true, ce_wrong, 1.0, 0.5).backward()
    assert ce_wrong.grad.item() < 0   # gradient descent increases ce_wrong
    assert ce_true.grad.item() > 0    # and the true-skill CE is still minimized (1 + margin-grad)
