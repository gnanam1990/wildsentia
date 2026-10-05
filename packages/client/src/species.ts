/**
 * How each species is drawn. Heights are the shoulder heights in config/species; a model is
 * scaled so the animal stands that tall. A species with no suitable model is drawn as a plain
 * stand-in in its own colour and size, and the passport says so — never as another animal's
 * model, which is how every elephant used to appear as a deer.
 */
import type { AnimalState } from './protocol.js';

export interface SpeciesVisual {
  heightM: number;
  /**
   * The species' model, or null when it is drawn as a stand-in. A model without animation clips
   * is drawn static. `yaw` turns a model that was not authored facing +z to face it.
   */
  model: { file: string; tint?: number; yaw?: number; referenceHeightM?: number } | null;
  /** The stand-in's colour, and the colour on the map. */
  colour: number;
}

export const SPECIES_VISUALS: Record<string, SpeciesVisual> = {
  // Quaternius Ultimate Animated Animals (CC0).
  chital:   { heightM: 0.9,  model: { file: '/assets/animals/Chital.glb' }, colour: 0xb7753f },
  sambar:   { heightM: 1.35, model: { file: '/assets/animals/Sambar.glb' }, colour: 0x6b5443 },
  gaur:     { heightM: 1.7,  model: { file: '/assets/animals/Gaur.glb' }, colour: 0x2f2520 },
  dhole:    { heightM: 0.5,  model: { file: '/assets/animals/Dhole.glb' }, colour: 0xb4552a },
  jackal:   { heightM: 0.45, model: { file: '/assets/animals/Jackal.glb' }, colour: 0xa98a5f },
  // Gobkit Free Animal Pack B (CC0).
  boar:     { heightM: 0.85, model: { file: '/assets/animals/WildBoar.glb' }, colour: 0x4b3f37 },
  // Existing project-owned geometry, rigged locally. Not the blocked Sketchfab download.
  tiger:    { heightM: 1.0,  model: { file: '/assets/animals/TigerRigged.glb' }, colour: 0xd9822b },
  // OpenGameArt CC0 rigs. See credits: generic elephant; rabbit is a hare approximation.
  elephant: { heightM: 2.7,  model: { file: '/assets/animals/ElephantWalking.glb' }, colour: 0x7d7a76 },
  // The arched tail rises above the head; scale by the body (front half) height.
  langur:   { heightM: 0.6,  model: { file: '/assets/animals/GreyLangur.glb', referenceHeightM: 0.699 }, colour: 0xb9b3a8 },
  squirrel: { heightM: 0.25, model: { file: '/assets/animals/GiantSquirrel.glb', referenceHeightM: 0.794 }, colour: 0x7a4a2a },
  hare:     { heightM: 0.22, model: { file: '/assets/animals/Hare.glb' }, colour: 0x9c8466 },
  vulture:  { heightM: 0.8,  model: { file: '/assets/animals/WhiteRumpedVulture.glb' }, colour: 0x3a3430 },
};

const UNKNOWN: SpeciesVisual = { heightM: 1, model: null, colour: 0x888888 };

export function visualFor(speciesId: string): SpeciesVisual {
  return SPECIES_VISUALS[speciesId] ?? UNKNOWN;
}

/** Local interim Asian-elephant age/sex variants. Body-mass scale still comes
 * from the saved animal; these only choose its visual geometry. */
export function visualForAnimal(animal: Pick<AnimalState, 'speciesId' | 'sex' | 'lifeStage'>, airborne = false): SpeciesVisual {
  // The realistic vulture is modelled with folded wings, so it cannot open them; in the air the
  // older rig, built with spreadable wings and Flap/Glide clips, stands in.
  if (animal.speciesId === 'vulture' && airborne) return { ...SPECIES_VISUALS.vulture!, model: { file: '/assets/animals/Vulture.glb' } };
  // Chital hinds carry no antlers; the generated stag model stays for males and the young.
  if (animal.speciesId === 'chital' && animal.sex === 'female' && animal.lifeStage !== 'newborn' && animal.lifeStage !== 'juvenile')
    return { ...SPECIES_VISUALS.chital!, model: { file: '/assets/animals/ChitalHind.glb' } };
  if (animal.speciesId === 'elephant') {
    if (animal.lifeStage === 'newborn' || animal.lifeStage === 'juvenile')
      return { ...SPECIES_VISUALS.elephant!, model: { file: '/assets/animals/AsianElephantCalf.glb', yaw: Math.PI } };
    if (animal.lifeStage === 'subadult')
      return { ...SPECIES_VISUALS.elephant!, model: { file: '/assets/animals/AsianElephantAdultFemale.glb', yaw: Math.PI } };
    if (animal.lifeStage === 'adult' || animal.lifeStage === 'elder') {
      if (animal.sex === 'male') return { ...SPECIES_VISUALS.elephant!, model: { file: '/assets/animals/AsianElephantAdultMale.glb', yaw: Math.PI } };
      if (animal.sex === 'female') return { ...SPECIES_VISUALS.elephant!, model: { file: '/assets/animals/AsianElephantAdultFemale.glb', yaw: Math.PI } };
    }
  }
  return visualFor(animal.speciesId);
}

export function modelStatusForAnimal(animal: Pick<AnimalState, 'speciesId' | 'sex' | 'lifeStage'>): string {
  if (visualForAnimal(animal).model?.file === '/assets/animals/AsianElephantCalf.glb')
    return 'Detailed calf-proportion proxy · age-specific gait, true drinking and anatomical validation pending';
  if (animal.speciesId === 'elephant' && animal.lifeStage === 'subadult')
    return 'Tuskless subadult approximation · sex-specific proportions and gait pending';
  if (visualForAnimal(animal).model?.file === '/assets/animals/AsianElephantAdultMale.glb')
    return 'Detailed Asian-elephant adult-male rig · trunk reach illustrative; drinking and gait polish pending';
  if (visualForAnimal(animal).model?.file === '/assets/animals/AsianElephantAdultFemale.glb')
    return 'Tuskless adult-female approximation · trunk reach illustrative; female proportions and drinking pending';
  return modelStatus(animal.speciesId);
}

/** Visible delivery status, separate from whether the species exists in the simulation. */
export function modelStatus(speciesId: string): string {
  if (visualFor(speciesId).model === null) return 'Placeholder · species rig pending';
  if (speciesId === 'tiger') return 'Local tiger rig · authored motion; deformation polish pending';
  if (speciesId === 'elephant') return 'Generic elephant rig · local walk added; gait polish pending';
  if (speciesId === 'hare') return 'Animated rabbit approximation · exact hare art pending';
  if (speciesId === 'boar') return 'Animated boar · detailed behaviour clips pending';
  if (['langur', 'squirrel', 'vulture'].includes(speciesId)) return 'Local stylized rig · species-inspired; anatomical polish pending';
  return 'Animated approximation · exact-species art pending';
}
