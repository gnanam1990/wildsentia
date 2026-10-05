"""Cuts captured shots (tools/video/capture.ts) into a ~60 s teaser for X/Twitter.

    python3 tools/video/edit.py <raw-dir> <out.mp4>

1920x1080 H.264 (yuv420p, +faststart), 60 fps, a 2.39:1 letterbox, a light warm grade and
vignette, crossfades between shots, and a title, captions and an end card drawn here.

Shots filmed by film.ts carry each frame's game-time stamp: frames are laid on those exact times,
resampled to 240 fps, and pairs of 240 fps sub-frames averaged before stepping to 60 fps — a
180-degree shutter's motion blur, with no judder from uneven capture.
"""
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

RAW, OUT = Path(sys.argv[1]), Path(sys.argv[2])
WORK = OUT.parent / "edit-work"
WORK.mkdir(parents=True, exist_ok=True)
W, H, FPS, FADE = 1920, 1080, 60, 0.6
BAR = round((H - W / 2.39) / 2)  # letterbox bar height

AVENIR = "/System/Library/Fonts/Avenir Next.ttc"
def font(size, index):
    return ImageFont.truetype(AVENIR, size, index=index)
# Avenir Next.ttc faces: 0 Bold, 2 Demi Bold, 5 Medium.
BOLD, DEMI, MEDIUM = 0, 2, 5

# (shot, seconds used, caption)
CUT = [
    ("a-canopy", 7.0, None),  # over the forest: title
    ("b-elephant", 6.0, "An island that lives on its own."),
    ("c-chital", 5.5, "Hundreds of animals. Each with a life of its own."),
    ("d-langur", 5.5, "They graze, drink, rest and raise their young."),
    ("e-gaur", 5.0, None),
    ("f-hunt-tiger", 9.5, "Every hunt is real. Nothing is scripted."),
    ("g-hunt-dhole", 8.0, "Predators hunt. Prey runs."),
    ("h-boar", 4.5, None),
    ("i-squirrel", 4.5, "Follow any animal. Watch its whole life."),
    ("j-sambar", 5.5, "AI agents can step into the wild."),
    ("k-rise", 9.5, None),  # rising over the forest: end card
]
CUT = [row for row in CUT if (RAW / row[0] / "meta.json").exists()]


def overlay(name, draw_fn):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw_fn(img)
    path = WORK / f"{name}.png"
    img.save(path)
    return path


def letterbox(img):
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, BAR], fill=(0, 0, 0, 255))
    d.rectangle([0, H - BAR, W, H], fill=(0, 0, 0, 255))


def shadowed_text(img, xy, text, fnt, fill=(255, 255, 255, 255), anchor="la", spacing=0):
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).text((xy[0] + 2, xy[1] + 3), text, font=fnt, fill=(0, 0, 0, 170), anchor=anchor)
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(6)))
    ImageDraw.Draw(img).text(xy, text, font=fnt, fill=fill, anchor=anchor)


def tracked_text(img, centre, text, fnt, tracking, fill=(255, 255, 255, 255)):
    """Evenly letter-spaced text centred on `centre` (baseline), with the same soft shadow."""
    widths = [fnt.getlength(c) for c in text]
    total = sum(widths) + tracking * (len(text) - 1)
    x = centre[0] - total / 2
    for c, w in zip(text, widths):
        shadowed_text(img, (x, centre[1]), c, fnt, fill=fill, anchor="ls")
        x += w + tracking


def caption(text):
    def draw(img):
        shadowed_text(img, (120, H - BAR - 70), text, font(46, DEMI), anchor="ls")
    return overlay("cap-" + str(abs(hash(text))), draw)


