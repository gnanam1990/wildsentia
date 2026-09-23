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

## File hashes (truncated sha256)
  - `animals/Deer.glb`: sha256 `75d88a0aa2f0569f`
  - `animals/Stag.glb`: sha256 `0910799eb37a9613`
  - `animals/Bull.glb`: sha256 `f44f2cb73afe2b4d`
  - `animals/ShibaInu.glb`: sha256 `c92467b05e0e9491`
  - `animals/Fox.glb`: sha256 `71e28dc471e8d001`
  - `animals/Boar.glb`: sha256 `e6ce64f0e4ac3646`

## Not yet modelled
Tiger, elephant, langur, squirrel, hare and vulture have no suitable rigged model yet and are
drawn as plain stand-ins in their own colour and size. The previous Poly-by-Google tiger (CC-BY,
zero animations, zero skins) was removed: an unrigged model glides instead of walking.

## Before production
Re-check every source page, record the exact downloaded version, compress (meshopt or Draco, KTX2
textures), and run a licence review over anything added later.
