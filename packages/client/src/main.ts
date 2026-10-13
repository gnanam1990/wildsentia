import * as THREE from 'three';
import { movementAt } from '@vana/shared';
import { WorldStore, type AnimalState } from './protocol.js';
import { createScene } from './scene.js';
import { hideFarFieldNear } from './terrain.js';
import { TerrainCheckpoints, type PreparedTerrain } from './terrainCheckpoints.js';
import { NEAR_RADIUS_M, TREE_DETAIL_RADIUS_M, NearVegetation } from './vegetation.js';
import { InsightPanel } from './insights.js';
import { LiveAgents, activityOf, isLiveMessage, isRosterMessage, rosterActivity, usdc } from './liveAgents.js';
import { COVER_RADIUS_M, GroundCover } from './groundCover.js';
import { AnimalLayer } from './animals.js';
import { FollowCamera, followDistanceFor } from './camera.js';
import { nearestOnScreen } from './picking.js';
import { Hud } from './hud.js';
import { ThoughtBubble } from './bubble.js';
import { LastSeen, worthRecapping } from './recap.js';
import { climbMoment, isRecordedClimb, pointAt, momentAt, replayDurationMs, trackPrecision, type Life, type RecordedClimb } from './replay.js';
import { CommunityLayer } from './communityLayer.js';
import { loadLifeHistory, loadSelectedClimb, loadSelectedEncounter } from './lifeHistory.js';
import { encounterAt, isRecordedEncounter, ReplayClock, type RecordedEncounter } from './encounterReplay.js';
import { huntMoment, huntReplaySeconds } from './huntActs.js';
import { SPECIES_VISUALS, visualFor } from './species.js';
import { Atmosphere, atmosphereAt, observerExposure } from './environment.js';
import { groundTint } from './groundTint.js';
import { wind } from './wind.js';
import { characterScale, markerSize } from './appearance.js';
import { LiveEncounterPlayer, recordedClimbPhase, withRecordedVisualIdentity } from './liveEncounters.js';
import { ObserverVisibility, type ObserverSubject } from './observerVisibility.js';
import { refreshSpeciesOptions } from './speciesPicker.js';
import { islandPool, waterGround } from './pools.js';
import { stackLabels } from './labelLayout.js';
import { restoreFollowOnOpen } from './followSubscription.js';
import { LIVE_BUSY_CLOSE_CODE, ReconnectBackoff } from './reconnect.js';
import type { EventMap } from './eventMap.js';
import { EventVisit } from './eventVisit.js';
import { RewardObserver } from './rewards.js';
import { SceneUpdates } from './sceneUpdates.js';
import { AdaptiveQuality, qualityMode, RenderPacer } from './renderQuality.js';
import { MicroEcologyLayer } from './microEcologyLayer.js';
import { animalFromHash, followedHash, initialFollowId } from './animalLink.js';
import { isAnimalLinkId } from './animalLink.js';
import { captureHighlight, highlightStart, type CaptureHandle } from './highlightCapture.js';
import { LazyDialog } from './lazyDialog.js';
import { ReturnPath } from './returnPath.js';
import { renderBaseY } from './space.js';
import { AmbientAudio, cueFor, type AudioAnimal } from './ambientAudio.js';
import { initObserverChrome } from './observerChrome.js';
import { populationCounter } from './populationCounter.js';
import { applyTheme, readTheme } from './theme.js';
import { parseChoice } from './themeModel.js';


/** Keep the activity label clear of this species' head. */
const bubbleHeight = (animal: AnimalState | undefined): number => {
  const height = animal === undefined ? 1 : visualFor(animal.speciesId).heightM;
  return (height + markerSize(height) * 1.6) * characterScale(animal ?? {});
};

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const { renderer, scene, camera, sun, setQuality, prepareShadows, setObserverCenter } = createScene(canvas);
let experienceViewPaused = false;
const observerChrome = initObserverChrome(setObserverCenter);
const atmosphere = new Atmosphere(scene, sun);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const ambientAudio = new AmbientAudio();
const ambientToggle = document.querySelector<HTMLButtonElement>('#ambient-toggle')!;
const ambientStatus = document.querySelector<HTMLOutputElement>('#ambient-status')!;
function setAmbientUi(message = ''): void {
  ambientToggle.textContent = `Ambient audio: ${ambientAudio.enabled ? 'on' : 'off'}`;
  ambientToggle.setAttribute('aria-pressed', String(ambientAudio.enabled));
  ambientStatus.textContent = message;
}
ambientToggle.addEventListener('click', async () => {
  if (ambientToggle.disabled) return;
  if (ambientAudio.enabled) { ambientAudio.stop(); setAmbientUi('Sound off.'); return; }
  ambientToggle.disabled = true; ambientStatus.textContent = 'Starting sound…';
  const started = await ambientAudio.start();
  if (document.hidden && started) ambientAudio.stop();
  ambientToggle.disabled = false;
  setAmbientUi(ambientAudio.enabled ? 'Sound on: current rain, wind and nearby visible water; calls only from visible animals recorded fleeing or hunting.'
    : 'Sound unavailable or tab hidden. It remains off; try again after returning.');
});

const store = new WorldStore();
const liveEncounters = new LiveEncounterPlayer();
/** The island's time as played on screen (see LiveEncounterPlayer.worldTimeAt). */
const liveWorldTime = (now = performance.now()): number | null =>
  liveEncounters.worldTimeAt(now) ?? store.world?.worldTime ?? null;
const encounterNotice = document.querySelector<HTMLElement>('#live-encounter-status')!;
const communityMotionNotice = document.querySelector<HTMLElement>('#community-motion-status')!;
const liveEncounterPicker = document.querySelector<HTMLSelectElement>('#live-encounter-picker')!;
const livePairFrame = document.querySelector<HTMLInputElement>('#live-encounter-frame')!;
const liveLabels = [document.querySelector<HTMLElement>('#live-subject-label')!, document.querySelector<HTMLElement>('#live-partner-label')!];
const humanLabel = document.querySelector<HTMLElement>('#human-subject-label')!;
let encounterPickerKey = '';
const animals = new AnimalLayer();
scene.add(animals.root);
const microEcology = new MicroEcologyLayer();
scene.add(microEcology.root);
const communityLayer = new CommunityLayer();
scene.add(communityLayer.root);
// Animals steered by outside AI agents, and the USDC drops they race for.
const liveAgents = new LiveAgents((x, z) => animals.groundHeightAt(x, z));
scene.add(liveAgents.root);

const follow = new FollowCamera(camera, canvas);
const EXPLORE_DISTANCE_M = 900;
// The observer camera stays above sea level; animals still use the actual ground sampler.
follow.groundHeightAt = (x, z) => Math.max(0, animals.groundHeightAt(x, z));
// Dragging the ground explores the island: it lets go of the followed animal or person.
// A replay keeps its own subject; the viewer stops it explicitly.
follow.onExplore = () => {
  if (!banner.hidden) return;
  if (followedId !== null || followedPersonId !== null) watch(null);
};
const observerVisibility = new ObserverVisibility();
const themeChoice = document.querySelector<HTMLSelectElement>('#theme-choice')!;
themeChoice.value = readTheme();
themeChoice.addEventListener('change', () => applyTheme(parseChoice(themeChoice.value)));
const revealAnimal = document.querySelector<HTMLInputElement>('#observer-cutaway')!;
const hud = new Hud({
  clock: document.querySelector('#clock')!,
  season: document.querySelector('#season')!,
  population: document.querySelector('#population')!,
  renderPopulation: populationCounter(document.querySelector('#population')!),
  passport: document.querySelector('#passport')!,
  feed: document.querySelector('#feed')!,
  notice: document.querySelector('#notice')!,
}, store);

const bubble = new ThoughtBubble(document.querySelector('#thought')!);

const storage = (() => { try { return localStorage; } catch { return null; } })();
try { revealAnimal.checked = storage?.getItem('vana.observer-cutaway') !== 'off'; } catch { /* default stays checked */ }
revealAnimal.addEventListener('change', () => {
  try { storage?.setItem('vana.observer-cutaway', revealAnimal.checked ? 'on' : 'off'); } catch { /* optional viewer preference */ }
});
// Created with the HUD: watch() can run before the feed timers below are set up.
/** Plain words for what an animal is doing in the played hour. */
/**
 * How much of a wide screen's extra width pair framing may count on. Capped at 1 it framed a
 * landscape view by its height alone and stood far back; uncapped, a pair lined up along the view
 * would be framed too tightly. 1.5 sits between.
 */
const PAIR_FRAME_ASPECT = 1.5;
const SPECIES_LABEL: Record<string, string> = { boar: 'Wild boar', squirrel: 'Giant squirrel', leopard: 'Leopard' };
const ACTIVITY_LABEL: Record<string, string> = {
  travelling: 'walking', fleeing: 'running away', drinking: 'drinking', resting: 'resting', chasing: 'chasing',
  stalking: 'stalking', dead: 'dead', grazing: 'grazing', feeding: 'feeding',
  pouncing: 'pouncing', holding: 'holding its prey', struck: 'struck', falling: 'falling', struggling: 'struggling',
};
hud.clockTime = () => liveWorldTime();
hud.liveActivity = (id) => {
  const avatar = liveAgents.avatarForAnimal(id);
  if (avatar) return { state: activityOf(avatar), goal: avatar.action === 'idle' ? '' : avatar.action, agent: avatar.name };
  const pose = liveEncounters.poses(performance.now(), reducedMotion.matches).get(id);
  return pose ? { state: ACTIVITY_LABEL[pose.animal.state] ?? pose.animal.state, goal: pose.animal.currentGoal } : null;
};
const insightPanel = new InsightPanel(document.querySelector('#outlook')!, document.querySelector('#highlights')!,
  undefined, () => hud.clockTime());
