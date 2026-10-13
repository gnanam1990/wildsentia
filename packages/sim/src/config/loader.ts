import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LIFE_STAGES, type SpeciesConfig } from '@vana/shared';

const habitatCost = z.object({
  shola: z.number().positive(),
  grassland: z.number().positive(),
  riparian: z.number().positive(),
  rock: z.number().positive(),
  marsh: z.number().positive(),
  water: z.number().positive(),
  // Congo habitats: optional; one left out costs as its island analogue (terrainCostFor).
  terra_firme: z.number().positive().optional(),
  flooded_forest: z.number().positive().optional(),
  swamp_forest: z.number().positive().optional(),
  bai: z.number().positive().optional(),
});

export const SpeciesConfigSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    archetype: z.enum([
      'apex_predator', 'pack_predator', 'herd_grazer',
      'mega_herbivore', 'omnivore_rooter', 'arboreal_troop', 'scavenger_flyer',
    ]),
    trophicRole: z
      .array(z.enum(['apex_predator', 'mesopredator', 'grazer', 'browser', 'omnivore', 'scavenger']))
      .min(1),
    body: z.object({ adultMassKg: z.number().positive(), shoulderHeightM: z.number().positive(),
      massBySexKg: z.object({ female: z.number().positive().finite(), male: z.number().positive().finite() }).optional() }),
    locomotion: z.object({
      walkMs: z.number().positive(),
      trotMs: z.number().positive(),
      sprintMs: z.number().positive(),
      sprintStaminaS: z.number().positive(),
      terrainCost: habitatCost,
      climbsTrees: z.boolean().optional(),
      // Congo 1B: swimmers and divers, and what crossing ground costs while it is flooded.
      swims: z.object({ swimMs: z.number().positive().finite(), diveSeconds: z.number().positive().max(3_600) }).optional(),
      floodedTerrainCost: z.object({
        water: z.number().positive().optional(), flooded_forest: z.number().positive().optional(),
      }).strict().optional(),
    }),
    senses: z.object({
      sightRangeM: z.number().nonnegative(),
      hearingRangeM: z.number().nonnegative(),
      smellRangeM: z.number().nonnegative(),
    }),
    escape: z.object({
      detectionDistanceM: z.number().nonnegative(),
      flightInitiationM: z.number().nonnegative(),
      evasiveness: z.number().min(0).max(1),
      avoids: z.array(z.string().min(1)).optional(),
      freezeFirst: z.boolean().optional(),
    }),
    diet: z.object({
      eats: z
        .array(z.object({
          target: z.enum(['grass', 'browse', 'meat', 'roots']),
          preference: z.number().min(0).max(1),
          foodValue: z.number().gt(0).max(1).optional(),
        }))
        .min(1),
      dailyIntakeKg: z.number().positive(),
      gutCapacityBodyFraction: z.number().gt(0).max(0.3).optional(),
      maxDailyIntakeKg: z.number().positive().finite().optional(),
      waterNeedLPerDay: z.number().positive(),
      canScavenge: z.boolean(),
      carrionTolerance: z.number().min(0).max(1),
    }),
    hunting: z
      .object({
        preferredPrey: z.array(z.string()).min(1),
        stalkConcealment: z.number().min(0).max(1),
        commitDistanceM: z.number().positive(),
        baseSuccess: z.number().min(0).max(1),
        staminaCostPerChase: z.number().min(0).max(1),
        huntFromHunger: z.number().min(0).max(0.9).optional(),
        preyPreference: z.record(z.string(), z.number().positive().finite()).optional(),
        packHuntRadiusM: z.number().positive().finite().optional(),
        packPreyKg: z.tuple([z.number().min(0).finite(), z.number().positive().finite()])
          .refine(([lo, hi]) => lo <= hi, 'pack prey range must be ordered').optional(),
        subdueSeconds: z.array(z.tuple([z.number().min(0).finite(), z.number().positive().max(1800)])).min(1)
          .refine(t => t.every((p, i) => i === 0 || p[0] >= t[i - 1]![0]), 'subdue table must be ordered by prey mass').optional(),
        subdueReferenceHunters: z.number().positive().finite().optional(),
        subdueBreakFree: z.number().min(0).max(1).optional(),
        maxPreyKg: z.number().positive().finite().optional(),
        cachesKills: z.boolean().optional(),
        preferredPreyKg: z.tuple([z.number().min(0).finite(), z.number().positive().finite()])
          .refine(([lo, hi]) => lo <= hi, 'preferred prey range must be ordered').optional(),
        preyLifeStages: z.array(z.enum(LIFE_STAGES)).min(1).optional(),
      })
      .optional(),
    social: z.object({
      structure: z.enum(['solitary', 'pair', 'herd', 'troop', 'pack', 'family']),
      groupSize: z.tuple([z.number().int().positive(), z.number().int().positive()]),
      alarmSharing: z.boolean(),
      heedsAlarmOf: z.array(z.string().min(1)).optional(),
      cooperativeCare: z.object({ donorFromDays: z.number().finite().nonnegative(), recipientFromDays: z.number().finite().nonnegative(),
        capacityBodyFraction: z.number().positive().max(0.2), collectionBodyFractionPerHour: z.number().positive().max(0.2),
        deliveryBodyFractionPerHour: z.number().positive().max(0.2), retentionHours: z.number().positive().max(24),
        moistureLPerKg: z.number().min(0).max(1) }).optional(),
      territory: z.object({
        femaleKm2: z.number().positive(),
        maleKm2: z.number().positive(),
        floaterMortalityPerDay: z.number().min(0).max(1),
      }).optional(),
    }),
    islandArrival: z.object({
      whenLivingAtMost: z.number().int().nonnegative(),
      dailyProbability: z.number().gt(0).max(1),
      minDaysBetween: z.number().finite().nonnegative(),
      preferMissingSex: z.boolean().optional(),
    }).optional(),
    activity: z.object({
      hourly: z.array(z.number().min(0).max(1)).length(24)
        .refine(h => h.some(v => v === 1), 'activity peaks at 1'),
    }).optional(),
    learning: z.object({
      innate: z.record(
        z.enum(['forage_efficiency', 'water_locations', 'predator_avoidance', 'stalk_technique']),
        z.number().min(0).max(1),
      ),
      learnRateFromParent: z.number().gt(0).max(1),
    }).optional(),
    lifecycle: z.object({
      maxAgeDays: z.number().positive(),
      baselineMortalityPerDay: z.number().min(0).max(1),
      stages: z
        .array(z.object({
          name: z.enum(['newborn', 'juvenile', 'subadult', 'adult', 'elder']),
          startDays: z.number().min(0),
          sizeFactor: z.number().positive().max(1),
          dependent: z.boolean(),
          mortalityPerDay: z.number().min(0).max(1),
        }))
        .min(2),
      sexualMaturityDays: z.number().positive(),
      gestationDays: z.number().positive(),
      litterSize: z.tuple([z.number().int().positive(), z.number().int().positive()]),
      interBirthIntervalDays: z.number().positive(),
      oestrusCycleDays: z.number().positive(),
      weanDays: z.number().positive(),
      followFromDays: z.number().nonnegative().optional(),
      gatherFromDays: z.number().finite().nonnegative().optional(),
      carriedUntilDays: z.number().positive().finite().optional(),
      forageFromDays: z.number().nonnegative().optional(),
      drinkFromDays: z.number().finite().nonnegative().optional(),
      meatFromDays: z.number().finite().nonnegative().optional(),
      nursing: z.object({ startHour: z.number().min(0).lt(24), windowHours: z.number().positive().max(24),
        dailyContactSeconds: z.number().positive().max(3600), locomotionFromDays: z.number().nonnegative() })
        .refine(n => n.startHour + n.windowHours <= 24, 'nursing window must fit inside one world day').optional(),
      denStayDays: z.number().positive().finite().optional(),
      condition: z.object({ conditionDays: z.number().positive().finite(), minBreedingCondition: z.number().min(0).max(1),
        fullBreedingCondition: z.number().min(0).max(1) })
        .refine(c => c.minBreedingCondition < c.fullBreedingCondition, 'breeding condition range must be ordered').optional(),
      dispersalDays: z.number().positive(),
    }),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.social.cooperativeCare && (cfg.social.structure !== 'pack' || !cfg.diet.canScavenge
      || !cfg.diet.eats.some(e => e.target === 'meat') || cfg.social.cooperativeCare.donorFromDays < cfg.lifecycle.weanDays
      || cfg.social.cooperativeCare.recipientFromDays >= cfg.lifecycle.weanDays)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['social', 'cooperativeCare'],
        message: 'cooperative food care requires a meat-eating scavenging pack, weaned donors and a pre-weaning recipient age' });
    }
    if (cfg.lifecycle.condition && (cfg.diet.maxDailyIntakeKg === undefined || !cfg.diet.eats.some(e => e.target === 'roots'))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lifecycle', 'condition'],
        message: 'condition-dependent breeding tracks a roots diet under a daily gut limit' });
    }
    if (cfg.lifecycle.denStayDays !== undefined && !cfg.social.cooperativeCare) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lifecycle', 'denStayDays'],
        message: 'a mother stays at the den only where the pack feeds her' });
    }
    if (cfg.body.massBySexKg && Math.abs((cfg.body.massBySexKg.female + cfg.body.massBySexKg.male) / 2 - cfg.body.adultMassKg)
      > cfg.body.adultMassKg * 0.05) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body', 'massBySexKg'],
        message: 'the mean adult mass must be the mean of the two sexes' });
    }
    if (cfg.hunting?.packHuntRadiusM !== undefined && cfg.social.structure !== 'pack') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hunting', 'packHuntRadiusM'], message: 'only a pack hunts as a pack' });
    }
    for (const prey of Object.keys(cfg.hunting?.preyPreference ?? {})) if (!cfg.hunting!.preferredPrey.includes(prey)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hunting', 'preyPreference', prey], message: 'a prey preference needs a preferred prey' });
    }
    if (cfg.lifecycle.forageFromDays !== undefined && (cfg.lifecycle.forageFromDays > cfg.lifecycle.weanDays
      || cfg.lifecycle.forageFromDays < cfg.lifecycle.weanDays
      && !cfg.diet.eats.some(e => e.target === 'grass' || e.target === 'browse' || e.target === 'roots'))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lifecycle', 'forageFromDays'],
        message: 'early foraging requires a plant food target and must start by weaning' });
    }
    if (cfg.lifecycle.gatherFromDays !== undefined && (cfg.lifecycle.gatherFromDays > cfg.lifecycle.weanDays
      || cfg.lifecycle.gatherFromDays > (cfg.lifecycle.followFromDays ?? cfg.lifecycle.weanDays))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lifecycle', 'gatherFromDays'],
        message: 'a litter gathers to its parent no later than it follows her or is weaned' });
    }
    if (cfg.lifecycle.drinkFromDays !== undefined && cfg.lifecycle.drinkFromDays > cfg.lifecycle.weanDays) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lifecycle', 'drinkFromDays'],
        message: 'independent drinking must start by weaning' });
    }
    if (cfg.lifecycle.meatFromDays !== undefined && (cfg.lifecycle.meatFromDays > cfg.lifecycle.weanDays
      || !cfg.diet.eats.some(e => e.target === 'meat') || !cfg.diet.canScavenge)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lifecycle', 'meatFromDays'],
        message: 'early meat access requires a scavenging meat eater and must start by weaning' });
    }
    if (cfg.lifecycle.interBirthIntervalDays <= cfg.lifecycle.gestationDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interBirthIntervalDays runs birth to birth, so it must exceed gestationDays',
      });
    }
    if (cfg.locomotion.sprintMs <= cfg.locomotion.walkMs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'sprintMs must exceed walkMs' });
    }
    const eatsMeat = cfg.diet.eats.some((e) => e.target === 'meat');
    const isPredator = cfg.archetype === 'apex_predator' || cfg.archetype === 'pack_predator';
    if (isPredator && cfg.hunting === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a predator archetype requires a hunting block' });
    }
    if (eatsMeat && !isPredator && !cfg.diet.canScavenge) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a species that eats meat must either hunt or scavenge',
      });
    }
    const stages = cfg.lifecycle.stages;
    if (stages[0]?.startDays !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the first life stage must start at day 0' });
    }
    for (let i = 1; i < stages.length; i++) {
      if (stages[i]!.startDays <= stages[i - 1]!.startDays) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'life stages must start in increasing order' });
        break;
      }
    }
    if (cfg.lifecycle.litterSize[0] > cfg.lifecycle.litterSize[1]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'litterSize min must not exceed max' });
    }
    if (cfg.lifecycle.weanDays > cfg.lifecycle.dispersalDays) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'an animal cannot disperse before it is weaned' });
    }
    if (cfg.social.groupSize[0] > cfg.social.groupSize[1]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'groupSize min must not exceed max' });
    }
  });

export function parseSpecies(raw: unknown): SpeciesConfig {
  return SpeciesConfigSchema.parse(raw) as SpeciesConfig;
}

export function loadSpeciesDir(dir: string): Map<string, SpeciesConfig> {
  const out = new Map<string, SpeciesConfig>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const cfg = parseSpecies(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    if (out.has(cfg.id)) throw new Error(`duplicate species id: ${cfg.id}`);
    out.set(cfg.id, cfg);
  }
  return out;
}
