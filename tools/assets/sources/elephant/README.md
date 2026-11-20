# Asian elephant source — review only

`asian-elephant-original.glb` is the exact previously downloaded **Asian Elephant** by
[planeta-elefante](https://sketchfab.com/planeta-elefante), from
[the source listing](https://sketchfab.com/3d-models/asian-elephant-2a7007e8bd2f45b89d1cc6ff75c5fed4).
The publisher's embedded attribution states [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Retain creator, source, licence link and modification notices with any redistribution.
This records the publisher's declared licence, not an independent authorship/legal clearance.

Recovered from the existing local external-drive download on 24 September 2026; no alternate
browser/download route was used after the earlier computer-use restriction. This durable copy
is unmodified: 4,161,952 bytes, SHA-256
`d6ababec061268be32de266aa22e00647e41cf4a1f4130eada9fc23e4d4cbecc`.

The source contains three elephant variants, pine meshes and a shared helper-heavy rig.
`isolate_elephant_candidate.mjs` detaches all but the first elephant without changing indices.
`prune_elephant_candidate.mjs` then removes unrelated payload and unneeded branches, remapping
the 64 weighted skin joints while retaining every required ancestor transform and all existing
animation channels/keyframes. Both tools refuse unreviewed input and existing output files.
The original binary must not be overwritten or re-exported through the known-problematic Blender
rig importer. Static Three.js-baked review poses are not rigged runtime replacements.

Latest compact derivative:
`tools/assets/sources/review/elephant-2026-09-24/recovered/AsianElephantCompact.glb`, relative to the repository root.
**Not live:** source-scale/forward-axis setup, Walk loop/contact polish, required lifecycle
motions, close-up texture fidelity and visual acceptance remain unfinished.