def title(img):
    tracked_text(img, (W // 2, H // 2 - 10), "VANA", font(150, BOLD), 60)
    tracked_text(img, (W // 2, H // 2 + 70), "THE LIVING WILD", font(38, MEDIUM), 14, fill=(232, 238, 226, 255))


def end_card(img):
    tracked_text(img, (W // 2, H // 2 - 30), "VANA", font(120, BOLD), 48)
    shadowed_text(img, (W // 2, H // 2 + 40), "A living forest, in real time.", font(44, MEDIUM), anchor="ms")
    shadowed_text(img, (W // 2, H // 2 + 120), "COMING SOON", font(34, DEMI), fill=(224, 173, 99, 255), anchor="ms")


bars = overlay("letterbox", letterbox)
title_png = overlay("title", title)
end_png = overlay("end", end_card)

GRADE = ("eq=contrast=1.07:saturation=1.18:brightness=0.005:gamma=0.97,"
         "colorbalance=rs=0.03:gs=0.01:bs=-0.04:rm=0.02:bm=-0.03,"
         "vignette=angle=PI/5:mode=forward,unsharp=5:5:0.4")


def clip(i, shot, seconds, text):
    meta = json.loads((RAW / shot / "meta.json").read_text())
    out = WORK / f"clip{i:02d}.mp4"
    if "times" in meta:
        # Exact frame times (game seconds): a concat list with per-frame durations.
        times = meta["times"]
        listing = WORK / f"frames{i:02d}.txt"
        lines = []
        for k, t in enumerate(times):
            duration = (times[k + 1] - t) if k + 1 < len(times) else 1 / 240
            lines += [f"file '{(RAW / shot / f'f{k:05d}.jpg').as_posix()}'", f"duration {duration:.6f}"]
        listing.write_text("\n".join(lines) + "\n")
        available = times[-1]
        inputs = ["-f", "concat", "-safe", "0", "-i", str(listing), "-loop", "1", "-i", str(bars)]
        timing = "fps=240,tmix=frames=2,framestep=4,"
    else:
        fps = meta["fps"]
        available = meta["frames"] / fps
        inputs = ["-framerate", f"{fps:.4f}", "-i", str(RAW / shot / "f%05d.jpg"), "-loop", "1", "-i", str(bars)]
        timing = f"fps={FPS},"
    # Use the calm middle of each move: start a little in, so the shot opens already moving.
    start = max(0.0, min(available - seconds, available * 0.08))
    chain = (f"[0:v]{timing}trim=start={start:.3f}:duration={seconds:.3f},setpts=PTS-STARTPTS,"
             f"scale={W}:{H}:flags=lanczos,{GRADE}[v];[v][1:v]overlay=0:0:shortest=1[b]")
    last = "b"
    extra = []
    if text or i == 0 or i == len(CUT) - 1:
        art = title_png if i == 0 else end_png if i == len(CUT) - 1 else caption(text)
        extra = ["-loop", "1", "-i", str(art)]
        if i == 0:
            fade = f"fade=in:st=0.8:d=0.9:alpha=1,fade=out:st={seconds - 1.6:.2f}:d=0.8:alpha=1"
        elif i == len(CUT) - 1:
            fade = f"fade=in:st=1.8:d=1.0:alpha=1"
        else:
            fade = f"fade=in:st=0.5:d=0.5:alpha=1,fade=out:st={seconds - 1.1:.2f}:d=0.5:alpha=1"
        chain += f";[2:v]format=rgba,{fade}[t];[b][t]overlay=0:0:shortest=1[o]"
        last = "o"
    if i == len(CUT) - 1:
        chain += f";[{last}]fade=out:st={seconds - 1.2:.2f}:d=1.2[f]"
        last = "f"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *inputs, *extra, "-filter_complex", chain, "-map", f"[{last}]",
                    "-t", f"{seconds:.3f}", "-r", str(FPS), "-c:v", "libx264", "-preset", "slow", "-crf", "14",
                    "-pix_fmt", "yuv420p", str(out)], check=True)
    return out, seconds


clips = [clip(i, *row) for i, row in enumerate(CUT)]

# Crossfade everything into one timeline.
inputs, chain, offset, prev = [], [], 0.0, "0:v"
for i, (path, seconds) in enumerate(clips):
    inputs += ["-i", str(path)]
    if i == 0:
        offset = seconds - FADE
        continue
    label = f"x{i}"
    chain.append(f"[{prev}][{i}:v]xfade=transition=fade:duration={FADE}:offset={offset:.3f}[{label}]")
    prev = label
    offset += seconds - FADE
total = offset + FADE
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-f", "lavfi", "-t", f"{total:.3f}",
                "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
                "-filter_complex", ";".join(chain), "-map", f"[{prev}]", "-map", f"{len(clips)}:a",
                "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-maxrate", "12M", "-bufsize", "24M", "-profile:v", "high", "-level", "4.1",
                "-pix_fmt", "yuv420p", "-r", str(FPS), "-c:a", "aac", "-b:a", "128k", "-shortest",
                "-movflags", "+faststart", str(OUT)], check=True)
print(f"wrote {OUT} ({total:.1f} s)")
