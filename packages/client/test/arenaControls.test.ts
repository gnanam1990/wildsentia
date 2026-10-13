import { describe, expect, it } from "vitest";
import { nearestHuntable } from "../src/arenaControls.js";
import type { ArenaFrame } from "@vana/shared";
describe("human arena hunt controls", () => {
  const frame = {
    animal: { id: "player", speciesId: "leopard", x: 0, z: 0, state: "idle" },
    nearby: [
      { id: "ineligible", speciesId: "boar", x: 1, z: 0, state: "idle" },
      { id: "far", speciesId: "chital", x: 20, z: 0, state: "idle" },
      { id: "near", speciesId: "hare", x: 3, z: 0, state: "idle" },
    ],
    huntablePrey: ["far", "near"],
  } as ArenaFrame;
  it("chooses the nearest server-admitted target for both keyboard and touch", () => {
    expect(nearestHuntable(frame)).toBe("near");
  });
  it("never targets an ineligible species or invents missing prey", () => {
    expect(nearestHuntable({ ...frame, huntablePrey: [] })).toBeNull();
    expect(nearestHuntable({ ...frame, huntablePrey: ["missing"] })).toBeNull();
    expect(nearestHuntable({ ...frame, animal: null })).toBeNull();
  });
});
