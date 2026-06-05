import torch

from mineworld_wm.config import TokenizerConfig
from mineworld_wm.tokenizer import Tokenizer
from mineworld_wm.drive.encoders import LidarCodec, ControlEncoder
from mineworld_wm.drive.collect import collect_rollout


def test_rgb_tokenizer_on_driving_frames():
    tok = Tokenizer(TokenizerConfig(image_size=64, base_channels=16, latent_channels=4, downsample=8, vq_codebook_size=128))
    r = collect_rollout(steps=8, seed=0)
    x = torch.from_numpy(r["rgb"]).float() / 255.0  # (8,3,64,64)
    out = tok(x)
    assert out.recon.shape == x.shape
    idx = tok.tokenize(x)
    assert idx.shape == (8, 8, 8)  # 64/downsample(8) = 8


def test_lidar_codec_reconstructs_and_learns():
    torch.manual_seed(0)
    r = collect_rollout(steps=40, seed=1)
    x = torch.from_numpy(r["lidar"]).float()  # (40,32)
    codec = LidarCodec(n_rays=32, dim=16)
    recon, z = codec(x)
    assert recon.shape == x.shape and z.shape == (40, 16)
    opt = torch.optim.Adam(codec.parameters(), lr=2e-3)
    first = codec.loss(x).item()
    for _ in range(200):
        loss = codec.loss(x)
        opt.zero_grad(); loss.backward(); opt.step()
    assert loss.item() < first * 0.5  # learned to reconstruct real LiDAR


def test_control_encoder_distinguishes_actions():
    enc = ControlEncoder(embed_dim=32)
    left = enc(torch.tensor([[-1.0, 0.5, 0.0]]))
    right = enc(torch.tensor([[1.0, 0.5, 0.0]]))
    assert left.shape == (1, 32)
    assert not torch.allclose(left, right)
