"""make_radio_sound - convert audio to AM/SW radio-sounding mono.

Usage:
    python make_radio_sound.py INPUT [-o OUTPUT] [--mode am|sw]
                              [--intensity 0.6] [--seed N] [--format mp3|wav]
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from scipy import signal as sps

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

SUPPORTED_INPUT_EXTS = {".mp3", ".mp4", ".m4a", ".wav", ".aac", ".ogg", ".flac"}
TARGET_SR = 22_050

MODES = {
    "am": {
        "band": (200.0, 4500.0),
        "drive": 2.2,
        "fade_depth": 0.18,
        "hiss_level": 0.025,
        "crackle_rate": 1.5,
        "tilt_db": -3.0,
    },
    "sw": {
        "band": (350.0, 2800.0),
        "drive": 3.0,
        "fade_depth": 0.45,
        "hiss_level": 0.05,
        "crackle_rate": 5.0,
        "tilt_db": -5.0,
    },
}


def _butter_bandpass_sos(low: float, high: float, sr: int, order: int = 6):
    nyq = 0.5 * sr
    return sps.butter(order, [low / nyq, high / nyq], btype="band", output="sos")


def _highshelf_tilt(x: np.ndarray, sr: int, db: float) -> np.ndarray:
    if abs(db) < 0.1:
        return x
    sos_lp = sps.butter(2, 1500 / (0.5 * sr), btype="low", output="sos")
    low = sps.sosfiltfilt(sos_lp, x)
    high = x - low
    gain = 10 ** (db / 20)
    return (low + gain * high).astype(np.float32)


def _saturate(x: np.ndarray, drive: float) -> np.ndarray:
    if drive <= 1.0:
        return x
    return (np.tanh(drive * x) / np.tanh(drive)).astype(np.float32)


def _fade_lfo(n: int, sr: int, depth: float, rng: np.random.Generator) -> np.ndarray:
    if depth <= 0:
        return np.ones(n, dtype=np.float32)
    t = np.arange(n) / sr
    f1 = 0.12 + rng.random() * 0.10
    f2 = 0.60 + rng.random() * 0.30
    p1 = rng.random() * 2 * np.pi
    p2 = rng.random() * 2 * np.pi
    lfo = 0.7 * np.sin(2 * np.pi * f1 * t + p1) + 0.3 * np.sin(2 * np.pi * f2 * t + p2)
    env = 1.0 - depth * (0.5 - 0.5 * lfo)
    return env.astype(np.float32)


def _hiss(
    n: int,
    sr: int,
    band: tuple[float, float],
    level: float,
    rng: np.random.Generator,
) -> np.ndarray:
    if level <= 0:
        return np.zeros(n, dtype=np.float32)
    noise = rng.standard_normal(n).astype(np.float32)
    sos = _butter_bandpass_sos(band[0], band[1], sr, order=4)
    out = sps.sosfiltfilt(sos, noise).astype(np.float32)
    peak = float(np.max(np.abs(out))) or 1.0
    return out / peak * level


def _crackles(
    n: int,
    sr: int,
    band: tuple[float, float],
    rate: float,
    rng: np.random.Generator,
) -> np.ndarray:
    if rate <= 0:
        return np.zeros(n, dtype=np.float32)
    duration_s = n / sr
    count = int(rng.poisson(rate * duration_s))
    if count == 0:
        return np.zeros(n, dtype=np.float32)
    out = np.zeros(n, dtype=np.float32)
    for _ in range(count):
        start = int(rng.integers(0, n))
        burst_ms = float(rng.uniform(4.0, 22.0))
        burst_len = max(8, int(sr * burst_ms / 1000))
        end = min(n, start + burst_len)
        length = end - start
        env = np.exp(-np.linspace(0.0, 6.0, length, dtype=np.float32))
        amp = float(rng.uniform(0.4, 1.0))
        out[start:end] += amp * env * rng.standard_normal(length).astype(np.float32)
    sos = _butter_bandpass_sos(band[0], band[1], sr, order=4)
    out = sps.sosfiltfilt(sos, out).astype(np.float32)
    peak = float(np.max(np.abs(out))) or 1.0
    return out / peak * 0.6


def _soft_compress(
    x: np.ndarray,
    threshold: float = 0.5,
    ratio: float = 3.0,
    makeup_db: float = 2.0,
) -> np.ndarray:
    abs_x = np.abs(x)
    over = abs_x > threshold
    out = np.where(
        over,
        np.sign(x) * (threshold + (abs_x - threshold) / ratio),
        x,
    )
    return (out * (10 ** (makeup_db / 20))).astype(np.float32)


def _ffmpeg(args: list[str]) -> None:
    result = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", *args], capture_output=True)
    if result.returncode != 0:
        msg = result.stderr.decode("utf-8", "replace").strip() or "(no stderr)"
        raise RuntimeError(f"ffmpeg failed: {msg}")


def _load_mono(path: Path) -> tuple[np.ndarray, int]:
    fd, tmp = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        _ffmpeg(
            [
                "-y",
                "-i",
                str(path),
                "-vn",
                "-ac",
                "1",
                "-ar",
                str(TARGET_SR),
                "-acodec",
                "pcm_s16le",
                "-f",
                "wav",
                tmp,
            ]
        )
        with wave.open(tmp, "rb") as wf:
            sr = wf.getframerate()
            raw = wf.readframes(wf.getnframes())
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return samples, sr


def _save(samples: np.ndarray, sr: int, path: Path, out_format: str) -> None:
    samples = np.clip(samples, -0.98, 0.98)
    pcm = (samples * 32767).astype(np.int16).tobytes()

    if out_format == "wav":
        with wave.open(str(path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(pcm)
        return

    fd, tmp = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        with wave.open(tmp, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(pcm)
        _ffmpeg(
            [
                "-y",
                "-i",
                tmp,
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "128k",
                str(path),
            ]
        )
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def radio_ify(
    samples: np.ndarray,
    sr: int,
    mode: str,
    intensity: float,
    rng: np.random.Generator,
) -> np.ndarray:
    cfg = MODES[mode]
    band = cfg["band"]

    x = _highshelf_tilt(samples, sr, cfg["tilt_db"])

    sos = _butter_bandpass_sos(band[0], band[1], sr, order=6)
    x = sps.sosfiltfilt(sos, x).astype(np.float32)

    peak = float(np.max(np.abs(x))) or 1.0
    x = x / peak * 0.9

    x = _saturate(x, cfg["drive"])

    fade_depth = cfg["fade_depth"] * intensity
    x = x * _fade_lfo(len(x), sr, fade_depth, rng)

    hiss_level = cfg["hiss_level"] * intensity
    x = x + _hiss(len(x), sr, band, hiss_level, rng)

    crackle_rate = cfg["crackle_rate"] * intensity
    crackle_gain = 0.4 + 0.6 * intensity
    x = x + _crackles(len(x), sr, band, crackle_rate, rng) * crackle_gain

    x = _soft_compress(x, threshold=0.5, ratio=3.0, makeup_db=2.0)
    return x.astype(np.float32)


def _default_output(input_path: Path, fmt: str) -> Path:
    return input_path.with_suffix(f".radio.{fmt}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="make-radio-sound",
        description="Convert audio to AM/SW radio-sounding mono with hiss and crackles.",
    )
    parser.add_argument("input", help="Input audio file (mp3/mp4/m4a/wav/aac/ogg/flac).")
    parser.add_argument("-o", "--output", help="Output path. Default: <input>.radio.<format>")
    parser.add_argument("--mode", choices=("am", "sw"), default="am", help="Radio flavour.")
    parser.add_argument(
        "--intensity",
        type=float,
        default=0.6,
        help="Effect strength 0.0-1.0 (default 0.6).",
    )
    parser.add_argument("--seed", type=int, default=None, help="Seed for deterministic noise/crackles.")
    parser.add_argument("--format", choices=("mp3", "wav"), default="mp3", help="Output format (default mp3).")
    args = parser.parse_args(argv)

    in_path = Path(args.input).expanduser().resolve()
    if not in_path.is_file():
        print(f"error: input not found: {in_path}", file=sys.stderr)
        return 2
    if in_path.suffix.lower() not in SUPPORTED_INPUT_EXTS:
        print(
            f"error: unsupported extension {in_path.suffix!r}. Supported: {sorted(SUPPORTED_INPUT_EXTS)}",
            file=sys.stderr,
        )
        return 2
    if not (0.0 <= args.intensity <= 1.0):
        print("error: --intensity must be between 0.0 and 1.0", file=sys.stderr)
        return 2

    out_path = Path(args.output).expanduser().resolve() if args.output else _default_output(in_path, args.format)

    rng = np.random.default_rng(args.seed)
    print(f"[load]   {in_path.name}")
    samples, sr = _load_mono(in_path)
    duration = len(samples) / sr
    print(f"[input]  {duration:.1f}s @ {sr} Hz, mono")
    print(f"[mode]   {args.mode}, intensity={args.intensity}")

    out = radio_ify(samples, sr, args.mode, args.intensity, rng)

    print(f"[save]   {out_path}")
    _save(out, sr, out_path, args.format)
    print("[done]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