const lastSeen = new LastSeen(storage);
/** The animal this viewer last followed, so coming back returns them to it. */
const lastFollowed = {
  get(): string | null { try { return storage?.getItem('vana.followed') ?? null; } catch { return null; } },
  set(id: string | null): void {
    try { if (id === null) storage?.removeItem('vana.followed'); else storage?.setItem('vana.followed', id); } catch { /* optional */ }
  },
};

let followedId: string | null = null;
let followedPersonId: string | null = null;
let historicAutofocusId: string | null = null;
let historicCameraOwned = false;
let socket: WebSocket | null = null;
const rewards = new RewardObserver();
const observerUiStatus = document.querySelector<HTMLElement>('#observer-ui-status')!;
const eventVisit = new EventVisit(scene, () => { void mapDialog.open(); });
let eventMap: EventMap | null = null;
let mapPatches: Parameters<EventMap['setPatches']>[0] = [];
let tintSeason = '';
const mapDialog = new LazyDialog<[]>('event map', observerUiStatus, async () => {
  const { EventMap } = await import('./eventMap.js');
  const map = new EventMap((event) => {
    watch(null);
    follow.target.set(event.position.x, animals.groundHeightAt(event.position.x, event.position.z), event.position.z);
    follow.distance = event.precision === 'patch' ? 220 : 40;
    eventVisit.show(event, animals.groundHeightAt);
    canvas.focus();
  }, (id) => watch(id), (id, eventId) => { void startReplay(id, eventId); }, id => watchSavedPerson(id),
  id => readPersonHistory(id, () => { void mapDialog.open(); }));
  map.setPatches(mapPatches);
  eventMap = map;
  return () => map.open();
});
document.querySelector('#open-event-map')!.addEventListener('click', () => { void mapDialog.open(); });
function watchSavedPerson(id: string): void {
  watch(null);
  const position = communityLayer.positionOf(id, performance.now(), reducedMotion.matches);
  if (position) {
    followedPersonId = id;
    follow.target.set(position.x, position.y + (position.alive ? 1.1 * position.scale : .2), position.z); follow.distance = 8;
    canvas.focus();
  } else readPersonHistory(id, null);
}
/** Closing a person's history goes back to the dialog it was read from, and only that one. */
const personHistoryReturn = new ReturnPath();
function readPersonHistory(id: string, back: (() => void) | null): void {
  personHistoryReturn.openedFrom(back);
  void personHistoryDialog.open(id);
}
const communityDialog = new LazyDialog<[]>('community observer', observerUiStatus, async () => {
  const { createCommunityDialog } = await import('./communityObserver.js');
  return createCommunityDialog((position, distance) => {
    watch(null);
    follow.target.set(position.x, animals.groundHeightAt(position.x, position.z), position.z);
    follow.distance = distance;
    canvas.focus();
  }, id => readPersonHistory(id, () => {
    document.querySelector<HTMLButtonElement>('#open-community')?.focus();
    void communityDialog.open();
  }), id => watchSavedPerson(id));
});
const personHistoryDialog = new LazyDialog<[string]>('person history', observerUiStatus, async () => {
  const { createPersonHistoryDialog } = await import('./personHistory.js');
  return createPersonHistoryDialog(() => { if (!personHistoryReturn.close()) canvas.focus(); }, frame => {
    communityLayer.setHistoricFrame(frame);
    if (!frame) { historicAutofocusId = null; historicCameraOwned = false; return; }
    if (frame.source !== 'recorded') return;
    if (historicAutofocusId !== frame.personId) {
      historicAutofocusId = frame.personId;
      watch(null); // A user-opened biography takes the camera off any animal/replay once.
      historicCameraOwned = true; followedPersonId = frame.personId; follow.distance = 8;
    } else if (historicCameraOwned && followedId === null && followedPersonId === null) {
      // Reacquire only after a missing recorded hour; an explicit animal/free-camera selection wins.
      followedPersonId = frame.personId;
    }
  });
});
document.querySelector('#open-community')!.addEventListener('click', () => { void communityDialog.open(); });

function connect(): void {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const connection = socket = new WebSocket(`${protocol}://${location.host}/live`);
  restoreFollowOnOpen(connection, () => followedId);
  // A new connection has no view yet: say where the camera looks straight away.
  connection.addEventListener('open', () => { viewSent = null; sendView(true); }, { once: true });
  connection.addEventListener('message', (event) => {
    if (socket !== connection) return;
    try {
      const message: unknown = JSON.parse(String(event.data));
      if (typeof message === 'object' && message !== null && 'type' in message) {
        if (message.type === 'scene') {
          if (!sceneUpdates.receive(message, performance.now())) connection.close();
          else reconnect.succeeded();
        } else if (message.type === 'viewers' || message.type === 'error') store.apply(message);
        else if (message.type === 'live') { if (isLiveMessage(message)) liveAgents.apply(message, performance.now()); }
        else if (message.type === 'live-roster') { if (isRosterMessage(message)) liveAgents.applyRoster(message); }
        else if (message.type === 'heartbeat') return;
        else connection.close(); // Incompatible split-state protocol: never mix generations.
      }
    } catch {
      // A malformed frame must not take down the render loop.
    }
  });
  connection.addEventListener('close', (event) => {
    if (socket !== connection) return;
    sceneUpdates.reset(); liveEncounters.disconnect(); liveAgents.clear();
    // Back off rather than hammer: longer after each failure, much longer when the server is full.
    const wait = reconnect.next(event.code);
    if (event.code === LIVE_BUSY_CLOSE_CODE && event.reason.startsWith('busy')) {
      sceneStatus.textContent = `The forest has as many viewers as it can take right now. Trying again in about ${Math.ceil(wait / 1000)} s.`;
      sceneStatus.hidden = false;
    }
    setTimeout(connect, wait);
  });
}
const reconnect = new ReconnectBackoff();

/** A life being replayed (spec §11): the record, when playback began, and how long it runs. */
let replay: { life: Life; records: RecordedEncounter[]; climbs: RecordedClimb[];
  encounter: RecordedEncounter | null; climb: RecordedClimb | null; clock: ReplayClock } | null = null;
const banner = document.querySelector<HTMLElement>('#replay')!;
const recordingPicker = document.querySelector<HTMLSelectElement>('#replay-recording')!;
const replaySeek = document.querySelector<HTMLInputElement>('#replay-seek')!;
const replayPlay = document.querySelector<HTMLButtonElement>('#replay-play')!;
const replaySpeed = document.querySelector<HTMLSelectElement>('#replay-speed')!;
const replayAutoFrame = document.querySelector<HTMLInputElement>('#replay-autoframe')!;
const replayStatus = banner.querySelector<HTMLElement>('.replay-status')!;
const replayWhen = banner.querySelector<HTMLElement>('.when')!;
const replayMoment = banner.querySelector<HTMLElement>('.moment')!;
let replayRequest = 0;
let replayAbort: AbortController | null = null;
let liveCameraDistance = follow.distance;

const dayOf = (t: number): string => {
  const days = Math.floor(t / 86_400);
  return `year ${Math.floor(days / 360) + 1}, day ${(days % 360) + 1}`;
};

