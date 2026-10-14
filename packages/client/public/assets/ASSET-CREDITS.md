# Asset provenance

Last checked: 25 September 2026. No asset enters the build without a row or section here (spec §13.4).

## Poly Haven — scanned rocks

Powered by [Poly Haven](https://polyhaven.com). Build tooling uses its public asset API;
the observer serves packaged assets locally without a runtime Poly Haven request.

| Local derivative | Source / author | Licence | Triangles | Bytes |
|---|---|---|---:|---:|
| `nature/NaturalBoulder.glb` | [Boulder 01](https://polyhaven.com/a/boulder_01), Rico Cilliers | CC0 | 6,000 | 3,030,308 |
| `nature/NaturalStone.glb` | [Rock 07](https://polyhaven.com/a/rock_07), Jenelle van Heerden | CC0 | 2,000 | 1,764,744 |

- Source glTF, binary and three 1K JPEG maps per asset are pinned by publisher MD5 in
  `tools/assets/build_natural_rocks.mjs`. [Publisher licence](https://polyhaven.com/license).
- Meshoptimizer 1.2.0 performs UV/normal-aware simplification from 66,122 / 14,844 source
  triangles. Boulder seam collapses use `Permissive`; stone uses default constraints.
- Normalized to 1 m high, centred horizontally, feet at zero. Vertex colours removed;
  source albedo, OpenGL normal and AO/roughness/metallic JPEG bytes embedded unchanged.
  The packed map also supplies AO. No AI generation or paid download.
- Five pebble/medium/boulder placement kinds reuse these two meshes with varied scale,
  partially embedded ground contact and shared textures. They remain decorative, not
  simulation obstacles or a claim about locally accurate geology.
- SHA-256 Boulder: `207cabc5240ccf047491754960a717b29c607ac92d92f88f84716736d1d97bec`.
- SHA-256 Stone: `5b0131a52f58fe9ce2974c97a358203ed3241aab9adfe7eb16a1c02568966a62`.

## Poly Haven — natural broadleaf derivatives

- Sources: [Island Tree 02](https://polyhaven.com/a/island_tree_02) (Rob Tuytel / Rico Cilliers),
  [Tree Small 02](https://polyhaven.com/a/tree_small_02) (Rico Cilliers). Both publisher pages
  specify CC0. Source blends and all referenced 1K textures were downloaded from the publisher
  API / `dl.polyhaven.org`; every downloaded file matched the publisher's size and MD5.
- Shipped: `nature/NaturalBroadleafSpreading.glb` (58,943 triangles; 6,502,704 bytes) and
  `nature/NaturalBroadleafUpright.glb` (67,499 triangles; 7,534,208 bytes).
- Local conversion: Blender 4.5.9 LTS, embedded-script execution disabled. Rebuild each disconnected
  leaf as a UV-fitted alpha-cutout card; retain non-planar exceptions; realise the author's tree
  nodes; simplify woody surfaces independently; remove source scene layout translation; normalize
  height to 8 m; embed albedo, normal and roughness images. RGB/alpha packing preserves sRGB code
  values. Source scenes/images are not overwritten. No AI generation or paid service was used.
- Six living-tree placement kinds now reuse these two files and their per-source distant atlases.
  Original Quaternius tree files remain available but those six living canopies no longer use them.
- **Generic visual proxies, not native-species claims.** Tree Small 02 is tagged Burkea africana /
  wild syringa by its author; neither source establishes the flora of a real forest. Leaf cards,
  scaled trunks and scanned root bases still need art-direction and terrain-contact refinement.

| File | SHA-256 |
|---|---|
| NaturalBroadleafSpreading.glb | `00c45fa5c92e2875316569563327776a8b86910b454b65a63218d7b86d06c704` |
| NaturalBroadleafUpright.glb | `aa082ce6b794117b7ecfffdb11e8d9d902cb79fb9a1a7f3d306cd17718b7c6d1` |

Source blend MD5: Island Tree `eeacbddb0ae5ceafa70115d066f21178` (38,795,227 bytes),
Tree Small `d602d9e4df77457454ac427fd37d0b53` (63,805,841 bytes).
See `tools/assets/export_natural_tree.py` and its reproduction instructions.

## Quaternius — Ultimate Animated Animal Pack
- Source: https://quaternius.com/packs/ultimateanimatedanimals.html (Google Drive folder linked there)
- Creator: Quaternius
- Licence stated by the creator: CC0 1.0 Universal (public domain). Attribution optional.
- Used for: chital (Deer), sambar (Stag), gaur (Bull), dhole (ShibaInu), jackal (Fox)
- Animation clips: Attack / Attack_Headbutt / Attack_Kick, Death, Eating, Gallop, Gallop_Jump,
  Idle, Idle_2, Idle_Headlow / Idle_2_HeadLow, Idle_HitReact1/2, Jump_toIdle, Walk
- Modifications: converted from embedded-buffer .gltf to binary .glb with
  `@gltf-transform/cli copy` (no geometry, material or animation changes). Sambar, gaur, dhole
  and jackal are tinted in the client at load time (`packages/client/src/species.ts`).

## VANA — generated island species (5 October 2026)
- Used for: chital (Chital), sambar (Sambar), gaur (Gaur), dhole (Dhole), golden jackal (Jackal),
  chital hinds (ChitalHind), black-naped hare (Hare), grey langur (GreyLangur), giant squirrel (GiantSquirrel), white-rumped vulture on the
  ground (WhiteRumpedVulture; in the air the earlier Vulture rig is drawn, since the generated
  bird's wings are modelled folded).
- Surfaces: generated for this project with Higgsfield under the owner's paid plan (Pro): GPT
  Image 2.5 front, side and back reference views, lifted with Tripo H3.1 multiview. Reference views,
  per-clip review sheets and an in-game check are in `docs/art-review/species-2026-10-05/`.
- Skeletons and clips: the existing rigs, refitted (Quaternius Deer, Stag, Bull, Fox, all CC0;
  VANA-authored Langur, Squirrel, Vulture). The old surfaces are not used.
- Rebuild: `ART=<dir of <species>-tripo.glb> tools/art/build_species.sh` (the species, rig, fit
  method and review clips are listed in the script). Tripo jobs: chital 318d3d7e, sambar
  c105333b, gaur e77817e4, dhole c2d53613, jackal a6b37f51, langur dfe4b295, squirrel
  a781faf2, vulture 7fd1587a, chital hind a6059627, hare 5dbb6e14 (an earlier standing hare,
  f8c08628, was rejected in review and not shipped).

## VANA — generated Congo species (14 October 2026)
- Used for: blue duiker (BlueDuiker), water chevrotain (WaterChevrotain), African leopard and the island's
  leopard (AfricanLeopard; one species). The interim LeopardRigged.glb (the tiger repainted) is retired.
- Surfaces: generated for this project with Higgsfield under the owner's paid plan (Pro): GPT
  Image 2.5 front, side and back reference views (duiker 14002d7a, 73eb7073, f2a9eb31; chevrotain
  766de682, 6031bedb, 89bdaf79), lifted with Tripo H3.1 multiview (20k faces, PBR, detailed
  texture; duiker d236ae94, chevrotain f4c95599). Reference views and per-clip review sheets are
  in `docs/art-review/congo-2026-10-14/`.
- Skeleton and clips: the Quaternius Deer rig and its clips (CC0), rest pose refitted to each body
  (`fit feet`); the deer's surface is not used.
- Rebuild: `ART=<dir of <species>-tripo.glb> tools/art/build_species.sh duiker chevrotain`.
- African leopard (AfricanLeopard): GPT Image 2.5 views (front d1c940e8, side 0933d8c9, back
  33b3b257; an earlier front view, db00bcf2, was not used: its tail swung out), Tripo H3.1
  multiview f5592116 (20k faces, PBR, detailed texture). Skeleton, weights and clips are this
  project's own, built by `tools/art/rig_big_cat.py` (36 bones; Idle, Walk, Run (the trot),
  Gallop, Sneak, Eating, Drinking, Resting, Pounce, Bite, Death): planted-paw IK strides designed
  against the client's stride length, baked to plain keys. Keyframed, not motion capture.
  Rebuild: `Blender -b --python tools/art/rig_big_cat.py -- --species leopard --mesh leopard-tripo.glb --out AfricanLeopard.glb`.

## VANA — generated Congo species, Phase 2A (14 October 2026)
- Used for: bay duiker (BayDuiker), Peters's duiker (PetersDuiker), red river hog (RedRiverHog), forest
  buffalo (ForestBuffalo), sitatunga (Sitatunga), African golden cat (AfricanGoldenCat).
- Surfaces: generated for this project with Higgsfield under the owner's paid plan (Pro): GPT Image 2.5
  front, side and back views (bay 724a3978, b7d9f782, 48e4947d; Peters's 84b5e563, 5fab2482, 6e852d2c;
  hog 78d10205, 0e03007b, dc086427; buffalo bcd47653, d7400cae, af7847de; sitatunga 36c523aa, ccb4d82b,
  f0b1a220; golden cat 6928a9e6, 18150a4d, 1d6dadb4), lifted with Tripo H3.1 multiview (20k faces, PBR,
  detailed texture; bay 932099c3, Peters's 0d252ef4, hog 23e9a930, buffalo ca4efba0, sitatunga 0e2b7e45,
  golden cat 105a5465). Reference views and review sheets: `docs/art-review/congo-2026-10-14/`.
- Skeletons and clips: the duikers and sitatunga on the Quaternius Deer rig, the hog (body-length fit)
  and buffalo (its skull and horns rigid with the head) on the Quaternius Bull rig, all CC0, by
  `tools/art/build_species.sh`; a dewclaw left as a detached crumb is dropped. The golden cat on the
  project's big-cat rig (`tools/art/rig_big_cat.py --species golden_cat`), keyframed, not motion capture.

## VANA — generated Congo species, Phase B (14 October 2026)
- Used for: forest elephant (ForestElephant), agile mangabey (AgileMangabey), crowned eagle
  (CrownedEagle on the ground, CrownedEagleFlying in the air), dwarf crocodile (DwarfCrocodile).
- Surfaces: generated for this project with Higgsfield under the owner's paid plan: GPT Image 2.5
  side, front and back views (elephant c8b7836b, ccce23b3, 1e3e72a4; mangabey 1a0e0e66, 57600fb9,
  b068640f; eagle d70959a7, 2bf06113, 5391f4ea; crocodile 1df93010, 86a866d7, 91dcba01), lifted with
  Tripo H3.1 multiview (20k faces, PBR, detailed texture; elephant 36714fe4, mangabey a7b68088, eagle
  d88a5833, crocodile 4016618d). The eagle in flight: GPT Image 2.5 views with its wings spread
  (f2f86ed4, 6c12f374, 287d8c4c) lifted with Meshy multi-image to 3D (dec91e64; a Tripo attempt from two views, b59e7972, grew fins where the wing was seen edge-on and was set aside). In flight it is bound to the Vulture rig's spread-wing rest; seen side-on its body tilts up (the rig rests as a standing bird), to be refined. Reference views and
  review sheets: `docs/art-review/congo-2026-10-14/`. (A mandrill mesh, 3bcd639e, was made and set
  aside when the research chose the agile mangabey.)
- Skeletons and clips, by `tools/art/build_species.sh`: the elephant on the generic CC0 elephant rig
  (ElephantWalking, OpenGameArt, below), the mangabey on the project's Langur rig, the eagle (both
  models) on the project's Vulture rig. The crocodile on a skeleton of its own
  (`tools/art/rig_crocodile.py`: spine, eight-bone tail, sprawled legs; weights by distance to the
  bones, as bone heat found no solution on its scutes), keyframed, not motion capture.

## VANA — generated wild boar (WildBoar)
- Used for: boar (WildBoar), from 5 October 2026.
- Surface: generated for this project with Higgsfield under the owner's paid plan (Pro). Three
  reference views (front, side, back) from GPT Image 2.5 (jobs 83c21a4e, 8dc52123, 4705dfa7),
  lifted to a textured mesh with Tripo H3.1 multiview (job fa976329). Reference views are kept in
  `docs/art-review/boar-2026-10-05/`.
- Skeleton and clips: the Quaternius Bull rig and its clips above (CC0), rest pose refitted to the
  boar's body; the bull's surface is not used.
- Built with `tools/art/bind_to_rig.py` (voxel-proxy bone-heat weights, texture 1024 px WebP):
  `Blender -b --python tools/art/bind_to_rig.py -- --mesh boar-tripo.glb --rig animals/Bull.glb
  --out WildBoar.glb --no-deform Tail4,Tail5,Tail6,Tail7`.

## Gobkit — Free Animal Pack B
- Source: https://gobkit.itch.io/gobkit-free-animal-pack-vol-2 (file from https://gobkit.com/api/free)
- Licence stated by the creator: CC0 1.0 (public domain). No attribution required.
- Used for: nothing at runtime since 5 October 2026 (formerly boar); kept for provenance.
- Animation clips: idle, walk, attack, dead
- Modifications: none.

## Quaternius — Stylized Nature MegaKit (Standard, free edition)
- Source: https://quaternius.com (the Standard edition, 68 of 116 models)
- Licence stated in the pack's License_Standard.txt: CC0 1.0 Universal (public domain).
- Retained files: trees, grass, bushes, ferns, flowers, clover, rocks and mushrooms.
  Current runtime uses the dead tree and understory; living trees and the five rock placement
  kinds use the Poly Haven derivatives above. Placement: `packages/client/src/vegetation.ts`.
- Modifications: textures resized to 512 px and re-encoded as WebP, models packed as binary
  .glb (`@gltf-transform/cli resize` then `webp`). The pack's vertex colours are wind masks for
  its own shader and are ignored at load; geometry is otherwise unchanged.
- Historical placement pass reused these rocks at pebble/medium/boulder scales. The current
  scanned replacements preserve varied scales; decorative instances are not simulation obstacles.
- The autumn-red `Leaves_TwistedTree` material is remapped to an evergreen palette in the
  runtime shader, preserving leaf texture detail/alpha. Original GLBs are unchanged.

## Locally authored grass carpet
- Source: `packages/client/src/groundCover.ts`, original procedural geometry written for VANA.
- Twelve tapered curved blades per tuft: 84 close / 36 distant triangles, two instanced batches
  sharing a material with GPU wind; reduced motion disables sway.
- No external image, generated texture, paid model or asset licence dependency. Height and density
  respond to patch biomass; this is a visual representation, not individual simulated grass plants.

## Locally synthesized ambient audio (5 October 2026)
- Source: `packages/client/src/ambientAudio.ts`, original Web Audio synthesis written for VANA.
  There are **no audio files**: nothing is downloaded, recorded, sampled or generated by an
  external service, and no third-party sound licence applies (equivalent to CC0, authored here).
- Rain, water and wind are three filtered paths of one two-second xorshift white-noise buffer
  computed in the browser after the observer clicks *Ambient audio*. Off by default; no autoplay.
- Animal calls are short oscillator glides or band-passed bursts of the same noise, with a few
  millisecond attack/decay envelope and stereo placement. Pitch and timing are rough synthetic
  approximations of an alarm bark, snort, trumpet, chatter, whistle or yip, **not recordings of
  any species** and not claimed to be acoustically accurate. They play only for an on-screen
  animal within 160 m whose saved or recorded state is fleeing (prey) or chasing (dhole, jackal).

## Locally authored ground layers and forest pattern (5 October 2026)
- Source: `packages/client/src/forestStructure.ts`, `groundTint.ts`, `wind.ts`. Procedural value
  noise and shader code written for VANA; no new image, model or texture asset. Leaf litter, red
  soil and moss tints, clump/clearing placement and wind sway are presentation only.

## Higgsfield — generated models (image to 3D)
- Source: generated for this project on higgsfield.ai (Pro plan) on 23 September 2026. A
  reference photo from GPT Image 2.5 (`gpt_image_2_5`), then Tripo H3.1 image to 3D
  (`tripo_h3_1_image_to_3d`, 20k face limit, PBR textures).
- Licence: output generated on a paid Higgsfield plan, owned by the project under Higgsfield's
  terms of service. Re-check those terms before production.
- Source retained unchanged: `animals/Tiger.glb`, unrigged, zero animation clips.
- Live derivative since 14 October 2026: `animals/TigerCat.glb`, the same surface on the big-cat
  rig the leopards use (`tools/art/rig_big_cat.py --species tiger`: 36 bones fitted to joints
  measured from the mesh; Idle, Walk, Run (the trot), Gallop, Sneak, Eating, Drinking, Resting,
  Pounce, Bite, Death as planted-paw IK strides baked to keys). Keyframed, not motion capture.
  No new generation credits used. The earlier `TigerRigged.glb` (a 19-bone fitted skeleton,
  `tools/assets/rig_local_tiger.py`) is retired.
- **Not the Amil “Running Tiger” Sketchfab asset.** The official download did not complete
  (`ERR_BLOCKED_BY_CLIENT` in Chrome); no Amil model was imported or attributed as shipped.

## File hashes (truncated sha256)
  - `animals/Deer.glb`: sha256 `75d88a0aa2f0569f`
  - `animals/Stag.glb`: sha256 `0910799eb37a9613`
  - `animals/Bull.glb`: sha256 `f44f2cb73afe2b4d`
  - `animals/ShibaInu.glb`: sha256 `c92467b05e0e9491`
  - `animals/Fox.glb`: sha256 `71e28dc471e8d001`
  - `animals/Boar.glb`: sha256 `e6ce64f0e4ac3646`
  - `animals/WildBoar.glb`: sha256 `4a04b5f961aaf403`
  - `animals/Chital.glb`: sha256 `2a7e48ad3d177857`
  - `animals/Sambar.glb`: sha256 `fd102b9d96c2d43c`
  - `animals/Gaur.glb`: sha256 `2932afd602cd44bd`
  - `animals/Dhole.glb`: sha256 `464c872895e14dd8`
  - `animals/Jackal.glb`: sha256 `8b0af8be0d610677`
  - `animals/GreyLangur.glb`: sha256 `f1df7353db1c1aaf`
  - `animals/GiantSquirrel.glb`: sha256 `fbfc1d0906d87f8d`
  - `animals/WhiteRumpedVulture.glb`: sha256 `dcd2259e64a75b99`
  - `animals/ChitalHind.glb`: sha256 `964cd399c9ba3459`
  - `animals/Hare.glb`: sha256 `21c4e03805abedc2`
  - `animals/BlueDuiker.glb`: sha256 `c5ae0e49d7c94327`
  - `animals/WaterChevrotain.glb`: sha256 `faa47f04cf2a1471`
  - `animals/AfricanLeopard.glb`: sha256 `52cf97f0a8fb06f6`
  - `animals/Tiger.glb`: sha256 `7d7c3d9546d1bbeb`
  - `animals/Elephant.glb`: sha256 `682e6b100ff1a6a23`
  - `animals/Rabbit.glb`: sha256 `763c19a2606208f05`
  - `animals/TigerCat.glb`: sha256 `dd2d718afcf503dd`
  - `animals/BayDuiker.glb`: sha256 `12e1e0034ceb09cc`
  - `animals/PetersDuiker.glb`: sha256 `0384af40492c6b5d`
  - `animals/RedRiverHog.glb`: sha256 `c464d7e57e5ef233`
  - `animals/ForestBuffalo.glb`: sha256 `41b1867fb33b0f74`
  - `animals/Sitatunga.glb`: sha256 `263724729507878d`
  - `animals/AfricanGoldenCat.glb`: sha256 `f224b1cff5928d55`
  - `animals/ForestElephant.glb`: sha256 `857653ac2031adb9`
  - `animals/AgileMangabey.glb`: sha256 `2d35e84625afd756`
  - `animals/CrownedEagle.glb`: sha256 `0385d33e2339dac3`
  - `animals/DwarfCrocodile.glb`: sha256 `3f2b62fd18fe5928`
  - `animals/CrownedEagleFlying.glb`: sha256 `6b4caf6310c6265e`
  - `animals/ElephantWalking.glb`: sha256 `f82c664c59e76713`
  - `animals/AsianElephantAdultMale.glb`: sha256 `fa5095bb38155cc041363ac60eb6d9a2f56cc660ffa2e322fd8a229afc841c8c`
  - `animals/AsianElephantAdultFemale.glb`: sha256 `4b2259f653ca329b0c61e69a155f312b97555d92b66506731edfcec5fb54de03`
  - `animals/AsianElephantCalf.glb`: sha256 `4cd93c060f3ffe010ff4299d5e91d5c14658467f6f2feb21c0ba05bd5793651f`
  - `animals/Langur.glb`: sha256 `baed053b237edf9db`
  - `animals/Squirrel.glb`: sha256 `903c2de358338aab3`
  - `animals/Vulture.glb`: sha256 `824ca9d39f66b0ff`

## OpenGameArt — elephant (added in the free/local implementation pass)

- Source: https://opengameart.org/content/low-poly-elephant-model
- Creator: syncopika. Source page declares **CC0**; checked 23 September 2026.
- Download: https://opengameart.org/sites/default/files/elephant-lowpoly.blend
- Used for: generic elephant; not verified as an anatomically accurate Asian elephant.
- Original `Elephant.glb` clips: Angry, Eating, GettingUp, Idle, Sitting. No original walk/run.
- Live `ElephantWalking.glb` preserves those five clips and adds a locally authored Walk
  using `tools/assets/extend_elephant.py`. Generic gait, not biomechanically validated.
- Modifications: local Blender 4.0.2 export with script execution disabled; legacy colours
  converted to Principled materials; armature constraints baked to sampled GLB animations.
- Geometry: 760 triangles, one skin across three material meshes. This is a low-poly generic
  fallback, not photorealistic production art. Age-known young elephants now use the separate
  calf-proportion derivative below. Foot-contact/gait polish, bathing, trunk-water contact and
  anatomically validated calves remain pending.

## Asian Elephant — interim adult and young viewer derivatives

- Creator: [planeta-elefante](https://sketchfab.com/planeta-elefante).
- Source: [Asian Elephant](https://sketchfab.com/3d-models/asian-elephant-2a7007e8bd2f45b89d1cc6ff75c5fed4).
- Publisher-declared licence: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- The live observer loads `animals/AsianElephantAdultMale.glb` **only** for adult/elder
  males. It is the pinned centred and flat-ground Walk derivative, repackaged with original
  mesh/skin/image/animation binary untouched by `tools/assets/elephant/build_live_adult_male.mjs`.
  `animals/AsianElephantAdultFemale.glb` is a tuskless **adult-female approximation** from
  the same source: four isolated paired tusk surfaces (432 triangles) were degenerated by
  `tools/assets/elephant/build_tuskless_review.mjs`, visually checked front/side, and
  repackaged by `tools/assets/elephant/build_live_adult_female.mjs`. Remaining skin, texture
  and animation bytes are unchanged. The exact review derivative is retained outside the
  public runtime in `docs/art-review/elephant-2026-09-24/recovered/`.
  `animals/AsianElephantCalf.glb` is a **calf-proportion proxy** from that pinned female
  derivative: `tools/assets/elephant/build_calf_review.mjs` compacts the torso, modestly
  enlarges the head, and shortens distal trunk-joint translations together with their
  retained animation samples. A first geometry-only attempt produced a hooked walking
  trunk and was rejected; both review copies remain in
  `docs/art-review/elephant-2026-09-25/`. Front/side Idle and Walk were checked in the
  local 3D workbench before `tools/assets/elephant/build_live_calf.mjs` repackaged the
  corrected review GLB. Newborn/juvenile use this model with their saved body-mass scale;
  subadults use a tuskless approximation. This is not measured calf anatomy or an
  age-specific gait.
  In the browser a local visual-only `TrunkReach` returns the source SprayWater clip's first
  0.28-second ground-contact pose; this is illustrative reaching, not true eating or drinking.
  The viewer applies a reversible, shader-only muted earth-grey grade to warm dark skin
  pixels in all three shipped variants; the original embedded image and ivory highlights
  remain unchanged. This is a display adaptation, not a new source texture or anatomical
  validation.
  The adult-female body is derived from the male and has
  not been anatomically validated. Retain credit to planeta-elefante, the source and
  this licence link; no endorsement is implied. Exact source authorship/commercial provenance,
  mouth contact, validated calf/female proportions and final visual/device acceptance remain open.
- Recovered from the existing local download; original bytes and attribution are preserved in
  `tools/assets/sources/elephant/` (repository-relative), not this public runtime directory.
- Modifications: first elephant isolated; unused rig branches, other meshes and unrelated maps
  removed. The compact derivative keeps 64 weighted joints with all required ancestors,
  6,994 triangles and four original clips. Vertex data, keyframes and chosen PNG are unchanged.
- Candidate: `docs/art-review/elephant-2026-09-24/recovered/AsianElephantCompact.glb`.
  Source-scale setup, gait/loop polish, lifecycle clips and visual acceptance remain pending;
  see `docs/2026-09-25-elephant-compact-rig.md`. That exact compact candidate remains
  review-only; the later pinned centred derivative is the interim adult-male live asset.
- Separate `AsianElephantLoopReview.glb` in the same review folder adds a locally authored
  0.3-second Walk-tail loop correction. Other clips remain unchanged. Numerical continuity
  is verified, but foot contact/natural gait and visual review remain unaccepted; see
  `docs/2026-09-25-elephant-walk-loop-review.md`. The same CC BY 4.0 attribution applies.
- `AsianElephantCenteredReview.glb` adds a reproducible parent-only centring/unit-height
  transform to the pinned loop-review GLB. Original binary, mesh, skin, clips, texture and
  attribution remain byte-for-byte unchanged. It is **review-only**, not mapped live; see
  `docs/2026-09-25-elephant-centered-root.md`. The same CC BY 4.0 attribution applies.

## OpenGameArt — rabbit (added in the free/local implementation pass)

- Source: https://opengameart.org/content/rabbit-0
- Creator: CDmir; collaborator TinyWorlds. Source page declares **CC0**, including animations;
  checked 23 September 2026.
- Download: https://opengameart.org/sites/default/files/rabbit.blend
- Used for: **rabbit approximation of hare**, explicitly labelled in the observer and review page.
- Modifications: local Blender 4.0.2 export with script execution disabled; non-character floor
  removed; packed fur/diffuse/normal images connected to Principled materials; alpha cutout fur.
  Action aliases: Running → Gallop, Guarding → Idle, Sitting.000 → Resting, Dying.000 → Death.
- Actual exported clips: Basic, Dead, Death, Dying.001, Gallop, Idle, Jump, Resting, Sitting.001.
  Basic and Dead are single-frame poses, not full motion cycles.
- Geometry: 2,640 triangles, two skinned meshes, three embedded images. Exact hare anatomy,
  feeding/drinking contact, injury and age-specific meshes remain pending.
- A source-preserving **review-only** lossless WebP texture derivative is documented in
  `docs/2026-09-25-rabbit-lossless-payload-review.md`. It retains this CC0 attribution and
  all decoded texture pixels/rig/clips, but is not mapped live pending browser visual and
  compatibility acceptance. The original `Rabbit.glb` is unchanged.
- Reproduction instructions and input/output hashes: `tools/assets/README.md`.

## Locally authored stylized wildlife

- `Langur.glb`, `Squirrel.glb`, `Vulture.glb`: original procedural geometry, materials,
  skeletons, skin weights and clips created in this repository. Reproduce with
  `tools/assets/build_wildlife.py`; no third-party mesh or generative API used.
- Project-authored work; no claim that these assets are a third-party CC0 download.
- Langur / squirrel clips: Idle, Walk, Run, Eating, Drinking, Resting, Death, Injured.
- Vulture clips: Idle, Walk, Flap, Glide, Eating, Drinking, Resting, Death.
- These are **stylized interim characters**, not exact-species or realistic production art.
  Fur/feather detail, anatomical proportions, continuous deformation, grooming, climbing,
  age/sex variants and grounded feeding/contact require further art work. The squirrel is
  generic chestnut-coloured, not an accurately striped palm squirrel.
- Vulture Flap/Glide now play only during explicitly recorded altitude-route intervals:
  rising/falling segments use Flap, level airborne segments use Glide. The simulation owns
  altitude and travel; the viewer only selects clips. There are no dedicated takeoff/landing
  clips, and no wing pose is inferred across an unrecorded interval. Langur/squirrel still
  have neither authored climb clips nor an authoritative climb trace.
- Resting is an idle/lowered-body variant; Injured is a held-leg visual, not disease simulation.
- A generated Hare prototype is not shipped: the existing CC0 rabbit remains the hare proxy.

## Downloaded motion references (tooling only)

- Source: [Mesh2Motion official repository](https://github.com/Mesh2Motion/mesh2motion-app/tree/3ce7f9d97d25e608b4779ce797da343775ded62b).
- Pinned commit `3ce7f9d97d25e608b4779ce797da343775ded62b`; files
  `static/animations/fox-animations.glb`, `static/animations/bird-animations.glb`, `LICENSE-CC0.MD`.
- Licence: CC0 for these original art files; licence copy included under
  `tools/assets/vendor/mesh2motion`. Other model variations can have different licences.
- Successfully downloaded and inspected: fox 14 clips; bird 5 clips. **Not retargeted into
  the shipped wildlife**; current new animal motions are locally authored instead.

## Remaining art gaps

All twelve roster entries now resolve to local models, but model coverage is not realistic
species or behavioural completeness. Exact-species replacements and contact-aware animation
remain pending, including dhole/Shiba Inu, gaur/bull, hare/rabbit and the stylized local rigs.

No paid asset, generation credit or model API was used in this implementation pass. The existing
local tiger was rigged without generating replacement geometry. A humanoid Quaternius bunny and an
undead squirrel were rejected as unsuitable representations; they are not included in the build.

## Before production
Re-check every source page, record the exact downloaded version, compress (meshopt or Draco, KTX2
textures), and run a licence review over anything added later.
# Scanned ground material — 24 September 2026

- [Forest Ground 04](https://polyhaven.com/a/forest_ground_04), Poly Haven.
- Rob Tuytel (photography/processing), Rico Cilliers (minor adjustment).
- CC0; [Poly Haven licensing FAQ](https://docs.polyhaven.com/en/faq). Downloaded from the
  publisher's `files/forest_ground_04` API / `dl.polyhaven.org` distribution, no payment/login.
- Local unmodified 1K JPEGs under `ground/`, total 3,068,218 bytes. Material tile width 3.2 m;
  albedo uses sRGB, OpenGL normals/roughness use linear data. Renderer adds biome tint.
- Publisher MD5 verified after download:
  - `forest_ground_04_diff_1k.jpg`: `6ad9df4d731a238299806f739a26af83`
  - `forest_ground_04_nor_gl_1k.jpg`: `a010a0802c2d9a930c6f00d3b1f196d2`
  - `forest_ground_04_rough_1k.jpg`: `b5c7ba5c16f00261e9a765d52cf7e0ac`
- Tree distance atlases are generated locally at runtime from the credited natural broadleaf
  derivatives and Quaternius dead tree, not downloaded artwork or species-accuracy evidence.
## Human character assemblies — 25 September 2026

`humans-v1/human-female.glb` and `human-male.glb` derive exclusively from Quaternius
free Standard packs, each licensed **CC0 1.0 Universal**:

- [Universal Base Characters](https://quaternius.com/packs/universalbasecharacters.html): cropped Superhero base heads/eyes/eyebrows and Buns/Buzzed hair.
- [Modular Character Outfits — Fantasy](https://quaternius.com/packs/modularcharacteroutfitsfantasy.html): Female/Male Peasant clothing. Full base bodies are not included beneath clothing.
- [Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html): seven selected non-root-motion clips; rest-relative rotations and vertical pelvis retargeting preserve target limb lengths and disable horizontal root displacement.

The three original license texts and `build.json` with pinned source/archive and output
SHA-256 digests accompany the runtime assets. The downloader uses anonymous, publisher-provided
free download endpoints; no paid pack, login or blocked asset was used. All image data is
embedded in the GLBs, maximum 512px; opaque skin/clothing images use JPEG, hair alpha is retained.
Builder: `tools/assets/build_humans.mjs`. Runtime selects bounded appearance variants from
saved appearance seeds. Generic medieval/game-style clothing is **not an authentic reconstruction
of any real tribal community**, and these models are not claimed to be photorealistic.
Work poses are illustrative and have no authority over simulation success/failure. Sleeping
and deceased people use a held lying pose derived from the terminal clip; they do not replay
a new death each frame. Fine contact/IK, exact work props and browser visual acceptance remain open.
