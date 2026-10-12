# Free/local asset conversion

## Character pose review (24 September 2026)

`review_character.py` renders a selected GLB mesh/clip/frame using official Blender 4.5.9.
It excludes bone-display helper meshes from framing and refuses existing outputs. Frame units
are Blender frames, not seconds. A missing requested clip is an error for rigged inputs.

Some imported rigs deform differently in Blender and Three.js. Before rejecting such a source,
`bake_character_review.mjs` evaluates the game's Three.js skinning at a specified **time in
seconds** and writes an isolated **static diagnostic pose** with original embedded textures.
It recomputes normals; this is a geometry comparison, not pixel-identical game-render evidence.
Only self-contained single-buffer GLBs, one triangle primitive and no morph targets are supported.
Use the exact loaded skinned-mesh name. Never ship its static output as an animated replacement.

```sh
node tools/assets/bake_character_review.mjs SOURCE.glb NEW_POSE.glb Object_7 Idle 0
blender -b --factory-startup --disable-autoexec --python-exit-code 1 --python tools/assets/review_character.py -- NEW_POSE.glb NEW_IMAGE.png - Idle 0 140
npx vitest run packages/client/test/characterReviewTool.test.ts
```

The final optional renderer argument rotates the review camera in degrees. Inspect idle and
multiple walking poses; stills alone cannot establish foot contact or transition quality.
Neither tool modifies the input asset or authoritative simulation.

## Natural rock conversion (24 September 2026)

