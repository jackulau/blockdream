"""Recursive multimodal transition: S_t + control_t → S_{t+1}, where S = (RGB
tokens, LiDAR, telemetry). The control + prev LiDAR + prev telemetry fuse into a
conditioning vector that (a) drives an autoregressive transformer over the next
RGB tokens and (b) feeds per-modality heads predicting next LiDAR + next telemetry.
This is the drift-sim recipe (fused transition + per-modality decoder heads).
"""

from __future__ import annotations

import torch
from torch import nn
import torch.nn.functional as F

from ..config import DynamicsConfig
from ..transition_ar import ARTransition


class DriveTransition(nn.Module):
    def __init__(self, cfg: DynamicsConfig, n_tokens: int, codebook_size: int,
                 n_lidar: int, n_telemetry: int, n_control: int = 3, cond_dim: int = 96,
                 n_history: int = 0, rgb_change_weight: float = 0.0,
                 rgb_div_weight: float = 0.0, rgb_div_margin: float = 0.5,
                 prev_corrupt: float = 0.0):
        super().__init__()
        self.n_lidar = n_lidar
        self.n_telemetry = n_telemetry
        self.n_control = n_control
        # RGB DYNAMICS LOSS (the copy-previous fix). Single-step teacher-forced CE lets the AR cheat by
        # echoing the previous frame (consecutive commaVQ token fields are ~40% identical), so the served
        # model learned to copy prev and the free-run rollout is near-frozen. Two flag-gated terms break it
        # (both default 0 = OFF, so existing checkpoints train/serve identically and the architecture is
        # unchanged): rgb_change_weight up-weights the CE on positions where the frame actually CHANGES
        # (next != prev) so copying is penalized exactly where it is wrong; rgb_div_weight requires the TRUE
        # control to predict the next frame better than a shuffled WRONG control by rgb_div_margin, forcing
        # control-dependent dynamics instead of a control-blind copy (the same divergence trick that broke
        # the Minecraft WM's skill collapse).
        self.rgb_change_weight = float(rgb_change_weight)
        self.rgb_div_weight = float(rgb_div_weight)
        self.rgb_div_margin = float(rgb_div_margin)
        # PREV-FRAME CORRUPTION (the strongest copy-previous fix, and control-safe). During training only,
        # replace a fraction of the PREV-frame tokens fed to the AR with random codes. The model can no
        # longer win by echoing prev (the copied positions are now wrong), so it must predict the next
        # frame from the control + spatial context - which is what makes the free-run field actually flow
        # at inference (clean prev). Unlike the control-divergence term it does NOT touch the shared cond,
        # so the telemetry/steering controllability is preserved. 0 = off (default; backward-compatible).
        self.prev_corrupt = float(prev_corrupt)
        # TEMPORAL CONTEXT: optionally condition on a window of the last n_history
        # (control, telemetry) frames so the dynamics see momentum/lag, not just the current
        # step (single-step telemetry prediction drifts over long rollouts). n_history=0 → the
        # original single-step behaviour (backward compatible; no extra params).
        self.n_history = n_history
        # fuse control + prev LiDAR + prev telemetry → conditioning
        self.cond = nn.Sequential(
            nn.Linear(n_control + n_lidar + n_telemetry, cond_dim), nn.GELU(),
            nn.Linear(cond_dim, cond_dim),
        )
        if n_history > 0:
            self.hist_proj: nn.Module = nn.Linear(n_history * (n_control + n_telemetry), cond_dim)
        self.ar = ARTransition(cfg, n_tokens=n_tokens, codebook_size=codebook_size, action_dim=cond_dim)
        self.lidar_head = nn.Sequential(nn.Linear(cond_dim, 64), nn.GELU(), nn.Linear(64, n_lidar))
        self.telemetry_head = nn.Sequential(nn.Linear(cond_dim, 64), nn.GELU(), nn.Linear(64, n_telemetry))
        # PHYSICAL TELEMETRY BOUND (critical for recursive stability). The telemetry head's output is
        # fed back as prev_tel every step; an unbounded Linear in that loop diverges to NaN over a long
        # rollout (off-distribution feedback the teacher-forced trainer never saw). We soft-clamp each
        # channel with scale*tanh(x/scale): ~identity for in-range values, saturating on runaway, so
        # speed/yaw-rate can never explode regardless of checkpoint quality. Scales are physical, set
        # from the sim telemetry layout [vx/30, vy/15, r, speed/30, sin(yaw), cos(yaw)] with headroom
        # (speed up to 60 m/s, yaw-rate up to 3 rad/s; sin/cos clamped near their [-1,1] domain).
        # persistent=False → not in state_dict, so old (pre-bound) checkpoints still load strict.
        default_scale = torch.tensor([2.0, 2.0, 3.0, 2.0, 1.5, 1.5])
        tel_scale = default_scale if n_telemetry == 6 else torch.full((n_telemetry,), 3.0)
        self.register_buffer("tel_scale", tel_scale, persistent=False)

    def _fuse(self, control: torch.Tensor, lidar: torch.Tensor, telemetry: torch.Tensor,
              history: torch.Tensor | None = None) -> torch.Tensor:
        c = self.cond(torch.cat([control, lidar, telemetry], dim=-1))
        if self.n_history > 0:
            if history is None:
                history = control.new_zeros((control.shape[0], self.n_history * (self.n_control + self.n_telemetry)))
            c = c + self.hist_proj(history)
        return c

    def bound_tel(self, raw: torch.Tensor) -> torch.Tensor:
        """Soft-clamp raw telemetry to its physical per-channel range. scale*tanh(x/scale) is ~identity
        for |x| << scale and saturates at ±scale, so the recursively fed-back telemetry can never diverge."""
        s = self.tel_scale.to(raw.dtype)
        return s * torch.tanh(raw / s)

    def rgb_loss(self, prev_tokens, next_tokens, c, control=None, prev_lidar=None, prev_tel=None, history=None):
        """RGB-token loss with the optional copy-previous fix (see __init__). With both weights 0 this is
        exactly the legacy single-step CE (self.ar.loss). With rgb_change_weight>0 the CE is up-weighted on
        positions where next != prev (the changes the copy shortcut gets wrong). With rgb_div_weight>0 a
        margin hinge requires the true control to out-predict a shuffled control, forcing control use.
        With prev_corrupt>0 a fraction of the prev-frame tokens are randomized (training only) so the AR
        cannot win by echoing prev - the strongest, control-safe copy fix."""
        if self.prev_corrupt > 0 and torch.is_grad_enabled():  # training only; clean prev for val (no_grad)
            m = torch.rand(prev_tokens.shape, device=prev_tokens.device) < self.prev_corrupt
            rnd = torch.randint(0, self.ar.codebook_size, prev_tokens.shape, device=prev_tokens.device)
            prev_tokens = torch.where(m, rnd, prev_tokens)
        cw, dw = self.rgb_change_weight, self.rgb_div_weight
        if cw <= 0 and dw <= 0:
            return self.ar.loss(prev_tokens, next_tokens, c)
        logits = self.ar.forward(prev_tokens, next_tokens, c)  # (B, n, codebook)
        ce_pos = F.cross_entropy(
            logits.reshape(-1, logits.shape[-1]), next_tokens.reshape(-1), reduction="none"
        ).view_as(next_tokens)  # (B, n)
        if cw > 0:
            w = 1.0 + cw * (next_tokens != prev_tokens).to(ce_pos.dtype)  # changed positions weigh (1+cw)x
            rgb = (ce_pos * w).sum() / w.sum().clamp_min(1e-6)
        else:
            rgb = ce_pos.mean()
        if dw > 0 and control is not None:
            idx = torch.randperm(control.shape[0], device=control.device)  # shuffle controls across batch
            c_wrong = self._fuse(control[idx], prev_lidar, prev_tel, history)
            ce_wrong = self.ar.loss(prev_tokens, next_tokens, c_wrong)
            rgb = rgb + dw * torch.relu(self.rgb_div_margin - (ce_wrong - ce_pos.mean()))
        return rgb

    def loss(self, prev_tokens, next_tokens, prev_lidar, prev_tel, control, next_lidar, next_tel, history=None):
        c = self._fuse(control, prev_lidar, prev_tel, history)
        rgb_loss = self.rgb_loss(prev_tokens, next_tokens, c, control, prev_lidar, prev_tel, history)
        # n_lidar == 0 (e.g. the real commaVQ camera-only path) → no LiDAR modality. F.mse_loss over
        # empty (B,0) tensors returns NaN, so skip the term entirely rather than feed a fake channel.
        lidar_loss = c.new_zeros(()) if self.n_lidar == 0 else F.mse_loss(torch.sigmoid(self.lidar_head(c)), next_lidar)
        tel_loss = F.mse_loss(self.bound_tel(self.telemetry_head(c)), next_tel)
        return rgb_loss + lidar_loss + tel_loss, {"rgb": rgb_loss.item(), "lidar": lidar_loss.item(), "tel": tel_loss.item()}

    def rollout_loss(self, tel0, lidar0, controls, tel_targets, lidar_targets, history=None):
        """Multi-step recursive (scheduled-sampling) loss on the telemetry + LiDAR feedback path.

        Starting from a REAL state (tel0, lidar0), roll the model K steps under the real control
        sequence using its OWN bounded predictions as feedback (exactly as inference does), and
        supervise every step against the real future. Single-step teacher forcing lets the model
        cheat with "next_tel ≈ prev_tel" (consecutive telemetry barely changes) and so it ignores
        control + drifts/collapses over a long rollout. Rolling its own predictions forward makes
        that shortcut accumulate error, forcing it to actually USE the control and stay on-trajectory
        - the fix for the flat, control-independent speed/yaw. RGB tokens stay single-step (AR decode
        is too expensive to roll in-loop and is not the unstable modality).

        With n_history > 0 the (control, telemetry) window SLIDES with the model's own predicted
        telemetry - the same feedback inference sees. `history` is the initial window (zeros =
        fresh-reset condition; most steps of a K-window build real history as they go).

        Shapes: tel0 (B,n_tel), lidar0 (B,n_lidar), controls (B,K,n_control),
        tel_targets (B,K,n_tel), lidar_targets (B,K,n_lidar).
        """
        tel, lidar = tel0, lidar0
        k = controls.shape[1]
        tel_loss = lidar_loss = controls.new_zeros(())
        rows: list[torch.Tensor] | None = None
        if self.n_history > 0:
            width = self.n_control + self.n_telemetry
            if history is None:
                rows = [controls.new_zeros((controls.shape[0], width)) for _ in range(self.n_history)]
            else:
                rows = list(history.view(controls.shape[0], self.n_history, width).unbind(1))
        for t in range(k):
            h = torch.cat(rows, dim=-1) if rows is not None else history
            c = self._fuse(controls[:, t], lidar, tel, h)
            if rows is not None:  # row_t = (control applied at t, telemetry observed at t)
                rows = rows[1:] + [torch.cat([controls[:, t], tel], dim=-1)]
            tel = self.bound_tel(self.telemetry_head(c))
            tel_loss = tel_loss + F.mse_loss(tel, tel_targets[:, t])
            if self.n_lidar > 0:  # camera-only real path has no LiDAR to roll
                lidar = torch.sigmoid(self.lidar_head(c))
                lidar_loss = lidar_loss + F.mse_loss(lidar, lidar_targets[:, t])
        return (tel_loss + lidar_loss) / k, {"roll_tel": tel_loss.item() / k, "roll_lidar": lidar_loss.item() / k}

    def rgb_rollout_loss(self, frames, controls, lidar0, tel0, history=None):
        """Scheduled-sampling RGB rollout - the inter-frame copy fix. From real frame 0, roll K steps:
        at each step predict the REAL next frame (teacher-forced CE, with gradient) but feed the model's
        OWN generated frame (detached) as the next prev. Teacher forcing alone lets the AR echo the
        previous frame (consecutive token fields are ~40% identical) and freeze at inference; rolling its
        own predictions forward forces it to predict multi-step change from its own (possibly copied)
        state, so copying accumulates error and stops being optimal. Telemetry rolls (detached) alongside
        so the conditioning matches inference. frames: (B,K+1,n_tokens); controls: (B,K,n_control)."""
        k = controls.shape[1]
        prev = frames[:, 0]
        tel, lidar = tel0, lidar0
        loss = frames.new_zeros((), dtype=torch.float32)
        for t in range(k):
            c = self._fuse(controls[:, t], lidar, tel, history)
            loss = loss + self.ar.loss(prev, frames[:, t + 1], c)   # gradient: predict real next
            with torch.no_grad():                                   # roll the model's OWN frame forward
                prev = self.ar.generate(prev, c)
                tel = self.bound_tel(self.telemetry_head(c))
        return loss / max(1, k), {"rgb_roll": (loss / max(1, k)).item()}

    @torch.no_grad()
    def step(self, prev_tokens, prev_lidar, prev_tel, control, history=None):
        """One recursive world-model step → (next_tokens, next_lidar, next_telemetry)."""
        c = self._fuse(control, prev_lidar, prev_tel, history)
        next_tokens = self.ar.generate(prev_tokens, c)
        next_lidar = torch.sigmoid(self.lidar_head(c))
        next_tel = self.bound_tel(self.telemetry_head(c))
        return next_tokens, next_lidar, next_tel
