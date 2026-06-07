import math

import numpy as np

from blockdream_wm.drive.physics import CarParams, CarState, step
from blockdream_wm.drive.sim import DriveSim, DriveConfig, make_oval_track
from blockdream_wm.drive.collect import collect_rollout


def test_throttle_accelerates():
    p = CarParams()
    s = CarState(vx=0.0)
    for _ in range(15):
        s = step(s, steer=0.0, throttle=1.0, brake=0.0, p=p, dt=1 / 15)
    assert s.vx > 3.0  # accelerated from rest


def test_steering_turns_the_car():
    p = CarParams()
    s = CarState(vx=8.0)  # moving forward
    yaw0 = s.yaw
    for _ in range(20):
        s = step(s, steer=0.6, throttle=0.3, brake=0.0, p=p, dt=1 / 15)  # steer left
    assert s.yaw - yaw0 > 0.1  # turned left (yaw increased)
    # opposite steer turns the other way
    s2 = CarState(vx=8.0)
    for _ in range(20):
        s2 = step(s2, steer=-0.6, throttle=0.3, brake=0.0, p=p, dt=1 / 15)
    assert s2.yaw < 0


def test_brake_decelerates():
    p = CarParams()
    s = CarState(vx=15.0)
    for _ in range(15):
        s = step(s, 0.0, 0.0, 1.0, p, 1 / 15)
    assert s.vx < 10.0


def test_lidar_detects_walls():
    sim = DriveSim(DriveConfig(n_lidar=32, lidar_range=40))
    rng = sim.lidar()
    assert rng.shape == (32,)
    assert rng.min() < 0.95  # on the track, some rays hit walls within range
    assert (rng >= 0).all() and (rng <= 1).all()


def test_rgb_render_shows_geometry():
    sim = DriveSim()
    img = sim.render_rgb()
    assert img.shape == (3, 64, 64)
    assert float(img.max()) > 0.5  # walls/car drawn (not all background)


def test_rollout_modalities_aligned():
    r = collect_rollout(steps=12, seed=0)
    T = r["rgb"].shape[0]
    assert T == 12
    assert r["rgb"].shape == (12, 3, 64, 64)
    assert r["lidar"].shape == (12, 32)
    assert r["telemetry"].shape == (12, 6)
    assert r["control"].shape == (12, 3)
    # the car actually moved (positions changed) → telemetry varies
    assert not np.allclose(r["telemetry"][0], r["telemetry"][-1])


def test_track_is_a_closed_corridor():
    walls, centerline = make_oval_track()
    assert walls.shape[1] == 4 and len(walls) > 0
    assert centerline.shape[1] == 2
