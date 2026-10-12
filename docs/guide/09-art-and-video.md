# 9. Art and video

## Animal models

Every animal model is a glTF binary (`.glb`) in
[`packages/client/public/assets/animals/`](../../packages/client/public/assets/animals), with
its skeleton and animation clips. Sources and licences are listed in
[`ASSET-CREDITS.md`](../../packages/client/public/assets/ASSET-CREDITS.md).

| Models | How they are made |
|---|---|
| Chital (stag and hind), sambar, gaur, wild boar, dhole, jackal, hare, grey langur, giant squirrel, white-rumped vulture | A generated mesh of the species, fitted and skinned onto an existing rig with its clips, by [`tools/art/bind_to_rig.py`](../../tools/art/bind_to_rig.py). [`tools/art/build_species.sh`](../../tools/art/build_species.sh) lists each species' rig, review clips and fitting mode. |
| Tiger | The project's own static tiger, rigged locally and given authored motion by [`tools/assets/rig_local_tiger.py`](../../tools/assets/rig_local_tiger.py): Idle, Walk, Run, Gallop, Pounce, Bite, Sneak, Eating, Drinking, Resting and Death. |
| Asian elephants (adult male, adult female, calf) | A licensed detailed model with its own walk, idle and trunk motion. |
| Stand-ins | Species without a model are drawn as a plain shape in the species' colour, never as another animal. |

Models are built with Blender 5 from the command line, for example:

```bash
blender -b --factory-startup --disable-autoexec \
  --python tools/assets/rig_local_tiger.py -- OUTPUT_DIR packages/client/public/assets/animals/Tiger.glb
```

Some fixes are applied to a shipped model by a script, so they can be reproduced:
[`tools/art/fix_langur_limb.py`](../../tools/art/fix_langur_limb.py) removes an extra limb the
generated langur mesh grew under its chest.

### Clips made in the browser

Two clips are built when a model loads, from the model's own motion:

- **TrunkReach** (elephants): a grounded trunk reach for feeding and drinking, from the
  elephant's spray clip.
- **Struggle** (prey): a downed animal's struggle, from the last pose of its Death clip, with its
  legs kicking about the axes they swing on in its own gait.

### Checks on every model

The test suite guards the art as well as the code: finite, normalised skin weights and real
motion in every clip; the clips each model must have (the tiger's Gallop, Pounce and Bite among
them); the Asian elephants' facing (the exports sit about 32° off their forward axis, corrected
in the client); and exactly four limbs on the ground for every four-legged model.

## The teaser video

The "coming soon" teaser is filmed from the running site and cut by script, so it can be
re-made whenever the build changes.

### Filming: `tools/video/film.ts`

```bash
(cd packages/client && npx vite --config vite.e2e.config.ts)   # the dev observer on :5299
npx tsx tools/video/film.ts <out-dir> [shot ...]
```

- Each shot follows a chosen animal (or replays a recorded hunt) with a camera path computed
  inside the page every frame, so the camera never steps.
- The page's clock runs at a fraction of real time while filming (`VANA_FILM_TIME_SCALE`,
  default 0.25; use 0.125 when the machine is busy), so the GPU has time for every frame.
  Frames are captured through the browser's screencast with their timestamps, converted to
  game time.
- Before recording a species shot the script waits until the camera has reached its animal.
- Each shot's `meta.json` records its frame times and the worst gap between frames; under
  about 15 ms of game time plays perfectly smoothly.

### Cutting: `tools/video/edit.py`

```bash
python3 tools/video/edit.py <out-dir> <output.mp4>
```

- Frames are laid on their exact times, resampled to 240 fps, and pairs of sub-frames are
  averaged before stepping to 60 fps: a 180° shutter's motion blur with no judder.
- 1920 × 1080, H.264, 60 fps; a 2.39:1 letterbox, a light warm grade and vignette, crossfades,
  a title card, captions and an end card drawn in the script.
- Check the result for repeated frames with ffmpeg's `mpdecimate`; a smooth cut has none
  outside still moments.

The current cut is `.ci-artifacts/video/wildsentia-coming-soon.mp4` (60 s), with a phone-sized
copy alongside it.
