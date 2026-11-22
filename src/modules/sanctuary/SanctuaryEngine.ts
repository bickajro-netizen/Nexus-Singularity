import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMHumanBoneName } from '@pixiv/three-vrm';

export interface SanctuaryVisualState {
  morphTargetWeights: { muscle_upper: number; muscle_core: number; muscle_legs: number; body_lean: number; posture_upright: number };
  boneScaleMultipliers: { upperArm: number; forearm: number; chest: number; spine: number; thigh: number; calf: number };
  auraUniforms: { intensity: number; primaryColorHex: string; secondaryColorHex: string; rimPower: number; recoveryMix: number };
  roomPropTiers: { studyDesk: 0 | 1 | 2 | 3; trainingCorner: 0 | 1 | 2 | 3 };
  stanceId: 'idle_calm' | 'stance_guard' | 'shadowbox_combo' | 'meditation_sit' | 'study_focus';
  quietMode: boolean;
  recoveryShieldActive: boolean;
  lowPowerMode: boolean;
}

export const SANCTUARY_CLAMP = {
  boneScaleMin: 0.96,
  boneScaleMax: 1.12,
  morphMin: 0.0,
  morphMax: 1.0,
  rimPowerMin: 2.2,
  rimPowerMax: 4.0,
  recoveryMixMin: 0.0,
  recoveryMixMax: 1.0,
  intensityMin: 0.0,
  intensityMax: 1.0,
} as const;

export function clampSanctuaryVisualState(state: SanctuaryVisualState): SanctuaryVisualState {
  const clamp = THREE.MathUtils.clamp;
  const clampTier = (v: number): 0 | 1 | 2 | 3 => clamp(Math.round(v), 0, 3) as 0 | 1 | 2 | 3;
  return {
    morphTargetWeights: {
      muscle_upper: clamp(state.morphTargetWeights.muscle_upper, SANCTUARY_CLAMP.morphMin, SANCTUARY_CLAMP.morphMax),
      muscle_core: clamp(state.morphTargetWeights.muscle_core, SANCTUARY_CLAMP.morphMin, SANCTUARY_CLAMP.morphMax),
      muscle_legs: clamp(state.morphTargetWeights.muscle_legs, SANCTUARY_CLAMP.morphMin, SANCTUARY_CLAMP.morphMax),
      body_lean: clamp(state.morphTargetWeights.body_lean, SANCTUARY_CLAMP.morphMin, SANCTUARY_CLAMP.morphMax),
      posture_upright: clamp(state.morphTargetWeights.posture_upright, SANCTUARY_CLAMP.morphMin, SANCTUARY_CLAMP.morphMax),
    },
    boneScaleMultipliers: {
      upperArm: clamp(state.boneScaleMultipliers.upperArm, SANCTUARY_CLAMP.boneScaleMin, SANCTUARY_CLAMP.boneScaleMax),
      forearm: clamp(state.boneScaleMultipliers.forearm, SANCTUARY_CLAMP.boneScaleMin, SANCTUARY_CLAMP.boneScaleMax),
      chest: clamp(state.boneScaleMultipliers.chest, SANCTUARY_CLAMP.boneScaleMin, SANCTUARY_CLAMP.boneScaleMax),
      spine: clamp(state.boneScaleMultipliers.spine, SANCTUARY_CLAMP.boneScaleMin, SANCTUARY_CLAMP.boneScaleMax),
      thigh: clamp(state.boneScaleMultipliers.thigh, SANCTUARY_CLAMP.boneScaleMin, SANCTUARY_CLAMP.boneScaleMax),
      calf: clamp(state.boneScaleMultipliers.calf, SANCTUARY_CLAMP.boneScaleMin, SANCTUARY_CLAMP.boneScaleMax),
    },
    auraUniforms: {
      intensity: clamp(state.auraUniforms.intensity, SANCTUARY_CLAMP.intensityMin, SANCTUARY_CLAMP.intensityMax),
      primaryColorHex: normalizeHex(state.auraUniforms.primaryColorHex, '#7c3aed'),
      secondaryColorHex: normalizeHex(state.auraUniforms.secondaryColorHex, '#c084fc'),
      rimPower: clamp(state.auraUniforms.rimPower, SANCTUARY_CLAMP.rimPowerMin, SANCTUARY_CLAMP.rimPowerMax),
      recoveryMix: clamp(state.auraUniforms.recoveryMix, SANCTUARY_CLAMP.recoveryMixMin, SANCTUARY_CLAMP.recoveryMixMax),
    },
    roomPropTiers: {
      studyDesk: clampTier(state.roomPropTiers.studyDesk),
      trainingCorner: clampTier(state.roomPropTiers.trainingCorner),
    },
    stanceId: state.stanceId,
    quietMode: !!state.quietMode,
    recoveryShieldActive: !!state.recoveryShieldActive,
    lowPowerMode: !!state.lowPowerMode,
  };
}

export interface AvatarLoadReport {
  ok: boolean;
  modeA: boolean;
  removedWeapons: string[];
  warnings: string[];
}

export interface MediaBlobReader {
  get(id: string): Promise<Blob | undefined>;
}

type StanceId = SanctuaryVisualState['stanceId'];

interface AuraUniforms {
  uTime: { value: number };
  uIntensity: { value: number };
  uPrimaryColor: { value: THREE.Color };
  uSecondaryColor: { value: THREE.Color };
  uRimPower: { value: number };
  uRecoveryMix: { value: number };
}

interface MorphBinding {
  mesh: THREE.Mesh;
  index: number;
  target: number;
  current: number;
}

interface BoneBinding {
  node: THREE.Object3D;
  baseScale: THREE.Vector3;
  baseRotX: number;
  targetXZ: number;
  currentXZ: number;
  targetRotXDelta: number;
  currentRotXDelta: number;
  children: Array<{ node: THREE.Object3D; baseScale: THREE.Vector3 }>;
}

interface ProceduralPose {
  spine: number;
  chest: number;
  neck: number;
  leftUpperArm: THREE.Euler;
  rightUpperArm: THREE.Euler;
  leftLowerArm: THREE.Euler;
  rightLowerArm: THREE.Euler;
  leftUpperLeg: THREE.Euler;
  rightUpperLeg: THREE.Euler;
  hipsY: number;
}

