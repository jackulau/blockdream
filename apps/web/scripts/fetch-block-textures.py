#!/usr/bin/env python3
"""Fetch REAL Minecraft block textures for the block-art tester.

Downloads the OFFICIAL Minecraft 1.21 client jar from Mojang's public distribution
(the same artifact the launcher fetches - you are licensed to it by owning Minecraft),
verifies its sha1, and extracts assets/minecraft/textures/block/*.png into
apps/web/public/blocks/ (GITIGNORED - Mojang's copyrighted assets, used locally, never
committed or redistributed). Then emits manifest.json mapping every palette block id to
its best texture file (map-relevant top face first, documented fallbacks).

    python3 apps/web/scripts/fetch-block-textures.py [--version 1.21]

Idempotent: caches the jar and skips re-download when the sha1 matches.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
WEB_DIR = SCRIPT_DIR.parent                     # apps/web
REPO = WEB_DIR.parent.parent                    # repo root
BLOCKS_DIR = WEB_DIR / "public" / "blocks"
CACHE_DIR = SCRIPT_DIR / ".cache"
PALETTE_DATA = REPO / "packages" / "palette" / "data"

MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"


def _get(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as r:  # noqa: S310 - official Mojang hosts
        return r.read()


def _sha1(b: bytes) -> str:
    return hashlib.sha1(b).hexdigest()  # noqa: S324 - Mojang publishes sha1, integrity check only


def resolve_client(version: str) -> tuple[str, str, str]:
    """→ (resolved version id, client.jar url, sha1) via piston-meta. version='latest' → latest release."""
    manifest = json.loads(_get(MANIFEST_URL))
    if version == "latest":
        version = manifest["latest"]["release"]
    entry = next((v for v in manifest["versions"] if v["id"] == version), None)
    if not entry:
        sys.exit(f"[textures] version {version!r} not found in Mojang manifest")
    vjson = json.loads(_get(entry["url"]))
    client = vjson["downloads"]["client"]
    return version, client["url"], client["sha1"]


def fetch_jar(version: str) -> tuple[Path, str]:
    version, url, sha1 = resolve_client(version)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    jar = CACHE_DIR / f"client-{version}.jar"
    if jar.exists() and _sha1(jar.read_bytes()) == sha1:
        print(f"[textures] cached jar OK ({version}, sha1 {sha1[:12]})")
        return jar, version
    print(f"[textures] downloading official {version} client.jar …")
    data = _get(url)
    got = _sha1(data)
    if got != sha1:
        sys.exit(f"[textures] sha1 mismatch! expected {sha1} got {got} - refusing")
    jar.write_bytes(data)
    print(f"[textures] verified sha1 {sha1[:12]} ({len(data) / 1e6:.1f} MB)")
    return jar, version


def extract_block_textures(jar: Path) -> set[str]:
    """Extract assets/minecraft/textures/block/*.png → BLOCKS_DIR. Returns filenames present."""
    BLOCKS_DIR.mkdir(parents=True, exist_ok=True)
    prefix = "assets/minecraft/textures/block/"
    names: set[str] = set()
    with zipfile.ZipFile(jar) as z:
        for info in z.infolist():
            if info.filename.startswith(prefix) and info.filename.endswith(".png"):
                fn = info.filename[len(prefix):]
                if "/" in fn:  # flat dir only
                    continue
                (BLOCKS_DIR / fn).write_bytes(z.read(info))
                names.add(fn)
    print(f"[textures] extracted {len(names)} block PNGs → {BLOCKS_DIR.relative_to(REPO)}")
    return names


def palette_block_ids() -> list[str]:
    """Every block id referenced by the palette (bases representative + per-base blocks + colors)."""
    ids: dict[str, None] = {}
    bp = json.loads((PALETTE_DATA / "java-block-palette-1.21.json").read_text())
    for base in bp["bases"]:
        ids.setdefault(base["representative"]["id"], None)
        for b in base.get("blocks", []):
            ids.setdefault(b["id"], None)
    colors_path = PALETTE_DATA / "java-block-colors-1.21.json"
    if colors_path.exists():
        bc = json.loads(colors_path.read_text())
        entries = bc if isinstance(bc, list) else bc.get("blocks", bc.get("colors", []))
        for e in entries:
            if isinstance(e, dict) and e.get("id"):
                ids.setdefault(e["id"], None)
    return list(ids)


_VARIANT_SUFFIXES = (
    "_slab", "_stairs", "_wall", "_pressure_plate", "_button", "_fence_gate", "_fence", "_trapdoor", "_door",
)


def _candidates(name: str) -> list[str]:
    """Map-relevant texture candidates for a (variant-stripped) block name, top face first."""
    c = [f"{name}_top.png", f"{name}.png", f"{name}_side.png", f"{name}_front.png", f"{name}_end.png"]
    c += [f"{name}s.png", f"{name}_top.png", f"{name}_block.png", f"{name}_block_top.png", f"{name}_planks.png"]
    c += [f"stripped_{name}_top.png", f"{name}_still.png"]
    if name.endswith("_brick"):                       # stone_brick → stone_bricks, etc.
        c += [f"{name}s.png", f"{name}s_top.png"]
    if name == "brick":
        c += ["bricks.png"]
    return c


_SPECIAL = {
    "snow_block": "snow.png",
    "dried_kelp_block": "dried_kelp_top.png",
    "heavy_weighted_pressure_plate": "gold_block.png",
    "light_weighted_pressure_plate": "iron_block.png",
    "hay_block": "hay_block_top.png",
    "quartz_pillar": "quartz_pillar_top.png",
    "magma_block": "magma.png",
}


def _resolve(name: str, available: set[str]) -> str | None:
    if name in _SPECIAL and _SPECIAL[name] in available:
        return _SPECIAL[name]
    cands: list[str] = []
    if name.endswith("_carpet"):                      # carpet uses the wool texture
        cands += [f"{name[: -len('_carpet')]}_wool.png"]
    if name.endswith("_wood"):                        # full-bark wood uses the log texture
        cands += _candidates(f"{name[: -len('_wood')]}_log")
    if name.endswith("_hyphae"):                      # nether "wood" uses the stem texture
        cands += _candidates(f"{name[: -len('_hyphae')]}_stem")
    cands += _candidates(name)
    for suf in _VARIANT_SUFFIXES:                     # slab/stairs/wall/… reuse the parent block
        if name.endswith(suf):
            cands += _candidates(name[: -len(suf)])
            break
    return next((c for c in cands if c in available), None)


def best_texture(block_id: str, available: set[str]) -> str | None:
    """Pick the map-relevant texture for a block id (top face = map colour); derived blocks reuse
    the parent material's texture. Recurses on the un-waxed name for waxed copper variants."""
    name = block_id.split(":", 1)[-1]
    r = _resolve(name, available)
    if r is None and name.startswith("waxed_"):
        r = _resolve(name[len("waxed_"):], available)
    return r


# Blocks whose faces differ but don't follow the generic <name>_top/_side convention.
_SPECIAL_FACES = {
    "grass_block": ("grass_block_top.png", "grass_block_side.png", "dirt.png"),
    "podzol": ("podzol_top.png", "podzol_side.png", "dirt.png"),
    "mycelium": ("mycelium_top.png", "mycelium_side.png", "dirt.png"),
    "crimson_nylium": ("crimson_nylium.png", "crimson_nylium_side.png", "netherrack.png"),
    "warped_nylium": ("warped_nylium.png", "warped_nylium_side.png", "netherrack.png"),
    "bookshelf": ("oak_planks.png", "bookshelf.png", "oak_planks.png"),
    "tnt": ("tnt_top.png", "tnt_side.png", "tnt_bottom.png"),
    "pumpkin": ("pumpkin_top.png", "pumpkin_side.png", "pumpkin_top.png"),
    "melon": ("melon_top.png", "melon_side.png", "melon_top.png"),
}


def _face_textures(block_id: str, available: set[str]) -> dict[str, str] | None:
    """Per-face {top,side,bottom} for a block with distinct faces (grass, logs, pillars, sandstone…),
    using ONLY files present in `available` so the manifest never points at a missing PNG. Returns
    None for single-texture blocks (the viewer then uses the one `textures[id]` entry on all faces)."""
    name = block_id.split(":", 1)[-1]

    def pick(*cands: str) -> str | None:
        return next((c for c in cands if c in available), None)

    # logs / stems / pillars: bark on the side, end-grain on top+bottom
    if name.endswith(("_log", "_stem")):
        side, top = pick(f"{name}.png"), pick(f"{name}_top.png")
        if side and top:
            return {"top": top, "side": side, "bottom": top}
    if name.endswith("_wood") or name.endswith("_hyphae"):  # all-bark: same texture every face
        base = name.rsplit("_", 1)[0] + ("_log" if name.endswith("_wood") else "_stem")
        side = pick(f"{base}.png")
        if side:
            return {"top": side, "side": side, "bottom": side}

    sf = _SPECIAL_FACES.get(name)
    if sf and all(f in available for f in sf):
        return {"top": sf[0], "side": sf[1], "bottom": sf[2]}

    # generic: a distinct _top plus a side (either <name>_side or the bare <name> e.g. sandstone)
    top = pick(f"{name}_top.png")
    side = pick(f"{name}_side.png", f"{name}.png")
    if top and side and top != side:
        return {"top": top, "side": side, "bottom": pick(f"{name}_bottom.png") or top}
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser("fetch-block-textures")
    ap.add_argument("--version", default="latest", help="Minecraft version, or 'latest' (most coverage)")
    args = ap.parse_args(argv)

    jar, version = fetch_jar(args.version)
    available = extract_block_textures(jar)

    ids = palette_block_ids()
    mapping: dict[str, str] = {}
    faces: dict[str, dict[str, str]] = {}
    unmapped: list[str] = []
    for bid in ids:
        tex = best_texture(bid, available)
        if tex:
            mapping[bid] = tex
        else:
            unmapped.append(bid)
        ft = _face_textures(bid, available)
        if ft:
            faces[bid] = ft

    manifest = {
        "version": version,
        "source": "official Mojang client jar (extracted locally, gitignored, not redistributed)",
        "block_count": len(ids),
        "mapped": len(mapping),
        "unmapped": sorted(unmapped),  # block-art falls back to a generated swatch for these
        "textures": mapping,
        "faces": faces,  # per-face textures for the 3D viewer (grass top/side, log end-grain, …)
    }
    print(f"[textures] per-face textures for {len(faces)} multi-face blocks (grass, logs, sandstone…)")
    (BLOCKS_DIR / "manifest.json").write_text(json.dumps(manifest, indent=0))
    print(f"[textures] manifest: {len(mapping)}/{len(ids)} palette blocks mapped "
          f"({100 * len(mapping) / max(1, len(ids)):.1f}%), {len(unmapped)} → swatch fallback")
    if unmapped:
        print(f"[textures] swatch-fallback ids: {', '.join(unmapped[:12])}{' …' if len(unmapped) > 12 else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
