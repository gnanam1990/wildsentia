# Asset provenance

Last checked: 22 September 2026.

## Quaternius — Ultimate Animated Animal Pack
- Source: https://quaternius.com/packs/ultimateanimatedanimals.html
- Creator: Quaternius
- Licence stated by the creator: CC0 1.0 Universal (public domain). Attribution optional.
- Files used: `animals/Deer.gltf`, `animals/Stag.gltf`
- Animation clips present: Attack_Headbutt, Attack_Kick, Death, Eating, Gallop, Gallop_Jump,
  Idle, Idle_2, Idle_Headlow, Idle_HitReact1, Idle_HitReact2, Jump_toIdle, Walk
- Modifications: none. Buffers are base64-embedded as shipped.

## Poly by Google — Tiger
- Source: https://poly.pizza/m/5A3w06FXUup — distributed by Poly Pizza
- Licence shown on the source page: Creative Commons Attribution 3.0
- File used: `animals/Tiger.glb`
- **Known limitation: this model has zero animations and zero skins.** It cannot walk. It is
  present only so the species mapping is exercised; a rigged replacement is required before any
  tiger is rendered in a release build.

## Before production
Re-check every source page, record the exact downloaded version, convert to `.glb` with Draco or
meshopt compression and KTX2 textures, and run a licence review over anything added later.
