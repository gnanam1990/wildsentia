import {
  recapFor,
  type ForestMoment,
  type WorldEvent,
  type SafariAnswer,
} from "@vana/shared";
import type { CheckpointObservation } from "../simHost.js";
export const MOMENT_TYPES = [
  "hunt",
  "born",
  "died",
  "immigration",
  "tree_climbed",
  "storm",
  "flood",
  "house_collapsed",
];
export function forestMoment(e: WorldEvent): ForestMoment {
  const actorId =
    e.type === "hunt" && e.outcome !== "success"
      ? (e.actors[1] ?? e.actors[0] ?? null)
      : (e.actors[0] ?? null);
  const line = actorId ? recapFor([e], actorId)[0]?.text : null;
  const title =
    e.type === "hunt"
      ? e.outcome === "success"
        ? "A hunt reached its conclusion"
        : "A recorded hunt attempt"
      : e.type === "born"
        ? "A new life begins"
        : e.type === "died"
          ? "A life remembered"
          : e.type === "immigration"
            ? "An arrival on the island"
            : e.type === "tree_climbed"
              ? "A journey into the trees"
              : e.type.replaceAll("_", " ");
  return {
    id: e.id,
    type: e.type,
    actorId,
    worldTime: e.worldTime,
    title,
    detail: line ?? `${e.type.replaceAll("_", " ")} · ${e.outcome}`,
    replay:
      e.type === "hunt" &&
      (e.encounter || ("hasEncounter" in e && e.hasEncounter))
        ? "hunt"
        : e.type === "tree_climbed" &&
            (e.movement || ("hasClimb" in e && e.hasClimb))
          ? "climb"
          : null,
    position: e.position ? { x: e.position.x, z: e.position.z } : null,
  };
}
const aliases: Record<string, string[]> = {
  tiger: ["tiger", "புலி"],
  leopard: ["leopard", "சிறுத்தை"],
  elephant: ["elephant", "யானை"],
  chital: ["deer", "chital", "மான்"],
  dhole: ["dhole", "wild dog", "செந்நாய்"],
  boar: ["boar", "பன்றி"],
  hare: ["hare", "rabbit", "முயல்"],
};
export function safariAnswer(
  question: string,
  selectedId: string | null,
  view: CheckpointObservation,
  moments: ForestMoment[],
): SafariAnswer {
  const q = question.toLowerCase();
  const species = Object.entries(aliases).find(([, words]) =>
    words.some((w) => q.includes(w)),
  )?.[0];
  const animal = species
    ? view.livingAnimals().find((a) => a.speciesId === species)
    : selectedId
      ? view.animal(selectedId)
      : undefined;
  const base = { source: "checkpoint" as const, worldTime: view.worldTime };
  if (animal) {
    const recent = moments.filter((m) => m.actorId === animal.id).slice(0, 2);
    const family = `${animal.offspringIds.length} recorded offspring`;
    const state = animal.alive
      ? `is ${animal.state.replaceAll("_", " ")}; its current goal is ${animal.currentGoal.replaceAll("_", " ")}`
      : "is no longer alive in this saved record";
    return {
      ...base,
      animalId: animal.id,
      eventIds: recent.map((m) => m.id),
      answer: `${animal.id} (${animal.speciesId}) ${state}. Hunger ${Math.round(animal.drives.hunger * 100)}%, thirst ${Math.round(animal.drives.thirst * 100)}%, fatigue ${Math.round(animal.drives.fatigue * 100)}%. It has ${family}.${recent.length ? " Recent record: " + recent.map((m) => m.detail).join(" ") : ""}`,
    };
  }
  if (species)
    return {
      ...base,
      animalId: null,
      eventIds: [],
      answer: `No living ${species} is present in this saved checkpoint. I can show another animal or recent forest moments.`,
    };
  const latest = moments[0];
  if (latest)
    return {
      ...base,
      animalId: latest.actorId,
      eventIds: [latest.id],
      answer: `${latest.title}. ${latest.detail} You can open this saved moment or ask about a tiger, elephant, deer or another followed life.`,
    };
  return {
    ...base,
    animalId: null,
    eventIds: [],
    answer:
      "Choose an animal to learn about its current goal, needs, family and retained history. No major moments are retained at this checkpoint yet.",
  };
}
