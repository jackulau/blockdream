"""Prove the movement-type (skill) conditioning ACTUALLY changes the model's rollout -
i.e. selecting "boat" vs "walk" produces measurably different generated frames, not the same
output behind a never-trained embedding.

To be fast + reliable (no flaky image-tokenizer training), this trains the REAL conditioning
modules - SkillRealEncoder + ARTransition - on a tiny token-level task where each skill has a
DISTINCT learnable dynamics (walk shifts tokens by +1/step, boat by +5/step). After a short
train, it rolls out from the SAME seed with skill=walk vs skill=boat and checks the rollouts
differ AND each matches its own skill's dynamics better than the other's. Prints DISTINCT/SAME.

(The on-disk image data path for the real trainer is scripts/gen_movement_data.py; this proves
the conditioning mechanism the trainer relies on.)
"""

from __future__ import annotations

import sys

import torch

from blockdream_wm.config import ActionConfig, DynamicsConfig
from blockdream_wm.movement import SkillRealEncoder, skill_id
from blockdream_wm.transition_ar import ARTransition

K = 16          # codebook size
GRID = 6        # 6x6 = 36 tokens/frame
N = GRID * GRID
DIM = 32
SHIFT = {"walk": 1, "boat": 5}  # per-skill token dynamics: next = (prev + shift) % K


def _next(prev: torch.Tensor, skill: str) -> torch.Tensor:
    return (prev + SHIFT[skill]) % K


def train(steps: int = 500, batch: int = 32, seed: int = 0) -> tuple[SkillRealEncoder, ARTransition]:
    torch.manual_seed(seed)
    enc = SkillRealEncoder(ActionConfig(embed_dim=DIM))
    ar = ARTransition(DynamicsConfig(kind="ar", dim=DIM, depth=2, heads=4), n_tokens=N, codebook_size=K, action_dim=DIM)
    opt = torch.optim.Adam([*enc.parameters(), *ar.parameters()], lr=3e-3)
    buttons = torch.zeros(batch, 9)
    buttons[:, 0] = 1.0  # forward
    camera = torch.zeros(batch, 2)
    names = list(SHIFT)
    for _ in range(steps):
        prev = torch.randint(0, K, (batch, N))
        sk = torch.randint(0, len(names), (batch,))
        nxt = torch.stack([_next(prev[i], names[sk[i]]) for i in range(batch)])
        ids = torch.tensor([skill_id(names[j]) for j in sk])
        action_emb = enc(buttons, camera, skill=ids)
        loss = ar.loss(prev, nxt, action_emb)
        opt.zero_grad()
        loss.backward()
        opt.step()
    return enc, ar


@torch.no_grad()
def rollout(enc: SkillRealEncoder, ar: ARTransition, prev: torch.Tensor, skill: str) -> torch.Tensor:
    b = torch.zeros(1, 9)
    b[:, 0] = 1.0
    emb = enc(b, torch.zeros(1, 2), skill=skill_id(skill))
    return ar.generate(prev, emb).view(-1)


def main() -> int:
    enc, ar = train()
    torch.manual_seed(123)
    prev = torch.randint(0, K, (1, N))
    gen_walk = rollout(enc, ar, prev, "walk")
    gen_boat = rollout(enc, ar, prev, "boat")

    differ = (gen_walk != gen_boat).float().mean().item()
    tgt_walk, tgt_boat = _next(prev.view(-1), "walk"), _next(prev.view(-1), "boat")
    acc_walk = (gen_walk == tgt_walk).float().mean().item()   # walk rollout matches walk dynamics
    acc_boat = (gen_boat == tgt_boat).float().mean().item()   # boat rollout matches boat dynamics
    cross = (gen_boat == tgt_walk).float().mean().item()      # boat rollout should NOT match walk dynamics

    print(f"[skill-conditioning] rollouts differ on {differ*100:.0f}% of tokens")
    print(f"[skill-conditioning] walk→walk acc {acc_walk*100:.0f}% · boat→boat acc {acc_boat*100:.0f}% · boat→walk(cross) {cross*100:.0f}%")
    distinct = differ >= 0.5 and acc_walk >= 0.6 and acc_boat >= 0.6 and acc_boat > cross + 0.2
    verdict = "DISTINCT" if distinct else "SAME"
    print(f"[skill-conditioning] verdict: {verdict} - selecting boat vs walk changes the rollout")
    return 0 if distinct else 1


if __name__ == "__main__":
    sys.exit(main())
