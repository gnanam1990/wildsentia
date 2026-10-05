import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { addCameraInteriorFade, cameraInteriorKeep, cutawayVisibility, ObserverVisibility, projectObserverSubjects } from '../src/observerVisibility.js';
import { addTreeDetailFade, treeImpostorMaterial } from '../src/treeLod.js';

function camera() {
  return new THREE.PerspectiveCamera(60, 2, 0.1, 1000);
}
function compile(material: THREE.Material) {
  const shader = { uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: '#include <begin_vertex>\n#include <project_vertex>',
    fragmentShader: '#include <map_fragment>\n#include <alphatest_fragment>' };
  material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
  return shader;
}

describe('observer-only occlusion reveal', () => {
  it('clears a crowded lens without fading distant trees or moving world objects', () => {
    expect(cameraInteriorKeep(1.3, 2.2, 'tree')).toBe(0);
    expect(cameraInteriorKeep(5, 2.2, 'tree')).toBe(0);
    expect(cameraInteriorKeep(10, 2.2, 'tree')).toBeGreaterThan(0);
    expect(cameraInteriorKeep(10, 2.2, 'tree')).toBeLessThan(1);
    expect(cameraInteriorKeep(20, 2.2, 'tree')).toBe(1);
    expect(cameraInteriorKeep(1.3, 3.4, 'rock')).toBe(0);
    expect(cameraInteriorKeep(15, 3.4, 'rock')).toBe(1);
  });
  it('composes camera-interior fade with tree LOD and subject cutaway on colour/depth shaders', () => {
    const observer = { value: new THREE.Vector3(1, 10, 2) };
    const material = new THREE.MeshStandardMaterial();
    addTreeDetailFade(material, observer);
    addCameraInteriorFade(material, observer, 'tree');
    new ObserverVisibility().patch(material);
    const shader = compile(material);
    expect(shader.vertexShader).toContain('interiorOrigin.xz');
    expect(shader.fragmentShader).toContain('screenNoise >= detail');
    expect(shader.fragmentShader).toContain('interiorNoise >= interiorKeep');
    expect(shader.fragmentShader).toContain('observerNoise >= observerKeep');
    expect(shader.uniforms.cameraInteriorObserver).toBe(observer);
    const depth = new THREE.MeshDepthMaterial();
    addCameraInteriorFade(depth, observer, 'rock');
    const depthShader = compile(depth);
    expect(depthShader.fragmentShader).toContain('interiorNoise >= interiorKeep');
    expect(depthShader.fragmentShader).not.toContain('observerNoise');
    material.dispose(); depth.dispose();
  });
  it('cuts only foreground decoration inside a soft subject-sized mask', () => {
    const subjects = [{ x: 100, y: 100, radius: 50, depth: 0.8 }];
    expect(cutawayVisibility({ x: 100, y: 100, depth: 0.7 }, subjects)).toBe(0.08);
    expect(cutawayVisibility({ x: 140, y: 100, depth: 0.7 }, subjects)).toBeCloseTo(0.54);
    expect(cutawayVisibility({ x: 150, y: 100, depth: 0.7 }, subjects)).toBe(1);
    expect(cutawayVisibility({ x: 100, y: 100, depth: 0.8 }, subjects)).toBe(1);
    expect(cutawayVisibility({ x: 100, y: 100, depth: 0.9 }, subjects)).toBe(1);
    expect(cutawayVisibility({ x: 100, y: 100, depth: 0.7 }, [])).toBe(1);
  });

  it('supports two encounter participants without multiplying overlapping opacity', () => {
    const subjects = [{ x: 100, y: 100, radius: 50, depth: 0.8 }, { x: 120, y: 100, radius: 50, depth: 0.8 }];
    expect(cutawayVisibility({ x: 110, y: 100, depth: 0.7 }, subjects)).toBe(0.08);
    expect(cutawayVisibility({ x: 10, y: 10, depth: 0.7 }, subjects)).toBe(1);
  });

  it('projects using physical drawing-buffer coordinates and scales with device pixel ratio', () => {
    const subjects = [{ x: 0, y: 0, z: -10, radius: 1 }];
    const [a] = projectObserverSubjects(camera(), { x: 1000, y: 500 }, subjects);
    const [b] = projectObserverSubjects(camera(), { x: 2000, y: 1000 }, subjects);
    expect(a!.x).toBe(500); expect(a!.y).toBe(250);
    expect(b!.x).toBe(a!.x * 2); expect(b!.y).toBe(a!.y * 2);
    expect(b!.radius).toBeCloseTo(a!.radius * 2); expect(b!.depth).toBe(a!.depth);
    expect(a!.depth).toBeGreaterThan(0); expect(a!.depth).toBeLessThan(1);
  });

  it('rejects invalid, behind-camera, clipped, and offscreen subjects; caps close masks', () => {
    const size = { x: 1000, y: 500 };
    for (const subject of [
      { x: 0, y: 0, z: 10, radius: 1 }, { x: 0, y: 0, z: -0.05, radius: 1 },
      { x: 0, y: 0, z: -2000, radius: 1 }, { x: 1000, y: 0, z: -10, radius: 1 },
      { x: NaN, y: 0, z: -10, radius: 1 }, { x: 0, y: 0, z: -10, radius: 0 },
    ]) expect(projectObserverSubjects(camera(), size, [subject])).toEqual([]);
    expect(projectObserverSubjects(camera(), { x: NaN, y: 500 }, [])).toEqual([]);
    expect(projectObserverSubjects(camera(), size, [{ x: 0, y: 0, z: -1, radius: 100 }])[0]!.radius).toBe(200);
  });

  it('composes near-tree hooks once and leaves alpha/shadow materials untouched', () => {
    const controller = new ObserverVisibility();
    const material = new THREE.MeshStandardMaterial({ alphaTest: 0.5 });
    addTreeDetailFade(material, { value: new THREE.Vector3() });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ alphaTest: 0.5 });
    const depthHook = mesh.customDepthMaterial.onBeforeCompile;
    controller.attach(mesh); const key = material.customProgramCacheKey();
    controller.attach(mesh);
    const shader = compile(material);
    expect(shader.fragmentShader).toContain('screenNoise >= detail');
    expect(shader.fragmentShader.match(/uniform vec4 observerSubjects/g)).toHaveLength(1);
    expect(shader.fragmentShader).toContain('#include <alphatest_fragment>');
    expect(material.customProgramCacheKey()).toBe(key);
    expect(material.alphaTest).toBe(0.5); expect(material.transparent).toBe(false);
    expect(mesh.customDepthMaterial.onBeforeCompile).toBe(depthHook);
    controller.update(camera(), { x: 1000, y: 500 }, [{ x: 0, y: 0, z: -10, radius: 1 }]);
    expect(shader.uniforms.observerSubjectCount!.value).toBe(1);
    controller.update(camera(), { x: 1000, y: 500 }, []);
    expect(shader.uniforms.observerSubjectCount!.value).toBe(0);
    mesh.geometry.dispose(); material.dispose(); mesh.customDepthMaterial.dispose();
  });

  it('preserves the far-tree billboard vertex shader and complementary fade', () => {
    const target = new THREE.WebGLRenderTarget(1, 1);
    const material = treeImpostorMaterial({ target, centre: new THREE.Vector3(), diameter: 12 });
    new ObserverVisibility().patch(material);
    const shader = compile(material);
    expect(shader.vertexShader).toContain('viewMatrix * vec4(treeWorld.xyz + windLean, 1.0)');
    expect(shader.fragmentShader).toContain('screenNoise < detail');
    expect(shader.fragmentShader).toContain('gl_FragCoord.z < subject.w');
    target.dispose(); material.dispose();
  });
});
