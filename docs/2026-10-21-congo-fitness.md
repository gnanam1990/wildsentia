# Fitness: a well-kept animal outruns and outhunts a neglected one (21 October 2026)

## Why

The owner wants agents to have a reason to look after their animal: one an agent keeps fed,
watered and rested should hunt faster and better than one whose agent neglects it.

Before this change, live play ignored how an animal was kept. An agent's animal ran at the
species' figures, and caught or lost its prey at the species' odds, whether it was full or
starving, rested or spent. The hourly simulation does use fatigue in its own hunts, but live
chases run in the live layer, which did not.

## The rule

**Fitness** (`packages/shared/src/fitness.ts`, `fitnessOf`) is a score from 0 to 1:

    kept    = 0.30 × fed + 0.25 × watered + 0.25 × rested + 0.20 × condition
    fitness = kept × (1 − 0.5 × wound severity)

- **fed** = 1 − hunger, **watered** = 1 − thirst, **rested** = 1 − fatigue.
- **condition** is the body condition where the species keeps one (sim_0.37), and 1 otherwise.
- **wound severity** is that of a contact wound.

At **even fitness** (`EVEN_FITNESS = 0.75`), an animal runs at its species' own figures. This is
an animal about as well kept as a wild one keeps itself: hunger, thirst and fatigue each at about
0.31. Above even it is faster and surer, below even slower and easier to catch
(`fitnessEffects`):

| | weakest (0) | even (0.75) | fittest (1) |
|---|---|---|---|
| speed, every gait | 0.7× | 1× | 1.1× |
| breath: sprint length, and recovery rate | 0.4× | 1× | 1.2× |
| grip: the hunter's odds of holding its prey | 0.4× | 1× | 1.2× |
| dodge: the hunter's odds against it as prey | 1.6× | 1× | 0.8× |

A live catch is still decided by the species' odds:

    baseSuccess × (1.4 − 0.8 × evasiveness) × tired × pack

That is then multiplied by the hunter's grip and the prey's dodge, and held between 0.1 and 0.9.
So a fit hunter after a starving prey has about 1.7 times the odds of an even pair, and a
starving hunter after a fit prey about half.

## Where it applies

**Live chases only** (`packages/server/src/live/liveLayer.ts`). The same rule covers:
- agents' animals;
- wild animals drawn into a live chase (a wild runner).

Hours the simulation plays by itself are not changed. Wild hunts, the predators' calibrated kill
rates, the sim version and recorded history all stay as they were, so a running world needs no
upgrade.

## What agents and viewers see

- **`observe` → `animal.fitness`:** the score, its parts, a label (fit, fair or weak) and its
  effects.
- **`observe` → `nearby[].looks`:** fit, fair or weak for each other animal. Pick on the weak.
- **The agent guide:** explains fitness and what it does.
- **The passport:** shows a Fitness meter, from `GET /animals/:id/passport` → `fitness`.

**The starter hunter:**
- When unfit (below 0.6), it tops up water at lower thirst.
- It rests when it is spent (fatigue above 0.8), or when it is unfit and tired.
- Of prey about as near, it takes the weakest-looking.
- It logs each change in its fitness label.

## Tests

- `packages/shared/test/fitness.test.ts`: the score, its parts, the effects and the labels.
- `packages/server/test/liveFitness.test.ts`:
  - a well-kept tiger covers more ground than a neglected one, in the ratio of their speeds;
  - at the same luck, a fit hunter catches a weak prey and a weak hunter loses a fit one.
- **Earlier tests that check a species' pace, trot or odds:** they now keep their animals at even
  fitness, so they still check the species' own figures.
- **`agentStarterKit.test.ts`:** the hunter rests when spent or unfit, tops up early, and takes
  the weakest-looking prey.
