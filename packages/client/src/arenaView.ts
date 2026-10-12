import * as THREE from "three";
import { AnimalLayer } from "./animals.js";
import type { AnimalState } from "./protocol.js";
import { patchAtPosition, type ArenaFrame } from "@vana/shared";
/** Uses the same animal rigs as the forest; ground and water beacons are a schematic arena. */
export class ArenaView {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 900);
  private animals = new AnimalLayer();
  private waters = new THREE.Group();
  private frame: ArenaFrame | null = null;
  private animation = 0;
  private disposed = false;
  private last = 0;
  private resize: ResizeObserver;
  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly command: ((x: number, z: number) => void) | null,
  ) {
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
      });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    } catch {
      this.renderer = null;
    }
    this.scene.background = new THREE.Color("#17271d");
    this.scene.fog = new THREE.Fog("#17271d", 120, 500);
    this.scene.add(new THREE.HemisphereLight(0xe5f4dc, 0x334032, 2));
    const sun = new THREE.DirectionalLight(0xffe8c4, 2.5);
    sun.position.set(25, 80, 30);
    this.scene.add(sun);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(12000, 12000),
      new THREE.MeshStandardMaterial({ color: 0x40533a, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
    this.animals.quality = "smooth";
    this.scene.add(this.animals.root, this.waters);
    this.resize = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      this.renderer?.setSize(r.width, r.height, false);
      this.camera.aspect = r.width / r.height;
      this.camera.updateProjectionMatrix();
    });
    this.resize.observe(canvas);
    canvas.addEventListener("pointerup", this.pointer);
    this.animation = requestAnimationFrame(this.draw);
  }
  private pointer = (e: PointerEvent) => {
    if (!this.command || !this.frame?.animal) return;
    const r = this.canvas.getBoundingClientRect();
    if (!this.renderer) {
      const animal = this.frame.animal;
      this.command(
        animal.x + (((e.clientX - r.left) / r.width) * 600 - 300) / 2,
        animal.z + (((e.clientY - r.top) / r.height) * 360 - 180) / 2,
      );
      return;
    }
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      ),
      this.camera,
    );
    const p = new THREE.Vector3();
    if (
      ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)
    )
      this.command(p.x, p.z);
  };
  update(frame: ArenaFrame): void {
    this.frame = frame;
    const a = frame.animal;
    if (!a) return;
    const map = new Map<string, AnimalState>();
    for (const p of [a, ...frame.nearby]) {
      const position = { x: p.x, z: p.z, heading: p.heading ?? 0 };
      map.set(p.id, {
        id: p.id,
        speciesId: p.speciesId,
        patchId: patchAtPosition(position),
        position,
        state:
          p.state === "chase"
            ? "chasing"
            : p.state === "flee"
              ? "fleeing"
              : p.state,
        currentGoal: "",
        lifeStage: p.lifeStage,
        drives:
          p.drives ??
          (p.id === a.id && frame.drives
            ? frame.drives
            : { hunger: 0, thirst: 0, fatigue: 0, fear: 0 }),
      });
    }
    this.animals.sync(map, performance.now(), a.id, a);
    this.camera.position.set(a.x + 27, 24, a.z + 32);
    this.camera.lookAt(a.x, 1, a.z);
    for (const o of [...this.waters.children]) {
      this.waters.remove(o);
      const m = o as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    for (const p of frame.water) {
      const marker = new THREE.Mesh(
        new THREE.RingGeometry(2.5, 3, 24),
        new THREE.MeshBasicMaterial({
          color: 0x84c8dc,
          side: THREE.DoubleSide,
        }),
      );
      marker.rotation.x = -Math.PI / 2;
      marker.position.set(p.x, 0.04, p.z);
      this.waters.add(marker);
    }
    if (!this.renderer) this.drawMap();
  }
  private drawMap(): void {
    const ctx = this.canvas.getContext("2d"),
      a = this.frame?.animal;
    if (!ctx || !a) return;
    this.canvas.width = 600;
    this.canvas.height = 360;
    ctx.fillStyle = "#17271d";
    ctx.fillRect(0, 0, 600, 360);
    ctx.strokeStyle = "#84c8dc";
    for (const water of this.frame?.water ?? []) {
      ctx.beginPath();
      ctx.arc(
        300 + (water.x - a.x) * 2,
        180 + (water.z - a.z) * 2,
        6,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
    for (const p of [...(this.frame?.nearby ?? []), a]) {
      ctx.fillStyle = p.id === a.id ? "#e0ad63" : "#7fc98a";
      ctx.beginPath();
      ctx.arc(
        300 + (p.x - a.x) * 2,
        180 + (p.z - a.z) * 2,
        p.id === a.id ? 7 : 3,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }
  private draw = (now: number) => {
    if (this.disposed) return;
    this.animation = requestAnimationFrame(this.draw);
    if (
      document.hidden ||
      this.canvas.closest("[hidden]") ||
      now - this.last < 33
    )
      return;
    this.animals.update(Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    this.renderer?.render(this.scene, this.camera);
  };
  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.animation);
    this.resize.disconnect();
    this.canvas.removeEventListener("pointerup", this.pointer);
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          m.dispose();
      }
    });
  }
}
