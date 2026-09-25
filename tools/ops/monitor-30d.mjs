/**
 * External, sampled 30-real-day observer. Run on a separate host from VANA if possible.
 * It records evidence; it does not restart services, deploy, or claim continuous uptime
 * between samples. A missed observation is itself a failed acceptance interval.
 */
import { appendFileSync, constants, lstatSync, readFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DAY_MS = 86_400_000;
export const DURATION_MS = 30 * DAY_MS;
export const INTERVAL_MS = 10 * 60_000;
export const MAX_GAP_MS = 15 * 60_000;
export const WORLD_HOURS_PER_REAL_HOUR = 12;
const REAL_MS_PER_WORLD_HOUR = 3_600_000 / WORLD_HOURS_PER_REAL_HOUR;
const WORLD_SECONDS_PER_HOUR = 3600;

export function validateUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/api/health' || url.search || url.hash ||
      url.username || url.password) {
    throw new Error('Use an HTTPS URL ending exactly in /api/health, without credentials or query');
  }
  return url.href;
}

export function evaluate(records) {
  const start = records[0];
  if (!start || start.kind !== 'start' || !Number.isSafeInteger(start.at) ||
      start.durationMs !== DURATION_MS || start.intervalMs !== INTERVAL_MS ||
      start.maxGapMs !== MAX_GAP_MS ||
      (start.worldHoursPerRealHour !== undefined && start.worldHoursPerRealHour !== WORLD_HOURS_PER_REAL_HOUR))
    throw new Error('Invalid or incompatible monitor journal');
  const state = { startedAt: start.at, lastAt: start.at, lastWorldTime: null,
    firstWorldTime: null, firstSampleAt: null, lastAdvanceAt: null,
    incidents: [], samples: 0, complete: false };
  for (const record of records.slice(1)) {
    if (record.kind === 'complete') {
      if (state.complete) throw new Error('Duplicate completion record');
      state.complete = true;
      continue;
    }
    if (record.kind !== 'sample' || state.complete || !Number.isSafeInteger(record.at))
      throw new Error('Invalid monitor sample');
    const issues = [];
    if (record.at <= state.lastAt) issues.push('clock_reversed_or_duplicate');
    if (record.at - state.lastAt > MAX_GAP_MS) issues.push('observation_gap');
    if (record.ok !== true || !Number.isFinite(record.worldTime) || record.worldTime < 0) {
      issues.push('unhealthy_or_unreachable');
    } else {
      if (state.firstWorldTime === null) {
        state.firstWorldTime = record.worldTime;
        state.firstSampleAt = record.at;
      } else {
        // A world that advances only occasionally is not a 12x 30-day run. Allow one
        // checkpoint of sampling phase difference, but not accumulated lost hours.
        const expectedHours = Math.floor((record.at - state.firstSampleAt) / REAL_MS_PER_WORLD_HOUR);
        if (record.worldTime - state.firstWorldTime <
            Math.max(0, expectedHours - 1) * WORLD_SECONDS_PER_HOUR)
          issues.push('world_time_behind_schedule');
      }
      if (state.lastWorldTime !== null && record.worldTime < state.lastWorldTime)
        issues.push('world_time_rollback');
      if (state.lastWorldTime === null || record.worldTime > state.lastWorldTime) {
        state.lastAdvanceAt = record.at;
      } else if (state.lastAdvanceAt !== null && record.at - state.lastAdvanceAt >= MAX_GAP_MS) {
        issues.push('world_time_stalled');
      }
      state.lastWorldTime = record.worldTime;
    }
    for (const issue of issues) state.incidents.push({ at: record.at, issue });
    state.lastAt = record.at;
    state.samples++;
  }
  return state;
}

function appendDurable(path, entry, create = false) {
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW |
    (create ? constants.O_CREAT | constants.O_EXCL : 0);
  const fd = openSync(path, flags, 0o600);
  try {
    appendFileSync(fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function loadOrStart(path, url) {
  if (!isAbsolute(path)) throw new Error('--journal must be an absolute private path');
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (current && (!current.isFile() || current.isSymbolicLink() || (current.mode & 0o077)))
    throw new Error('Journal must be a private regular file, not a symlink');
  if (!current) appendDurable(path, { kind: 'start', at: Date.now(), url,
    durationMs: DURATION_MS, intervalMs: INTERVAL_MS, maxGapMs: MAX_GAP_MS,
    worldHoursPerRealHour: WORLD_HOURS_PER_REAL_HOUR }, true);
  const content = readFileSync(path, 'utf8');
  if (!content.endsWith('\n')) throw new Error('Incomplete journal record; inspect without discarding evidence');
  const records = content.trimEnd().split('\n').map(line => JSON.parse(line));
  if (records[0]?.url !== url) throw new Error('Journal belongs to a different health URL');
  return records;
}

async function observe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
    if (!response.ok) return { kind: 'sample', at: Date.now(), ok: false, status: response.status };
    const data = await response.json();
    return { kind: 'sample', at: Date.now(), ok: data?.ok === true,
      worldTime: data?.worldTime };
  } catch (error) {
    return { kind: 'sample', at: Date.now(), ok: false,
      error: error instanceof Error ? error.name : 'unknown_error' };
  }
}

export async function run(url, journal) {
  const records = loadOrStart(journal, url);
  if (evaluate(records).complete) throw new Error('This 30-day journal is already complete');
  for (;;) {
    const sample = await observe(url);
    appendDurable(journal, sample);
    records.push(sample);
    const state = evaluate(records);
    const issues = state.incidents.filter(item => item.at === sample.at);
    console.log(JSON.stringify({ at: new Date(sample.at).toISOString(), ok: sample.ok,
      worldTime: sample.worldTime ?? null, issues: issues.map(item => item.issue),
      incidentCount: state.incidents.length, samples: state.samples }));
    if (sample.at - state.startedAt >= DURATION_MS) {
      const accepted = state.incidents.length === 0;
      appendDurable(journal, { kind: 'complete', at: Date.now(), accepted,
        incidents: state.incidents.length });
      console.log(JSON.stringify({ accepted, observedRealDays: (sample.at - state.startedAt) / DAY_MS,
        incidents: state.incidents.length, journal }));
      if (!accepted) process.exitCode = 1;
      return;
    }
    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--url' || args[2] !== '--journal')
      throw new Error('usage: node tools/ops/monitor-30d.mjs --url https://DOMAIN/api/health --journal /ABSOLUTE/PRIVATE/vana-30d.jsonl');
    await run(validateUrl(args[1]), args[3]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
