"""Vehicle dynamics — dynamic bicycle model with a Pacejka 'magic formula' tire,
drift-capable, with a kinematic-blend guard at low speed (the dynamic model is
singular as v→0). This is the standard good-physics vehicle model (same family as
highway-env / nuPlan / CARLA's underlying dynamics).
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass
class CarParams:
    m: float = 1500.0       # mass (kg)
    Iz: float = 2250.0      # yaw inertia (kg·m²)
    lf: float = 1.2         # CoG → front axle (m)
    lr: float = 1.6         # CoG → rear axle (m)
    # Pacejka lateral (per axle): Fy = D·sin(C·atan(B·α − E·(B·α − atan(B·α))))
    Bf: float = 10.0
    Cf: float = 1.6
    Df: float = 9000.0
    Br: float = 11.0
    Cr: float = 1.6
    Dr: float = 10000.0
    # longitudinal
    f_max: float = 9000.0    # max drive force (N)
    brake_max: float = 12000.0
    c_drag: float = 1.2      # aero drag coeff (N per (m/s)²)
    c_roll: float = 80.0     # rolling resistance (N)
    max_steer: float = 0.6   # rad (~34°)
    v_blend: float = 3.0     # below this speed, blend toward kinematic model


@dataclass
class CarState:
    x: float = 0.0
    y: float = 0.0
    yaw: float = 0.0
    vx: float = 0.0   # body-frame longitudinal velocity
    vy: float = 0.0   # body-frame lateral velocity
    r: float = 0.0    # yaw rate

    def speed(self) -> float:
        return math.hypot(self.vx, self.vy)


def _pacejka(alpha: float, B: float, C: float, D: float) -> float:
    ba = B * alpha
    return D * math.sin(C * math.atan(ba - 0.0 * (ba - math.atan(ba))))  # E=0 (simple)


def step(state: CarState, steer: float, throttle: float, brake: float, p: CarParams, dt: float, substeps: int = 4) -> CarState:
    """Advance the vehicle by dt under (steer∈[-1,1], throttle∈[0,1], brake∈[0,1])."""
    delta = max(-1.0, min(1.0, steer)) * p.max_steer
    h = dt / substeps
    s = CarState(**vars(state))
    for _ in range(substeps):
        vx = s.vx
        vx_eff = max(abs(vx), 0.5) * (1 if vx >= 0 else -1)  # avoid /0 in slip
        # slip angles
        alpha_f = delta - math.atan2(s.vy + p.lf * s.r, vx_eff)
        alpha_r = -math.atan2(s.vy - p.lr * s.r, vx_eff)
        Fyf = _pacejka(alpha_f, p.Bf, p.Cf, p.Df)
        Fyr = _pacejka(alpha_r, p.Br, p.Cr, p.Dr)
        # longitudinal force
        Fx = throttle * p.f_max - brake * p.brake_max * (1 if vx >= 0 else -1)
        Fx -= p.c_drag * vx * abs(vx) + p.c_roll * (1 if vx > 0 else (-1 if vx < 0 else 0))
        # dynamic equations (body frame)
        vx_dot = (Fx - Fyf * math.sin(delta)) / p.m + s.vy * s.r
        vy_dot = (Fyf * math.cos(delta) + Fyr) / p.m - s.vx * s.r
        r_dot = (p.lf * Fyf * math.cos(delta) - p.lr * Fyr) / p.Iz
        # low-speed blend toward kinematic bicycle (avoids spin at standstill)
        blend = min(1.0, max(0.0, abs(s.vx) / p.v_blend))
        if blend < 1.0:
            beta = math.atan(0.5 * math.tan(delta))
            v = s.vx
            kin_vy = v * math.sin(beta)
            kin_r = v * math.sin(beta) / (p.lf + p.lr)
            s.vy = blend * (s.vy + vy_dot * h) + (1 - blend) * kin_vy
            s.r = blend * (s.r + r_dot * h) + (1 - blend) * kin_r
            s.vx = s.vx + vx_dot * h
        else:
            s.vx += vx_dot * h
            s.vy += vy_dot * h
            s.r += r_dot * h
        # integrate pose (global)
        s.x += (s.vx * math.cos(s.yaw) - s.vy * math.sin(s.yaw)) * h
        s.y += (s.vx * math.sin(s.yaw) + s.vy * math.cos(s.yaw)) * h
        s.yaw += s.r * h
    # keep yaw in [-pi, pi]
    s.yaw = (s.yaw + math.pi) % (2 * math.pi) - math.pi
    return s
