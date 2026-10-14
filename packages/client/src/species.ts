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
  // The generated tiger (animals/Tiger.glb, not the blocked Sketchfab download) on the big-cat rig (tools/art/rig_big_cat.py), as the leopards are.
  tiger:    { heightM: 1.0,  model: { file: '/assets/animals/TigerCat.glb' }, colour: 0xd9822b },
  // One species with the Congo's leopard: the same generated model and big-cat rig (tools/art/rig_big_cat.py).
  leopard:  { heightM: 0.7,  model: { file: '/assets/animals/AfricanLeopard.glb' }, colour: 0xc9963e },
  // OpenGameArt CC0 rigs. See credits: generic elephant; rabbit is a hare approximation.
  elephant: { heightM: 2.7,  model: { file: '/assets/animals/ElephantWalking.glb' }, colour: 0x7d7a76 },
  // The arched tail rises above the head; scale by the body (front half) height.
  langur:   { heightM: 0.6,  model: { file: '/assets/animals/GreyLangur.glb', referenceHeightM: 0.699 }, colour: 0xb9b3a8 },
  squirrel: { heightM: 0.25, model: { file: '/assets/animals/GiantSquirrel.glb', referenceHeightM: 0.794 }, colour: 0x7a4a2a },
  hare:     { heightM: 0.22, model: { file: '/assets/animals/Hare.glb' }, colour: 0x9c8466 },
  vulture:  { heightM: 0.8,  model: { file: '/assets/animals/WhiteRumpedVulture.glb' }, colour: 0x3a3430 },
  // Congo forest (1B). Duiker and chevrotain: generated surfaces on the Deer rig
  // (tools/art/build_species.sh). Leopard: a generated surface on its own big-cat rig
  // (tools/art/rig_big_cat.py). Reviews in docs/art-review/congo-2026-10-14.
  african_leopard:  { heightM: 0.65, model: { file: '/assets/animals/AfricanLeopard.glb' }, colour: 0xc9963e },
  blue_duiker:      { heightM: 0.36, model: { file: '/assets/animals/BlueDuiker.glb' }, colour: 0x5b5560 },
  water_chevrotain: { heightM: 0.35, model: { file: '/assets/animals/WaterChevrotain.glb' }, colour: 0x6b4a32 },
  // Congo 2A: generated surfaces; the antelopes on the Deer rig, the hog and buffalo on the Bull
  // rig (tools/art/build_species.sh), the golden cat on the big-cat rig (tools/art/rig_big_cat.py).
  bay_duiker:         { heightM: 0.5,  model: { file: '/assets/animals/BayDuiker.glb' }, colour: 0x8a3b1e },
  peters_duiker:      { heightM: 0.52, model: { file: '/assets/animals/PetersDuiker.glb' }, colour: 0xa24a22 },
  red_river_hog:      { heightM: 0.7,  model: { file: '/assets/animals/RedRiverHog.glb' }, colour: 0xb4521f },
  forest_buffalo:     { heightM: 1.2,  model: { file: '/assets/animals/ForestBuffalo.glb' }, colour: 0x6b3a22 },
  sitatunga:          { heightM: 1.0,  model: { file: '/assets/animals/Sitatunga.glb' }, colour: 0x4a443c },
  african_golden_cat: { heightM: 0.42, model: { file: '/assets/animals/AfricanGoldenCat.glb' }, colour: 0xb7783a },
  // Phase B (docs/2026-10-14-congo-phase-b-research.md). Heights are the models' whole height:
  // the elephant's back, the mangabey's raised tail, the standing eagle, the crocodile's high walk.
  forest_elephant:    { heightM: 2.3,  model: { file: '/assets/animals/ForestElephant.glb' }, colour: 0x5d5a56 },
  agile_mangabey:     { heightM: 0.48, model: { file: '/assets/animals/AgileMangabey.glb' }, colour: 0x8a7d62 },
  crowned_eagle:      { heightM: 0.62, model: { file: '/assets/animals/CrownedEagle.glb' }, colour: 0x3a3632 },
  dwarf_crocodile:    { heightM: 0.4,  model: { file: '/assets/animals/DwarfCrocodile.glb' }, colour: 0x2e2a22 },
};

const UNKNOWN: SpeciesVisual = { heightM: 1, model: null, colour: 0x888888 };

export function visualFor(speciesId: string): SpeciesVisual {
  return SPECIES_VISUALS[speciesId] ?? UNKNOWN;
}

/**
 * The Asian elephant exports face backwards and are also turned on their root bone: the adults'
 * body axis lies 32.2 degrees, the calf's 30.5, off the file's forward axis (measured from the
 * skinned mesh's long axis; the root bone carries the same -147.8 degree turn). A half turn alone
 * left them walking crabwise, a third of a right angle off their path.
 */
