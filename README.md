# Vana — The Living Wild

One shared, server-authoritative wildlife simulation. You can watch it. You cannot control it.

- **Design spec:** [`docs/2026-09-22-vana-design.md`](docs/2026-09-22-vana-design.md)
- **M1 plan:** [`docs/superpowers/plans/2026-09-22-vana-m1-simulation-core.md`](docs/superpowers/plans/2026-09-22-vana-m1-simulation-core.md)

## Status

**M1 — simulation core: complete.** Headless, deterministic, nutrient-conserving.

| Gate | Result |
|---|---|
| 1,000 world-days, no failures | pass (1.09 s wall clock) |
| Nutrient conservation | drift 7×10⁻¹⁰ against a 10⁻² tolerance |
| Determinism across seeds | identical event streams |
| Events emitted per 1,000-day run | 527,112 |

## Packages

| Package | Responsibility |
|---|---|
| `@vana/shared` | Types, seeded RNG, world clock. Shared by server and client. |
| `@vana/sim` | The authoritative world: patches, fields, agents, events, snapshots. Headless. No network. |
| `@vana/runner` | Headless soak runs and validation gates. |

## Commands

```bash
npm install
npm test                             # full suite including the 1,000-day soak
npm run typecheck
npm run soak -- --seed 1 --days 1000 # M1 gate
```

## Rules this codebase enforces in tests

- **No `Math.random()` in `@vana/sim`** — runs must replay bit-for-bit.
- **No network client in `@vana/sim`** — the simulation never calls a language model.
- **Nutrients are conserved.** Drift beyond tolerance fails the build.
- **Every significant change emits an event with an id.** Narration without an event id is not possible.

## What M1 does not do yet

Predation, carcasses and decomposition (M4); reproduction, genetics and lineage (M5); parental
teaching (M6); thought bubbles and narration (M7); life replay (M8); the server and 3D client
(M2 and M3).

M1 has no reproduction, so the herbivore population declines toward its configured floor and is
held there by off-map immigration. That is expected: M1 proves stability and conservation, not
population dynamics.
