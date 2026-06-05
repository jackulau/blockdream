"""Driving environment: an oval track (walls), raycast LiDAR, ego-centric top-down
RGB render, and telemetry — the multimodal observation (RGB + LiDAR + telemetry)
the world model learns to predict, driven by (steer, throttle, brake)."""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .physics import CarParams, CarState, step


def make_oval_track(rx: float = 60.0, ry: float = 40.0, width: float = 12.0, n: int = 80):
    """Two concentric ellipses → a closed road corridor. Returns (walls (M,4), centerline (n,2))."""
    th = np.linspace(0, 2 * np.pi, n, endpoint=False)
    def ellipse(ax, by):
        return np.stack([ax * np.cos(th), by * np.sin(th)], axis=1)
    outer = ellipse(rx + width / 2, ry + width / 2)
    inner = ellipse(rx - width / 2, ry - width / 2)
    centerline = ellipse(rx, ry)
    segs = []
    for ring in (outer, inner):
        for i in range(n):
            a, b = ring[i], ring[(i + 1) % n]
            segs.append([a[0], a[1], b[0], b[1]])
    return np.asarray(segs, dtype=np.float64), centerline


@dataclass
class DriveConfig:
    n_lidar: int = 32          # rays over 360°
    lidar_range: float = 40.0
    img_size: int = 64
    view_range: float = 45.0   # meters shown around the car (half-extent)
    dt: float = 1.0 / 15.0


class DriveSim:
    def __init__(self, cfg: DriveConfig | None = None, params: CarParams | None = None, seed: int = 0):
        self.cfg = cfg or DriveConfig()
        self.p = params or CarParams()
        self.walls, self.centerline = make_oval_track()
        self.rng = np.random.default_rng(seed)
        self.state = CarState()
        self.reset()

    def reset(self, idx: int | None = None) -> None:
        # spawn on the centerline, heading along the track
        n = len(self.centerline)
        i = idx if idx is not None else int(self.rng.integers(0, n))
        p0 = self.centerline[i]
        p1 = self.centerline[(i + 1) % n]
        yaw = math.atan2(p1[1] - p0[1], p1[0] - p0[0])
        self.state = CarState(x=float(p0[0]), y=float(p0[1]), yaw=yaw, vx=6.0)

    def step(self, steer: float, throttle: float, brake: float) -> None:
        self.state = step(self.state, steer, throttle, brake, self.p, self.cfg.dt)

    # --- observations ---------------------------------------------------------
    def _to_ego(self, pts: np.ndarray) -> np.ndarray:
        """World points (...,2) → car frame (x forward, y left)."""
        c, s = math.cos(-self.state.yaw), math.sin(-self.state.yaw)
        rot = np.array([[c, -s], [s, c]])
        d = pts - np.array([self.state.x, self.state.y])
        return d @ rot.T

    def lidar(self) -> np.ndarray:
        """Range per ray, normalized [0,1] (1 = max range / no hit)."""
        O = np.array([self.state.x, self.state.y])
        A = self.walls[:, :2]
        B = self.walls[:, 2:]
        AB = B - A
        ranges = np.full(self.cfg.n_lidar, self.cfg.lidar_range)
        for k in range(self.cfg.n_lidar):
            ang = self.state.yaw + (2 * math.pi * k / self.cfg.n_lidar)
            d = np.array([math.cos(ang), math.sin(ang)])
            denom = d[0] * AB[:, 1] - d[1] * AB[:, 0]
            ok = np.abs(denom) > 1e-9
            AO = A - O
            t = (AO[:, 0] * AB[:, 1] - AO[:, 1] * AB[:, 0]) / np.where(ok, denom, 1)
            u = (AO[:, 0] * d[1] - AO[:, 1] * d[0]) / np.where(ok, denom, 1)
            hit = ok & (t > 0) & (u >= 0) & (u <= 1) & (t < self.cfg.lidar_range)
            if hit.any():
                ranges[k] = t[hit].min()
        return (ranges / self.cfg.lidar_range).astype(np.float32)

    def render_rgb(self) -> np.ndarray:
        """Ego-centric top-down (3,S,S) float[0,1]: walls (white), road sense, car (green)."""
        S, R = self.cfg.img_size, self.cfg.view_range
        img = np.zeros((S, S, 3), dtype=np.float32)
        img[:, :, 2] = 0.06  # faint blue background

        def to_px(fx, fy):  # car frame (fwd, left) → pixel (forward = up)
            px = int(round(S / 2 - fy / R * (S / 2)))
            py = int(round(S / 2 - fx / R * (S / 2)))
            return px, py

        # draw walls
        e1 = self._to_ego(self.walls[:, :2])
        e2 = self._to_ego(self.walls[:, 2:])
        for (a, b) in zip(e1, e2):
            _line(img, *to_px(a[0], a[1]), *to_px(b[0], b[1]), (0.9, 0.9, 0.95))
        # car marker (triangle pointing up) at center, green
        cx, cy = S // 2, S // 2
        for dy in range(-3, 2):
            half = max(0, 2 + dy)
            for dx in range(-half, half + 1):
                yy, xx = cy + dy, cx + dx
                if 0 <= yy < S and 0 <= xx < S:
                    img[yy, xx] = (0.2, 0.85, 0.3)
        return np.transpose(img, (2, 0, 1)).copy()

    def telemetry(self) -> np.ndarray:
        """Normalized [vx/30, vy/15, r, speed/30, sin(yaw), cos(yaw)]."""
        s = self.state
        return np.array([s.vx / 30, s.vy / 15, s.r, s.speed() / 30, math.sin(s.yaw), math.cos(s.yaw)], dtype=np.float32)

    def observation(self) -> dict:
        return {"rgb": self.render_rgb(), "lidar": self.lidar(), "telemetry": self.telemetry()}


def _line(img: np.ndarray, x0: int, y0: int, x1: int, y1: int, color) -> None:
    """Draw a line (DDA) onto an (S,S,3) image; pixels are (row=y, col=x)."""
    S = img.shape[0]
    dx, dy = x1 - x0, y1 - y0
    n = max(abs(dx), abs(dy))
    if n == 0:
        if 0 <= y0 < S and 0 <= x0 < S:
            img[y0, x0] = color
        return
    for i in range(n + 1):
        x = int(round(x0 + dx * i / n))
        y = int(round(y0 + dy * i / n))
        if 0 <= y < S and 0 <= x < S:
            img[y, x] = color