const WEAPON_RE = /sword|blade|katana|dagger|knife|gun|rifle|pistol|weapon|bow|staff|spear|axe/i;
const STANCE_FADE: Record<StanceId, number> = {
  idle_calm: 0.45,
  stance_guard: 0.3,
  shadowbox_combo: 0.22,
  meditation_sit: 0.6,
  study_focus: 0.5,
};
const MAX_PARTICLES = 240;
const RECOVERY_BLUE = new THREE.Color('#38bdf8');
const DAMP_LAMBDA = 4.5;

function normalizeHex(hex: string, fallback: string): string {
  const v = typeof hex === 'string' ? hex.trim() : '';
  return /^#([0-9a-fA-F]{6})$/.test(v) ? v.toLowerCase() : fallback;
}

function safeColor(hex: string, fallback: string): THREE.Color {
  try {
    return new THREE.Color(normalizeHex(hex, fallback));
  } catch {
    return new THREE.Color(fallback);
  }
}

function disposeMaterial(mat: THREE.Material): void {
  const anyMat = mat as THREE.Material & Record<string, unknown>;
  const mapKeys = [
    'map', 'alphaMap', 'aoMap', 'bumpMap', 'displacementMap', 'emissiveMap', 'envMap',
    'lightMap', 'metalnessMap', 'normalMap', 'roughnessMap', 'specularMap',
    'specularIntensityMap', 'specularColorMap', 'clearcoatMap', 'clearcoatRoughnessMap',
    'clearcoatNormalMap', 'sheenColorMap', 'sheenRoughnessMap', 'transmissionMap',
    'thicknessMap', 'anisotropyMap', 'iridescenceMap', 'iridescenceThicknessMap',
  ];
  for (const key of mapKeys) {
    const tex = anyMat[key];
    if (tex && tex instanceof THREE.Texture) tex.dispose();
  }
  const uniforms = (anyMat as any).uniforms;
  if (uniforms && typeof uniforms === 'object') {
    for (const u of Object.values(uniforms) as Array<{ value?: unknown }>) {
      if (u?.value instanceof THREE.Texture) u.value.dispose();
    }
  }
  mat.dispose();
}

function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if ((mesh as any).isMesh || (mesh as any).isSkinnedMesh || (mesh as any).isPoints || (mesh as any).isLine) {
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (mesh as any).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach(disposeMaterial);
      else if (mat) disposeMaterial(mat);
    }
  });
}

function fuzzyFindBone(root: THREE.Object3D, aliases: string[]): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  const lowerAliases = aliases.map((a) => a.toLowerCase());
  root.traverse((obj) => {
    if (found) return;
    const n = obj.name.toLowerCase();
    for (const a of lowerAliases) {
      if (n === a || n.includes(a)) {
        found = obj;
        return;
      }
    }
  });
  return found;
}

function getHumanoidBone(vrm: VRM | null, root: THREE.Object3D, humanName: VRMHumanBoneName | null, aliases: string[]): THREE.Object3D | null {
  if (vrm?.humanoid && humanName) {
    const node = vrm.humanoid.getNormalizedBoneNode(humanName);
    if (node) return node;
    const raw = vrm.humanoid.getRawBoneNode(humanName);
    if (raw) return raw;
  }
  return fuzzyFindBone(root, aliases);
}

function createProceduralPose(stance: StanceId, t: number): ProceduralPose {
  const breath = Math.sin(t * Math.PI * 2 * 0.25) * 0.015;
  const base: ProceduralPose = {
    spine: breath,
    chest: breath * 0.8,
    neck: -breath * 0.5,
    leftUpperArm: new THREE.Euler(0.25, 0, 0.15),
    rightUpperArm: new THREE.Euler(0.25, 0, -0.15),
    leftLowerArm: new THREE.Euler(-0.15, 0, 0),
    rightLowerArm: new THREE.Euler(-0.15, 0, 0),
    leftUpperLeg: new THREE.Euler(0, 0, 0),
    rightUpperLeg: new THREE.Euler(0, 0, 0),
    hipsY: 0,
  };
  if (stance === 'stance_guard') {
    base.leftUpperArm.set(-0.9, 0.2, 0.35);
    base.rightUpperArm.set(-0.7, -0.25, -0.45);
    base.leftLowerArm.set(-1.1, 0, 0);
    base.rightLowerArm.set(-0.9, 0, 0);
    base.spine += 0.04;
    base.chest += 0.03;
  } else if (stance === 'shadowbox_combo') {
    const phase = (t * 2.2) % 1;
    const punch = Math.sin(phase * Math.PI * 2);
    base.leftUpperArm.set(-0.8 + punch * 0.4, 0.15, 0.25);
    base.rightUpperArm.set(-1.1 - punch * 0.5, -0.2, -0.35);
    base.leftLowerArm.set(-1.0 - punch * 0.3, 0, 0);
    base.rightLowerArm.set(-0.6 + punch * 0.4, 0, 0);
    base.spine += punch * 0.05;
    base.chest += punch * 0.04;
  } else if (stance === 'meditation_sit') {
    base.hipsY = -0.35;
    base.leftUpperLeg.set(-1.2, 0.35, 0.4);
    base.rightUpperLeg.set(-1.2, -0.35, -0.4);
    base.leftUpperArm.set(0.35, 0, 0.45);
    base.rightUpperArm.set(0.35, 0, -0.45);
    base.leftLowerArm.set(-0.4, 0, 0);
    base.rightLowerArm.set(-0.4, 0, 0);
    base.spine += 0.02;
  } else if (stance === 'study_focus') {
    base.leftUpperArm.set(-0.55, 0.15, 0.25);
    base.rightUpperArm.set(-0.45, -0.15, -0.2);
    base.leftLowerArm.set(-0.9, 0, 0);
    base.rightLowerArm.set(-0.8, 0, 0);
    base.spine += 0.08;
    base.chest += 0.05;
    base.neck += -0.06;
  }
  return base;
}


