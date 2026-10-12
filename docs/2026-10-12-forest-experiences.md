# Forest experiences

Built from main `e4c136664a04d54ca7a07a5ac703ec92acdaafcb`. Open `/experiences.html` from the forest's view settings.

## Survival League

Three- and five-minute water, hunting and survival missions run in separate worker arenas. Each competitor receives the same seed, species, cohort, starting needs and eight command turns. Local Forager/Careful strategies, a browser-controlled person and configured OpenRouter models use the existing live movement, resource and hunt implementation. The parent process alone holds provider credentials and reserves conservative input/output token budgets before each paid call. A provider failure disqualifies the entry; it does not silently substitute a local strategy.

Arena ground is schematic; the animal rigs are the forest's existing rigs. Saved position frames replay the observed match, not an independent re-execution of a model. Completed results and the monthly UTC league score commit together. Raw jobs remain for 30 days; monthly score totals remain after raw session retention.

## Forest moments

Major retained checkpoint events become cards and share links. Recorded hunts and tree journeys select their exact retained replay; a clip follows the actor through the recording's final 20 seconds. Shorter recordings retain their actual ending. Other events make a clearly labelled story clip: the current forest scene accompanies historical record text. No birth or death animation is fabricated. The browser records 20 seconds of actual rendered canvas with caption/source overlays and prefers MP4 when available, otherwise WebM. This uses native canvas/MediaRecorder rather than adding a separate React/Remotion rendering service. Cancelling, navigating or hiding the tab stops recording. Clip generation requires a browser with supported canvas recording and successful scene loading.

## Safari guide

Text answers select real checkpoint animals and needs, family fields and recent event text. Browser speech recognition and local speech synthesis are optional, user-initiated inputs/outputs. They require browser support and microphone permission; text remains available.

LiveKit adds a separate speech conversation when configured. The Python worker calls only the bounded public Safari fact endpoint, publishes the saved answer to the browser and may follow its animal in the observer. It has no world mutation or wallet tools. Sessions last at most 180 seconds and 12 fact-tool calls; the server also bounds room creation and daily reserved voice seconds.

## Follow a life

The browser's HttpOnly profile cookie owns a persistent, world-scoped list (maximum 20). Nicknames belong to that list and do not rename animals in the forest. Cards show saved family links, major retained history and unread recent updates. Browser notifications are opt-in and operate while the page remains open. They are not an offline push service. An archived life outside the retained checkpoint is explicitly distinguished from a confirmed death.

## What-if Lab

Three-, seven- and 30-day comparisons fork the same actual saved snapshot and RNG state. Both copies return held animals to autonomous behavior and use a closed population policy. No-rain suppresses rainfall while retaining groundwater and evaporation. Fewer-predators removes every second predator per species from the copied experiment and records its body/carried-food biomass as nutrient export. Baseline and experiment produce actual day-by-day population, fresh-water, vegetation, birth/death and nutrient totals. The live writer is never passed to a worker. Results include the source time, simulation version and assumptions; they are model experiments, not real-world forecasts.

## Startup and deployment

Migration 025 adds jobs, follows, quota reservations and monthly scores. Ordinary server startup applies it through the existing writer/migration ownership path. Without provider keys, local matches, text Safari, follows, lab experiments and browser video recording work.

```sh
# Site origin must match the browser, including the port in local development.
VANA_EXPERIENCES_ORIGIN=https://your-forest.example

# Optional: enable a reviewed allowlist of paid model players.
OPENROUTER_API_KEY=configure-in-your-secret-manager
VANA_LEAGUE_MODELS=provider/pinned-model-id,other-provider/pinned-model-id
VANA_LEAGUE_PUBLIC_MODELS=1
VANA_LEAGUE_DAILY_TOKENS=200000

# Optional: LiveKit voice (configure these in the server AND worker environments).
VANA_SAFARI_LIVEKIT=1
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=configure-in-your-secret-manager
LIVEKIT_API_SECRET=configure-in-your-secret-manager
VANA_VOICE_DAILY_SECONDS=1800
VANA_SAFARI_API_URL=https://your-forest.example/api/experiences/safari
# When using OpenRouter, select a pinned voice LLM explicitly.
VANA_SAFARI_LLM=provider/pinned-model-id
```

Run the voice worker independently from the HTTP process:

```sh
python3 -m venv .voice-venv
.voice-venv/bin/pip install -r tools/voice/requirements.txt
.voice-venv/bin/python tools/voice/safari.py download-files
.voice-venv/bin/python tools/voice/safari.py dev
# Use the SDK's start mode for a production worker.
# Local SDK/reader tests mock every network/provider call.
.voice-venv/bin/python -m unittest discover -s tools/voice -p 'test_*.py'
```

LiveKit Cloud inference is used for STT/TTS by default; optional `VANA_SAFARI_STT`, `VANA_SAFARI_TTS` and `VANA_SAFARI_VOICE` change them. A self-hosted transport needs separately configured compatible inference providers; supplying only transport credentials does not establish inference availability. No live paid-provider operation is implied by building the adapters.

Only `/?embed=experiences` allows same-origin forest framing. Account/other pages retain their framing denial. Only `/experiences.html` grants same-origin microphone permission. Mobile pages use the same controls, reduced-motion settings and explicit text fallbacks.

## Resource and recovery policy

At most two jobs run globally, four jobs per browser profile per hour and 64 starts per 24 hours. Worker heaps are bounded and do not inherit server credentials. Models get at most eight provider calls per entry; each reserves 9000 tokens against the daily allowance, including failures/uncertain responses. No arbitrary model IDs or provider endpoints come from the browser. Public callers cannot command, fetch or cancel another profile's job.

Cancelling ends workers and provider requests. Process restart marks outstanding jobs interrupted rather than inventing winners or resuming an unknown live state. Active progress is serialized and cannot overwrite terminal records. Stop/close terminates owned workers. League outcomes and monthly scores share a transaction and retries cannot double-count a match.

External documentation: [OpenRouter chat completions](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request), [LiveKit voice agents](https://docs.livekit.io/agents/start/voice-ai/), [LiveKit compatible LLMs](https://docs.livekit.io/agents/models/llm/openai-compatible-llms/).

## Verification on 12 October 2026

- The complete regular `verify:ci` gate passed in a freshly created private PostgreSQL cluster: 2,063 Vitest tests, zero failures/skips, plus the contract gate, TypeScript checks and production client build. Long release soaks remain separate.
- Six Python worker tests passed against LiveKit Agents 1.8.6, with all HTTP/provider calls mocked.
- Actual built-page browser checks covered 375/768/1440px layouts, completed local matches, identical initial player positions, match replay/export, reload/monthly scores, safely rendered persistent nicknames, profile separation, grounded Safari, both three-day lab scenarios, recorded video/download/cancel and human turn guards.
- A mobile hunt used a server-admitted prey target, accepted a real command and cancelled the owned match without a page exception.
- The recorded portrait artifact decoded at 720×1280 and 20.007 seconds. Footage came from the running test forest's retained recording.
- Both Caddy configurations were validated and tested through actual HTTP responses, including narrow framing/microphone exceptions and encoded-path metrics denial.

These checks used disposable databases and fresh browser contexts. Paid OpenRouter/LiveKit conversations, production credentials and production deployment were not exercised. Enable those adapters with the configuration above and validate the configured providers before opening paid sessions publicly.
