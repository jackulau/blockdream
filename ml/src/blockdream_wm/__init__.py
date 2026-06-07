"""blockdream_wm — neural Minecraft world model.

Two model lineages share this package:
  * server autoregressive (MineWorld-style: VQ tokens + transformer)
  * browser latent-diffusion (continuous VAE latent + few-step denoiser)

Everything here is verified at synthetic / CPU scale. Full-scale multi-GPU
training and live-Minecraft capture are operator steps (see PLAN.md §0).
"""

__version__ = "0.0.0"
