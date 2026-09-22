import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { SpeciesConfig } from '@vana/shared';

const habitatCost = z.object({
  shola: z.number().positive(),
  grassland: z.number().positive(),
  riparian: z.number().positive(),
  rock: z.number().positive(),
  marsh: z.number().positive(),
  water: z.number().positive(),
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
    body: z.object({ adultMassKg: z.number().positive(), shoulderHeightM: z.number().positive() }),
    locomotion: z.object({
      walkMs: z.number().positive(),
      trotMs: z.number().positive(),
      sprintMs: z.number().positive(),
      sprintStaminaS: z.number().positive(),
      terrainCost: habitatCost,
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
    }),
    diet: z.object({
      eats: z
        .array(z.object({
          target: z.enum(['grass', 'browse', 'meat']),
          preference: z.number().min(0).max(1),
        }))
        .min(1),
      dailyIntakeKg: z.number().positive(),
      waterNeedLPerDay: z.number().positive(),
    }),
    lifecycle: z.object({
      maxAgeDays: z.number().positive(),
      baselineMortalityPerDay: z.number().min(0).max(1),
    }),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.locomotion.sprintMs <= cfg.locomotion.walkMs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'sprintMs must exceed walkMs' });
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
