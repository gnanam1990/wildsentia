# Isolated local preview

This is a development observer, **not** a public deployment or production backup strategy.
It starts the current simulation in a dedicated local PostgreSQL database and runs the client.
All three listeners are bound to `127.0.0.1`: client 5178, API/WebSocket 8085, PostgreSQL 65439.
Those are the default mainland ports. The separate `island_v1` profile uses client 5179,
API/WebSocket 8086 and PostgreSQL 65438, with a distinct new database directory. Fresh island
previews include `household_v1`; older version-2 island previews remain household-free and
are never silently reshaped when resumed.
No existing `DATABASE_URL`, narration credentials or other database is used.

Requirements: installed project dependencies and PostgreSQL 17 binaries. Override `VANA_PG_BIN`
when they are not under `/opt/homebrew/opt/postgresql@17/bin`.

```sh
# NEW world: creates a private .local-preview/world-* directory and prints its path.
npm exec tsx tools/preview/local.ts

# NEW separate island; never reshapes the existing mainland database.
VANA_PREVIEW_TERRAIN_PROFILE=island_v1 npm exec tsx tools/preview/local.ts

# RESUME: use the exact directory printed by the first command.
npm exec tsx tools/preview/local.ts .local-preview/world-REPLACE_WITH_EXISTING_ID
```

A new world uses seed 1 and really simulates its first ten hours so art QA starts in daylight.
Profile and private connection metadata are retained with the directory. Resume uses its saved
profile; a contradictory requested profile is rejected. Legacy version-1 metadata means mainland.
A resumed world restores its existing checkpoint; it does not repeat the ten-hour advance.
Time then advances at 1×. Narration is template-only, and no model is called. Simulation-version
upgrades are **not** implicitly enabled. A version mismatch must be reviewed separately.

Ctrl-C/SIGTERM saves the world checkpoint, closes the API/client and stops PostgreSQL only if
this invocation started that exact private cluster. Data is retained. Abrupt termination relies
on the normal durable checkpoint recovery path; this script is not a process supervisor.

The directory contains local-only database credentials in mode-0600 files and database data.
`.local-preview/` is ignored by Git. Do not publish, commit or share its contents. Copying or
deleting a preview world is a separate explicit operation; the runner never wipes an existing
directory and never falls back to an external database. Port conflicts fail rather than being
resolved by killing another service.

24 September 2026: the older `/tmp/vana-live-pair-preview-*` preview was found absent, with no
listeners on its ports. A **new**, separate current-version world was created at
`.local-preview/world-z5CUvQ`. It is not a migration or restoration of the missing v0.7 world.

Later on 24 September, the separate island candidate `.local-preview/world-IT1WmW` encountered
the v0.15 patch-only breeding bug during first-morning advancement and was resumed from its
saved checkpoint. v0.16 fixes that path; the full founding cohort now passes the ten-hour boot
and six-hour track persistence regression. The existing candidate was **not** reset or upgraded
as part of that fix. Version mismatches still require explicit operator review, not deletion
of the preview directory. Error reporting names the startup stage without exposing credentials.