export const ASIAN_ELEPHANT_YAW = Math.PI - 32.2 * Math.PI / 180;
export const ASIAN_ELEPHANT_CALF_YAW = Math.PI - 30.5 * Math.PI / 180;

/** Local interim Asian-elephant age/sex variants. Body-mass scale still comes
 * from the saved animal; these only choose its visual geometry. */
export function visualForAnimal(animal: Pick<AnimalState, 'speciesId' | 'sex' | 'lifeStage'>, airborne = false): SpeciesVisual {
  // The realistic vulture is modelled with folded wings, so it cannot open them; in the air the
  // older rig, built with spreadable wings and Flap/Glide clips, stands in.
  if (animal.speciesId === 'vulture' && airborne) return { ...SPECIES_VISUALS.vulture!, model: { file: '/assets/animals/Vulture.glb' } };
  // The crowned eagle has a second model, generated with its wings spread, for the air.
  if (animal.speciesId === 'crowned_eagle' && airborne) return { ...SPECIES_VISUALS.crowned_eagle!, heightM: 0.35, model: { file: '/assets/animals/CrownedEagleFlying.glb' } };
  // Chital hinds carry no antlers; the generated stag model stays for males and the young.
  if (animal.speciesId === 'chital' && animal.sex === 'female' && animal.lifeStage !== 'newborn' && animal.lifeStage !== 'juvenile')
    return { ...SPECIES_VISUALS.chital!, model: { file: '/assets/animals/ChitalHind.glb' } };
  if (animal.speciesId === 'elephant') {
    if (animal.lifeStage === 'newborn' || animal.lifeStage === 'juvenile')
      return { ...SPECIES_VISUALS.elephant!, model: { file: '/assets/animals/AsianElephantCalf.glb', yaw: ASIAN_ELEPHANT_CALF_YAW } };
    if (animal.lifeStage === 'subadult')
      return { ...SPECIES_VISUALS.elephant!, model: { file: '/assets/animals/AsianElephantAdultFemale.glb', yaw: ASIAN_ELEPHANT_YAW } };
    if (animal.lifeStage === 'adult' || animal.lifeStage === 'elder') {
      if (animal.sex === 'male') return { ...SPECIES_VISUALS.elephant!, model: { file: '/assets/animals/AsianElephantAdultMale.glb', yaw: ASIAN_ELEPHANT_YAW } };
      if (animal.sex === 'female') return { ...SPECIES_VISUALS.elephant!, model: { file: '/assets/animals/AsianElephantAdultFemale.glb', yaw: ASIAN_ELEPHANT_YAW } };
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
  if (speciesId === 'african_leopard') return 'Generated African leopard on its own big-cat rig · planted-paw gaits, keyframed, not motion capture';
  if (speciesId === 'blue_duiker') return 'Generated blue duiker on the deer rig · the deer\'s clips; duiker-specific gait pending';
  if (['bay_duiker', 'peters_duiker', 'sitatunga'].includes(speciesId)) return 'Generated from reference views, on the deer rig · the deer\'s clips';
  if (['red_river_hog', 'forest_buffalo'].includes(speciesId)) return 'Generated from reference views, on the bull rig · the bull\'s clips';
  if (speciesId === 'african_golden_cat') return 'Generated golden cat on the big-cat rig · planted-paw gaits, keyframed, not motion capture';
  if (speciesId === 'forest_elephant') return 'Generated forest elephant on the generic elephant rig · its walk and feeding clips; gait polish pending';
  if (speciesId === 'agile_mangabey') return 'Generated agile mangabey on the langur rig · the langur\'s clips';
  if (speciesId === 'crowned_eagle') return 'Generated crowned eagle on the vulture rig · a wings-spread model in the air; its side profile in flight pending';
  if (speciesId === 'dwarf_crocodile') return 'Generated dwarf crocodile on a skeleton of its own · high walk, swim, jaws and death keyframed, not motion capture';
  if (speciesId === 'water_chevrotain') return 'Generated water chevrotain on the deer rig · the deer\'s clips; it swims with its back at the waterline';
  if (speciesId === 'tiger') return 'Generated tiger on its own big-cat rig · planted-paw gaits, keyframed, not motion capture';
  if (speciesId === 'leopard') return 'Generated leopard on its own big-cat rig · planted-paw gaits, keyframed, not motion capture';
  if (speciesId === 'elephant') return 'Generic elephant rig · local walk added; gait polish pending';
  if (speciesId === 'hare') return 'Animated rabbit approximation · exact hare art pending';
  if (speciesId === 'boar') return 'Animated boar · detailed behaviour clips pending';
  if (['langur', 'squirrel', 'vulture'].includes(speciesId)) return 'Local stylized rig · species-inspired; anatomical polish pending';
  return 'Animated approximation · exact-species art pending';
}
