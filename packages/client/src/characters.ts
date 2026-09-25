import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SPECIES_VISUALS, modelStatus, modelStatusForAnimal, visualFor, visualForAnimal } from './species.js';
import { elephantTrunkReach } from './animation.js';
import { tintHumanScene } from './humans.js';
import { elephantSurface } from './elephantSurface.js';

const canvas = document.querySelector<HTMLCanvasElement>('#character')!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x29382f);
scene.add(new THREE.HemisphereLight(0xe8f4e0, 0x574837, 2.1));
const light = new THREE.DirectionalLight(0xffead3, 3);
light.position.set(4, 7, 5); light.castShadow = true; scene.add(light);
light.shadow.mapSize.set(2048, 2048); light.shadow.normalBias = 0.025; light.shadow.bias = -0.0002;
const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 64), new THREE.MeshStandardMaterial({ color: 0x374c38, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; ground.position.y = -0.015; scene.add(ground);
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.maxDistance = 20; controls.minDistance = 0.4; controls.maxPolarAngle = Math.PI * 0.49;
const species = document.querySelector<HTMLSelectElement>('#species')!;
const clip = document.querySelector<HTMLSelectElement>('#clip')!;
const status = document.querySelector<HTMLElement>('#status')!;
const details = document.querySelector<HTMLElement>('#details')!;
const pause = document.querySelector<HTMLButtonElement>('#pause')!;
for (const id of Object.keys(SPECIES_VISUALS)) species.add(new Option(id === 'elephant' ? 'elephant · adult male' : id, id));
species.add(new Option('elephant · adult female interim', 'elephant-female'));
species.add(new Option('elephant · calf interim', 'elephant-calf'));
species.add(new Option('elephant · young generic', 'elephant-generic'));
for (const id of ['human-female', 'human-male']) species.add(new Option(`${id} · generic CC0 character`, id));
let model: THREE.Object3D | null = null;
let mixer: THREE.AnimationMixer | null = null;
let clips: THREE.AnimationClip[] = [];
let serial = 0;
let playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;
const resetCamera = (): void => { camera.position.set(3.4, 2.1, 4.4); controls.target.set(0, 0.85, 0); controls.update(); };
resetCamera();
const pauseLabel = (): void => { pause.textContent = playing ? 'Pause animation' : 'Play animation'; };
pauseLabel();
function dispose(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose();
      m.dispose();
    }
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) (mesh as THREE.SkinnedMesh).skeleton.dispose();
  });
}
function playClip(): void {
  mixer?.stopAllAction();
  const chosen = clips.find((c) => c.name === clip.value);
  if (!mixer || !chosen) return;
  const action = mixer.clipAction(chosen);
  const terminal = /death|dead|dying/i.test(chosen.name);
  action.setLoop(terminal ? THREE.LoopOnce : THREE.LoopRepeat, terminal ? 1 : Infinity);
  action.clampWhenFinished = terminal; action.reset().play();
  mixer.update(0);
}
async function load(): Promise<void> {
  const request = ++serial;
  mixer?.stopAllAction();
  if (model) { scene.remove(model); dispose(model); }
  model = null; mixer = null; clips = []; clip.replaceChildren(); clip.disabled = true;
  const human = species.value === 'human-female' || species.value === 'human-male';
  const adultMaleElephant = species.value === 'elephant';
  const adultFemaleElephant = species.value === 'elephant-female';
  const calf = species.value === 'elephant-calf';
  const genericElephant = species.value === 'elephant-generic';
  status.textContent = human ? 'CC0 Quaternius assembly. Generic game-style costume, not an authentic cultural reconstruction. Task poses remain illustrative; anatomy, work props and browser acceptance are not complete.'
    : adultMaleElephant ? modelStatusForAnimal({ speciesId: 'elephant', sex: 'male', lifeStage: 'adult' })
      : adultFemaleElephant ? modelStatusForAnimal({ speciesId: 'elephant', sex: 'female', lifeStage: 'adult' })
      : calf ? modelStatusForAnimal({ speciesId: 'elephant', sex: 'female', lifeStage: 'juvenile' })
      : modelStatus(genericElephant ? 'elephant' : species.value);
  const visual = human ? { model: { file: `/assets/humans-v1/${species.value}.glb`, yaw: 0, tint: undefined } }
    : adultMaleElephant ? visualForAnimal({ speciesId: 'elephant', sex: 'male', lifeStage: 'adult' })
      : adultFemaleElephant ? visualForAnimal({ speciesId: 'elephant', sex: 'female', lifeStage: 'adult' })
      : calf ? visualForAnimal({ speciesId: 'elephant', sex: 'female', lifeStage: 'juvenile' })
      : visualFor(genericElephant ? 'elephant' : species.value);
  if (visual.model === null) { details.textContent = 'No species mesh or animation shipped yet. Placeholder in the live forest; no substitute animal shown here.'; return; }
  details.textContent = 'Loading local asset…';
  try {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().loadAsync(visual.model.file);
    if (request !== serial) { dispose(gltf.scene); return; }
    const root = gltf.scene;
    root.rotation.y = visual.model.yaw ?? 0;
    if (adultMaleElephant || adultFemaleElephant || calf) elephantSurface(root);
    let triangles = 0; let skins = 0;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true; mesh.receiveShadow = true;
      triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position!.count) / 3;
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) skins++;
      if (visual.model?.tint) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) (m as THREE.MeshStandardMaterial).color.multiply(new THREE.Color(visual.model.tint));
    });
    if (human) tintHumanScene(root, species.value === 'human-male' ? 1 : 0);
    const box = new THREE.Box3().setFromObject(root);
    const height = Math.max(0.001, box.max.y - box.min.y);
    const scale = 1.8 / height;
    const center = box.getCenter(new THREE.Vector3());
    const holder = new THREE.Group();
    holder.add(root); holder.scale.setScalar(scale); holder.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    model = holder; scene.add(holder);
    const spray = adultMaleElephant || adultFemaleElephant || calf ? gltf.animations.find(c => c.name === 'SprayWater') : undefined;
    clips = spray ? [...gltf.animations, elephantTrunkReach(spray)] : gltf.animations;
    mixer = new THREE.AnimationMixer(root);
    for (const c of clips) clip.add(new Option(`${c.name} · ${c.duration.toFixed(1)}s`, c.name));
    clip.disabled = clips.length === 0;
    if (clips.some((c) => c.name === 'Idle')) clip.value = 'Idle';
    if (!clips.length) clip.add(new Option('No animation clips', ''));
    details.textContent = `${Math.round(triangles).toLocaleString()} triangles · ${skins} skinned meshes · ${clips.length} clips. Preview normalized to 1.8 m; ${human ? 'live village uses saved appearance variants. This viewer previews clips, not world events.' : 'live forest uses species and body-mass scale.'}`;
    playClip(); resetCamera();
  } catch { if (request === serial) details.textContent = 'Asset could not load. Select another species and retry.'; }
}
species.addEventListener('change', () => { void load(); });
clip.addEventListener('change', playClip);
pause.addEventListener('click', () => { playing = !playing; pauseLabel(); });
document.querySelector('#reset')!.addEventListener('click', resetCamera);
document.querySelector('#rotate')!.addEventListener('click', () => {
  camera.position.sub(controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4).add(controls.target);
  controls.update();
});
document.querySelector('#zoom')!.addEventListener('click', () => {
  const offset = camera.position.clone().sub(controls.target);
  camera.position.copy(controls.target).add(offset.multiplyScalar(offset.length() > 3 ? 0.75 : 1.8));
  controls.update();
});
new ResizeObserver(() => {
  const { width, height } = canvas.getBoundingClientRect();
  renderer.setSize(width, height, false); camera.aspect = width / Math.max(height, 1); camera.updateProjectionMatrix();
}).observe(canvas);
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => { const dt = Math.min(clock.getDelta(), 0.1); if (playing) mixer?.update(dt); controls.update(); renderer.render(scene, camera); });
const requestedSpecies = new URLSearchParams(location.search).get('species');
species.value = requestedSpecies && (Object.hasOwn(SPECIES_VISUALS, requestedSpecies) || ['human-female', 'human-male', 'elephant-female', 'elephant-calf', 'elephant-generic'].includes(requestedSpecies)) ? requestedSpecies : 'elephant';
void load();
