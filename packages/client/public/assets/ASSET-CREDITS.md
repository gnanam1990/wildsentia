# Asset provenance

Last checked: 23 September 2026. No asset enters the build without a row here (spec §13.4).

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

## Gobkit — Free Animal Pack B
- Source: https://gobkit.itch.io/gobkit-free-animal-pack-vol-2 (file from https://gobkit.com/api/free)
- Licence stated by the creator: CC0 1.0 (public domain). No attribution required.
- Used for: boar (Boar)
- Animation clips: idle, walk, attack, dead
- Modifications: none.

## Quaternius — Stylized Nature MegaKit (Standard, free edition)
- Source: https://quaternius.com (the Standard edition, 68 of 116 models)
- Licence stated in the pack's License_Standard.txt: CC0 1.0 Universal (public domain).
- Used for: near-camera trees, grass, bushes, ferns, flowers, clover, rocks and mushrooms
  (`nature/*.glb`, 22 models; placement and scale in `packages/client/src/vegetation.ts`)
- Modifications: textures resized to 512 px and re-encoded as WebP, models packed as binary
  .glb (`@gltf-transform/cli resize` then `webp`). The pack's vertex colours are wind masks for
  its own shader and are ignored at load; geometry is otherwise unchanged.

## Higgsfield — generated models (image to 3D)
- Source: generated for this project on higgsfield.ai (Pro plan) on 23 September 2026. A
  reference photo from GPT Image 2.5 (`gpt_image_2_5`), then Tripo H3.1 image to 3D
  (`tripo_h3_1_image_to_3d`, 20k face limit, PBR textures).
- Licence: output generated on a paid Higgsfield plan, owned by the project under Higgsfield's
  terms of service. Re-check those terms before production.
- Used for: tiger (Tiger)
- Animation clips: none. Unrigged and static: the animal glides rather than walks.
- Modifications: none. Turned 180° at load (`yaw` in `packages/client/src/species.ts`) to face +z.

## File hashes (truncated sha256)
  - `animals/Deer.glb`: sha256 `75d88a0aa2f0569f`
  - `animals/Stag.glb`: sha256 `0910799eb37a9613`
  - `animals/Bull.glb`: sha256 `f44f2cb73afe2b4d`
  - `animals/ShibaInu.glb`: sha256 `c92467b05e0e9491`
  - `animals/Fox.glb`: sha256 `71e28dc471e8d001`
  - `animals/Boar.glb`: sha256 `e6ce64f0e4ac3646`
  - `animals/Tiger.glb`: sha256 `7d7c3d9546d1bbeb`

## Not yet modelled
Elephant, langur, squirrel, hare and vulture have no model yet and are drawn as plain stand-ins
in their own colour and size. The previous Poly-by-Google tiger (CC-BY, zero animations, zero
skins) was removed; the Higgsfield tiger above is also unrigged, accepted as static for now.

## Before production
Re-check every source page, record the exact downloaded version, compress (meshopt or Draco, KTX2
textures), and run a licence review over anything added later.
