"""Structured, leveled logging for the world-model server + trainers. Level via the BLOCKDREAM_LOG
env var (DEBUG | INFO | WARNING | ERROR), default INFO. Replaces scattered print() calls with one
consistent, timestamped, name-tagged stream — and DEBUG turns on per-step latency timing without
touching the hot path when it's off (logger.debug short-circuits on level)."""

from __future__ import annotations

import logging
import os
import time
from contextlib import contextmanager
from collections.abc import Iterator

_CONFIGURED = False


def _configure() -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return
    level = os.environ.get("BLOCKDREAM_LOG", "INFO").upper()
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s | %(message)s",
        datefmt="%H:%M:%S",
    )
    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    _configure()
    return logging.getLogger(f"blockdream_wm.{name}")


@contextmanager
def timed(logger: logging.Logger, label: str) -> Iterator[None]:
    """Log `label NNNms` at DEBUG. Zero overhead beyond a clock read when DEBUG is off."""
    t0 = time.time()
    yield
    if logger.isEnabledFor(logging.DEBUG):
        logger.debug("%s %.0fms", label, (time.time() - t0) * 1000)
