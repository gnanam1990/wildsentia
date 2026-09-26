import * as THREE from 'three';
import { movementAt } from '@vana/shared';
import { WorldStore, type AnimalState } from './protocol.js';
import { createScene } from './scene.js';
import { hideFarFieldNear } from './terrain.js';
import { TerrainCheckpoints, type PreparedTerrain } from './terrainCheckpoints.js';
import { NEAR_RADIUS_M, TREE_DETAIL_RADIUS_M, NearVegetation } from './vegetation.js';
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
import { SPECIES_VISUALS, visualFor } from './species.js';
import { Atmosphere, atmosphereAt, observerExposure } from './environment.js';
import { groundTint } from './groundTint.js';
import { characterScale, markerSize } from './appearance.js';
import { LiveEncounterPlayer, withRecordedVisualIdentity } from './liveEncounters.js';
import { ObserverVisibility, type ObserverSubject } from './observerVisibility.js';
import { refreshSpeciesOptions } from './speciesPicker.js';
import { restoreFollowOnOpen } from './followSubscription.js';
import type { EventMap } from './eventMap.js';
import { EventVisit } from './eventVisit.js';
import { RewardObserver } from './rewards.js';
import { SceneUpdates } from './sceneUpdates.js';
import { AdaptiveQuality, qualityMode, RenderPacer } from './renderQuality.js';
import { MicroEcologyLayer } from './microEcologyLayer.js';
import { animalFromHash, initialFollowId } from './animalLink.js';
import { LazyDialog } from './lazyDialog.js';
import { renderBaseY } from './space.js';
import { AmbientAudio } from './ambientAudio.js';


/** Where the thought floats: just above the marker over this species' head. */
const bubbleHeight = (animal: AnimalState | undefined): number => {
  const height = animal === undefined ? 1 : visualFor(animal.speciesId).heightM;
  return (height + markerSize(height) * 1.6) * characterScale(animal ?? {});
};

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const { renderer, scene, camera, sun, setQuality, prepareShadows } = createScene(canvas);
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
  setAmbientUi(ambientAudio.enabled ? 'Sound on. Only current seasonal rain and nearby visible water.'
    : 'Sound unavailable or tab hidden. It remains off; try again after returning.');
});

