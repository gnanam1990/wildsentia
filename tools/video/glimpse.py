"""Cuts a short social clip (10-15 s) from shots filmed by film.ts.

    python3 tools/video/glimpse.py <raw-dir> <out.mp4> "shot:start:seconds:caption" ... [--tag TEXT]

Each shot is laid on its exact frame times, resampled to 240 fps and blended to 60 fps (a
180-degree shutter, as in edit.py), pushed in slightly so the animals read on a phone, graded,
and given an optional lower-third caption. Shots crossfade; the last ends on a small end tag.
1920x1080, H.264, 60 fps, with a silent audio track for platforms that expect one.
"""
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

args = [a for a in sys.argv[1:] if not a.startswith("--")]
RAW, OUT, specs = Path(args[0]), Path(args[1]), args[2:]
# "--tag ''" leaves the end tag off (when the last caption already names the place).
TAG = sys.argv[sys.argv.index("--tag") + 1] if "--tag" in sys.argv else "WILDSENTIA"
if "--tag" in sys.argv:
    specs = [a for a in specs if a != TAG]
WORK = OUT.parent / "glimpse-work"
WORK.mkdir(parents=True, exist_ok=True)
W, H, FPS, FADE, PUSH = 1920, 1080, 60, 0.5, 1.22

AVENIR = "/System/Library/Fonts/Avenir Next.ttc"
font = lambda size, index: ImageFont.truetype(AVENIR, size, index=index)
BOLD, DEMI = 0, 2
GRADE = ("eq=contrast=1.07:saturation=1.15:brightness=0.02:gamma=1.1,"
         "colorbalance=rs=0.03:gs=0.01:bs=-0.04:rm=0.02:bm=-0.03,"
         "vignette=angle=PI/5:mode=forward,unsharp=5:5:0.45")


def shadowed(img, xy, text, fnt, anchor, fill=(255, 255, 255, 255)):
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).text((xy[0] + 2, xy[1] + 3), text, font=fnt, fill=(0, 0, 0, 180), anchor=anchor)
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(7)))
    ImageDraw.Draw(img).text(xy, text, font=fnt, fill=fill, anchor=anchor)


def overlay(name, draw):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw(img)
    path = WORK / f"{name}.png"
    img.save(path)
    return path


def caption_png(i, text, closing=False):
    # The closing line is the clip's title: larger, and higher in the frame.
    if closing:
        return overlay(f"cap{i}", lambda img: shadowed(img, (W // 2, int(H * 0.8)), text, font(84, BOLD), "ms"))
    return overlay(f"cap{i}", lambda img: shadowed(img, (W // 2, H - 110), text, font(54, DEMI), "ms"))


def tag_png():
    def draw(img):
        shadowed(img, (W - 70, H - 64), TAG, font(40, BOLD), "rs")
    return overlay("tag", draw)


clips = []
for i, spec in enumerate(specs):
    shot, start, seconds, *rest = spec.split(":", 3)
    start, seconds, text = float(start), float(seconds), (rest[0] if rest else "")
    meta = json.loads((RAW / shot / "meta.json").read_text())
    times = meta["times"]
    listing = WORK / f"frames{i}.txt"
    lines = []
    for k, t in enumerate(times):
        duration = (times[k + 1] - t) if k + 1 < len(times) else 1 / 240
        lines += [f"file '{(RAW / shot / f'f{k:05d}.jpg').as_posix()}'", f"duration {duration:.6f}"]
    listing.write_text("\n".join(lines) + "\n")
    cw, ch = round(W / PUSH / 2) * 2, round(H / PUSH / 2) * 2
    chain = (f"[0:v]fps=240,tmix=frames=2,framestep=4,trim=start={start:.3f}:duration={seconds:.3f},setpts=PTS-STARTPTS,"
             f"crop=iw-8:ih-8:4:4,crop={cw}:{ch},scale={W}:{H}:flags=lanczos,{GRADE}[v]")
    inputs = ["-f", "concat", "-safe", "0", "-i", str(listing)]
    last = "v"
    if text:
        inputs += ["-loop", "1", "-i", str(caption_png(i, text, closing=i == len(specs) - 1))]
        chain += (f";[1:v]format=rgba,fade=in:st=0.35:d=0.45:alpha=1,fade=out:st={seconds - 0.9:.2f}:d=0.45:alpha=1[t]"
                  f";[v][t]overlay=0:0:shortest=1[c]")
        last = "c"
    if i == len(specs) - 1 and TAG:
        n = 2 if text else 1
        inputs += ["-loop", "1", "-i", str(tag_png())]
        chain += f";[{n}:v]format=rgba,fade=in:st={seconds - 2.2:.2f}:d=0.6:alpha=1[g];[{last}][g]overlay=0:0:shortest=1[e]"
        last = "e"
    out = WORK / f"clip{i}.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", chain, "-map", f"[{last}]",
                    "-t", f"{seconds:.3f}", "-r", str(FPS), "-c:v", "libx264", "-preset", "slow", "-crf", "14",
                    "-pix_fmt", "yuv420p", str(out)], check=True)
    clips.append((out, seconds))

inputs, chain, offset, prev = [], [], 0.0, "0:v"
for i, (path, seconds) in enumerate(clips):
    inputs += ["-i", str(path)]
    if i == 0:
        offset = seconds - FADE
        continue
    chain.append(f"[{prev}][{i}:v]xfade=transition=fade:duration={FADE}:offset={offset:.3f}[x{i}]")
    prev = f"x{i}"
    offset += seconds - FADE
total = offset + FADE
chain.append(f"[{prev}]fade=in:st=0:d=0.4,fade=out:st={total - 0.6:.2f}:d=0.6[final]")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-f", "lavfi", "-t", f"{total:.3f}",
                "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
                "-filter_complex", ";".join(chain), "-map", "[final]", "-map", f"{len(clips)}:a",
                "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-maxrate", "16M", "-bufsize", "32M",
                "-profile:v", "high", "-level", "4.2", "-pix_fmt", "yuv420p", "-r", str(FPS),
                "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", str(OUT)], check=True)
print(f"wrote {OUT} ({total:.1f} s)")