class AuraSystem {
  public readonly group = new THREE.Group();
  private uniforms: AuraUniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 0.5 },
    uPrimaryColor: { value: new THREE.Color('#7c3aed') },
    uSecondaryColor: { value: new THREE.Color('#c084fc') },
    uRimPower: { value: 3.0 },
    uRecoveryMix: { value: 0 },
  };
  private patchedMaterials = new WeakSet<THREE.Material>();
  private particleGeometry: THREE.BufferGeometry;
  private particleMaterial: THREE.ShaderMaterial;
  private particlePoints: THREE.Points;
  private basePositions: Float32Array;
  private seeds: Float32Array;
  private maxDraw = MAX_PARTICLES;
  private enabled = true;

  constructor() {
    this.particleGeometry = new THREE.BufferGeometry();
    this.basePositions = new Float32Array(MAX_PARTICLES * 3);
    this.seeds = new Float32Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.15 + Math.random() * 0.55;
      const y = Math.random() * 1.8;
      this.basePositions[i * 3] = Math.cos(a) * r;
      this.basePositions[i * 3 + 1] = y;
      this.basePositions[i * 3 + 2] = Math.sin(a) * r;
      this.seeds[i] = Math.random();
    }
    this.particleGeometry.setAttribute('position', new THREE.BufferAttribute(this.basePositions.slice(), 3));
    this.particleGeometry.setAttribute('aSeed', new THREE.BufferAttribute(this.seeds, 1));
    this.particleGeometry.setDrawRange(0, MAX_PARTICLES);
    this.particleMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: this.uniforms.uTime,
        uIntensity: this.uniforms.uIntensity,
        uPrimaryColor: this.uniforms.uPrimaryColor,
        uSecondaryColor: this.uniforms.uSecondaryColor,
        uRecoveryMix: this.uniforms.uRecoveryMix,
      },
      vertexShader: `
        attribute float aSeed;
        uniform float uTime;
        uniform float uIntensity;
        varying float vAlpha;
        varying float vSeed;
        void main() {
          vec3 p = position;
          float speed = 0.18 + aSeed * 0.22;
          float y = mod(p.y + uTime * speed + aSeed * 1.8, 1.8);
          float angle = uTime * (0.25 + aSeed * 0.35) + aSeed * 6.2831853;
          float radius = length(p.xz) * (0.85 + 0.15 * sin(uTime * 0.7 + aSeed * 10.0));
          p.x = cos(angle) * radius;
          p.z = sin(angle) * radius;
          p.y = y;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (2.0 + aSeed * 2.5) * (0.6 + uIntensity) * (120.0 / -mv.z);
          vAlpha = smoothstep(0.0, 0.15, y) * (1.0 - smoothstep(1.4, 1.8, y));
          vSeed = aSeed;
        }
      `,
      fragmentShader: `
        uniform float uIntensity;
        uniform vec3 uPrimaryColor;
        uniform vec3 uSecondaryColor;
        uniform float uRecoveryMix;
        varying float vAlpha;
        varying float vSeed;
        void main() {
          vec2 uv = gl_PointCoord.xy - 0.5;
          float d = length(uv);
          float core = smoothstep(0.5, 0.0, d);
          vec3 recoveryBlue = vec3(0.2196, 0.7412, 0.9725);
          vec3 base = mix(uPrimaryColor, uSecondaryColor, vSeed);
          vec3 col = mix(base, recoveryBlue, clamp(uRecoveryMix, 0.0, 1.0));
          float alpha = core * vAlpha * (0.15 + 0.55 * uIntensity);
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });
    this.particlePoints = new THREE.Points(this.particleGeometry, this.particleMaterial);
    this.particlePoints.frustumCulled = false;
    this.particlePoints.renderOrder = 10;
    this.group.add(this.particlePoints);
  }

  attachToAvatar(root: THREE.Object3D): void {
    this.group.position.set(0, 0.9, 0);
    root.add(this.group);
  }

  patchMaterials(root: THREE.Object3D): void {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!(mesh as any).isMesh && !(mesh as any).isSkinnedMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) {
        if (!mat || this.patchedMaterials.has(mat)) continue;
        this.patchedMaterials.add(mat);
        const anyMat = mat as any;
        const prev = anyMat.onBeforeCompile;
        anyMat.onBeforeCompile = (shader: any, renderer: any) => {
          if (typeof prev === 'function') prev(shader, renderer);
          shader.uniforms.uTime = this.uniforms.uTime;
          shader.uniforms.uIntensity = this.uniforms.uIntensity;
          shader.uniforms.uPrimaryColor = this.uniforms.uPrimaryColor;
          shader.uniforms.uSecondaryColor = this.uniforms.uSecondaryColor;
          shader.uniforms.uRimPower = this.uniforms.uRimPower;
          shader.uniforms.uRecoveryMix = this.uniforms.uRecoveryMix;
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <common>',
            `#include <common>
             uniform float uTime;
             uniform float uIntensity;
             uniform vec3 uPrimaryColor;
             uniform vec3 uSecondaryColor;
             uniform float uRimPower;
             uniform float uRecoveryMix;`
          );
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <dithering_fragment>',
            `#include <dithering_fragment>
             {
               vec3 vNorm = normalize(normal);
               vec3 vViewDir = normalize(vViewPosition);
               float fres = pow(1.0 - max(dot(vNorm, vViewDir), 0.0), uRimPower);
               float pulseA = 0.5 + 0.5 * sin(uTime * 3.0);
               float pulseB = 0.5 + 0.5 * sin(uTime * 2.2 + 1.57);
               float pulse = mix(pulseA, pulseB, clamp(uRecoveryMix, 0.0, 1.0));
               vec3 recoveryBlue = vec3(0.2196, 0.7412, 0.9725);
               vec3 auraCol = mix(uPrimaryColor, recoveryBlue, clamp(uRecoveryMix, 0.0, 1.0));
               auraCol = mix(auraCol, uSecondaryColor, 0.25 * (1.0 - uRecoveryMix));
               gl_FragColor.rgb += auraCol * fres * uIntensity * (0.35 + 0.65 * pulse);
             }`
          );
        };
        anyMat.needsUpdate = true;
      }
    });
  }

  update(time: number, state: SanctuaryVisualState): void {
    this.uniforms.uTime.value = time;
    const quietDim = state.quietMode ? 0.25 : 1.0;
    const recoveryMix = state.recoveryShieldActive ? Math.max(state.auraUniforms.recoveryMix, 0.85) : state.auraUniforms.recoveryMix;
    this.uniforms.uIntensity.value = state.auraUniforms.intensity * quietDim;
    this.uniforms.uPrimaryColor.value.copy(safeColor(state.auraUniforms.primaryColorHex, '#7c3aed'));
    if (state.recoveryShieldActive) {
      this.uniforms.uSecondaryColor.value.copy(RECOVERY_BLUE);
    } else {
      this.uniforms.uSecondaryColor.value.copy(safeColor(state.auraUniforms.secondaryColorHex, '#c084fc'));
    }
    this.uniforms.uRimPower.value = state.auraUniforms.rimPower;
    this.uniforms.uRecoveryMix.value = THREE.MathUtils.clamp(recoveryMix, 0, 1);
    this.particlePoints.visible = this.enabled && this.uniforms.uIntensity.value > 0.001;
  }

  setLowPower(on: boolean): void {
    const target = on ? Math.floor(MAX_PARTICLES * 0.5) : MAX_PARTICLES;
    if (target !== this.maxDraw) {
      this.maxDraw = target;
      this.particleGeometry.setDrawRange(0, this.maxDraw);
    }
  }

  dispose(): void {
    if (this.group.parent) this.group.parent.remove(this.group);
    this.particleGeometry.dispose();
    this.particleMaterial.dispose();
  }
}

class RoomSystem {
  public readonly group = new THREE.Group();
  private studyTier: 0 | 1 | 2 | 3 = -1 as 0 | 1 | 2 | 3;
  private trainingTier: 0 | 1 | 2 | 3 = -1 as 0 | 1 | 2 | 3;
  private studyGroup: THREE.Group | null = null;
  private trainingGroup: THREE.Group | null = null;

  constructor() {
    this.group.name = 'SanctuaryRoom';
  }

  update(tiers: SanctuaryVisualState['roomPropTiers']): void {
    if (tiers.studyDesk !== this.studyTier) {
      this.replaceStudy(tiers.studyDesk);
    }
    if (tiers.trainingCorner !== this.trainingTier) {
      this.replaceTraining(tiers.trainingCorner);
    }
  }

  private replaceStudy(tier: 0 | 1 | 2 | 3): void {
    if (this.studyGroup) {
      this.group.remove(this.studyGroup);
      disposeObject3D(this.studyGroup);
      this.studyGroup = null;
    }
    this.studyTier = tier;
    if (tier === 0) return;
    const g = new THREE.Group();
    g.name = `StudyDeskTier${tier}`;
    g.position.set(-1.4, 0, -0.8);
    const deskMat = new THREE.MeshStandardMaterial({ color: 0x3b2a1a, roughness: 0.8, metalness: 0.1 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.7, metalness: 0.2 });
    const paperMat = new THREE.MeshStandardMaterial({ color: 0xd6c7a1, roughness: 0.95, metalness: 0.0 });
    const glowMat = new THREE.MeshStandardMaterial({ color: 0x7dd3fc, emissive: 0x38bdf8, emissiveIntensity: 1.2, roughness: 0.3, metalness: 0.1 });
    const desk = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.6), deskMat);
    desk.position.set(0, 0.75, 0);
    g.add(desk);
    for (const sx of [-0.5, 0.5]) {
      for (const sz of [-0.22, 0.22]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.75, 0.06), deskMat);
        leg.position.set(sx, 0.375, sz);
        g.add(leg);
      }
    }
    if (tier >= 1) {
      const book1 = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.04, 0.16), paperMat);
      book1.position.set(-0.25, 0.81, 0.05);
      g.add(book1);
      const grimoire = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.06, 0.2), new THREE.MeshStandardMaterial({ color: 0x4c1d95, roughness: 0.6, metalness: 0.2, emissive: 0x2e1065, emissiveIntensity: 0.4 }));
      grimoire.position.set(0.15, 0.82, -0.05);
      grimoire.rotation.y = -0.25;
      g.add(grimoire);
    }
    if (tier >= 2) {
      for (const mx of [-0.22, 0.22]) {
        const monitor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.03), darkMat);
        monitor.position.set(mx, 1.0, -0.18);
        g.add(monitor);
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.18), new THREE.MeshBasicMaterial({ color: 0x0ea5e9, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
        screen.position.set(mx, 1.0, -0.16);
        g.add(screen);
        const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.16, 8), darkMat);
        stand.position.set(mx, 0.87, -0.18);
        g.add(stand);
      }
    }
    if (tier >= 3) {
      const holoBase = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.04, 16), darkMat);
      holoBase.position.set(0, 0.81, 0.18);
      g.add(holoBase);
      for (let i = 0; i < 5; i++) {
        const node = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 10), glowMat.clone());
        const a = (i / 5) * Math.PI * 2;
        node.position.set(Math.cos(a) * 0.12, 1.05 + (i % 2) * 0.06, 0.18 + Math.sin(a) * 0.08);
        g.add(node);
      }
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.008, 8, 24), glowMat.clone());
      ring.position.set(0, 1.06, 0.18);
      ring.rotation.x = Math.PI / 2;
      g.add(ring);
    }
    this.studyGroup = g;
    this.group.add(g);
  }

  private replaceTraining(tier: 0 | 1 | 2 | 3): void {
    if (this.trainingGroup) {
      this.group.remove(this.trainingGroup);
      disposeObject3D(this.trainingGroup);
      this.trainingGroup = null;
    }
    this.trainingTier = tier;
    if (tier === 0) return;
    const g = new THREE.Group();
    g.name = `TrainingCornerTier${tier}`;
    g.position.set(1.3, 0, 0.6);
    const matMat = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.95, metalness: 0.0 });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.35, metalness: 0.8 });
    const rubberMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.9, metalness: 0.05 });
    const sigilMat = new THREE.MeshStandardMaterial({ color: 0x7c3aed, emissive: 0x4c1d95, emissiveIntensity: 1.0, roughness: 0.4, metalness: 0.2, transparent: true, opacity: 0.9 });
    if (tier >= 1) {
      const mat = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.03, 0.55), matMat);
      mat.position.set(0, 0.015, 0);
      g.add(mat);
    }
    if (tier >= 2) {
      for (let i = 0; i < 2; i++) {
        const dx = -0.2 + i * 0.4;
        const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.22, 10), metalMat);
        handle.rotation.z = Math.PI / 2;
        handle.position.set(dx, 0.08, -0.12);
        g.add(handle);
        for (const sx of [-1, 1]) {
          const weight = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 12), rubberMat);
          weight.rotation.z = Math.PI / 2;
          weight.position.set(dx + sx * 0.12, 0.08, -0.12);
          g.add(weight);
        }
      }
      const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.28, 0.14), new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.85, metalness: 0.05 }));
      backpack.position.set(0.35, 0.16, 0.15);
      g.add(backpack);
    }
    if (tier >= 3) {
      const rigMat = new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.5, metalness: 0.7 });
      for (const sx of [-0.45, 0.45]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.8, 10), rigMat);
        post.position.set(sx, 0.9, -0.2);
        g.add(post);
      }
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.96, 12), rigMat);
      bar.rotation.z = Math.PI / 2;
      bar.position.set(0, 1.75, -0.2);
      g.add(bar);
      const sigil = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.24, 24), sigilMat);
      sigil.rotation.x = -Math.PI / 2;
      sigil.position.set(0, 0.02, 0);
      g.add(sigil);
      const inner = new THREE.Mesh(new THREE.CircleGeometry(0.1, 24), new THREE.MeshBasicMaterial({ color: 0xc084fc, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
      inner.rotation.x = -Math.PI / 2;
      inner.position.set(0, 0.021, 0);
      g.add(inner);
    }
    this.trainingGroup = g;
    this.group.add(g);
  }

  dispose(): void {
    if (this.studyGroup) { disposeObject3D(this.studyGroup); this.studyGroup = null; }
    if (this.trainingGroup) { disposeObject3D(this.trainingGroup); this.trainingGroup = null; }
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

export class SanctuaryEngine {
  private readonly container: HTMLElement;
  private readonly mediaReader: MediaBlobReader;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly clock: THREE.Clock;
  private readonly loader: GLTFLoader;
  private readonly aura = new AuraSystem();
  private readonly room = new RoomSystem();

  private vrm: VRM | null = null;
  private avatarRoot: THREE.Group | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private clips: THREE.AnimationClip[] = [];
  private currentAction: THREE.AnimationAction | null = null;
  private currentStance: StanceId = 'idle_calm';
  private proceduralStance: StanceId = 'idle_calm';
  private proceduralBlend = 1;
  private proceduralTime = 0;

  private morphBindings = new Map<string, MorphBinding[]>();
  private boneBindings = new Map<string, BoneBinding[]>();
  private morphModeA = false;

  private rafId: number | null = null;
  private lastFrameMs = 0;
  private fpsCap = 0;
  private baseDpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
  private lowPower = false;
  private disposed = false;
  private contextLost = false;
  private visible = true;
  private intersecting = true;
  private intersectionObserver: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private state: SanctuaryVisualState = clampSanctuaryVisualState({
    morphTargetWeights: { muscle_upper: 0, muscle_core: 0, muscle_legs: 0, body_lean: 0, posture_upright: 0 },
    boneScaleMultipliers: { upperArm: 1, forearm: 1, chest: 1, spine: 1, thigh: 1, calf: 1 },
    auraUniforms: { intensity: 0.5, primaryColorHex: '#7c3aed', secondaryColorHex: '#c084fc', rimPower: 3.0, recoveryMix: 0 },
    roomPropTiers: { studyDesk: 0, trainingCorner: 0 },
    stanceId: 'idle_calm',
    quietMode: false,
    recoveryShieldActive: false,
    lowPowerMode: false,
  });

  private readonly onVisibility = () => { this.visible = !document.hidden; this.syncLoop(); };
  private readonly onContextLost = (e: Event) => { e.preventDefault(); this.contextLost = true; this.stopLoop(); };
  private readonly onContextRestored = () => { this.contextLost = false; this.syncLoop(); };

  constructor(container: HTMLElement, mediaReader: MediaBlobReader, _opts?: any) {
    if (!container) throw new Error('SanctuaryEngine: container is required');
    if (!mediaReader || typeof mediaReader.get !== 'function') throw new Error('SanctuaryEngine: mediaReader.get is required');
    this.container = container;
    this.mediaReader = mediaReader;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(this.baseDpr);
    this.renderer.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight), false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x0b0614, 0.035);
    this.camera = new THREE.PerspectiveCamera(32, Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight), 0.1, 100);
    this.camera.position.set(0, 1.35, 3.6);
    this.camera.lookAt(0, 1.0, 0);

    this.clock = new THREE.Clock();
    this.loader = new GLTFLoader();
    this.loader.register((parser) => new VRMLoaderPlugin(parser));

    this.setupLights();
    this.setupGround();
    this.scene.add(this.room.group);

    document.addEventListener('visibilitychange', this.onVisibility);
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost as EventListener, false);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored as EventListener, false);

    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.target === this.container) this.intersecting = entry.isIntersecting && entry.intersectionRatio >= 0.05;
        }
        this.syncLoop();
      }, { threshold: [0, 0.05, 0.1, 1] });
      this.intersectionObserver.observe(this.container);
    }
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.resize(this.container.clientWidth, this.container.clientHeight);
      });
      this.resizeObserver.observe(this.container);
    }

    this.syncLoop();
  }

  private setupLights(): void {
    const ambient = new THREE.AmbientLight(0xbfa7ff, 0.55);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xfff1d6, 1.1);
    key.position.set(2.5, 4, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 12;
    key.shadow.camera.left = -3;
    key.shadow.camera.right = 3;
    key.shadow.camera.top = 3;
    key.shadow.camera.bottom = -3;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x7dd3fc, 0.6);
    rim.position.set(-3, 2.5, -2);
    this.scene.add(rim);
    const fill = new THREE.PointLight(0x8b5cf6, 0.8, 10);
    fill.position.set(0, 2.2, 1.5);
    this.scene.add(fill);
  }

  private setupGround(): void {
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(4.5, 48),
      new THREE.MeshStandardMaterial({ color: 0x120a1a, roughness: 0.95, metalness: 0.05 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = 'SanctuaryGround';
    this.scene.add(ground);
  }

  async loadAvatar(blobId: string): Promise<AvatarLoadReport> {
    if (this.disposed) throw new Error('SanctuaryEngine disposed');
    const report: AvatarLoadReport = { ok: false, modeA: false, removedWeapons: [], warnings: [] };
    let objectUrl: string | null = null;
    try {
      const blob = await this.mediaReader.get(blobId);
      if (!blob) {
        report.warnings.push(`Blob not found: ${blobId}`);
        return report;
      }
      objectUrl = URL.createObjectURL(blob);
      const gltf = await this.loader.loadAsync(objectUrl);
      const vrm = (gltf.userData.vrm as VRM | undefined) ?? null;
      const root = (vrm?.scene ?? gltf.scene) as THREE.Group;

      this.clearAvatar();
      this.vrm = vrm;
      this.avatarRoot = root;
      this.avatarRoot.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if ((mesh as any).isMesh || (mesh as any).isSkinnedMesh) {
          mesh.castShadow = !this.lowPower;
          mesh.receiveShadow = !this.lowPower;
          const mat = (mesh as any).material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) mat.forEach((m) => { m.transparent = m.transparent; });
        }
      });

      this.sanitizeWeapons(this.avatarRoot, report);
      this.scene.add(this.avatarRoot);
      this.aura.attachToAvatar(this.avatarRoot);
      this.aura.patchMaterials(this.avatarRoot);

      this.clips = Array.isArray(gltf.animations) ? gltf.animations.slice() : [];
      this.mixer = new THREE.AnimationMixer(this.avatarRoot);
      this.bindMorphs(report);
      this.bindBones();
      this.applyStateToAvatar(this.state, 0, true);
      this.applyStance(this.state.stanceId, true);
      report.ok = true;
      report.modeA = this.morphModeA;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.warnings.push(`loadAvatar failed: ${msg}`);
      report.ok = false;
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
    return report;
  }

  private sanitizeWeapons(root: THREE.Object3D, report: AvatarLoadReport): void {
    const toRemove: THREE.Object3D[] = [];
    root.traverse((obj) => {
      if (obj === root) return;
      const name = obj.name || '';
      if (WEAPON_RE.test(name)) toRemove.push(obj);
    });
    for (const obj of toRemove) {
      const name = obj.name || '(unnamed)';
      if (obj.parent) obj.parent.remove(obj);
      disposeObject3D(obj);
      report.removedWeapons.push(name);
      report.warnings.push(`Removed weapon-like object: ${name}`);
      console.warn(`[SanctuaryEngine] Removed weapon-like object: ${name}`);
    }
  }

  private bindMorphs(report: AvatarLoadReport): void {
    this.morphBindings.clear();
    this.morphModeA = false;
    if (!this.avatarRoot) return;
    const wanted: Record<string, string[]> = {
      muscle_upper: ['muscle_upper', 'upper_muscle', 'muscleUpper', 'arm_muscle', 'upperbody_muscle'],
      muscle_core: ['muscle_core', 'core_muscle', 'muscleCore', 'abs', 'core'],
      muscle_legs: ['muscle_legs', 'leg_muscle', 'muscleLegs', 'legs_muscle'],
      body_lean: ['body_lean', 'lean', 'bodyLean', 'thin', 'slim'],
      posture_upright: ['posture_upright', 'upright', 'postureUpright', 'posture'],
    };
    const foundAny: Record<string, boolean> = { muscle_upper: false, muscle_core: false, muscle_legs: false, body_lean: false, posture_upright: false };
    this.avatarRoot.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      const dict = (mesh.morphTargetDictionary ?? null) as Record<string, number> | null;
      const infl = (mesh.morphTargetInfluences ?? null) as number[] | null;
      if (!dict || !infl) return;
      for (const [key, aliases] of Object.entries(wanted)) {
        for (const alias of aliases) {
          let idx = dict[alias];
          if (idx === undefined) {
            const lower = alias.toLowerCase();
            const matchKey = Object.keys(dict).find((k) => k.toLowerCase() === lower || k.toLowerCase().includes(lower));
            if (matchKey !== undefined) idx = dict[matchKey];
          }
          if (idx !== undefined && idx >= 0 && idx < infl.length) {
            const arr = this.morphBindings.get(key) ?? [];
            if (!arr.some((b) => b.mesh === mesh && b.index === idx)) {
              arr.push({ mesh, index: idx, target: 0, current: infl[idx] ?? 0 });
              this.morphBindings.set(key, arr);
            }
            foundAny[key] = true;
          }
        }
      }
    });
    this.morphModeA = Object.values(foundAny).some(Boolean);
    if (!this.morphModeA) report.warnings.push('No physique morph targets found; using bone fallback (Mode B).');
  }

  private bindBones(): void {
    this.boneBindings.clear();
    if (!this.avatarRoot) return;
    const root = this.avatarRoot;
    const defs: Array<{ key: string; human: VRMHumanBoneName[]; aliases: string[]; posture?: boolean }> = [
      { key: 'upperArm', human: ['leftUpperArm', 'rightUpperArm'], aliases: ['upperarm', 'upper_arm', 'arm_l', 'arm_r', 'leftarm', 'rightarm'] },
      { key: 'forearm', human: ['leftLowerArm', 'rightLowerArm'], aliases: ['lowerarm', 'lower_arm', 'forearm', 'leftforearm', 'rightforearm'] },
      { key: 'chest', human: ['chest', 'upperChest'], aliases: ['chest', 'upperchest', 'spine2', 'spine_02'], posture: true },
      { key: 'spine', human: ['spine'], aliases: ['spine', 'spine1', 'spine_01'], posture: true },
      { key: 'thigh', human: ['leftUpperLeg', 'rightUpperLeg'], aliases: ['upperleg', 'upper_leg', 'thigh', 'leftupleg', 'rightupleg'] },
      { key: 'calf', human: ['leftLowerLeg', 'rightLowerLeg'], aliases: ['lowerleg', 'lower_leg', 'calf', 'leftleg', 'rightleg', 'shin'] },
    ];
    const neckDef = { key: 'neck', human: ['neck'] as VRMHumanBoneName[], aliases: ['neck'], posture: true };
    const allDefs = [...defs, neckDef];

    for (const def of allDefs) {
      const nodes: THREE.Object3D[] = [];
      for (const h of def.human) {
        const n = getHumanoidBone(this.vrm, root, h, def.aliases);
        if (n && !nodes.includes(n)) nodes.push(n);
      }
      if (nodes.length === 0) {
        const fuzzy = fuzzyFindBone(root, def.aliases);
        if (fuzzy) nodes.push(fuzzy);
      }
      const bindings: BoneBinding[] = nodes.map((node) => {
        const children: Array<{ node: THREE.Object3D; baseScale: THREE.Vector3 }> = [];
        for (const child of node.children) children.push({ node: child, baseScale: child.scale.clone() });
        return {
          node,
          baseScale: node.scale.clone(),
          baseRotX: node.rotation.x,
          targetXZ: 1,
          currentXZ: 1,
          targetRotXDelta: 0,
          currentRotXDelta: 0,
          children,
        };
      });
      if (bindings.length > 0) this.boneBindings.set(def.key, bindings);
    }
  }

  updateState(state: SanctuaryVisualState): void {
    if (this.disposed) return;
    const next = clampSanctuaryVisualState(state);
    const stanceChanged = next.stanceId !== this.state.stanceId;
    const lowPowerChanged = next.lowPowerMode !== this.state.lowPowerMode;
    this.state = next;
    this.room.update(this.state.roomPropTiers);
    if (lowPowerChanged) this.applyLowPower(this.state.lowPowerMode);
    if (stanceChanged) this.applyStance(this.state.stanceId, false);
    if (this.avatarRoot) this.applyStateTargets(this.state);
  }

  private applyStateTargets(state: SanctuaryVisualState): void {
    const morphs = state.morphTargetWeights;
    const morphMap: Record<string, number> = {
      muscle_upper: morphs.muscle_upper,
      muscle_core: morphs.muscle_core,
      muscle_legs: morphs.muscle_legs,
      body_lean: morphs.body_lean,
      posture_upright: morphs.posture_upright,
    };
    for (const [key, bindings] of this.morphBindings.entries()) {
      const t = morphMap[key] ?? 0;
      for (const b of bindings) b.target = t;
    }

    const boneMap: Record<string, number> = {
      upperArm: state.boneScaleMultipliers.upperArm,
      forearm: state.boneScaleMultipliers.forearm,
      chest: state.boneScaleMultipliers.chest,
      spine: state.boneScaleMultipliers.spine,
      thigh: state.boneScaleMultipliers.thigh,
      calf: state.boneScaleMultipliers.calf,
    };
    for (const [key, bindings] of this.boneBindings.entries()) {
      const t = THREE.MathUtils.clamp(boneMap[key] ?? 1, SANCTUARY_CLAMP.boneScaleMin, SANCTUARY_CLAMP.boneScaleMax);
      for (const b of bindings) b.targetXZ = t;
    }
    const postureDelta = THREE.MathUtils.lerp(0, -0.18, state.morphTargetWeights.posture_upright);
    for (const key of ['spine', 'chest', 'neck']) {
      const bindings = this.boneBindings.get(key);
      if (!bindings) continue;
      const factor = key === 'spine' ? 0.5 : key === 'chest' ? 0.35 : 0.15;
      for (const b of bindings) b.targetRotXDelta = postureDelta * factor;
    }
  }

  private applyStateToAvatar(state: SanctuaryVisualState, dt: number, snap: boolean): void {
    this.applyStateTargets(state);
    for (const bindings of this.morphBindings.values()) {
      for (const b of bindings) {
        b.current = snap ? b.target : THREE.MathUtils.damp(b.current, b.target, DAMP_LAMBDA, dt);
        const infl = b.mesh.morphTargetInfluences;
        if (infl && b.index < infl.length) infl[b.index] = b.current;
      }
    }
    for (const [key, bindings] of this.boneBindings.entries()) {
      const hasMorph = this.morphBindings.has(key) && (this.morphBindings.get(key)?.length ?? 0) > 0;
      for (const b of bindings) {
        const useBoneScale = !hasMorph || key === 'upperArm' || key === 'forearm' || key === 'chest' || key === 'spine' || key === 'thigh' || key === 'calf';
        b.currentXZ = snap ? b.targetXZ : THREE.MathUtils.damp(b.currentXZ, b.targetXZ, DAMP_LAMBDA, dt);
        b.currentRotXDelta = snap ? b.targetRotXDelta : THREE.MathUtils.damp(b.currentRotXDelta, b.targetRotXDelta, DAMP_LAMBDA, dt);
        const xz = useBoneScale ? b.currentXZ : 1;
        b.node.scale.set(b.baseScale.x * xz, b.baseScale.y, b.baseScale.z * xz);
        if (key === 'spine' || key === 'chest' || key === 'neck') {
          b.node.rotation.x = b.baseRotX + b.currentRotXDelta;
        }
        const invXZ = xz !== 0 ? 1 / xz : 1;
        for (const child of b.children) {
          child.node.scale.set(child.baseScale.x * invXZ, child.baseScale.y, child.baseScale.z * invXZ);
        }
      }
    }
  }

  private applyStance(stance: StanceId, snap: boolean): void {
    this.currentStance = stance;
    this.proceduralStance = stance;
    if (!this.mixer) {
      this.proceduralBlend = 1;
      return;
    }
    const clip = this.findClipForStance(stance);
    if (!clip) {
      if (this.currentAction) {
        this.currentAction.fadeOut(snap ? 0 : STANCE_FADE[stance]);
        this.currentAction = null;
      }
      this.proceduralBlend = 1;
      return;
    }
    const nextAction = this.mixer.clipAction(clip);
    nextAction.enabled = true;
    nextAction.setEffectiveTimeScale(1);
    nextAction.setEffectiveWeight(1);
    nextAction.clampWhenFinished = true;
    nextAction.setLoop(THREE.LoopRepeat, Infinity);
    if (this.currentAction && this.currentAction !== nextAction) {
      nextAction.reset().play();
      this.currentAction.crossFadeTo(nextAction, snap ? 0 : STANCE_FADE[stance], false);
    } else if (!this.currentAction) {
      nextAction.reset().fadeIn(snap ? 0 : STANCE_FADE[stance]).play();
    }
    this.currentAction = nextAction;
    this.proceduralBlend = 0;
  }

  private findClipForStance(stance: StanceId): THREE.AnimationClip | null {
    if (this.clips.length === 0) return null;
    const hints: Record<StanceId, string[]> = {
      idle_calm: ['idle_calm', 'idle', 'calm', 'breath'],
      stance_guard: ['stance_guard', 'guard', 'defend', 'block'],
      shadowbox_combo: ['shadowbox_combo', 'shadowbox', 'punch', 'combo', 'fight'],
      meditation_sit: ['meditation_sit', 'meditat', 'sit', 'lotus'],
      study_focus: ['study_focus', 'study', 'focus', 'read', 'type'],
    };
    const names = hints[stance];
    for (const hint of names) {
      const found = this.clips.find((c) => c.name.toLowerCase().includes(hint));
      if (found) return found;
    }
    if (stance === 'idle_calm') return this.clips[0] ?? null;
    return null;
  }

  private applyProceduralPose(dt: number): void {
    if (!this.avatarRoot) return;
    this.proceduralTime += dt;
    const pose = createProceduralPose(this.proceduralStance, this.proceduralTime);
    const alpha = snapOrDampAlpha(this.proceduralBlend, 1, dt, 4.0);
    this.proceduralBlend = 1;

    const applyRot = (human: VRMHumanBoneName, aliases: string[], euler: THREE.Euler) => {
      const node = getHumanoidBone(this.vrm, this.avatarRoot as THREE.Group, human, aliases);
      if (!node) return;
      node.rotation.x = THREE.MathUtils.lerp(node.rotation.x, euler.x, alpha);
      node.rotation.y = THREE.MathUtils.lerp(node.rotation.y, euler.y, alpha);
      node.rotation.z = THREE.MathUtils.lerp(node.rotation.z, euler.z, alpha);
    };
    const applyX = (human: VRMHumanBoneName, aliases: string[], x: number) => {
      const node = getHumanoidBone(this.vrm, this.avatarRoot as THREE.Group, human, aliases);
      if (!node) return;
      node.rotation.x = THREE.MathUtils.lerp(node.rotation.x, node.rotation.x + x, alpha);
    };

    applyX('spine', ['spine'], pose.spine);
    applyX('chest', ['chest', 'upperchest'], pose.chest);
    applyX('neck', ['neck'], pose.neck);
    applyRot('leftUpperArm', ['leftupperarm', 'upperarm_l'], pose.leftUpperArm);
    applyRot('rightUpperArm', ['rightupperarm', 'upperarm_r'], pose.rightUpperArm);
    applyRot('leftLowerArm', ['leftlowerarm', 'forearm_l'], pose.leftLowerArm);
    applyRot('rightLowerArm', ['rightlowerarm', 'forearm_r'], pose.rightLowerArm);
    applyRot('leftUpperLeg', ['leftupperleg', 'thigh_l'], pose.leftUpperLeg);
    applyRot('rightUpperLeg', ['rightupperleg', 'thigh_r'], pose.rightUpperLeg);

    const hips = getHumanoidBone(this.vrm, this.avatarRoot, 'hips', ['hips', 'pelvis']);
    if (hips) {
      hips.position.y = THREE.MathUtils.lerp(hips.position.y, hips.position.y + pose.hipsY, alpha * 0.2);
    }
  }

  setLowPowerMode(on: boolean): void {
    if (this.disposed) return;
    this.state = { ...this.state, lowPowerMode: !!on };
    this.applyLowPower(this.state.lowPowerMode);
  }

  private applyLowPower(on: boolean): void {
    this.lowPower = !!on;
    this.renderer.setPixelRatio(this.lowPower ? 1 : this.baseDpr);
    this.renderer.shadowMap.enabled = !this.lowPower;
    this.fpsCap = this.lowPower ? 30 : 0;
    this.aura.setLowPower(this.lowPower);
    if (this.avatarRoot) {
      this.avatarRoot.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if ((mesh as any).isMesh || (mesh as any).isSkinnedMesh) {
          mesh.castShadow = !this.lowPower;
          mesh.receiveShadow = !this.lowPower;
        }
      });
    }
    if (this.lowPower) this.applyDrawRange(0.5);
    else this.applyDrawRange(1);
  }

  private applyDrawRange(fraction: number): void {
    if (!this.avatarRoot) return;
    const f = THREE.MathUtils.clamp(fraction, 0.1, 1);
    this.avatarRoot.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      const geom = mesh.geometry as THREE.BufferGeometry | undefined;
      if (!geom) return;
      const index = geom.getIndex();
      const total = index ? index.count : (geom.getAttribute('position')?.count ?? 0);
      if (total > 0) geom.setDrawRange(0, Math.floor(total * f));
    });
  }

  resize(w: number, h: number): void {
    if (this.disposed) return;
    const width = Math.max(1, Math.floor(w));
    const height = Math.max(1, Math.floor(h));
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private shouldRun(): boolean {
    return !this.disposed && !this.contextLost && this.visible && this.intersecting;
  }

  private syncLoop(): void {
    if (this.shouldRun()) this.startLoop();
    else this.stopLoop();
  }

  private startLoop(): void {
    if (this.rafId !== null) return;
    this.clock.getDelta();
    const tick = (now: number) => {
      if (!this.shouldRun()) { this.rafId = null; return; }
      this.rafId = requestAnimationFrame(tick);
      if (this.fpsCap > 0) {
        const minDelta = 1000 / this.fpsCap;
        if (now - this.lastFrameMs < minDelta) return;
        this.lastFrameMs = now - ((now - this.lastFrameMs) % minDelta);
      }
      const dt = Math.min(this.clock.getDelta(), 0.05);
      this.updateFrame(dt);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private updateFrame(dt: number): void {
    const t = this.clock.elapsedTime;
    if (this.mixer) this.mixer.update(dt);
    if (this.vrm) this.vrm.update(dt);
    if (this.avatarRoot) {
      this.applyStateToAvatar(this.state, dt, false);
      if (!this.currentAction || this.proceduralBlend >= 1 || !this.findClipForStance(this.currentStance)) {
        this.applyProceduralPose(dt);
      }
    }
    this.aura.update(t, this.state);
    this.renderer.render(this.scene, this.camera);
  }

  private clearAvatar(): void {
    if (this.currentAction) {
      this.currentAction.stop();
      this.currentAction = null;
    }
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.mixer.getRoot());
      this.mixer = null;
    }
    this.clips = [];
    this.morphBindings.clear();
    this.boneBindings.clear();
    this.morphModeA = false;
    if (this.avatarRoot) {
      if (this.avatarRoot.parent) this.avatarRoot.parent.remove(this.avatarRoot);
      disposeObject3D(this.avatarRoot);
      this.avatarRoot = null;
    }
    this.vrm = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost as EventListener, false);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored as EventListener, false);
    if (this.intersectionObserver) { this.intersectionObserver.disconnect(); this.intersectionObserver = null; }
    if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver = null; }

    this.clearAvatar();
    this.aura.dispose();
    this.room.dispose();

    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if ((mesh as any).isMesh || (mesh as any).isSkinnedMesh || (mesh as any).isPoints || (mesh as any).isLine) {
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = (mesh as any).material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach(disposeMaterial);
        else if (mat) disposeMaterial(mat);
      }
    });

    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}

function snapOrDampAlpha(current: number, target: number, dt: number, lambda: number): number {
  const next = THREE.MathUtils.damp(current, target, lambda, dt);
  return Math.abs(next - target) < 0.001 ? target : next;
}