const store = new WorldStore();
const liveEncounters = new LiveEncounterPlayer();
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
const revealAnimal = document.querySelector<HTMLInputElement>('#observer-cutaway')!;
const hud = new Hud({
  clock: document.querySelector('#clock')!,
  season: document.querySelector('#season')!,
  population: document.querySelector('#population')!,
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
  id => { void personHistoryDialog.open(id); });
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
  } else void personHistoryDialog.open(id);
}
const communityDialog = new LazyDialog<[]>('community observer', observerUiStatus, async () => {
  const { createCommunityDialog } = await import('./communityObserver.js');
  return createCommunityDialog((position, distance) => {
    watch(null);
    follow.target.set(position.x, animals.groundHeightAt(position.x, position.z), position.z);
    follow.distance = distance;
    canvas.focus();
  }, id => { void personHistoryDialog.open(id); }, id => watchSavedPerson(id));
});
const personHistoryDialog = new LazyDialog<[string]>('person history', observerUiStatus, async () => {
  const { createPersonHistoryDialog } = await import('./personHistory.js');
  return createPersonHistoryDialog(() => {
    document.querySelector<HTMLButtonElement>('#open-community')?.focus();
    void communityDialog.open();
  }, frame => {
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
  connection.addEventListener('message', (event) => {
    if (socket !== connection) return;
    try {
      const message: unknown = JSON.parse(String(event.data));
      if (typeof message === 'object' && message !== null && 'type' in message) {
        if (message.type === 'scene') {
          if (!sceneUpdates.receive(message, performance.now())) connection.close();
        } else if (message.type === 'viewers' || message.type === 'error') store.apply(message);
        else if (message.type === 'heartbeat') return;
        else connection.close(); // Incompatible split-state protocol: never mix generations.
      }
    } catch {
      // A malformed frame must not take down the render loop.
    }
  });
  connection.addEventListener('close', () => {
    if (socket !== connection) return;
    sceneUpdates.reset(); liveEncounters.clear(); setTimeout(connect, 2000);
  });
}

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
    recordingPicker.value = kind === 'climb' && climbs.length ? 'climb:0'
      : selected >= 0 ? String(selected) : life.track.length ? 'life' : '0';
    selectRecording();
    replayPlay.focus();
  } catch (error) {
    if (request !== replayRequest) return;
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
  const span = e ? e.trace.samples.at(-1)!.seconds : climb ? climb.trace.samples.at(-1)!.seconds
    : replay.life.track.at(-1)!.worldTime - replay.life.track[0]!.worldTime;
  replay.clock = new ReplayClock(e || climb ? Math.max(1, span * 1000) : replayDurationMs(span));
  replay.clock.speed = Number(replaySpeed.value);
  replaySeek.value = '0'; replayPlay.textContent = 'Play';
  replayStatus.textContent = e ? 'Paused · paired server recording' : climb ? 'Paused · single-animal saved tree route'
    : `Paused · ${replay.records.length} recent paired encounters available`;
  banner.querySelector('.precision')!.textContent = e
    ? `Event ${e.eventId}. Both actors share recorded timestamps. Paths are linearly interpolated; poses/body variants are illustrative. Terrain and weather are current, not historical.`
    : climb ? `Event ${climb.eventId}. Position, altitude and timing come from one retained route; no height is inferred from sparse life samples. ${climb.verticalDistanceM > 0 ? 'Climb pose is illustrative; local rigs have no climbing clip.' : 'No vertical climb was recorded.'} Terrain and weather are current, not historical.`
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

function stopReplay(): void {
  replayRequest++;
  replayAbort?.abort(); replayAbort = null;
  replay = null;
  banner.hidden = true;
  document.body.classList.remove('is-replaying');
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
  void hud.refreshPassport(id).then(() => hud.render(followedId));
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(id === null ? { type: 'unwatch' } : { type: 'watch', actorId: id }));
}

liveEncounterPicker.addEventListener('change', () => {
  const encounter = liveEncounters.current(performance.now())?.encounters.find((e) => e.eventId === liveEncounterPicker.value);
  if (encounter) { stopReplay(); watch(encounter.predator.id); livePairFrame.checked = true; }
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
let groundCover: GroundCover | null = null;
let terrainRoot: THREE.Object3D | null = null;
const graphics = document.querySelector<HTMLSelectElement>('#render-quality')!;
const graphicsStatus = document.querySelector<HTMLOutputElement>('#render-quality-status')!;
let savedQuality: unknown;
try { savedQuality = storage?.getItem('vana.graphics'); } catch { /* optional preference */ }
const quality = new AdaptiveQuality(qualityMode(savedQuality));
graphics.value = quality.mode;
function applyQuality(): void {
  setQuality(quality.tier); animals.quality = quality.tier;
  groundCover?.setQuality(quality.tier); nature?.setQuality(quality.tier);
  graphicsStatus.textContent = `${quality.mode === 'auto' ? 'Auto · ' : ''}${quality.tier} graphics`;
}
applyQuality();
graphics.addEventListener('change', () => {
  quality.select(qualityMode(graphics.value)); applyQuality();
  try { storage?.setItem('vana.graphics', quality.mode); } catch { /* optional preference */ }
});
const pacer = new RenderPacer();
const terrainCheckpoints = new TerrainCheckpoints();
document.addEventListener('visibilitychange', () => {
  pacer.reset(); quality.resetTiming();
  if (document.hidden && ambientAudio.enabled) { ambientAudio.stop(); setAmbientUi('Sound paused while this tab is hidden. Click to resume.'); }
});
addEventListener('pagehide', (event) => {
  ambientAudio.stop(); setAmbientUi('Sound off.');
  // Preserve resources if the browser keeps this document alive in its back/forward cache.
  if (!(event as PageTransitionEvent).persisted) { nature?.dispose(); groundCover?.dispose(); microEcology.dispose(); communityLayer.dispose(); terrainCheckpoints.dispose(); }
});
const carcasses = new Map<string, AnimalState>();
const sceneStatus = document.querySelector<HTMLElement>('#scene-status')!;
const sceneUpdates = new SceneUpdates<{
  terrain: PreparedTerrain;
  cover: GroundCover | null; vegetation: NearVegetation | null;
}>({
  async prepare(environment) {
    const terrain = terrainCheckpoints.prepare(environment.patches);
    let cover: GroundCover | null = null, vegetation: NearVegetation | null = null;
    try {
      if (groundCover === null) cover = new GroundCover(environment.patches, (x, z) => animals.groundHeightAt(x, z));
      if (nature === null) {
        vegetation = new NearVegetation(environment.patches, (x, z) => animals.groundHeightAt(x, z));
        await vegetation.load(renderer);
      }
      return { terrain, cover, vegetation };
    } catch (error) { terrainCheckpoints.discard(terrain); cover?.dispose(); vegetation?.dispose(); throw error; }
  },
  discard(prepared) { terrainCheckpoints.discard(prepared.terrain); prepared.cover?.dispose(); prepared.vegetation?.dispose(); },
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
      if (prepared.vegetation) {
        nature = prepared.vegetation; nature.setQuality(quality.tier);
        observerVisibility.attach(nature.root); scene.add(nature.root);
      }
      else nature?.setPatches(update.environment.patches);
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
  if (animal) { stopReplay(); watch(animal.id); }
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

// Dev-only handle so the running world can be inspected from the console.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__vana = { scene, camera, follow, animals, store };
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
function renderFrame(dt: number, now: number): void {
  if (store.world) ambientAudio.sample(store.world.season, mapPatches, camera, animals.groundHeightAt, now);
  // A season can turn without a patch change; the update is a cheap no-op otherwise.
  if (store.world && store.world.season !== tintSeason) { tintSeason = store.world.season; groundTint.update(mapPatches, tintSeason); }
  // Use the settled camera, not the followed animal or the previous frame's target.
  // Otherwise zooming/panning leaves the viewer outside the detail island.
  if (nature !== null && terrainRoot !== null) {
    if (nature.update(camera.position, camera)) {
      hideFarFieldNear(terrainRoot, camera.position, NEAR_RADIUS_M,
        nature.hasTreeLod ? Number.POSITIVE_INFINITY : TREE_DETAIL_RADIUS_M, COVER_RADIUS_M - 12);
    }
    nature.setDistantLight(store.world ? atmosphereAt(store.world.worldTime, store.world.season).daylight : 1);
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
function frame(): void {
  requestAnimationFrame(frame);
  const now = performance.now();
  const elapsedMs = pacer.next(now, document.hidden);
  if (elapsedMs === null) return;
  if (elapsedMs > 0 && quality.sample(elapsedMs)) applyQuality();
  const dt = Math.min(elapsedMs / 1000, 0.1);
  observerSubjects = [];
  humanLabel.hidden = true;
  follow.reducedMotion = reducedMotion.matches;
  refreshEncounterPicker(now);
  if (store.world !== null) {
    atmosphere.update(store.world.worldTime, store.world.season, now / 1000, follow.target, reducedMotion.matches, follow.distance, camera.position);
    renderer.toneMappingExposure = observerExposure(atmosphereAt(store.world.worldTime, store.world.season).daylight, follow.distance);
  }

  groundCover?.animate(now / 1000, reducedMotion.matches);

  communityLayer.setReplay(replay !== null);
  if (replay !== null) {
    rewards.position(0, 0, false);
    encounterNotice.hidden = true;
    for (const label of liveLabels) label.hidden = true;
    const { life, encounter, climb, clock: playback } = replay;
    playback.tick(dt * 1000);
    const progress = playback.progress;
    if (encounter) {
      const seconds = encounter.trace.samples.at(-1)!.seconds * progress;
      const points = encounterAt(encounter.trace, seconds);
      const drives = { hunger: 0, thirst: 0, fatigue: 0, fear: 0 }; // Rendering input only; no drive UI in encounter mode.
      animals.syncReplayGroup([
        { animal: { id: encounter.trace.predatorId, speciesId: encounter.predatorSpecies, patchId: 0,
          state: points.predator.moving ? points.phase === 'chase' ? 'chasing' : 'stalking' : 'resting', currentGoal: '', drives }, position: points.predator },
        { animal: { id: encounter.trace.preyId, speciesId: encounter.preySpecies, patchId: 0,
          state: points.finished && encounter.outcome === 'success' ? 'dead' : points.prey.moving ? 'fleeing' : 'resting', currentGoal: '', drives }, position: points.prey },
      ], seconds);
      observerSubjects = [observerSubject(encounter.predatorSpecies, points.predator), observerSubject(encounter.preySpecies, points.prey)];
      const x = (points.predator.x + points.prey.x) / 2; const z = (points.predator.z + points.prey.z) / 2;
      if (replayAutoFrame.checked) {
        const gap = Math.hypot(points.predator.x - points.prey.x, points.predator.z - points.prey.z);
        const desired = Math.max(12, gap / (2 * Math.tan(camera.fov * Math.PI / 360) * Math.min(1, camera.aspect)) * 1.25 + 8);
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
        state: position.moving ? 'travelling' : 'resting', currentGoal: climb.trace.goal, drives }, position, seconds);
      observerSubjects = [observerSubject(life.speciesId, position)];
      follow.follow({ ...position, moving: !playback.paused && position.moving,
        y: renderBaseY(position, animals.groundHeightAt) }, playback.paused || reducedMotion.matches ? 1 : dt);
      const moment = climbMoment(climb, seconds);
      replayMoment.textContent = moment;
      replayWhen.textContent = `${life.id} · +${seconds.toFixed(1)}s`;
      replaySeek.setAttribute('aria-valuetext', `${seconds.toFixed(1)} seconds, ${moment}`);
    } else {
      const playhead = life.track[0]!.worldTime + (life.track.at(-1)!.worldTime - life.track[0]!.worldTime) * progress;
      const point = pointAt(life.track, life.id, playhead);
      animals.syncReplay({ id: life.id, speciesId: life.speciesId, patchId: 0, state: point.state, currentGoal: '', drives: point.drives }, point, playhead);
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

  const visibleAnimals = new Map([...carcasses, ...store.animals]);
  const poses = liveEncounters.poses(now, reducedMotion.matches);
  for (const [id, pose] of poses) {
    const current = visibleAnimals.get(id);
    // Older retained hours predate recorded sex/life-stage fields. Use a same-species
    // live identity only for missing visual metadata; route, state, outcome and body
    // size still come exclusively from the recorded pose.
    visibleAnimals.set(id, withRecordedVisualIdentity(pose.animal, current));
  }
  const followedEncounter = followedId === null ? undefined : poses.get(followedId);
  encounterNotice.hidden = followedEncounter === undefined;
  const encounterText = followedEncounter === undefined ? ''
    : followedEncounter.kind === 'movement'
      ? `Recorded activity · ${followedEncounter.phase}. One-hour delayed server route${followedEncounter.climbVisualPhase ? ' with saved altitude' : ''}; drinking uses an aggregate action window, not exact sip timing. Poses are illustrative; the passport shows the newer checkpoint.`
      : `Recorded encounter · ${followedEncounter.phase}. Both animals share one server timeline. Passport and event log show the newer checkpoint.`;
  // A short line on the card; the full account of what is recorded stays in the tooltip.
  const encounterShort = followedEncounter === undefined ? ''
    : followedEncounter.kind === 'movement'
      ? `Replaying its recorded ${followedEncounter.climbVisualPhase ? 'climb' : 'route'} · about an hour behind live`
      : `Replaying a recorded hunt · ${followedEncounter.phase}`;
  if (encounterNotice.textContent !== encounterShort) { encounterNotice.textContent = encounterShort; encounterNotice.title = encounterText; }
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
        const desired = Math.max(12, gap / (2 * Math.tan(camera.fov * Math.PI / 360) * Math.min(1, camera.aspect)) * 1.25 + 8);
        follow.distance += (desired - follow.distance) * Math.min(1, dt * 3);
        const x = (position.x + partner.x) / 2, z = (position.z + partner.z) / 2;
        follow.follow({ x, z, heading: position.heading, moving: false,
          y: Math.max(renderBaseY(position, animals.groundHeightAt), renderBaseY(partner, animals.groundHeightAt)) }, dt);
      } else follow.follow({ ...position, y: renderBaseY(position, animals.groundHeightAt),
        focusHeight: visualFor(speciesId).heightM * characterScale(visibleAnimals.get(followedId) ?? {}) * 0.5 }, dt);
    }
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
      const text = `${person.name} · ${communityLayer.showingHistoricFrame ? 'saved hourly movement' : person.recorded ? 'recorded activity' : 'saved checkpoint'}`;
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
    const text = `${pose.animal.speciesId} · recorded position`;
    if (label.textContent !== text) label.textContent = text;
    label.style.left = `${Math.max(82, Math.min(innerWidth - 82, (p.x + 1) / 2 * innerWidth))}px`;
    label.style.top = `${Math.max(30, (1 - p.y) / 2 * innerHeight)}px`;
  });

  renderFrame(dt, now);
}

// Start looking at the middle of the world until the first animal is followed.
follow.target.set(3000, 0, 3000);
follow.distance = 900;
frame();

addEventListener('hashchange', () => {
  const id = animalFromHash(location.hash);
  if (id !== null) watch(id);
});

// Explicit shared links include dead/departed animals and take priority over local preferences.
const stop = store.onChange(() => {
  if (store.world === null) return;
  if (followRevision === 0) {
    const id = initialFollowId(location.hash, lastFollowed.get(), store.animals);
    if (id !== null) { follow.distance = 22; watch(id); }
  }
  stop();
});
