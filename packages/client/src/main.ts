import * as THREE from 'three';
import { WorldStore } from './protocol.js';
import { createScene } from './scene.js';
import { buildTerrain, countDrawCalls, makeHeightSampler, type PatchView } from './terrain.js';
import { AnimalLayer } from './animals.js';
import { FollowCamera } from './camera.js';
import { Hud } from './hud.js';
import { ThoughtBubble } from './bubble.js';
import { LastSeen, worthRecapping } from './recap.js';

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const { renderer, scene, camera, sun } = createScene(canvas);

const store = new WorldStore();
const animals = new AnimalLayer();
scene.add(animals.root);

const follow = new FollowCamera(camera, canvas);
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
const lastSeen = new LastSeen(storage);
/** The animal this viewer last followed, so coming back returns them to it. */
const lastFollowed = {
  get(): string | null { try { return storage?.getItem('vana.followed') ?? null; } catch { return null; } },
  set(id: string | null): void {
    try { if (id === null) storage?.removeItem('vana.followed'); else storage?.setItem('vana.followed', id); } catch { /* optional */ }
  },
};

let followedId: string | null = null;
let socket: WebSocket | null = null;

function connect(): void {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${location.host}/live`);
  socket.addEventListener('message', (event) => {
    try {
      store.apply(JSON.parse(String(event.data)));
    } catch {
      // A malformed frame must not take down the render loop.
    }
  });
  socket.addEventListener('close', () => { setTimeout(connect, 2000); });
}

/** Set on follow; answered once the world clock is known, before lastSeen is overwritten. */
let recapPending: string | null = null;

function watch(id: string | null): void {
  followedId = id;
  hud.recap = null;
  recapPending = id;
  lastFollowed.set(id);
  void hud.refreshPassport(id).then(() => hud.render(followedId));
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(id === null ? { type: 'unwatch' } : { type: 'watch', actorId: id }));
}

// Terrain comes from the server's patch state, not from anything generated here.
void (async () => {
  const response = await fetch('/api/patches');
  const body = (await response.json()) as { patches: PatchView[] };
  const terrain = buildTerrain(body.patches);
  terrain.traverse((o) => {
    const mesh = o as THREE.Mesh;
    // Only the ground tiles receive shadows. Grass and rock instances casting onto each other
    // at this scale costs more than it shows.
    mesh.receiveShadow = mesh.name === 'ground';
  });
  scene.add(terrain);
  animals.groundHeightAt = makeHeightSampler(body.patches);
  console.info(`terrain draw calls: ${countDrawCalls(terrain)} (budget 150)`);
})();

// Click to follow.
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
canvas.addEventListener('pointerup', (event) => {
  pointer.x = (event.clientX / innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(animals.root.children, true)[0];
  if (!hit) return;
  let node: THREE.Object3D | null = hit.object;
  while (node !== null && !store.animals.has(node.name)) node = node.parent;
  if (node !== null) watch(node.name);
});

document.querySelector('#freecam')!.addEventListener('click', () => { watch(null); });

// Family members and teachers in the passport are links: follow them.
document.querySelector('#passport')!.addEventListener('click', (event) => {
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
  hud.render(followedId);
  if (followedId === null || store.world === null) return;
  if (recapPending === followedId) {
    recapPending = null;
    const since = lastSeen.get(followedId);
    const now = store.world.worldTime;
    if (worthRecapping(since, now)) void hud.loadRecap(followedId, since!, now).then(() => hud.render(followedId));
  }
  lastSeen.mark(followedId, store.world.worldTime);
});
void hud.refreshFeed();
setInterval(() => { void hud.refreshFeed(); }, 10_000);

// Dev-only handle so the running world can be inspected from the console.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__vana = { scene, camera, follow, animals, store };
}

const clock = new THREE.Clock();
function frame(): void {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now();

  animals.sync(store.animals, now, followedId, { x: follow.target.x, z: follow.target.z });
  animals.update(dt);

  if (followedId !== null) {
    const position = animals.positionOf(followedId, now);
    if (position !== null) {
      follow.follow({ ...position, y: animals.groundHeightAt(position.x, position.z) }, dt);
      // Keep the shadow box centred on whoever is being watched.
      sun.target.position.set(position.x, 0, position.z);
      sun.position.set(position.x + 90, 160, position.z + 70);
    }
    // The bubble floats over the animal's head, projected into screen space.
    const head = position === null ? null
      : new THREE.Vector3(position.x, animals.groundHeightAt(position.x, position.z) + 3, position.z).project(camera);
    bubble.show(
      store.animals.get(followedId),
      head === null || head.z > 1 ? null : { x: (head.x + 1) / 2 * innerWidth, y: (1 - head.y) / 2 * innerHeight },
    );
  } else {
    follow.freeLook(dt);
    bubble.show(undefined, null);
  }
  sun.target.updateMatrixWorld();

  renderer.render(scene, camera);
}

// Start looking at the middle of the world until the first animal is followed.
follow.target.set(3000, 0, 3000);
follow.distance = 900;
frame();

// Return a viewer to the animal they last followed; otherwise follow the first one reported,
// so the world is not empty on arrival.
const stop = store.onChange(() => {
  const first = store.animals.keys().next();
  if (first.done === true) return;
  follow.distance = 22;
  const previous = lastFollowed.get();
  watch(previous !== null && store.animals.has(previous) ? previous : first.value);
  stop();
});
