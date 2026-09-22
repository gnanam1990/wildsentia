import * as THREE from 'three';
import { WorldStore } from './protocol.js';
import { createScene } from './scene.js';
import { buildTerrain, countDrawCalls, makeHeightSampler, type PatchView } from './terrain.js';
import { AnimalLayer } from './animals.js';
import { FollowCamera } from './camera.js';
import { Hud } from './hud.js';

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

function watch(id: string | null): void {
  followedId = id;
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

connect();
store.onChange(() => { hud.render(followedId); });
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

  animals.sync(store.animals, now, followedId);
  animals.update(dt);

  if (followedId !== null) {
    const position = animals.positionOf(followedId, now);
    if (position !== null) {
      follow.follow({ ...position, y: animals.groundHeightAt(position.x, position.z) }, dt);
      // Keep the shadow box centred on whoever is being watched.
      sun.target.position.set(position.x, 0, position.z);
      sun.position.set(position.x + 90, 160, position.z + 70);
    }
  } else {
    follow.freeLook(dt);
  }
  sun.target.updateMatrixWorld();

  renderer.render(scene, camera);
}

// Start looking at the middle of the world until the first animal is followed.
follow.target.set(3000, 0, 3000);
follow.distance = 900;
frame();

// Follow the first animal the server reports, so the world is not empty on arrival.
const stop = store.onChange(() => {
  const first = store.animals.keys().next();
  if (first.done === true) return;
  follow.distance = 22;
  watch(first.value);
  stop();
});
