/**
 * How each species is drawn. Heights are the shoulder heights in config/species; a model is
 * scaled so the animal stands that tall. A species with no suitable model is drawn as a plain
 * stand-in in its own colour and size, and the passport says so — never as another animal's
 * model, which is how every elephant used to appear as a deer.
 */
export interface SpeciesVisual {
  heightM: number;
  /**
   * The species' model, or null when it is drawn as a stand-in. A model without animation clips
   * is drawn static. `yaw` turns a model that was not authored facing +z to face it.
   */
  model: { file: string; tint?: number; yaw?: number } | null;
  /** The stand-in's colour, and the colour on the map. */
  colour: number;
}

export const SPECIES_VISUALS: Record<string, SpeciesVisual> = {
  // Quaternius Ultimate Animated Animals (CC0).
  chital:   { heightM: 0.9,  model: { file: '/assets/animals/Deer.glb' }, colour: 0xb7753f },
  sambar:   { heightM: 1.35, model: { file: '/assets/animals/Stag.glb', tint: 0x8a7a68 }, colour: 0x6b5443 },
  gaur:     { heightM: 1.7,  model: { file: '/assets/animals/Bull.glb', tint: 0x8a6a55 }, colour: 0x2f2520 },
  dhole:    { heightM: 0.5,  model: { file: '/assets/animals/ShibaInu.glb', tint: 0xd0703a }, colour: 0xb4552a },
  jackal:   { heightM: 0.45, model: { file: '/assets/animals/Fox.glb', tint: 0xc9a67a }, colour: 0xa98a5f },
  // Gobkit Free Animal Pack B (CC0).
  boar:     { heightM: 0.85, model: { file: '/assets/animals/Boar.glb', tint: 0x5f5650 }, colour: 0x4b3f37 },
  // Generated with Higgsfield (image to 3D, Tripo H3.1). Static: no rig, no clips.
  tiger:    { heightM: 1.0,  model: { file: '/assets/animals/Tiger.glb', yaw: Math.PI }, colour: 0xd9822b },
  // No suitable model yet. Drawn as stand-ins until one is added.
  elephant: { heightM: 2.7,  model: null, colour: 0x7d7a76 },
  langur:   { heightM: 0.6,  model: null, colour: 0xb9b3a8 },
  squirrel: { heightM: 0.25, model: null, colour: 0x7a4a2a },
  hare:     { heightM: 0.22, model: null, colour: 0x9c8466 },
  vulture:  { heightM: 0.8,  model: null, colour: 0x3a3430 },
};

const UNKNOWN: SpeciesVisual = { heightM: 1, model: null, colour: 0x888888 };

export function visualFor(speciesId: string): SpeciesVisual {
  return SPECIES_VISUALS[speciesId] ?? UNKNOWN;
}