Powered by [Poly Haven](https://polyhaven.com). `build_natural_rocks.mjs` downloads only two
reviewed CC0 sources, verifies all five source files per asset against pinned publisher hashes,
and creates self-contained GLBs with byte-preserved 1K PBR maps. No Blender or paid tool needed.
The tool-only dependency is pinned to meshoptimizer 1.2.0 with a separate package lock.

Run from the repository root:

```sh
npm ci --prefix tools/assets --ignore-scripts
rock_scratch=$(mktemp -d)
node tools/assets/build_natural_rocks.mjs boulder_01 "$rock_scratch" "$rock_scratch/NaturalBoulder.glb"
node tools/assets/build_natural_rocks.mjs rock_07 "$rock_scratch" "$rock_scratch/NaturalStone.glb"
npx vitest run packages/client/test/rockAssets.test.ts packages/client/test/vegetation.test.ts packages/client/test/vegetationResources.test.ts
```

Inspect replacements before copying into the client; tests above inspect the **shipped** files.
Existing outputs are accepted only if byte-identical; differing files are never silently
overwritten. The converter normalizes height/feet and simplifies with UV and normal weights.
Boulder uses Permissive seam collapse to reach 6,000 triangles; stone uses default constraints
at 2,000. Reported simplifier errors (0.01656 / 0.01169) are not visual-quality guarantees.
Exact output hashes, authors and limitations are recorded in `ASSET-CREDITS.md`.

## Natural tree conversion (24 September 2026)

Use official Blender **4.5.9 LTS**. The macOS arm64 runtime used for this conversion matched the
publisher's SHA-256 `e3a3d7aac381fb4e4d05197f99cd8899484d7e8bc4497c134066e6733f372238`.
It was mounted temporarily, not installed globally. Temporary sources/runtime may need downloading
again; the accepted GLBs, exporter, tests and provenance remain in this repository.

```sh
tree_scratch=$(mktemp -d)
node tools/assets/download_polyhaven.mjs island_tree_02 "$tree_scratch"
node tools/assets/download_polyhaven.mjs tree_small_02 "$tree_scratch"
blender -b --factory-startup --disable-autoexec "$tree_scratch/island_tree_02/island_tree_02_1k.blend" --python-exit-code 1 --python tools/assets/export_natural_tree.py -- island_tree_02 "$tree_scratch/NaturalBroadleafSpreading.glb"
blender -b --factory-startup --disable-autoexec "$tree_scratch/tree_small_02/tree_small_02_1k.blend" --python-exit-code 1 --python tools/assets/export_natural_tree.py -- tree_small_02 "$tree_scratch/NaturalBroadleafUpright.glb"
blender -b --factory-startup --disable-autoexec --python-exit-code 1 --python tools/assets/render_tree_review.py -- "$tree_scratch/NaturalBroadleafSpreading.glb" "$tree_scratch/NaturalBroadleafUpright.glb" "$tree_scratch/review.png"
```

Inspect the render **before** copying new assets into `packages/client/public/assets/nature`.
Source branch resampling counts also determine leaf placement: reducing them destroys density.
Whole-canopy decimation deletes small leaves. The accepted exporter instead fits independent
UV-preserving cards and separately budgets bark. The procedural tree's scene layout offset must
not separate it from its scanned trunk. Blender's RGB-plus-alpha packing needs raw sRGB code values
to avoid double-darkening the exported leaf texture. These failures were caught by visual review;
export success and triangle counts alone are not sufficient QA.

`inspect_tree_source.py` inventories a source without executing embedded scripts.
`inspect_glb_images.mjs OUTPUT.glb SCRATCH_DIR` extracts embedded maps for colour/alpha inspection.
`natureAssets.test.ts` checks actual packaged bounds, embedded maps, budgets and mask materials;
`vegetationResources.test.ts` checks per-kind shader ownership, failed-load cleanup and view-turn
culling. Free asset provenance and native-species limitations are in `ASSET-CREDITS.md`.

## Existing animal sources

The imported elephant/rabbit GLBs are locally converted CC0 art. Other files include original
project-authored models and a derivative of the existing project tiger; see credits. Source files are downloads, not executable
build dependencies. Never enable embedded Python scripts in downloaded Blender scenes.

| Output | Source | Source SHA-256 |
|---|---|---|
| Elephant.glb | https://opengameart.org/sites/default/files/elephant-lowpoly.blend | `cb916973655dcd16905681c7a7df87d80e964103a02cbe585747f816bb0fd4f1` |
| Rabbit.glb | https://opengameart.org/sites/default/files/rabbit.blend | `bb6deef1ee91b21380355138374cae87946451ce864502b1af68eb60f4750843` |

With Blender 4.0.2, run from the repository root (input files downloaded separately):

```sh
blender --background --disable-autoexec elephant-lowpoly.blend --python tools/assets/export_blend.py -- Elephant.glb
blender --background --disable-autoexec rabbit.blend --python tools/assets/export_blend.py -- Rabbit.glb
```

Output SHA-256:

- Elephant: `682e6b100ff1a6a230904137db2941f4f0a43ede58cc9bd248e87191c7f431c3`
- Rabbit: `763c19a2606208f0560386b5e207b4995b0f71f857d75ebfa7f25af04956bfa3`

The exporter repairs legacy material connections, bakes constraints and retains author motion.
It removes Rabbit's modelling floor by a guarded scene-specific rule; the elephant's actual
mesh is named Plane, so never strip all meshes named Plane. Blender reports unsupported
constraint/animation-target warnings while baking old scene actions; acceptance requires both
GLB structure tests and actual visual playback, not merely a successful export command.

Inspect `/characters.html` after `npm run dev:client`. Check geometry, textures, source clips,
foot contact and transition limitations. The page is isolated art QA, not an ecosystem control.
The species rig/animation claims in `packages/client/test/assets.test.ts` inspect the binary
GLB manifests rather than trusting filenames.

See `packages/client/public/assets/ASSET-CREDITS.md` for source licence links and known limitations.

## Local wildlife and motion pass

Requires Blender **4.0.2**. Run these commands from the repository root; output goes to a new
scratch directory for inspection before copying accepted GLBs into the client:

```sh
asset_out=$(mktemp -d)
blender -b --factory-startup --disable-autoexec --python-exit-code 1 --python tools/assets/build_wildlife.py -- "$asset_out"
blender -b --factory-startup --disable-autoexec --python-exit-code 1 --python tools/assets/rig_local_tiger.py -- "$asset_out" packages/client/public/assets/animals/Tiger.glb
blender -b --factory-startup --disable-autoexec --python-exit-code 1 --python tools/assets/extend_elephant.py -- packages/client/public/assets/animals/Elephant.glb "$asset_out/ElephantWalking.glb"
```

- `build_wildlife.py`: stylized Langur, Squirrel, Vulture plus a non-shipped Hare experiment.
  Geometry, rigs and motion are locally authored. No downloaded creature is silently renamed.
- `rig_local_tiger.py`: continuous distance-weight binding fitted to the existing source tiger;
  eight conservative motion clips. It is **not** the requested Sketchfab Running Tiger.
- `big_cat_gaits.mjs` (Node, no Blender; `npm ci` here first): replaces the tiger's and leopard's
  Walk, Run (a trot) and Sneak with a cat's four-beat walk, a diagonal trot and a low stalk. Planted
  paws are held to the ground and flat by solving knee and ankle; swinging paws clear it. Run it on
  the rigged tiger after `rig_local_tiger.py`, and on `LeopardRigged.glb` after
  `leopard_from_tiger.py` (which copies the tiger's clips):
  `node tools/assets/big_cat_gaits.mjs IN.glb OUT.glb`. `packages/client/test/bigCatGait.test.ts`
  measures the result by forward kinematics.
  Further manual skin-weight, shoulder and paw-contact refinement is required.
- `extend_elephant.py`: preserves five source clips and adds Walk. Source GLB is not overwritten.
- Export with `--python-exit-code 1`: Blender otherwise can return zero after a Python failure.
- Draco is not installed in the conversion container; these exports are uncompressed GLBs.
  A Draco availability warning is not evidence that compressed output was produced.
- `inspect_scene.py` provides a read-only inventory of source objects, materials, bones and clips.

Downloaded, pinned reference files (not used in shipped animations):

| Local file under `vendor/mesh2motion` | SHA-256 |
|---|---|
| fox-animations.glb | `80e80641a5692a14aba7616a46d2a28d3595479764887c578c766b99dba8a0d0` |
| bird-animations.glb | `9624b0bf70abe400ed0445c2423c69d5e046bd7d60074e399e2be161763c4f99` |
| LICENSE-CC0.MD | `52fec1c484df708c16b4c27b2bf0d7f0d3994105c57adc4b9e6f95bcfd9de65f` |

Source: Mesh2Motion/mesh2motion-app, commit `3ce7f9d97d25e608b4779ce797da343775ded62b`,
`static/animations/{fox,bird}-animations.glb` and root `LICENSE-CC0.MD`.

Validation: binary tests check actual skins, normalized weights, finite animation samples,
nonzero clip duration and changing keyframes. These tests **do not establish anatomical or
biomechanical quality**. Inspect every new rig in `/characters.html` before release. All new
status labels deliberately retain pending-art warnings.
## CC0 human build

`download_quaternius_standard.mjs` downloads only an allowlisted publisher's free Standard
ZIP through its anonymous download flow, retaining a source manifest and SHA-256. It refuses
auth/payment/quarantine responses and does not execute archive code. Raw ZIPs and intermediate
review builds are ignored, not deleted. Reproduce in the repository root:

```sh
npm ci --prefix tools/assets --ignore-scripts
node tools/assets/download_quaternius_standard.mjs universal-base-characters tools/assets/sources/humans-base
node tools/assets/download_quaternius_standard.mjs modular-character-outfits-fantasy tools/assets/sources/humans-outfits
node tools/assets/download_quaternius_standard.mjs universal-animation-library tools/assets/sources/humans-motion
node tools/assets/build_humans.mjs NEW_OUTPUT_DIRECTORY
node tools/assets/review_humans.mjs NEW_OUTPUT_DIRECTORY NEW_REVIEW.png
```

Download directories must be absent (existing source manifests/archives are retained). The
builder requires the three pinned archive digests, processes only asset data and writes to
a new output directory. It assembles clothing with cropped head/hair, retargets in-place
motion, resamples redundant keys and reduces texture sizes. Source URI spelling corrections
are explicit; unexpected missing data fails rather than substituting an unrelated texture.

The review tool CPU-projects actual posed triangles with sampled base-color textures. It is
a diagnostic contact sheet, **not a screenshot of the browser**, PBR rendering acceptance or
proof of exact hand/foot contact. Runtime and `/characters.html?species=human-female` (or
`human-male`) use the real embedded GLBs and Three.js skeletal animation. Run
`npx vitest run packages/client/test/humanAssets.test.ts packages/client/test/humans.test.ts`
for source integrity, skin/pose and live rendering-contract checks.

## Rabbit texture budget (26 September 2026)

`shrink_rabbit_textures.py` rewrote only the three embedded images of
`packages/client/public/assets/animals/Rabbit.glb`: 1024 px to 512 px, the alpha-masked fur
and the normal map as PNG, the opaque body (whose alpha channel is unused) as JPEG q90.
Every geometry, skin and animation buffer view is byte-identical to the source; the source
file's SHA-256 is recorded in `asset.extras.textureBudget`. 4.82 MB to 1.93 MB.