async function startReplay(id: string, selectedEventId?: string, kind: 'encounter' | 'climb' = 'encounter'): Promise<void> {
  eventVisit.clear();
  const request = ++replayRequest;
  replayAbort?.abort(); replayAbort = new AbortController();
  if (banner.hidden) liveCameraDistance = follow.distance;
  replay = null;
  banner.hidden = false;
  document.body.classList.add('is-replaying');
  observerChrome.setReplaying(true);
  replayStatus.textContent = 'Loading recorded history…';
  replayWhen.textContent = ''; replayMoment.textContent = '';
  banner.querySelector('.precision')!.textContent = '';
  recordingPicker.replaceChildren(); recordingPicker.disabled = true;
  replaySeek.disabled = true; replayPlay.disabled = true;
  try {
    const life = selectedEventId ? kind === 'climb'
      ? await loadSelectedClimb(id, selectedEventId, replayAbort.signal)
      : await loadSelectedEncounter(id, selectedEventId, replayAbort.signal)
      : await loadLifeHistory(id, { signal: replayAbort.signal,
      progress: (pages, moments) => { if (request === replayRequest) replayStatus.textContent = `Loading recorded history · ${pages} pages · ${moments} summary moments…`; } });
    if (request !== replayRequest) return;
    const records = (life.encounters ?? []).filter(isRecordedEncounter)
      .filter((e) => [e.trace.predatorId, e.trace.preyId].includes(life.id));
    const climbs = (life.climbs ?? []).filter(isRecordedClimb).filter(e => e.trace.actorId === life.id);
    if (life.track.length === 0 && records.length === 0 && climbs.length === 0)
      throw new Error('No recorded positions, encounters or tree routes for this animal yet.');
    const whole = new Option('Whole life — sampled positions', 'life');
    whole.disabled = life.track.length === 0;
    recordingPicker.add(whole);
    records.forEach((e, i) => recordingPicker.add(new Option(
      `${dayOf(e.trace.startWorldTime)} · ${e.predatorSpecies} / ${e.preySpecies} · ${e.outcome}`, String(i),
    )));
    climbs.forEach((e, i) => recordingPicker.add(new Option(
      `${dayOf(e.trace.startWorldTime)} · recorded tree ${e.direction} · ${e.outcome}`, `climb:${i}`,
    )));
    replay = { life, records, climbs, encounter: null, climb: null, clock: new ReplayClock(1) };
    recordingPicker.disabled = false; replaySeek.disabled = false; replayPlay.disabled = false;
    const selected = records.findIndex((e) => e.eventId === selectedEventId);
    const selectedClimb = climbs.findIndex((e) => e.eventId === selectedEventId);
    if (selectedEventId && (kind === 'climb' ? selectedClimb : selected) < 0) throw new Error('This selected recording is no longer retained.');
    recordingPicker.value = kind === 'climb' && climbs.length ? `climb:${Math.max(0, selectedClimb)}`
      : selected >= 0 ? String(selected) : life.track.length ? 'life' : '0';
    selectRecording();
    replayPlay.focus();
  } catch (error) {
    if (request !== replayRequest) return;
    replay = null;
    replaySeek.disabled = true; replayPlay.disabled = true; recordingPicker.disabled = true;
    replayStatus.textContent = `${error instanceof Error ? error.message : 'Recorded history is unavailable.'} Return to live and try again.`;
  }
}

function selectRecording(): void {
  if (!replay) return;
  replay.climb = recordingPicker.value.startsWith('climb:')
    ? replay.climbs[Number(recordingPicker.value.slice(6))] ?? null : null;
  replay.encounter = recordingPicker.value === 'life' || replay.climb
    ? null : replay.records[Number(recordingPicker.value)] ?? null;
  const e = replay.encounter, climb = replay.climb;
  replayAutoFrame.disabled = e === null;
  replayAutoFrame.checked = true;
  const span = e ? huntReplaySeconds(e.trace, e.outcome) : climb ? climb.trace.samples.at(-1)!.seconds
    : replay.life.track.at(-1)!.worldTime - replay.life.track[0]!.worldTime;
  replay.clock = new ReplayClock(e || climb ? Math.max(1, span * 1000) : replayDurationMs(span));
  replay.clock.speed = Number(replaySpeed.value);
  replaySeek.value = '0'; replayPlay.textContent = 'Play';
  replayStatus.textContent = e ? 'Paused · paired server recording' : climb ? 'Paused · single-animal saved tree route'
    : `Paused · ${replay.records.length} recent paired encounters available`;
  banner.querySelector('.precision')!.textContent = e
    ? `Event ${e.eventId}. Both actors share recorded timestamps. Paths are linearly interpolated; poses/body variants are illustrative. Terrain and weather are current, not historical.`
    : climb ? `Event ${climb.eventId}. Position, altitude and timing come from one retained route; no height is inferred from sparse life samples. ${climb.verticalDistanceM > 0 ? 'Climb pose is illustrative: the body is stood upright on the trunk and its walk cycle stands in for gripping.' : 'No vertical climb was recorded.'} Terrain and weather are current, not historical.`
    : `${trackPrecision(replay.life.track)} All retained summary pages loaded. Picker shows recent paired recordings; Browse retained history can open older recorded encounters and tree routes.`;
  if (e) {
    const s = e.trace.samples[0]!;
    follow.distance = Math.max(15, Math.hypot(s.predator.x - s.prey.x, s.predator.z - s.prey.z) * 1.5 + 12);
  } else if (climb) follow.distance = 15;
  else follow.distance = 22;
}
recordingPicker.addEventListener('change', selectRecording);
replayPlay.addEventListener('click', () => {
  if (!replay) return;
  if (replay.clock.paused) replay.clock.play(); else replay.clock.paused = true;
});
replaySeek.addEventListener('input', () => { replay?.clock.seek(Number(replaySeek.value) / 1000); });
replaySpeed.addEventListener('change', () => { if (replay) replay.clock.speed = Number(replaySpeed.value); });
canvas.addEventListener('wheel', () => { if (replay?.encounter) replayAutoFrame.checked = false; });
canvas.addEventListener('keydown', (e) => {
  if (replay?.encounter && ['+', '=', '-'].includes(e.key)) replayAutoFrame.checked = false;
});
reducedMotion.addEventListener('change', () => { if (reducedMotion.matches && replay) replay.clock.paused = true; });

/** Leaves a replay (or one still loading) for the live view; does nothing when none is open. */
function stopReplay(): void {
  if (banner.hidden) return;
  replayRequest++;
  replayAbort?.abort(); replayAbort = null;
  replay = null;
  banner.hidden = true;
  document.body.classList.remove('is-replaying');
  observerChrome.setReplaying(false);
  follow.distance = liveCameraDistance;
  canvas.focus();
}
banner.querySelector('[data-stop-replay]')!.addEventListener('click', stopReplay);

/** Set on follow; answered once the world clock is known, before lastSeen is overwritten. */
let recapPending: string | null = null;
let recapLoading = false;
let recapRetryAt = 0;
let followRevision = 0;

function watch(id: string | null): void {
  if (id !== null) observerChrome.showAnimal();
  eventVisit.clear();
  followedPersonId = null;
  historicCameraOwned = false;
  followRevision++; recapLoading = false; recapRetryAt = 0;
  livePairFrame.checked = false;
  if (!banner.hidden) stopReplay();
  followedId = id;
  rewards.watch(id);
  const subject = id === null ? undefined : store.animals.get(id) ?? liveEncounters.poses(performance.now()).get(id)?.animal;
  speciesPicker.value = subject?.speciesId ?? '';
  if (subject) follow.flyToDistance(followDistanceFor(subject.speciesId, visualFor(subject.speciesId).heightM));
  hud.cancelRecap();
  recapPending = id;
  lastFollowed.set(id);
  // The address bar follows along, so copying or reloading it comes back to this animal.
  const hash = followedHash(location.hash, id);
  if (hash !== location.hash) {
    try { history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`); } catch { /* optional */ }
  }
  void hud.refreshPassport(id).then(() => hud.render(followedId));
  // An agent's animal does what its agent decides; an estimate of its next hour would mislead.
  void insightPanel.outlook(id !== null && liveAgents.avatarForAnimal(id) ? null : id);
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(id === null ? { type: 'unwatch' } : { type: 'watch', actorId: id }));
}

liveEncounterPicker.addEventListener('change', () => {
  const encounter = liveEncounters.current(performance.now())?.encounters.find((e) => e.eventId === liveEncounterPicker.value);
  if (encounter) { watch(encounter.predator.id); livePairFrame.checked = true; }
});
canvas.addEventListener('wheel', () => { livePairFrame.checked = false; }, { passive: true });
canvas.addEventListener('keydown', (e) => {
  if (!e.ctrlKey && !e.metaKey && !e.altKey && ['+', '=', '-'].includes(e.key)) livePairFrame.checked = false;
});

function refreshEncounterPicker(nowMs: number): void {
  const frame = liveEncounters.current(nowMs);
  const key = `${frame?.id ?? ''}:${reducedMotion.matches}`;
  if (key === encounterPickerKey) return;
  encounterPickerKey = key;
  liveEncounterPicker.replaceChildren();
  const prompt = document.createElement('option'); prompt.value = '';
  prompt.textContent = reducedMotion.matches ? 'Motion reduced — use paused life replay'
    : frame?.encounters.length ? 'Choose a recorded hunt' : 'No current recordings';
  liveEncounterPicker.append(prompt);
  liveEncounterPicker.disabled = reducedMotion.matches || !frame?.encounters.length;
  if (!reducedMotion.matches) for (const e of frame?.encounters ?? []) {
    const option = document.createElement('option'); option.value = e.eventId;
    option.textContent = `${e.predatorSpecies} / ${e.preySpecies} · ${e.outcome} · ${e.eventId.slice(-6)}`;
    liveEncounterPicker.append(option);
  }
}

/** Detailed plants around the camera, and the stand-in terrain they replace there. */
let nature: NearVegetation | null = null;
/** The detailed vegetation still downloading; it joins the scene whenever it arrives. */
let natureLoading: NearVegetation | null = null;
function loadNature(patches: ConstructorParameters<typeof NearVegetation>[0]): void {
  const vegetation = new NearVegetation(patches, (x, z) => animals.groundHeightAt(x, z));
  natureLoading = vegetation;
  vegetation.load(renderer).then(() => {
    if (natureLoading !== vegetation) return;
    natureLoading = null;
    nature = vegetation; nature.setQuality(quality.tier);
    if (mapPatches.length) nature.setPatches(mapPatches);
    observerVisibility.attach(nature.root); scene.add(nature.root);
  }, () => {
    // Retried on the next scene update; the fallback forest stays meanwhile.
    vegetation.dispose(); if (natureLoading === vegetation) natureLoading = null;
  });
}
let groundCover: GroundCover | null = null;
let terrainRoot: THREE.Object3D | null = null;
const graphics = document.querySelector<HTMLSelectElement>('#render-quality')!;
const graphicsStatus = document.querySelector<HTMLOutputElement>('#render-quality-status')!;
let savedQuality: unknown;
try { savedQuality = storage?.getItem('vana.graphics'); } catch { /* optional preference */ }
const quality = new AdaptiveQuality(qualityMode(savedQuality));
graphics.value = quality.mode;
function applyQuality(): void {
  setQuality(quality.tier); animals.quality = quality.tier; wind.setTier(quality.tier);
  groundCover?.setQuality(quality.tier); nature?.setQuality(quality.tier);
  graphicsStatus.textContent = `${quality.mode === 'auto' ? 'Auto · ' : ''}${quality.tier} graphics`;
}
applyQuality();
graphics.addEventListener('change', () => {
  quality.select(qualityMode(graphics.value)); applyQuality();
  try { storage?.setItem('vana.graphics', quality.mode); } catch { /* optional preference */ }
});
const pacer = new RenderPacer(Number(new URLSearchParams(location.search).get('maxfps') ?? 60));
const terrainCheckpoints = new TerrainCheckpoints();
document.addEventListener('visibilitychange', () => {
  pacer.reset(); quality.resetTiming();
  if (document.hidden && ambientAudio.enabled) { ambientAudio.stop(); setAmbientUi('Sound paused while this tab is hidden. Click to resume.'); }
});
addEventListener('pagehide', (event) => {
  ambientAudio.stop(); setAmbientUi('Sound off.');
  // Preserve resources if the browser keeps this document alive in its back/forward cache.
  if (!(event as PageTransitionEvent).persisted) { nature?.dispose(); natureLoading?.dispose(); natureLoading = null; groundCover?.dispose(); microEcology.dispose(); communityLayer.dispose(); terrainCheckpoints.dispose(); }
});
const carcasses = new Map<string, AnimalState>();
const sceneStatus = document.querySelector<HTMLElement>('#scene-status')!;
const sceneUpdates = new SceneUpdates<{
  terrain: PreparedTerrain;
  cover: GroundCover | null;
}>({
  async prepare(environment) {
    const terrain = terrainCheckpoints.prepare(environment.patches);
    let cover: GroundCover | null = null;
    try {
      if (groundCover === null) cover = new GroundCover(environment.patches, (x, z) => animals.groundHeightAt(x, z));
      // Detailed trees and rocks are most of a first visit's bytes. The terrain's fallback
      // trunks and canopies show the forest meanwhile, so they load after the scene appears.
      if (nature === null && natureLoading === null) loadNature(environment.patches);
      return { terrain, cover };
    } catch (error) { terrainCheckpoints.discard(terrain); cover?.dispose(); throw error; }
  },
  discard(prepared) { terrainCheckpoints.discard(prepared.terrain); prepared.cover?.dispose(); },
  commit(update, prepared) {
    // No await in this commit: terrain, resources, carcasses, route playback and HUD become
    // visible together before the next animation frame or subscriber notification.
    if (prepared) {
      terrainRoot = terrainCheckpoints.commit(prepared.terrain);
      // Before atlas detail is ready, the terrain's fallback trunks/canopies are
      // still real foreground decoration and need the same observer cutaway.
      for (const kind of ['grass', 'rock', 'trunk', 'canopy']) {
        const decorative = terrainRoot.getObjectByName(kind);
        if (decorative) observerVisibility.attach(decorative);
      }
      animals.groundHeightAt = prepared.terrain.height;
      scene.add(terrainRoot);
      if (prepared.cover) { groundCover = prepared.cover; observerVisibility.attach(groundCover.root); scene.add(groundCover.root); }
      else groundCover?.setPatches(update.environment.patches);
      groundCover?.setQuality(quality.tier);
      nature?.setPatches(update.environment.patches);
      const ground = waterGround(update.environment.patches);
      animals.pools = update.environment.patches.flatMap((patch) => { const pool = islandPool(patch, ground); return pool ? [pool] : []; });
      microEcology.sync(update.environment.microEcology, update.environment.patches, prepared.terrain.height);
      communityLayer.sync(update.environment.community, prepared.terrain.height);
      communityLayer.setReplay(replay !== null);
      mapPatches = update.environment.patches;
      if (store.world) groundTint.update(update.environment.patches, store.world.season);
      eventMap?.setPatches(mapPatches);
      carcasses.clear();
      for (const c of update.environment.carcasses) carcasses.set(c.id, c);
    }
    liveEncounters.apply(update.frame, update.frameReceivedAt);
    communityLayer.applyRecording(update.environment.community, update.frame, update.frameReceivedAt);
    store.replaceCheckpoint(update.world, update.animals);
  },
  status(state) {
    canvas.setAttribute('aria-busy', String(state === 'loading'));
    const text = state === 'ready' ? '' : state === 'loading'
      ? 'Preparing saved forest scene…' : 'Scene update unavailable. Keeping the last complete scene; retrying automatically.';
    if (sceneStatus.textContent !== text) sceneStatus.textContent = text;
    sceneStatus.hidden = !text;
  },
});

// Click to follow.
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerStart: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (event) => { if (event.isPrimary) pointerStart = { x: event.clientX, y: event.clientY }; });
canvas.addEventListener('pointercancel', () => { pointerStart = null; });
canvas.addEventListener('pointerup', (event) => {
  const start = pointerStart; pointerStart = null;
  if (!start || event.button !== 0 || follow.wasGesture || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
  const id = pickedAnimal(event);
  if (id !== null) watch(id);
});
canvas.addEventListener('dblclick', (event) => {
  const id = pickedAnimal(event);
  if (id !== null && id === followedId && banner.hidden) rewards.openClaim();
});
function pickedAnimal(event: MouseEvent | PointerEvent): string | null {
  pointer.x = (event.clientX / innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  raycaster.params.Points = { threshold: 6 };
  // A model under the cursor wins: an elephant's body is larger than any tap radius.
  for (const hit of raycaster.intersectObjects(animals.root.children, true)) {
    if (animals.isDots(hit.object)) continue;
    let node: THREE.Object3D | null = hit.object;
    while (node !== null && !store.animals.has(node.name) && !carcasses.has(node.name)) node = node.parent;
    if (node) return node.name;
  }
  // Otherwise the animal drawn nearest the tap, model or dot, within a finger's width.
  const rect = canvas.getBoundingClientRect();
  const positions = new Map<string, { x: number; y: number; z: number }>();
  const now = performance.now();
  for (const id of store.animals.keys()) {
    const p = animals.positionOf(id, now);
    if (p !== null) positions.set(id, { x: p.x, y: renderBaseY(p, animals.groundHeightAt) + visualFor(store.animals.get(id)!.speciesId).heightM * 0.5, z: p.z });
  }
  return nearestOnScreen(positions, camera, event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height,
    event instanceof PointerEvent && event.pointerType === 'touch' ? 36 : 22);
}

// Explore lets go and rises to a wide view, so the button always shows the island around you.
// Clean view for screenshots, streams and trailers: H toggles it, ?cinema=1 starts in it.
const showInterface = document.querySelector<HTMLButtonElement>('#show-interface')!;
function setCleanView(on: boolean): void {
  document.body.classList.toggle('clean-view', on);
  observerChrome.setCinema(on);
  document.body.classList.remove('interface-poked');
  animals.markersVisible = !on;
}
// Touch screens have no H key: in clean view a tap shows "Show interface" for a few seconds.
let pokedTimer: number | null = null;
addEventListener('pointerdown', () => {
  if (!document.body.classList.contains('clean-view')) return;
  document.body.classList.add('interface-poked');
  if (pokedTimer !== null) clearTimeout(pokedTimer);
  pokedTimer = window.setTimeout(() => { document.body.classList.remove('interface-poked'); }, 4000);
}, { capture: true });
showInterface.addEventListener('click', () => { setCleanView(false); canvas.focus(); });
if (new URLSearchParams(location.search).has('cinema')) setCleanView(true);
addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 'h' || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
  setCleanView(!document.body.classList.contains('clean-view'));
});

// On-screen camera pad. Holding a button keeps turning, tilting or zooming until released.
const cameraActions: Record<string, () => void> = {
  'rotate-left': () => follow.rotateBy(-0.05), 'rotate-right': () => follow.rotateBy(0.05),
  'tilt-up': () => follow.tiltBy(0.035), 'tilt-down': () => follow.tiltBy(-0.035),
  'zoom-in': () => follow.zoomBy(1 / 1.06), 'zoom-out': () => follow.zoomBy(1.06),
};
for (const button of document.querySelectorAll<HTMLButtonElement>('#view-settings [data-camera]')) {
  const action = button.dataset.camera!;
  if (action === 'reset') { button.addEventListener('click', () => follow.resetView()); continue; }
  let timer: number | null = null;
  const stop = (): void => { if (timer !== null) { clearInterval(timer); timer = null; } };
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault(); button.setPointerCapture(event.pointerId);
    cameraActions[action]!(); stop(); timer = window.setInterval(cameraActions[action]!, 30);
  });
  for (const end of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(end, stop);
  // Keyboard users: one step per Enter or Space.
  button.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); for (let i = 0; i < 4; i++) cameraActions[action]!(); }
  });
}

document.querySelector('#freecam')!.addEventListener('click', () => {
  watch(null);
  if (follow.distance < EXPLORE_DISTANCE_M) follow.flyToDistance(EXPLORE_DISTANCE_M);
  canvas.focus();
});
const speciesPicker = document.querySelector<HTMLSelectElement>('#species-picker')!;
for (const id of Object.keys(SPECIES_VISUALS)) {
  const option = document.createElement('option');
  option.value = id;
  option.textContent = id;
  speciesPicker.append(option);
}
speciesPicker.addEventListener('change', () => {
  const animal = [...store.animals.values()].find((a) => a.speciesId === speciesPicker.value);
  if (animal) watch(animal.id); // watch() leaves any replay; the picker keeps focus.
});

// Family members and teachers in the passport are links: follow them.
const historyDialog = new LazyDialog<[string]>('animal history', observerUiStatus, async () => {
  const { createHistoryDialog } = await import('./history.js');
  return createHistoryDialog((id, eventId, kind) => { void startReplay(id, eventId, kind); });
});
const shareDialog = new LazyDialog<[string]>('share story', observerUiStatus, async () => {
  const { createShareDialog } = await import('./shareStory.js');
  return createShareDialog();
});
document.querySelector('#passport')!.addEventListener('click', (event) => {
  const shareButton = (event.target as HTMLElement).closest<HTMLElement>('[data-share]');
  if (shareButton) {
    void shareDialog.open(shareButton.dataset.share!);
    return;
  }
  const historyButton = (event.target as HTMLElement).closest<HTMLElement>('[data-history]');
  if (historyButton) { void historyDialog.open(historyButton.dataset.history!); return; }
  const replayButton = (event.target as HTMLElement).closest<HTMLElement>('[data-replay]');
  if (replayButton !== null) {
    void startReplay(replayButton.dataset.replay!);
    return;
  }
  if ((event.target as HTMLElement).closest('[data-dismiss-recap]') !== null) {
    hud.recap = null;
    hud.render(followedId);
    return;
  }
  const link = (event.target as HTMLElement).closest<HTMLElement>('[data-follow]');
  if (link === null) return;
  event.preventDefault();
  watch(link.dataset.follow ?? null);
});
setInterval(() => { void hud.refreshPassport(followedId).then(() => hud.render(followedId)); }, 5000);

connect();
store.onChange(() => {
  refreshSpeciesOptions(speciesPicker.options, store.world?.population);
  const speed = store.world?.worldHoursPerRealHour;
  if (speed !== undefined) animals.tracker.setWorldSpeed(speed);
  hud.render(followedId);
  if (followedId === null || store.world === null) return;
  // Never advance durable-history memory using a newer, rollback-prone live world frame.
  const passport = hud.passport?.id === followedId ? hud.passport : null;
  const now = passport?.asOfWorldTime;
  if (now === undefined || passport?.nextEventSequence === undefined) return;
  if (recapPending === followedId) {
    const cursor = lastSeen.cursor(followedId);
    if (worthRecapping(cursor?.worldTime ?? null, now)) {
      if (!recapLoading && performance.now() >= recapRetryAt) {
        recapLoading = true;
        const revision = followRevision, id = followedId;
        void hud.loadRecap(id, cursor!.worldTime, now, cursor!.nextSequence).then((ok) => {
          if (revision !== followRevision) return;
          recapLoading = false;
          if (ok) { recapPending = null; lastSeen.mark(id, ok.worldTime, ok.nextSequence); }
          else recapRetryAt = performance.now() + 10_000;
          hud.render(followedId);
        });
        hud.render(followedId);
      }
      // Failed/in-flight retrieval must not erase the old cursor and silently lose the recap.
      return;
    }
    recapPending = null;
  }
  lastSeen.mark(followedId, now, passport.nextEventSequence);
});
void hud.refreshFeed();
setInterval(() => { void hud.refreshFeed(); }, 10_000);
// TypeSafe AI estimates (server-side, optional): highlights above the feed and the followed
// animal's likely next hour. Answers are cached per checkpoint, so polling costs no calls.
void insightPanel.highlights();
setInterval(() => {
  void insightPanel.highlights();
  void insightPanel.outlook(followedId !== null && liveAgents.avatarForAnimal(followedId) ? null : followedId);
}, 30_000);

// Dev-only handle so the running world can be inspected from the console.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__vana = { scene, camera, follow, animals, store, liveEncounters, startReplay };
}

const renderStats = document.querySelector<HTMLOutputElement>('#render-stats')!;
renderStats.hidden = !new URLSearchParams(location.search).has('stats');
let statsStarted = performance.now(); let statsFrames = 0;
const drawingSize = new THREE.Vector2();
let observerSubjects: ObserverSubject[] = [];
function observerSubject(speciesId: string, position: { x: number; z: number; altitudeM?: number }, size = 1): ObserverSubject {
  const height = visualFor(speciesId).heightM * size;
  return { x: position.x, y: renderBaseY(position, animals.groundHeightAt) + height * 0.5,
    z: position.z, radius: Math.max(0.35, height * 1.25) };
}
/** The live scene's animals for the ambient audio this frame; none during a replay. */
let audioSubjects: ReadonlyMap<string, AnimalState> | null = null;
/** Drawn animals whose saved or recorded state has a call (ambientAudio.ts), with positions.
 * Agent-steered animals are left out: only the simulation's own recorded states may call. */
function audibleAnimals(): AudioAnimal[] {
  const result: AudioAnimal[] = [];
  if (!audioSubjects) return result;
  const now = performance.now();
  for (const [id, animal] of audioSubjects) {
    if (!cueFor(animal.speciesId, animal.state) || liveAgents.avatarForAnimal(id)) continue;
    const position = animals.positionOf(id, now);
    if (!position) continue;
    result.push({ id, speciesId: animal.speciesId, state: animal.state, x: position.x,
      y: renderBaseY(position, animals.groundHeightAt) + visualFor(animal.speciesId).heightM * 0.5, z: position.z });
  }
  return result;
}
function renderFrame(dt: number, now: number): void {
  if (store.world) ambientAudio.sample(store.world.season, mapPatches, camera, animals.groundHeightAt, now, wind.state, audibleAnimals);
  // A season can turn without a patch change; the update is a cheap no-op otherwise.
  if (store.world && store.world.season !== tintSeason) { tintSeason = store.world.season; groundTint.update(mapPatches, tintSeason); }
  // Use the settled camera, not the followed animal or the previous frame's target.
  // Otherwise zooming/panning leaves the viewer outside the detail island.
  if (nature !== null && terrainRoot !== null) {
    if (nature.update(camera.position, camera)) {
      hideFarFieldNear(terrainRoot, camera.position, NEAR_RADIUS_M,
        nature.hasTreeLod ? Number.POSITIVE_INFINITY : TREE_DETAIL_RADIUS_M, COVER_RADIUS_M - 12);
    }
    nature.setDistantLight(store.world ? atmosphereAt(liveWorldTime(now)!, store.world.season).daylight : 1);
  }
  groundCover?.update(camera.position, 2);
  communityLayer.update(dt, camera.position, quality.tier, reducedMotion.matches, now, followedPersonId);
  const communityText = communityLayer.playbackNotice(now, reducedMotion.matches);
  if (communityMotionNotice.textContent !== communityText) communityMotionNotice.textContent = communityText;
  communityMotionNotice.hidden = !communityText;
  observerVisibility.update(camera, renderer.getDrawingBufferSize(drawingSize), revealAnimal.checked ? observerSubjects : []);
  prepareShadows(performance.now());
  renderer.render(scene, camera);
  if (renderStats.hidden) return;
  statsFrames++;
  const elapsed = performance.now() - statsStarted;
  if (elapsed < 1000) return;
  renderStats.textContent = `${Math.round(statsFrames * 1000 / elapsed)} fps · ${quality.tier} · ${drawingSize.x}×${drawingSize.y} · ${renderer.info.render.calls} draws · ${(renderer.info.render.triangles / 1e6).toFixed(2)}M triangles`;
  statsStarted = performance.now(); statsFrames = 0;
}
const frameAnimals = new Map<string, AnimalState>();
function frame(): void {
  requestAnimationFrame(frame);
  const now = performance.now();
  const elapsedMs = pacer.next(now, document.hidden || experienceViewPaused);
  if (experienceViewPaused) return;
  if (elapsedMs === null) return;
  if (elapsedMs > 0 && quality.sample(elapsedMs)) applyQuality();
  const dt = Math.min(elapsedMs / 1000, 0.1);
  observerSubjects = [];
  humanLabel.hidden = true;
  follow.reducedMotion = reducedMotion.matches;
  refreshEncounterPicker(now);
  if (store.world !== null) {
    const shownTime = liveWorldTime(now)!;
    atmosphere.update(shownTime, store.world.season, now / 1000, follow.target, reducedMotion.matches, follow.distance, camera.position);
    renderer.toneMappingExposure = observerExposure(atmosphereAt(shownTime, store.world.season).daylight, follow.distance);
  }

  // Grass, leaves, branches and the wind channel share one presentation-only wind (wind.ts).
  if (store.world !== null) wind.update(liveWorldTime(now)!, store.world.season, now / 1000, reducedMotion.matches);

  communityLayer.setReplay(replay !== null);
  if (replay !== null) {
    audioSubjects = null; // Replayed actions are the past: no calls for them.
    rewards.position(0, 0, false);
    encounterNotice.hidden = true;
    for (const label of liveLabels) label.hidden = true;
    const { life, encounter, climb, clock: playback } = replay;
    playback.tick(dt * 1000);
    const progress = playback.progress;
    if (encounter) {
      const seconds = huntReplaySeconds(encounter.trace, encounter.outcome) * progress;
      const points = encounterAt(encounter.trace, seconds);
      const drives = { hunger: 0, thirst: 0, fatigue: 0, fear: 0 }; // Rendering input only; no drive UI in encounter mode.
      // The replay runs recorded time 1:1, so an act's real time is its recorded time.
      const moment = huntMoment(encounter.trace, encounter.outcome, seconds,
        { phase: points.phase, predatorMoving: points.predator.moving, preyMoving: points.prey.moving, finished: points.finished },
        (recorded) => seconds - recorded);
      const predatorAt = moment.facePrey ? { ...points.predator,
        heading: Math.atan2(points.prey.x - points.predator.x, points.prey.z - points.predator.z) } : points.predator;
      animals.syncReplayGroup([
        { animal: { id: encounter.trace.predatorId, speciesId: encounter.predatorSpecies, patchId: 0,
          state: moment.predator.state, currentGoal: '', drives }, position: predatorAt,
          ...(moment.predator.act === undefined ? {} : { act: moment.predator.act }) },
        { animal: { id: encounter.trace.preyId, speciesId: encounter.preySpecies, patchId: 0,
          state: moment.prey.state, currentGoal: '', drives }, position: points.prey,
          ...(moment.prey.act === undefined ? {} : { act: moment.prey.act }),
          ...(moment.prey.weight === undefined ? {} : { actWeight: moment.prey.weight }) },
      ], seconds);
      observerSubjects = [observerSubject(encounter.predatorSpecies, points.predator), observerSubject(encounter.preySpecies, points.prey)];
      // Keeping both framed aims between them; without it, the camera stays on the animal whose
      // replay this is, so a long stalk is not filmed from far off, looking at the grass between.
      const subject = replay.life.id === encounter.trace.preyId ? points.prey : predatorAt;
      const x = replayAutoFrame.checked ? (points.predator.x + points.prey.x) / 2 : subject.x;
      const z = replayAutoFrame.checked ? (points.predator.z + points.prey.z) / 2 : subject.z;
      if (replayAutoFrame.checked) {
        const gap = Math.hypot(points.predator.x - points.prey.x, points.predator.z - points.prey.z);
        const desired = Math.max(12, gap / (2 * Math.tan(camera.fov * Math.PI / 360) * Math.min(PAIR_FRAME_ASPECT, camera.aspect)) * 1.25 + 8);
        follow.distance += (desired - follow.distance) * (playback.paused || reducedMotion.matches ? 1 : Math.min(1, dt * 3));
      }
      follow.follow({ x, z, heading: 0, moving: false, y: animals.groundHeightAt(x, z) }, playback.paused || reducedMotion.matches ? 1 : dt);
      replayWhen.textContent = `${encounter.trace.predatorId} / ${encounter.trace.preyId} · +${seconds.toFixed(1)}s`;
      replayMoment.textContent = `${points.phase}${points.finished ? ` · recorded outcome: ${encounter.outcome}` : ''}`;
      replaySeek.setAttribute('aria-valuetext', `${seconds.toFixed(1)} seconds, ${points.phase}`);
    } else if (climb) {
      const seconds = climb.trace.samples.at(-1)!.seconds * progress;
      const position = movementAt(climb.trace, seconds);
      const drives = { hunger: 0, thirst: 0, fatigue: 0, fear: 0 }; // The route has no recorded drive series.
      animals.syncReplay({ id: life.id, speciesId: life.speciesId, patchId: climb.trace.destinationPatchId,
        state: position.moving ? 'travelling' : 'resting', currentGoal: climb.trace.goal, drives }, position, seconds,
        recordedClimbPhase(climb.trace, seconds));
      observerSubjects = [observerSubject(life.speciesId, position)];
      // An upright climber's body rises above its hind feet: aim at the body, not the bark below it.
      const climbing = recordedClimbPhase(climb.trace, seconds) !== null;
      follow.follow({ ...position, moving: !playback.paused && position.moving,
        y: renderBaseY(position, animals.groundHeightAt), ...(climbing ? { focusHeight: visualFor(life.speciesId).heightM * 1.4 } : {}) },
        playback.paused || reducedMotion.matches ? 1 : dt);
      const moment = climbMoment(climb, seconds);
      replayMoment.textContent = moment;
      replayWhen.textContent = `${life.id} · +${seconds.toFixed(1)}s`;
      replaySeek.setAttribute('aria-valuetext', `${seconds.toFixed(1)} seconds, ${moment}`);
    } else {
      const playhead = life.track[0]!.worldTime + (life.track.at(-1)!.worldTime - life.track[0]!.worldTime) * progress;
      const point = pointAt(life.track, life.id, playhead);
      // The clip runs on the replay's own clock: a whole life compressed into minutes would
      // otherwise spin the walk and graze cycles thousands of times faster than life.
      animals.syncReplay({ id: life.id, speciesId: life.speciesId, patchId: 0, state: point.state, currentGoal: '', drives: point.drives }, point, playback.elapsedMs / 1000);
      observerSubjects = [observerSubject(life.speciesId, point)];
      follow.follow({ ...point, moving: !playback.paused && point.moving, y: renderBaseY(point, animals.groundHeightAt) }, playback.paused || reducedMotion.matches ? 1 : dt);
      replayMoment.textContent = momentAt(life.moments, playhead)?.text ?? '';
      replayWhen.textContent = `${life.id} · ${dayOf(playhead)}`;
      replaySeek.setAttribute('aria-valuetext', dayOf(playhead));
    }
    animals.update(playback.paused ? 0 : dt * playback.speed);
    replaySeek.value = String(Math.round(progress * 1000));
    replayPlay.textContent = playback.paused ? progress >= 1 ? 'Replay again' : 'Play' : 'Pause';
    const status = `${playback.paused ? progress >= 1 ? 'Finished' : 'Paused' : 'Playing'} · ${encounter ? 'paired server recording' : climb ? 'saved tree route' : 'sampled life record'}`;
    if (replayStatus.textContent !== status) replayStatus.textContent = status;
    bubble.show(undefined, null);
    renderFrame(dt, now);
    return;
  }

  // One map reused every frame: copying thousands of animals through spread arrays, twice a
  // frame, was garbage the collector had to sweep up while the forest was drawing.
  const visibleAnimals = frameAnimals; visibleAnimals.clear();
  for (const [id, carcass] of carcasses) visibleAnimals.set(id, carcass);
  for (const [id, animal] of store.animals) visibleAnimals.set(id, animal);
  audioSubjects = visibleAnimals;
  const poses = liveEncounters.poses(now, reducedMotion.matches);
  // An agent's animal moves where its agent steers it, live; that wins over any recording.
  for (const [id, pose] of liveAgents.poses(now, visibleAnimals)) poses.set(id, pose);
  liveAgents.animate(now / 1000);
  for (const [id, pose] of poses) {
    const current = visibleAnimals.get(id);
    // Older retained hours predate recorded sex/life-stage fields. Use a same-species
    // live identity only for missing visual metadata; route, state, outcome and body
    // size still come exclusively from the recorded pose.
    visibleAnimals.set(id, withRecordedVisualIdentity(pose.animal, current));
  }
  const followedEncounter = followedId === null ? undefined : poses.get(followedId);
  // Only a hunt in progress earns a line on the card; ordinary movement is just what you see.
  const hunting = followedEncounter !== undefined && followedEncounter.kind !== 'movement';
  encounterNotice.hidden = !hunting;
  const encounterShort = hunting ? `Hunt in progress · ${followedEncounter!.phase}` : '';
  const encounterText = hunting ? 'Both animals move on one shared timeline from the server; poses are illustrative.' : '';
  if (encounterNotice.textContent !== encounterShort) { encounterNotice.textContent = encounterShort; encounterNotice.title = encounterText; }
  animals.avoid = nature?.obstacles ?? null;
  animals.people = communityLayer.placedPeople;
  animals.sync(visibleAnimals, now, followedId, { x: follow.target.x, z: follow.target.z }, poses);
  animals.update(dt);

  if (followedId !== null) {
    const position = animals.positionOf(followedId, now);
    if (position !== null) {
      const speciesId = store.animals.get(followedId)?.speciesId ?? carcasses.get(followedId)?.speciesId ?? '';
      observerSubjects = [observerSubject(speciesId, position, characterScale(visibleAnimals.get(followedId) ?? {}))];
      const partner = followedEncounter && livePairFrame.checked ? poses.get(followedEncounter.partnerId)?.position : undefined;
      if (partner) {
        const partnerAnimal = visibleAnimals.get(followedEncounter!.partnerId);
        if (partnerAnimal) observerSubjects.push(observerSubject(partnerAnimal.speciesId, partner, characterScale(partnerAnimal)));
        const gap = Math.hypot(position.x - partner.x, position.z - partner.z);
        const desired = Math.max(12, gap / (2 * Math.tan(camera.fov * Math.PI / 360) * Math.min(PAIR_FRAME_ASPECT, camera.aspect)) * 1.25 + 8);
        follow.distance += (desired - follow.distance) * Math.min(1, dt * 3);
        const x = (position.x + partner.x) / 2, z = (position.z + partner.z) / 2;
        follow.follow({ x, z, heading: position.heading, moving: false,
          y: Math.max(renderBaseY(position, animals.groundHeightAt), renderBaseY(partner, animals.groundHeightAt)) }, dt);
      } else follow.follow({ ...position, y: renderBaseY(position, animals.groundHeightAt),
        focusHeight: visualFor(speciesId).heightM * characterScale(visibleAnimals.get(followedId) ?? {}) * 0.5 }, dt);
    } else follow.hold(dt); // Not placed this frame: keep the last framing, but zoom and turns still work.
    // The bubble floats over the animal's head, projected into screen space.
    const head = position === null ? null
      : new THREE.Vector3(
        position.x,
        renderBaseY(position, animals.groundHeightAt) + bubbleHeight(visibleAnimals.get(followedId)),
        position.z,
      ).project(camera);
    bubble.show(
      followedEncounter ? undefined : store.animals.get(followedId),
      head === null || head.z > 1 ? null : { x: (head.x + 1) / 2 * innerWidth, y: (1 - head.y) / 2 * innerHeight },
    );
    rewards.position(head ? (head.x + 1) / 2 * innerWidth : 0, head ? (1 - head.y) / 2 * innerHeight - 50 : 0,
      head !== null && head.z >= -1 && head.z <= 1 && Math.abs(head.x) < .9 && Math.abs(head.y) < .85,
      visibleAnimals.get(followedId)?.state === 'dead');
  } else {
    rewards.position(0, 0, false);
    const person = followedPersonId === null ? null : communityLayer.positionOf(followedPersonId, now, reducedMotion.matches);
    if (person) {
      follow.follow({ ...person, focusHeight: person.alive ? 1.1 * person.scale : .2 }, reducedMotion.matches ? 1 : dt);
      observerSubjects = [{ x: person.x, y: person.y + (person.alive ? .9 * person.scale : .2), z: person.z, radius: 1.5 * person.scale }];
      const head = new THREE.Vector3(person.x, person.y + (person.alive ? 2 * person.scale : .5), person.z).project(camera);
      humanLabel.hidden = head.z < -1 || head.z > 1 || Math.abs(head.x) > 1 || Math.abs(head.y) > 1;
      // Browsing a person's history is explicitly the past; otherwise they are simply there.
      const text = communityLayer.showingHistoricFrame ? `${person.name} · saved hourly movement` : person.name;
      if (humanLabel.textContent !== text) humanLabel.textContent = text;
      humanLabel.style.left = `${Math.max(82, Math.min(innerWidth - 82, (head.x + 1) / 2 * innerWidth))}px`;
      humanLabel.style.top = `${Math.max(30, (1 - head.y) / 2 * innerHeight)}px`;
    } else { followedPersonId = null; follow.freeLook(dt); }
    bubble.show(undefined, null);
  }
  sun.target.updateMatrixWorld();

  // Labels locate recorded actors even when dense decorative canopy occludes their models.
  // They do not claim that the animal is visible, and are not per-frame live announcements.
  [followedId, followedEncounter?.partnerId].forEach((id, index) => {
    const label = liveLabels[index]!;
    const pose = followedEncounter && id ? poses.get(id) : undefined;
    if (!pose) { label.hidden = true; return; }
    const p = new THREE.Vector3(pose.position.x,
      renderBaseY(pose.position, animals.groundHeightAt) + bubbleHeight(pose.animal), pose.position.z).project(camera);
    label.hidden = p.z < -1 || p.z > 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1;
    const species = SPECIES_LABEL[pose.animal.speciesId] ?? pose.animal.speciesId.replace(/^./, (c) => c.toUpperCase());
    const avatar = liveAgents.avatarForAnimal(pose.animal.id);
    const text = avatar ? `${avatar.name} · ${species} · ${activityOf(avatar)}` : `${species} · ${ACTIVITY_LABEL[pose.animal.state] ?? pose.animal.state}`;
    if (label.textContent !== text) label.textContent = text;
    let x = Math.max(82, Math.min(innerWidth - 82, (p.x + 1) / 2 * innerWidth)), y = Math.max(30, (1 - p.y) / 2 * innerHeight);
    const first = liveLabels[0]!;
    if (index === 1 && !first.hidden && !label.hidden) {
      ({ x, y } = stackLabels({ x: parseFloat(first.style.left), y: parseFloat(first.style.top), width: first.offsetWidth, height: first.offsetHeight },
        { x, y, width: label.offsetWidth, height: label.offsetHeight }));
    }
    label.style.left = `${x}px`;
    label.style.top = `${y}px`;
  });

  drawAgentTags(now);
  sendView();
  hud.tickClock();
  renderFrame(dt, now);
}


// ---- AI agents: name tags over their animals, and the agents chip in the top bar ----------

/** Tells the server where the camera looks, so it sends the agents there; at most once a second. */
let viewSentAt = 0, viewSent: { x: number; z: number; radius: number } | null = null;
function sendView(force = false): void {
  // Before a scene is drawn the camera is at its default spot, not where the viewer looks; on a
  // regional world that would load (and then, ten seconds later, unload) a far corner (Congo 1A.4).
  if (socket?.readyState !== WebSocket.OPEN || terrainRoot === null) return;
  const now = performance.now();
  const view = { x: follow.target.x, z: follow.target.z, radius: Math.min(1500, Math.max(300, follow.distance * 2.5 + 200)) };
  const moved = !viewSent || Math.hypot(view.x - viewSent.x, view.z - viewSent.z) > 25 || Math.abs(view.radius - viewSent.radius) > viewSent.radius * 0.2;
  if (!force && (!moved || now - viewSentAt < 1000)) return;
  viewSentAt = now; viewSent = view;
  socket.send(JSON.stringify({ type: 'view', x: Math.round(view.x), z: Math.round(view.z), radius: Math.round(view.radius) }));
}

const agentTags: HTMLElement[] = [];
const tagPoint = new THREE.Vector3();
/** Names over the nearest agents' animals (the followed one already has its own label). */
function drawAgentTags(now: number): void {
  const eye = camera.position;
  const near = [...liveAgents.positions(now).values()].filter((p) => p.avatar.animalId !== followedId)
    .map((p) => ({ p, d: Math.hypot(p.x - eye.x, p.z - eye.z) })).filter((e) => e.d < 450)
    .sort((a, b) => a.d - b.d).slice(0, 12);
  while (agentTags.length < near.length) {
    const tag = document.createElement('div'); tag.className = 'agent-tag'; tag.hidden = true;
    document.body.append(tag); agentTags.push(tag);
  }
  agentTags.forEach((tag, i) => {
    const entry = near[i];
    if (!entry) { tag.hidden = true; return; }
    const { p } = entry;
    tagPoint.set(p.x, animals.groundHeightAt(p.x, p.z) + visualFor(p.avatar.speciesId).heightM + 0.9, p.z).project(camera);
    tag.hidden = tagPoint.z < -1 || tagPoint.z > 1 || Math.abs(tagPoint.x) > 1 || Math.abs(tagPoint.y) > 1;
    const key = `${p.avatar.name}\n${p.avatar.said ?? ''}`;
    if (tag.dataset.key !== key) {
      tag.dataset.key = key;
      // Another player's words: set as text, never as markup.
      const name = document.createElement('b'); name.textContent = p.avatar.name;
      if (p.avatar.said) { const line = document.createElement('span'); line.className = 'said'; line.textContent = p.avatar.said; tag.replaceChildren(name, line); }
      else tag.replaceChildren(name);
    }
    tag.style.left = `${(tagPoint.x + 1) / 2 * innerWidth}px`;
    tag.style.top = `${(1 - tagPoint.y) / 2 * innerHeight}px`;
  });
}

const agentsChip = document.querySelector<HTMLButtonElement>('#live-agents')!;
const agentsList = document.querySelector<HTMLElement>('#agents-list')!;
let agentsListKey = '';
/** Who is playing and which drops are out, with a way to go and look. Built from text nodes. */
function renderAgentsChip(): void {
  const avatars = liveAgents.roster, drops = liveAgents.drops;
  agentsChip.hidden = avatars.length === 0 && drops.length === 0;
  if (agentsChip.hidden) { agentsList.hidden = true; agentsChip.setAttribute('aria-expanded', 'false'); return; }
  const summary = `${avatars.length} agent${avatars.length === 1 ? '' : 's'} · ${drops.length} drop${drops.length === 1 ? '' : 's'}`;
  if (agentsChip.textContent !== summary) agentsChip.textContent = summary;
  const key = JSON.stringify([avatars.map((a) => [a.agentId, a.name, a.speciesId, rosterActivity(a)]), drops.map((d) => [d.id, d.amountMicro, !!d.spotted])]);
  if (key !== agentsListKey) {
    agentsListKey = key;
    const rows: HTMLElement[] = [];
    const row = (title: string, note: string, label: string, data: Record<string, string>, cls = '') => {
      const r = document.createElement('div'); r.className = `agent-row ${cls}`;
      const span = document.createElement('span'); span.textContent = title;
      const small = document.createElement('small'); small.textContent = note; span.append(small);
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      Object.assign(button.dataset, data);
      r.append(span, button); rows.push(r);
    };
    for (const a of avatars.slice(0, 200)) row(a.name, `${SPECIES_LABEL[a.speciesId] ?? a.speciesId.replace(/^./, (c) => c.toUpperCase())} · ${rosterActivity(a)}`, 'Follow', { followAnimal: a.animalId });
    for (const d of drops) row(`${usdc(d.amountMicro)} USDC drop`, d.spotted ? 'spotted: race to open it' : 'somewhere in the gold circle', 'Look', { lookDrop: d.id }, 'drop-row');
    agentsList.replaceChildren(...rows);
  }
  if (!agentsList.hidden) placeAgentsList();
}
function placeAgentsList(): void {
  const r = agentsChip.getBoundingClientRect();
  agentsList.style.top = `${Math.round(r.bottom + 6)}px`;
  agentsList.style.left = `${Math.round(Math.max(12, Math.min(r.left, innerWidth - 292)))}px`;
}
setInterval(renderAgentsChip, 1000);
// The way in for agents, shown only when this island takes them.
void fetch('/api/agents/info', { cache: 'no-store' }).then((r) => {
  if (r.ok) document.querySelector<HTMLElement>('#connect-agent')!.hidden = false;
}).catch(() => undefined);
// Challenges, shown only when this island runs them.
void fetch('/api/challenges/info', { cache: 'no-store' }).then((r) => {
  if (r.ok) document.querySelector<HTMLElement>('#challenges-link')!.hidden = false;
}).catch(() => undefined);
agentsChip.addEventListener('click', () => {
  agentsList.hidden = !agentsList.hidden;
  agentsChip.setAttribute('aria-expanded', String(!agentsList.hidden));
  if (!agentsList.hidden) placeAgentsList();
});
addEventListener('resize', () => { if (!agentsList.hidden) placeAgentsList(); });
// Like any dropdown: a press elsewhere or Escape closes it (Escape returns focus to the chip).
function closeAgentsList(returnFocus = false): void {
  if (agentsList.hidden) return;
  agentsList.hidden = true; agentsChip.setAttribute('aria-expanded', 'false');
  if (returnFocus) agentsChip.focus();
}
document.addEventListener('pointerdown', (event) => {
  const target = event.target as Node | null;
  if (target && !agentsList.contains(target) && !agentsChip.contains(target)) closeAgentsList();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeAgentsList(!agentsList.hidden); });
agentsList.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const animal = target.closest<HTMLElement>('[data-follow-animal]')?.dataset.followAnimal;
  if (animal) {
    // It may be far from the camera, so not yet in the live stream: fly there first.
    const at = liveAgents.roster.find((a) => a.animalId === animal);
    if (at) follow.target.set(at.x, animals.groundHeightAt(at.x, at.z), at.z);
    watch(animal); sendView(true);
    closeAgentsList();
    return;
  }
  const dropId = target.closest<HTMLElement>('[data-look-drop]')?.dataset.lookDrop;
  const drop = dropId ? liveAgents.drops.find((d) => d.id === dropId) : undefined;
  if (drop) {
    watch(null);
    const at = drop.spotted ?? drop.hint;
    follow.target.set(at.x, animals.groundHeightAt(at.x, at.z), at.z);
    follow.flyToDistance(drop.spotted ? 40 : drop.hint.radius * 3);
    closeAgentsList();
  }
});

// Start looking at the middle of the world until the first animal is followed.
follow.target.set(3000, 0, 3000);
follow.distance = 900;
frame();

addEventListener('hashchange', () => {
  const id = animalFromHash(location.hash);
  if (id !== null) watch(id);
});

// Same-origin experience pages may guide the observer and capture its actual rendered scene.
// No external window can invoke this bridge; all actor/event references remain bounded.
let experienceCapture: CaptureHandle | null = null;
let experienceCaptureStarting = false, experienceCaptureGeneration = 0;
let experienceCanCapture = false;
const experienceEmbed = new URLSearchParams(location.search).get('embed') === 'experiences';
const experienceReply = (data: unknown, transfer: Transferable[] = []) => {
  if (experienceEmbed && parent !== window) parent.postMessage({ ...(data as Record<string, unknown>), session: new URLSearchParams(location.search).get('experienceSession') ?? '' }, location.origin, transfer);
};
async function experienceReady(): Promise<void> {
  const params = new URLSearchParams(location.hash.slice(1)), id = animalFromHash(location.hash), event = params.get('event'), kind = params.get('kind');
  if (id && event && /^[a-zA-Z0-9_-]{1,128}$/.test(event) && ['hunt', 'climb'].includes(kind ?? '')) {
    await startReplay(id, event, kind === 'climb' ? 'climb' : 'encounter');
    if (!replay) { experienceReply({ type: 'wildsentia:capture-error', message: 'The selected recording is unavailable.' }); return; }
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  const readyUntil = performance.now() + 15_000;
  while (animals.pendingModelCount > 0 && performance.now() < readyUntil) await new Promise(resolve => setTimeout(resolve, 250));
  if (animals.pendingModelCount > 0) { experienceReply({ type:'wildsentia:capture-error', message:'Animal models are still loading. Reopen the preview and try again.' }); return; }
  experienceCanCapture = true;
  experienceReply({ type: 'wildsentia:ready' });
}
if (experienceEmbed) addEventListener('message', async (event: MessageEvent) => {
  if (event.origin !== location.origin || event.source !== parent || !event.data || typeof event.data !== 'object') return;
  const data = event.data as Record<string, unknown>;
  if (data.type === 'wildsentia:visibility' && typeof data.visible === 'boolean') { experienceViewPaused = !data.visible; return; }
  if (data.type === 'wildsentia:follow' && isAnimalLinkId(data.animalId)) { watch(data.animalId); return; }
  if (data.type === 'wildsentia:cancel-capture') { ++experienceCaptureGeneration; experienceCapture?.cancel(); return; }
  if (data.type !== 'wildsentia:capture' || !experienceCanCapture || data.session !== new URLSearchParams(location.search).get('experienceSession') || experienceCapture || experienceCaptureStarting || ![15,20,30].includes(Number(data.duration))
    || !['title','caption','context'].every(k => typeof data[k] === 'string' && (data[k] as string).length <= 500)) return;
  experienceCaptureStarting = true;
  const generation = ++experienceCaptureGeneration;
  try {
    const shared = new URLSearchParams(location.hash.slice(1)), eventId = shared.get('event'), actorId = animalFromHash(location.hash);
    if (eventId && actorId) {
      // The embedded viewer has its own replay picker; recording must return to the
      // exact shared event so its caption cannot describe different footage.
      await startReplay(actorId, eventId, shared.get('kind') === 'climb' ? 'climb' : 'encounter');
      if (!replay) throw new Error('selected recording unavailable');
    }
    if (generation !== experienceCaptureGeneration || experienceViewPaused || document.hidden) throw new Error('capture cancelled');
    if (replay?.encounter || replay?.climb) {
      replay.clock.speed = 1;
      replay.clock.seek(highlightStart(replay.clock.durationMs, Number(data.duration)));
      replayAutoFrame.checked = false;
      follow.distance = followDistanceFor(replay.life.speciesId, visualFor(replay.life.speciesId).heightM);
      // Render the selected actor at the saved clip start before capture begins. Long
      // stalks remain honest recordings without a distant camera aimed between actors.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (generation !== experienceCaptureGeneration || experienceViewPaused || document.hidden) throw new Error('capture cancelled');
      replay.clock.play();
    }
    const handle = experienceCapture = captureHighlight(canvas, { duration: data.duration as 15|20|30, title: data.title as string, caption: data.caption as string, context: data.context as string });
    void handle.done.then(clip => experienceReply({ type:'wildsentia:clip', ...clip }, [clip.bytes]))
      .catch(() => experienceReply({ type:'wildsentia:capture-error', message:'Recording stopped or unavailable. Try again in a browser with video capture.' }))
      .finally(() => { if (experienceCapture === handle) experienceCapture = null; });
  } catch { experienceReply({ type:'wildsentia:capture-error', message:'Recording stopped or its selected replay is unavailable. Reopen the preview and try again.' }); }
  finally { experienceCaptureStarting = false; }
});
addEventListener('pagehide', () => experienceCapture?.cancel());

// Explicit shared links include dead/departed animals and take priority over local preferences.
const stop = store.onChange(() => {
  if (store.world === null) return;
  if (followRevision === 0) {
    const id = initialFollowId(location.hash, lastFollowed.get(), store.animals);
    if (id !== null) { follow.distance = 22; watch(id); }
  }
  stop();
  void experienceReady();
});
