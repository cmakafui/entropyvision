"use client";

import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, Line, OrbitControls, useGLTF, Bvh } from "@react-three/drei";
import {
  EffectComposer,
  Bloom,
  Vignette,
  Noise,
} from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Plus,
  Trash2,
  Shuffle,
  Target,
  Layers,
  Waypoints,
  Info,
  Lightbulb,
  X,
} from "lucide-react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

// ---------------------------
// Core assets
// ---------------------------
useGLTF.setDecoderPath("https://www.gstatic.com/draco/v1/decoders/");
const MODEL_URL = "/hk_compressed.glb"; // place your GLB in public/
useGLTF.preload(MODEL_URL);

// ---------------------------
// Types & constants
// ---------------------------

type Mobility =
  | { kind: "static" }
  | {
      kind: "orbit"; // good for car loops
      center: THREE.Vector3;
      radius: number;
      altitude: number; // meters above ground
      angularSpeed: number; // radians per second
      phase?: number; // optional offset so multiple orbits don't sync
    }
  | {
      kind: "waypoint"; // NEW: follow waypoints in a loop
      points: THREE.Vector3[];
      speed: number; // m/s along the segment
      currentIdx: number; // index of current segment start
      progress: number; // 0..1 progress along current segment
    };

type Tx = {
  id: string;
  pos: THREE.Vector3; // meters in model space
  powerDbm: number; // dBm
  freqMHz: number; // MHz
  color: THREE.Color;
  mobility?: Mobility;
};

type PlacementMenuState = {
  worldPos: THREE.Vector3;
  screen: { x: number; y: number }; // viewport coords for menu
} | null;

type RayHop = {
  from: THREE.Vector3;
  to: THREE.Vector3;
  distance: number;
  fsplLoss: number; // dB
  reflLoss: number; // dB (0 for the first LOS hop)
  material: string; // "los" | materialType
  prAfter: number; // dBm after this hop
};

type RayBundle = {
  segments: {
    points: [THREE.Vector3, THREE.Vector3];
    los: boolean;
    color: THREE.Color;
    alpha: number;
  }[];
  hops: RayHop[];
  color: THREE.Color;
};

const DEFAULT_FREQ = 2400; // MHz
const DEFAULT_PWR = 36; // dBm
const MAX_BOUNCES = 2;
const MIN_POWER_DBM = -110; // terminate under this
const WALL_LOSS_DB = 25; // generic NLOS penalty

// Palette for transmitters
const TX_COLORS = ["#38bdf8", "#f472b6", "#f59e0b", "#34d399", "#a78bfa"].map(
  (c) => new THREE.Color(c)
);

// ---------------------------
// Math helpers
// ---------------------------
const fsplDb = (dMeters: number, fMHz: number) => {
  const dKm = Math.max(dMeters / 1000, 0.001);
  return 32.4 + 20 * Math.log10(fMHz) + 20 * Math.log10(dKm);
};

const reflect = (dir: THREE.Vector3, normal: THREE.Vector3) =>
  dir
    .clone()
    .sub(normal.clone().multiplyScalar(2 * dir.dot(normal)))
    .normalize();

const easeInOut = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

// Fibonacci sphere for near-uniform sampling
function fibonacciSphereDirs(n: number) {
  const dirs: THREE.Vector3[] = [];
  const phi = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(n - 1, 1)) * 2; // y from 1 to -1
    const radius = Math.sqrt(Math.max(1 - y * y, 0));
    const theta = phi * i;
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;
    dirs.push(new THREE.Vector3(x, y, z).normalize());
  }
  return dirs;
}

// Softmax with temperature, returns weights for color mixing and best index
function softmaxDbm(values: number[], temp = 4) {
  if (values.length === 0) return { weights: [], bestIdx: -1 };
  const maxv = Math.max(...values);
  const exps = values.map((v) => Math.exp((v - maxv) / temp));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  const weights = exps.map((e) => e / sum);
  const bestIdx = values.indexOf(Math.max(...values));
  return { weights, bestIdx };
}

// ---------------------------
// City Model with semantic materials (marks userData.materialType)
// ---------------------------

function Model({
  modelRef,
}: {
  modelRef: React.RefObject<THREE.Group | null>;
}) {
  const { scene } = useGLTF(MODEL_URL);

  const centered = useMemo(() => {
    const src = scene.clone();
    src.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(src);
    const center = box.getCenter(new THREE.Vector3());

    const root = new THREE.Group();
    root.position.set(-center.x, -center.y, -center.z);
    root.add(src);

    // global bounds
    const globalBox = new THREE.Box3().setFromObject(root);
    const globalMinY = globalBox.min.y;
    const globalMaxY = globalBox.max.y;
    const globalH = Math.max(globalMaxY - globalMinY, 1e-3);

    // Materials
    const waterMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#020617"),
      roughness: 0.25,
      metalness: 0.9,
    });
    const terrainMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#0f172a"),
      roughness: 0.95,
      metalness: 0.1,
    });
    const lowMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#1f2937"),
      roughness: 0.9,
      metalness: 0.2,
    });
    const midMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#e5e7eb"),
      roughness: 0.8,
      metalness: 0.3,
    });
    const highMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#e5e7eb"),
      emissive: new THREE.Color("#38bdf8"),
      emissiveIntensity: 0.25,
      roughness: 0.6,
      metalness: 0.5,
    });

    const tmp = new THREE.Vector3();

    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      // Only meshes
      if (!(mesh as THREE.Mesh & { isMesh?: boolean }).isMesh) return;

      const geom = mesh.geometry as THREE.BufferGeometry;
      if (!geom.boundingBox) geom.computeBoundingBox();
      const bb = geom.boundingBox!;
      mesh.getWorldPosition(tmp);

      const localH = bb.max.y - bb.min.y;
      const sizeX = bb.max.x - bb.min.x;
      const sizeZ = bb.max.z - bb.min.z;
      const footprint = sizeX * sizeZ;
      const worldMaxY = tmp.y + bb.max.y;
      const normH = (worldMaxY - globalMinY) / globalH;

      const flatish = localH < globalH * 0.03;
      const bigFootprint = footprint > globalH * globalH * 0.01;
      const waterLevel = globalMinY + globalH * 0.03;

      let mat: THREE.Material;
      let mtype = "concrete" as
        | "water"
        | "terrain"
        | "glass"
        | "concrete"
        | "metal";

      if (flatish && worldMaxY < waterLevel) {
        mat = waterMat;
        mtype = "water";
      } else if (flatish && bigFootprint) {
        mat = terrainMat;
        mtype = "terrain";
      } else {
        if (normH < 0.4) {
          mat = lowMat;
          mtype = "concrete";
        } else if (normH < 0.75) {
          mat = midMat;
          mtype = "concrete";
        } else {
          mat = highMat;
          mtype = "glass";
        }
      }

      mesh.material = mat;
      (mesh.userData as { materialType?: string }).materialType = mtype;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });

    return root;
  }, [scene]);

  return (
    <Bvh firstHitOnly>
      <group ref={modelRef}>
        <primitive object={centered} />
      </group>
    </Bvh>
  );
}

// ---------------------------
// Camera intro & helper to fly camera to a target
// ---------------------------
function CameraSetup({
  modelRef,
  controlsRef,
}: {
  modelRef: React.RefObject<THREE.Group | null>;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}) {
  const { camera } = useThree();
  const hasInit = useRef(false);
  const centerRef = useRef(new THREE.Vector3());
  const startRef = useRef(new THREE.Vector3());
  const targetRef = useRef(new THREE.Vector3());
  const tRef = useRef(0);
  const animRef = useRef(false);

  useFrame((_, delta) => {
    if (!animRef.current) return;
    tRef.current += delta / 4; // 4s
    const t = Math.min(tRef.current, 1);
    const k = easeInOut(t);
    camera.position.lerpVectors(startRef.current, targetRef.current, k);
    camera.lookAt(centerRef.current);
    if (controlsRef.current) {
      const was = controlsRef.current.enableDamping;
      controlsRef.current.enableDamping = false;
      controlsRef.current.target.copy(centerRef.current);
      controlsRef.current.update();
      controlsRef.current.enableDamping = was;
    }
    if (t >= 1) {
      animRef.current = false;
      if (controlsRef.current) {
        controlsRef.current.enabled = true;
      }
    }
  });

  useEffect(() => {
    if (!modelRef.current || hasInit.current) return;
    modelRef.current.updateWorldMatrix(true, true);

    const box = new THREE.Box3().setFromObject(modelRef.current);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    centerRef.current.copy(
      center.length() < 1e-3 ? new THREE.Vector3() : center
    );

    const fov =
      camera instanceof THREE.PerspectiveCamera
        ? (camera.fov * Math.PI) / 180
        : (50 * Math.PI) / 180;
    const frameDist = (maxDim / (2 * Math.tan(fov / 2))) * 1.8;

    const angle = Math.PI / 4; // hero
    const h = maxDim * 0.6;
    const r = frameDist * 0.9;
    targetRef.current.set(
      center.x + r * Math.cos(angle),
      center.y + h,
      center.z + r * Math.sin(angle)
    );

    const startH = maxDim * 4;
    startRef.current.set(center.x, center.y + startH, center.z);

    camera.position.copy(startRef.current);
    camera.lookAt(center);

    if (controlsRef.current) {
      controlsRef.current.target.copy(center);
      controlsRef.current.enabled = false;
      controlsRef.current.update();
    }

    tRef.current = 0;
    animRef.current = true;
    hasInit.current = true;
  }, [camera, modelRef, controlsRef]);

  // Helper to fly camera
  useEffect(() => {
    (
      window as Window & {
        __radioCityFlyTo?: (pos: THREE.Vector3, lookAt: THREE.Vector3) => void;
      }
    ).__radioCityFlyTo = (pos: THREE.Vector3, lookAt: THREE.Vector3) => {
      startRef.current.copy(camera.position);
      targetRef.current.copy(pos);
      centerRef.current.copy(lookAt);
      tRef.current = 0;
      animRef.current = true;
      // Disable controls during animation
      if (controlsRef.current) {
        controlsRef.current.enabled = false;
      }
    };
    return () => {
      delete (
        window as Window & {
          __radioCityFlyTo?: (
            pos: THREE.Vector3,
            lookAt: THREE.Vector3
          ) => void;
        }
      ).__radioCityFlyTo;
    };
  }, [camera, controlsRef]);

  return null;
}

// ---------------------------
// Atmosphere
// ---------------------------
function CityAtmosphere() {
  const { scene } = useThree();
  useEffect(() => {
    const bg = new THREE.Color("#020617");
    const fog = new THREE.FogExp2(bg, 0.00012);
    Object.assign(scene, { background: bg, fog });
  }, [scene]);
  return null;
}

// ---------------------------
// Moving TX Controller
// ---------------------------
function MovingTxController({ txs }: { txs: Tx[] }) {
  const timeRef = useRef(0);

  useFrame((_, dt) => {
    timeRef.current += dt;
    const t = timeRef.current;

    txs.forEach((tx, idx) => {
      const m = tx.mobility;
      if (!m || m.kind === "static") return;

      if (m.kind === "orbit") {
        const phase = m.phase ?? idx * 0.8;
        const theta = phase + t * m.angularSpeed;

        tx.pos.set(
          m.center.x + Math.cos(theta) * m.radius,
          m.center.y + m.altitude,
          m.center.z + Math.sin(theta) * m.radius
        );
      }

      // NEW: waypoint following
      if (m.kind === "waypoint") {
        const { points, speed } = m;
        if (points.length < 2) return;

        const from = points[m.currentIdx];
        const to = points[(m.currentIdx + 1) % points.length];
        const dist = from.distanceTo(to);

        // Move progress along current segment
        m.progress += (speed * dt) / Math.max(dist, 1e-6);

        if (m.progress >= 1) {
          m.progress = 0;
          m.currentIdx = (m.currentIdx + 1) % points.length; // loop
        }

        tx.pos.lerpVectors(from, to, m.progress);
      }
    });
  });

  return null;
}

// ---------------------------
// Keyboard nav (WASD + QE)
// ---------------------------
function KeyboardNavigation({
  controlsRef,
  bounds,
}: {
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  bounds?: CityGeometry["bounds"] | null;
}) {
  const { camera } = useThree();
  const keys = useRef<Record<string, boolean>>({
    KeyW: false,
    KeyA: false,
    KeyS: false,
    KeyD: false,
    KeyQ: false,
    KeyE: false,
    Space: false,
    ControlLeft: false,
    ControlRight: false,
    ShiftLeft: false,
    ShiftRight: false,
  });

  const moveRef = useRef(new THREE.Vector3());
  const fwdRef = useRef(new THREE.Vector3());
  const rightRef = useRef(new THREE.Vector3());
  const upRef = useRef(new THREE.Vector3());

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      if (e.code in keys.current) {
        keys.current[e.code] = true;
        // Prevent space from scrolling the page, and Q/E from triggering browser shortcuts
        if (e.code === "Space" || e.code === "KeyQ" || e.code === "KeyE") {
          e.preventDefault();
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code in keys.current) keys.current[e.code] = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useFrame((_, dt) => {
    const ctr = controlsRef.current;
    if (!ctr) return;
    const st = keys.current;
    const move = moveRef.current.set(0, 0, 0);
    const fwd = fwdRef.current;
    const right = rightRef.current;
    const up = upRef.current.copy(camera.up).normalize();
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() === 0) {
      fwd.set(0, 0, -1);
    } else {
      fwd.normalize();
    }
    right.crossVectors(fwd, up).normalize();
    if (st.KeyW) move.add(fwd);
    if (st.KeyS) move.sub(fwd);
    if (st.KeyA) move.sub(right);
    if (st.KeyD) move.add(right);
    if (st.KeyQ) move.add(up);
    if (st.KeyE) move.sub(up);
    if (st.Space) move.add(up);
    if (st.ControlLeft || st.ControlRight) move.sub(up);
    if (move.lengthSq() === 0) return;
    move.normalize();
    const dist = camera.position.distanceTo(ctr.target);
    // Base speed is higher, and less dependent on distance
    let speed = Math.max(150, 100 + dist * 0.1);
    if (st.ShiftLeft || st.ShiftRight) speed *= 3;
    const step = speed * dt;
    move.multiplyScalar(step);

    // ==== NEW: compute clamped next positions ====
    const nextCam = camera.position.clone().add(move);
    const nextTarget = ctr.target.clone().add(move);

    if (bounds) {
      const padding = 40; // small buffer around the city
      const floorOffset = 5; // keep camera some units above min Y

      const minY = bounds.min.y + floorOffset;
      const maxY = bounds.max.y + 400; // don't fly *too* high if you want

      const minX = bounds.min.x - padding;
      const maxX = bounds.max.x + padding;
      const minZ = bounds.min.z - padding;
      const maxZ = bounds.max.z + padding;

      nextCam.y = THREE.MathUtils.clamp(nextCam.y, minY, maxY);
      nextTarget.y = THREE.MathUtils.clamp(nextTarget.y, minY, maxY);

      nextCam.x = THREE.MathUtils.clamp(nextCam.x, minX, maxX);
      nextTarget.x = THREE.MathUtils.clamp(nextTarget.x, minX, maxX);

      nextCam.z = THREE.MathUtils.clamp(nextCam.z, minZ, maxZ);
      nextTarget.z = THREE.MathUtils.clamp(nextTarget.z, minZ, maxZ);
    }

    camera.position.copy(nextCam);
    ctr.target.copy(nextTarget);

    // Only update if damping is enabled, otherwise it's redundant
    if (ctr.enableDamping) {
      ctr.update();
    }
  });
  return null;
}

// ---------------------------
// Ray engine
// ---------------------------
type CityGeometry = {
  meshes: THREE.Mesh[];
  bounds: {
    min: THREE.Vector3;
    max: THREE.Vector3;
    size: THREE.Vector3;
    center: THREE.Vector3;
  } | null;
};

function useCityGeometry(
  modelRef: React.RefObject<THREE.Group | null>
): CityGeometry {
  const [meshes, setMeshes] = useState<THREE.Mesh[]>([]);
  const [bounds, setBounds] = useState<CityGeometry["bounds"]>(null);

  useEffect(() => {
    const root = modelRef.current;
    if (!root) {
      // If the model is not ready yet, just bail out.
      // We rely on the dependency on modelRef.current to re-run when it appears.
      return;
    }

    const collected: THREE.Mesh[] = [];
    root.traverse((o) => {
      // @ts-expect-error runtime check from three
      if (o.isMesh) collected.push(o as THREE.Mesh);
    });

    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    setMeshes(collected);
    setBounds({
      min: box.min.clone(),
      max: box.max.clone(),
      size,
      center,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelRef.current]); // <-- important: depend on the *current* node

  return { meshes, bounds };
}

function materialReflectionLossDb(
  mesh: THREE.Object3D | null,
  normal: THREE.Vector3,
  dirIn: THREE.Vector3
) {
  const matType = (mesh?.userData as { materialType?: string })?.materialType;
  const grazing =
    1 - Math.abs(normal.clone().normalize().dot(dirIn.clone().normalize())); // 0 head-on, 1 grazing
  if (matType === "glass") return 10 + 10 * grazing; // 10-20 dB
  if (matType === "metal") return 0 + 3 * grazing; // 0-3 dB
  return 3 + 6 * grazing; // concrete default
}

function buildRayBundle(
  tx: Tx,
  meshes: THREE.Object3D[],
  rayCount: number,
  maxBounces = MAX_BOUNCES
): RayBundle[] {
  if (!meshes.length) return [];
  const dirs = fibonacciSphereDirs(rayCount);
  const rc = new THREE.Raycaster();
  const bundles: RayBundle[] = [];

  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i].clone();
    let origin = tx.pos.clone().add(dir.clone().multiplyScalar(0.5));
    let power = tx.powerDbm;
    const hops: RayHop[] = [];
    const segments: RayBundle["segments"] = [];
    let bounces = 0;
    let first = true;

    while (bounces <= maxBounces && power > MIN_POWER_DBM) {
      rc.set(origin, dir);
      rc.far = 5000;
      const hits = rc.intersectObjects(meshes, true);
      if (!hits.length) break;
      const hit = hits[0];
      const d = hit.distance;
      const fspl = fsplDb(d, tx.freqMHz);
      power -= fspl;
      const p = hit.point.clone();

      const n = hit.face?.normal
        ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
        : new THREE.Vector3(0, 1, 0);
      const refl = first ? 0 : materialReflectionLossDb(hit.object, n, dir);
      if (!first) power -= refl;

      hops.push({
        from: origin.clone(),
        to: p.clone(),
        distance: d,
        fsplLoss: fspl,
        reflLoss: refl,
        material: first
          ? "los"
          : (hit.object.userData as { materialType?: string })?.materialType ||
            "concrete",
        prAfter: power,
      });
      segments.push({
        points: [origin.clone(), p.clone()],
        los: first,
        color: tx.color,
        alpha: THREE.MathUtils.clamp(
          (power - MIN_POWER_DBM) / (DEFAULT_PWR - MIN_POWER_DBM),
          0.15,
          1
        ),
      });

      // Reflect to continue
      const newDir = reflect(dir, n);
      origin = p.clone().add(newDir.clone().multiplyScalar(0.25));
      dir.copy(newDir);
      first = false;
      bounces++;
      if (power <= MIN_POWER_DBM) break;
    }

    if (segments.length) bundles.push({ segments, hops, color: tx.color });
  }

  return bundles;
}

// ---------------------------
// Signal wavefronts (pulsing rings around TX)
// ---------------------------
function SignalWaves({ txs }: { txs: Tx[] }) {
  const groupRef = useRef<THREE.Group>(null);
  const NUM_WAVES = 3;

  useFrame(({ clock }) => {
    const group = groupRef.current;
    if (!group) return;
    const t = clock.getElapsedTime();
    const dummyPos = new THREE.Vector3();

    let idx = 0;
    txs.forEach((tx, txIdx) => {
      for (let w = 0; w < NUM_WAVES; w++) {
        const mesh = group.children[idx] as THREE.Mesh | undefined;
        if (!mesh) {
          idx++;
          continue;
        }

        // Phase in [0,1) – staggered per ring & TX
        const phase = (t * 0.35 + w * 0.3 + txIdx * 0.17) % 1.0;

        // Radius grows from inner to outer
        const radius = THREE.MathUtils.lerp(12, 260, phase);

        // Soft fade in/out over the cycle
        const pulse = 1.0 - Math.abs(phase - 0.5) * 2.0; // 1 at mid, 0 at edges
        const mat = mesh.material as THREE.MeshBasicMaterial;

        dummyPos.copy(tx.pos);
        dummyPos.y += 1.0;

        mesh.position.copy(dummyPos);
        mesh.scale.set(radius, radius, radius);
        mat.opacity = 0.15 + 0.55 * pulse; // 0.15–0.7

        idx++;
      }
    });
  });

  if (!txs.length) return null;

  return (
    <group ref={groupRef}>
      {txs.map((tx) =>
        Array.from({ length: NUM_WAVES }).map((_, i) => (
          <mesh
            key={`${tx.id}-wave-${i}`}
            rotation-x={-Math.PI / 2}
            renderOrder={-0.5}
          >
            <ringGeometry args={[1, 1.35, 64]} />
            <meshBasicMaterial
              color={"#" + tx.color.getHexString()}
              transparent
              opacity={0.4}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </mesh>
        ))
      )}
    </group>
  );
}

// ---------------------------
// Signal particles flowing along ray paths
// ---------------------------
type SignalParticlesProps = {
  bundlesByTx: Record<string, RayBundle[]>;
};

type SignalParticleSample = {
  from: THREE.Vector3;
  to: THREE.Vector3;
  color: THREE.Color;
  strength: number; // 0..1
  phase: number; // 0..1, random offset
};

function SignalParticles({ bundlesByTx }: SignalParticlesProps) {
  const instRef = useRef<THREE.InstancedMesh>(null);

  const particles = useMemo<SignalParticleSample[]>(() => {
    const result: SignalParticleSample[] = [];

    Object.values(bundlesByTx).forEach((bundles) => {
      bundles.forEach((bundle) => {
        bundle.hops.forEach((hop) => {
          // Only decorate reasonably strong segments
          if (hop.prAfter < -85) return;

          // One or two particles per hop is enough
          const count = 2;
          for (let i = 0; i < count; i++) {
            result.push({
              from: hop.from.clone(),
              to: hop.to.clone(),
              color: bundle.color.clone(),
              strength: THREE.MathUtils.clamp(
                (hop.prAfter - MIN_POWER_DBM) / (DEFAULT_PWR - MIN_POWER_DBM),
                0,
                1
              ),
              phase: Math.random(),
            });
          }
        });
      });
    });

    return result;
  }, [bundlesByTx]);

  useFrame(({ clock }) => {
    const inst = instRef.current;
    if (!inst || particles.length === 0) return;
    const t = clock.getElapsedTime();
    const dummy = new THREE.Object3D();

    particles.forEach((p, i) => {
      const localT = (t * 0.7 + p.phase) % 1.0;
      const pos = new THREE.Vector3().lerpVectors(p.from, p.to, localT);

      const size = 0.6 + p.strength * 1.4;
      dummy.position.copy(pos);
      dummy.scale.setScalar(size);
      dummy.lookAt(pos.clone().add(new THREE.Vector3(0, 1, 0))); // just to stabilise matrix
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);

      const c = p.color
        .clone()
        .lerp(new THREE.Color("#ffffff"), 0.5 * p.strength);
      inst.setColorAt(i, c);
    });

    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  });

  if (!particles.length) return null;

  return (
    <instancedMesh
      ref={instRef}
      args={
        [undefined, undefined, particles.length] as [
          THREE.BufferGeometry | undefined,
          THREE.Material | undefined,
          number
        ]
      }
      frustumCulled={false}
      renderOrder={5}
    >
      <sphereGeometry args={[0.9, 10, 10]} />
      <meshBasicMaterial
        vertexColors
        transparent
        opacity={0.95}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </instancedMesh>
  );
}

// ---------------------------
// Presets & helpers
// ---------------------------
function useBounds(modelRef: React.RefObject<THREE.Group | null>) {
  const { bounds } = useCityGeometry(modelRef);
  return bounds;
}

function makeTx(
  pos: THREE.Vector3,
  idx: number,
  mobility: Mobility = { kind: "static" }
): Tx {
  return {
    id: crypto.randomUUID(),
    pos,
    powerDbm: DEFAULT_PWR,
    freqMHz: DEFAULT_FREQ,
    color: TX_COLORS[idx % TX_COLORS.length].clone(),
    mobility,
  };
}

// ---------------------------
// Interference slice (GPU shader) – moving interference fringes
// ---------------------------
const MAX_TX = 8; // Fixed shader array size - must match GLSL #define MAX_TX

function InterferenceField({
  txs,
  modelRef,
  visible = true,
  yOffset = 4.0, // lift above ground to avoid z-fighting
  phaseTimeScale = 1e-9, // uPhaseTimeScale slows GHz oscillations down to ~Hz so humans can see them
  intensityScale = 6.0, // boosts contrast; tweak to taste
  spatialScale = 0.03, // Stretch fringes in space (0.03 = ~3m visual spacing instead of sub-meter RF fringes)
}: {
  txs: Tx[];
  modelRef: React.RefObject<THREE.Group | null>;
  visible?: boolean;
  yOffset?: number;
  phaseTimeScale?: number;
  intensityScale?: number;
  spatialScale?: number;
}) {
  const bounds = useBounds(modelRef);
  const matRef = useRef<THREE.ShaderMaterial>(null);

  // Initialize arrays once - these are mutable and will be updated in useEffect
  // Using useState with lazy initializer to create arrays once, then mutating their contents
  // This is the standard pattern for Three.js shader uniforms
  const [arrays] = useState(() => ({
    posArray: new Array(MAX_TX).fill(0).map(() => new THREE.Vector3()),
    freqArray: new Float32Array(MAX_TX),
    powArray: new Float32Array(MAX_TX),
  }));

  // Create uniforms with arrays that will be updated in useEffect
  const uniforms = useMemo(() => {
    return {
      uTime: { value: 0 },
      uTxCount: { value: Math.min(txs.length, MAX_TX) },
      uIntensityScale: { value: intensityScale },
      uPhaseTimeScale: { value: phaseTimeScale },
      uSpatialScale: { value: spatialScale },
      uPos: { value: arrays.posArray }, // Vector3[] - Three.js handles array uniforms
      uFreq: { value: arrays.freqArray }, // Float32Array
      uPow: { value: arrays.powArray }, // Float32Array
    };
  }, [intensityScale, phaseTimeScale, spatialScale, txs.length, arrays]);

  // Update uniforms when TX change (initial setup)
  useEffect(() => {
    // Note: Modifying array contents (not references) is intentional for Three.js uniforms.
    // We're updating mutable array elements, not the state object itself.
    // This is a standard pattern for efficient shader uniform updates.
    const { posArray, freqArray, powArray } = arrays;
    const m = Math.min(txs.length, MAX_TX);
    for (let i = 0; i < MAX_TX; i++) {
      if (i < m) {
        posArray[i].copy(txs[i].pos);
        freqArray[i] = txs[i].freqMHz * 1e6; // Hz
        // Convert dBm -> arbitrary amplitude scale; visually tuned.
        // Roughly: power(W)=10^((dBm-30)/10). Amplitude ~ sqrt(W).
        const watts = Math.pow(10, (txs[i].powerDbm - 30) / 10);
        powArray[i] = Math.sqrt(watts); // amplitude proxy
      } else {
        posArray[i].set(1e9, 1e9, 1e9); // move off-screen
        freqArray[i] = 0;
        powArray[i] = 0;
      }
    }
    if (matRef.current) {
      matRef.current.uniforms.uTxCount.value = m;
      matRef.current.uniforms.uFreq.value = freqArray;
      matRef.current.uniforms.uPow.value = powArray;
      matRef.current.uniforms.uPos.value = posArray;
      matRef.current.uniforms.uSpatialScale.value = spatialScale;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txs.length, spatialScale]);

  // Update positions every frame to follow moving TXs
  useFrame(({ clock }) => {
    if (!matRef.current) return;
    const t = clock.getElapsedTime();
    matRef.current.uniforms.uTime.value = t;

    const { posArray, freqArray, powArray } = arrays;
    const m = Math.min(txs.length, MAX_TX);

    for (let i = 0; i < MAX_TX; i++) {
      if (i < m) {
        posArray[i].copy(txs[i].pos);
        freqArray[i] = txs[i].freqMHz * 1e6;
        const watts = Math.pow(10, (txs[i].powerDbm - 30) / 10);
        powArray[i] = Math.sqrt(watts);
      } else {
        posArray[i].set(1e9, 1e9, 1e9);
        freqArray[i] = 0;
        powArray[i] = 0;
      }
    }

    matRef.current.uniforms.uTxCount.value = m;
    matRef.current.uniforms.uPos.value = posArray;
    matRef.current.uniforms.uFreq.value = freqArray;
    matRef.current.uniforms.uPow.value = powArray;
  });

  if (!bounds || !visible) return null;

  const { min, center, size } = bounds;

  const vertexShader = /* glsl */ `
    varying vec3 vWorld;
    void main() {
      vec4 w = modelMatrix * vec4(position, 1.0);
      vWorld = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }
  `;

  const fragmentShader = /* glsl */ `
    precision highp float;
    varying vec3 vWorld;

    // uniforms
    uniform float uTime;
    uniform int   uTxCount;
    uniform float uIntensityScale;
    uniform float uPhaseTimeScale;
    uniform float uSpatialScale;
    // NOTE: MAX_TX is fixed at compile time (8). Must match the constant in the component.
    #define MAX_TX 8

    uniform vec3  uPos[MAX_TX];
    uniform float uFreq[MAX_TX]; // Hz
    uniform float uPow[MAX_TX];  // amplitude proxy

    // constants
    const float PI = 3.14159265358979323846;
    const float C  = 299792458.0; // m/s

    // quick tri-color map (dark blue -> cyan -> magenta)
    vec3 palette(float x) {
      x = clamp(x, 0.0, 1.0);
      vec3 a = vec3(0.06, 0.08, 0.22);
      vec3 b = vec3(0.10, 0.70, 1.00);
      vec3 c = vec3(0.98, 0.20, 0.80);
      vec3 col = mix(a, b, smoothstep(0.0, 0.7, x));
      col = mix(col, c, smoothstep(0.6, 1.0, x));
      return col;
    }

    void main() {
      // sum time-varying field from all TX
      float E = 0.0;

      for (int i = 0; i < MAX_TX; i++) {
        if (i >= uTxCount) break;

        vec3 dvec = vWorld - uPos[i];
        float d   = length(dvec) + 1e-3;

        float f = uFreq[i];
        if (f <= 0.0) continue;

        float lambda = C / f;
        float k_phys = 2.0 * PI / lambda;    // physical wavenumber
        float omega = 2.0 * PI * f;          // angular frequency

        // Stretch fringes in space by spatialScale so city-scale bands are visible
        // instead of sub-meter RF fringes (which would appear as dense speckle)
        float k = k_phys * uSpatialScale;

        // Slow down phase so GHz is viewable; keep correct spatial k*d.
        float phase = (omega * uTime * uPhaseTimeScale) - (k * d);

        // amplitude ~ sqrt(power) / d  (visual, not exact physics)
        float A = uPow[i] / d;

        E += A * cos(phase);
      }

      // intensity ~ E^2, compress for display
      float I = E * E * uIntensityScale;
      float v = 1.0 - exp(-I); // softroll (0..~1)

      vec3 col = palette(v);
      gl_FragColor = vec4(col, 0.8);

      // additive look, but keep alpha for layering
    }
  `;

  return (
    <mesh
      position={[center.x, min.y + yOffset, center.z]}
      rotation={[-Math.PI / 2, 0, 0]}
      renderOrder={-1}
    >
      <planeGeometry args={[size.x, size.z, 1, 1]} />
      <shaderMaterial
        ref={matRef}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </mesh>
  );
}

// ---------------------------
// Probe Payload type (shared)
// ---------------------------
type ProbePayload = {
  rows: Array<{
    idx: number;
    pr: number;
    los: boolean;
    dist: string;
    freq: number;
  }>;
  bestIdx: number;
  margin: number;
  bestPower: number;
  qualityTier: "excellent" | "good" | "fair" | "poor" | "dead";
  interferenceCount: number;
  handoverStable: boolean;
  weights: number[];
};

// ---------------------------
// Path Mover (moving car along path)
// ---------------------------
function PathMover({
  points,
  txs,
  meshes,
  onProbe,
  controlsRef,
  chase,
}: {
  points: THREE.Vector3[];
  txs: Tx[];
  meshes: THREE.Object3D[];
  onProbe?: (p: THREE.Vector3, payload: ProbePayload) => void;
  controlsRef?: React.RefObject<OrbitControlsImpl | null>;
  chase?: boolean;
}) {
  const moverRef = useRef<THREE.Group>(null);
  const tmpPos = useRef(new THREE.Vector3());
  const rc = useMemo(() => new THREE.Raycaster(), []);

  type PathSegment = {
    from: THREE.Vector3;
    to: THREE.Vector3;
    length: number;
    startDist: number;
  };

  const data = useMemo(() => {
    if (points.length < 2) {
      return { segments: [] as PathSegment[], total: 0 };
    }

    const segments: PathSegment[] = [];
    let acc = 0;

    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i];
      const to = points[i + 1];
      const length = from.distanceTo(to);
      const safeLen = Math.max(length, 1e-3);
      segments.push({ from, to, length: safeLen, startDist: acc });
      acc += safeLen;
    }

    return { segments, total: acc };
  }, [points]);

  const distRef = useRef(0);

  useFrame((state, dt) => {
    const mover = moverRef.current;
    const { segments, total } = data;
    if (!mover || segments.length === 0 || total <= 0) return;

    const speed = 35; // m/s along path
    const cycle = 2 * total; // ping-pong over [0, 2L)

    distRef.current = (distRef.current + speed * dt) % cycle;
    let d = distRef.current;

    // Ping-pong: 0→L→0
    if (d > total) d = 2 * total - d;

    // Find segment where this distance lies
    let seg = segments[segments.length - 1];
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (d >= s.startDist && d <= s.startDist + s.length) {
        seg = s;
        break;
      }
    }

    const local = (d - seg.startDist) / seg.length;
    const pos = tmpPos.current.lerpVectors(seg.from, seg.to, local);

    // Lift slightly above the ground so it doesn't clip
    pos.y += 3;

    mover.position.copy(pos);

    // Optional: tiny breathing/pulse
    const t = state.clock.getElapsedTime();
    const pulse = 0.8 + 0.2 * Math.sin(t * 4);
    mover.scale.setScalar(pulse);

    // ⬇️ NEW: treat the car as a moving probe
    if (onProbe && txs.length && meshes.length) {
      const payload = probeAtWithRc(rc, pos, txs, meshes);
      onProbe(pos, payload); // no clone needed anymore
    }

    // Chase cam: smoothly follow the car
    if (chase && controlsRef?.current) {
      controlsRef.current.target.lerp(pos, 0.2);
    }
  });

  if (data.segments.length === 0) return null;

  return (
    <group ref={moverRef} renderOrder={20}>
      <mesh>
        <sphereGeometry args={[3.2, 24, 24]} />
        <meshStandardMaterial
          color="#f97316"
          emissive="#fdba74"
          emissiveIntensity={2.5}
          metalness={0.4}
          roughness={0.3}
          depthTest={false}
        />
      </mesh>
    </group>
  );
}

// ---------------------------
// RF Probe helper (reusable, optimized with raycaster reuse)
// ---------------------------
function probeAtWithRc(
  rc: THREE.Raycaster,
  p: THREE.Vector3,
  txs: Tx[],
  meshes: THREE.Object3D[]
): ProbePayload {
  const pr: number[] = [];
  const rows: ProbePayload["rows"] = [];

  txs.forEach((t, idx) => {
    const dir = t.pos.clone().sub(p);
    const dist = dir.length();
    dir.normalize();
    rc.set(p, dir);
    rc.far = Math.max(dist - 0.25, 0.25);
    const los = !rc.intersectObjects(meshes, true)[0];
    const pl = fsplDb(dist, t.freqMHz) + (los ? 0 : WALL_LOSS_DB);
    const val = t.powerDbm - pl;
    pr.push(val);
    rows.push({
      idx: idx + 1,
      pr: val,
      los,
      dist: dist.toFixed(1),
      freq: t.freqMHz,
    });
  });

  const { weights, bestIdx } = softmaxDbm(pr, 4);
  const sorted = [...pr].sort((a, b) => b - a);
  const best = sorted[0] ?? -Infinity;
  const secondBest = sorted[1] ?? best;
  const margin = best - secondBest;

  let qualityTier: ProbePayload["qualityTier"];
  if (best > -70) qualityTier = "excellent";
  else if (best > -85) qualityTier = "good";
  else if (best > -100) qualityTier = "fair";
  else if (best > MIN_POWER_DBM) qualityTier = "poor";
  else qualityTier = "dead";

  const interferenceCount = pr.filter((v) => v > -80).length;
  const handoverStable = margin >= 3.0;

  return {
    rows,
    bestIdx: (bestIdx >= 0 ? bestIdx : 0) + 1,
    margin,
    bestPower: best,
    qualityTier,
    interferenceCount,
    handoverStable,
    weights,
  };
}

// Convenience wrapper that creates its own raycaster (for backward compatibility)
function probeAt(
  p: THREE.Vector3,
  txs: Tx[],
  meshes: THREE.Object3D[]
): ProbePayload {
  const rc = new THREE.Raycaster();
  return probeAtWithRc(rc, p, txs, meshes);
}

// ---------------------------
// Color helper for RF power
// ---------------------------
function colorForDbm(dbm: number): THREE.Color {
  // Red → Orange → Yellow → Green based on best power
  if (dbm <= -100) return new THREE.Color("#ef4444");
  if (dbm <= -90) return new THREE.Color("#f97316");
  if (dbm <= -80) return new THREE.Color("#f59e0b");
  return new THREE.Color("#22c55e");
}

// ---------------------------
// Path RF Overlay (heat-line with handover markers)
// ---------------------------
function PathRfOverlay({
  points,
  txs,
  meshes,
}: {
  points: THREE.Vector3[];
  txs: Tx[];
  meshes: THREE.Object3D[];
}) {
  const { samples, colors, handovers } = useMemo(() => {
    const outPts: THREE.Vector3[] = [];
    const outCols: [number, number, number][] = [];
    const hMarkers: { pos: THREE.Vector3; from: number; to: number }[] = [];

    if (points.length < 2 || txs.length === 0 || meshes.length === 0) {
      return { samples: outPts, colors: outCols, handovers: hMarkers };
    }

    const STEP = 6; // meters between samples along the polyline
    let lastBest = -1;

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const segLen = Math.max(a.distanceTo(b), 1e-6);
      const count = Math.max(2, Math.ceil(segLen / STEP));

      for (let k = 0; k < count; k++) {
        const t = k / (count - 1);
        const p = new THREE.Vector3().lerpVectors(a, b, t);
        // keep the path at ground + small lift
        p.y = points[i].y;

        const payload = probeAt(p, txs, meshes);
        outPts.push(p);
        const col = colorForDbm(payload.bestPower);
        outCols.push([col.r, col.g, col.b]);

        if (lastBest !== -1 && payload.bestIdx !== lastBest) {
          hMarkers.push({
            pos: p.clone(),
            from: lastBest,
            to: payload.bestIdx,
          });
        }
        lastBest = payload.bestIdx;
      }
    }

    return { samples: outPts, colors: outCols, handovers: hMarkers };
  }, [points, txs, meshes]);

  // Create line with vertex colors
  const lineObject = useMemo(() => {
    if (samples.length < 2) return null;

    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(samples.length * 3);
    const colorArray = new Float32Array(samples.length * 3);

    samples.forEach((p, i) => {
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;

      const [r, g, b] = colors[i] || [1, 1, 1];
      colorArray[i * 3] = r;
      colorArray[i * 3 + 1] = g;
      colorArray[i * 3 + 2] = b;
    });

    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(colorArray, 3));

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      linewidth: 3,
    });

    return new THREE.Line(geom, material);
  }, [samples, colors]);

  if (!lineObject) return null;

  return (
    <group renderOrder={18}>
      {/* Thick path with per-vertex colors */}
      <primitive object={lineObject} />
      {/* Handover pins */}
      {handovers.map((h, i) => (
        <group key={i} position={h.pos}>
          <mesh>
            <sphereGeometry args={[2.2, 16, 16]} />
            <meshStandardMaterial
              color="#93c5fd"
              emissive="#60a5fa"
              emissiveIntensity={1.8}
            />
          </mesh>
          <Html distanceFactor={10} position={[0, 6, 0]}>
            <div className="rounded-full border border-blue-300/40 bg-black/80 px-1.5 py-0.5 text-[9px] font-mono text-blue-200 shadow">
              TX {h.from} → TX {h.to}
            </div>
          </Html>
        </group>
      ))}
    </group>
  );
}

// ---------------------------
// Scene wrapper
// ---------------------------
function Scene({
  controlsRef,
  txs,
  showRays,
  showInterf,
  modelRef,
  onCityClick,
  pathMode,
  onAddPathPoint,
  pathPoints,
  carProbe,
  chase,
  onCarProbe,
}: {
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  txs: Tx[];
  showRays: boolean;
  showInterf: boolean;
  modelRef: React.RefObject<THREE.Group | null>;
  onCityClick: (payload: {
    worldPos: THREE.Vector3;
    screen: { x: number; y: number };
  }) => void;
  pathMode: boolean;
  onAddPathPoint: (p: THREE.Vector3) => void;
  pathPoints: THREE.Vector3[];
  carProbe: { pos: THREE.Vector3; payload: ProbePayload } | null;
  chase: boolean;
  onCarProbe: (pos: THREE.Vector3, payload: ProbePayload) => void;
}) {
  const { meshes, bounds } = useCityGeometry(modelRef);
  const [bundlesByTx, setBundlesByTx] = useState<Record<string, RayBundle[]>>(
    {}
  );

  // PERF: fewer rays per TX
  const BASE_RAYS = 260;
  const raysPerTx = Math.max(120, BASE_RAYS - (txs.length - 1) * 60);

  // rebuild rays when txs change or meshes ready
  useEffect(() => {
    if (!meshes.length) return;
    const map: Record<string, RayBundle[]> = {};
    txs.forEach((t) => {
      map[t.id] = buildRayBundle(t, meshes, raysPerTx, MAX_BOUNCES);
    });
    setTimeout(() => setBundlesByTx(map), 0);
  }, [txs, meshes, raysPerTx]);

  // click to place items (guard clicks on UI)
  const { camera, gl } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const mouse = useRef(new THREE.Vector2());

  const isUIClick = (e: MouseEvent) =>
    (e.target as HTMLElement)?.closest?.("[data-ui-root]") !== null;

  const getPointOnCity = useCallback(
    (event: MouseEvent) => {
      if (!modelRef.current) return null as THREE.Vector3 | null;
      const rect = (gl.domElement as HTMLCanvasElement).getBoundingClientRect();
      mouse.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse.current, camera as THREE.Camera);
      const hits = raycaster.intersectObjects(modelRef.current.children, true);
      if (!hits.length) return null;
      return hits[0].point.clone();
    },
    [camera, gl, modelRef, raycaster]
  );

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (isUIClick(e) || e.button !== 0) return; // ignore UI + non-left clicks

      // NEW: Path builder uses Shift+Click to add a waypoint
      if (pathMode && e.shiftKey && !e.altKey) {
        const p = getPointOnCity(e);
        if (!p) return;
        // clamp to "ground" so the car doesn't climb buildings
        if (bounds) p.y = bounds.min.y + 5;
        onAddPathPoint(p);
        return; // don't open placement menu
      }

      // Existing behavior: Alt+Click opens the placement menu
      if (!e.altKey) return;

      const p = getPointOnCity(e);
      if (!p) return;
      onCityClick({
        worldPos: p,
        screen: { x: e.clientX, y: e.clientY },
      });
    };
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("click", onClick);
    };
  }, [getPointOnCity, onCityClick, pathMode, bounds, onAddPathPoint]);

  const [selectedRay, setSelectedRay] = useState<{
    pos: THREE.Vector3;
    hops: RayHop[];
  } | null>(null);

  return (
    <>
      {/* Model */}
      <Model modelRef={modelRef} />

      {/* Path builder overlay – now bright + animated */}
      {pathPoints.length > 0 && (
        <group renderOrder={15}>
          {/* Solid bright path line */}
          <Line
            points={pathPoints}
            color="#f97316"
            linewidth={2.6}
            transparent
            opacity={1}
            depthTest={false}
          />

          {/* Glowy dashed highlight on top */}
          {pathPoints.length > 1 && (
            <Line
              points={pathPoints}
              color="#fed7aa"
              linewidth={1.4}
              transparent
              opacity={0.95}
              depthTest={false}
              dashed
              dashSize={4}
              gapSize={2}
            />
          )}

          {/* Waypoint markers */}
          {pathPoints.map((p, i) => (
            <group key={i} position={p} renderOrder={16}>
              <mesh>
                <sphereGeometry args={[3, 20, 20]} />
                <meshStandardMaterial
                  color="#f97316"
                  emissive="#fdba74"
                  emissiveIntensity={2.2}
                  metalness={0.4}
                  roughness={0.35}
                  depthTest={false}
                />
              </mesh>
              <Html distanceFactor={10} position={[0, 7, 0]}>
                <div className="rounded-full border border-amber-300/40 bg-black/80 px-1.5 py-0.5 text-[9px] font-mono text-amber-200 shadow">
                  PATH {i + 1}
                </div>
              </Html>
            </group>
          ))}

          {/* Moving car that continuously probes RF */}
          <PathMover
            points={pathPoints}
            txs={txs}
            meshes={meshes}
            onProbe={onCarProbe}
            controlsRef={controlsRef}
            chase={chase}
          />
        </group>
      )}

      {/* RF heat-line overlay on path */}
      {pathPoints.length > 1 && (
        <PathRfOverlay points={pathPoints} txs={txs} meshes={meshes} />
      )}

      {/* Interference fringes on ground plane */}
      {showInterf && (
        <InterferenceField txs={txs} modelRef={modelRef} visible={true} />
      )}

      {/* Pulsing wavefronts around transmitters */}
      {showRays && <SignalWaves txs={txs} />}

      {/* Particle trails riding along ray paths */}
      {showRays && <SignalParticles bundlesByTx={bundlesByTx} />}

      {/* Rays with LOS vs NLOS emphasis and click-to-explain */}
      {showRays &&
        txs.map((t) => (
          <group key={t.id}>
            {(bundlesByTx[t.id] || []).map((bundle, bi) => (
              <group key={bi}>
                {bundle.segments.map((seg, si) => (
                  <Line
                    key={si}
                    points={[seg.points[0], seg.points[1]]}
                    color={"#" + seg.color.getHexString()}
                    transparent
                    opacity={(seg.los ? 0.9 : 0.45) * seg.alpha}
                    linewidth={seg.los ? 1.6 : 1}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelectedRay({ pos: seg.points[1], hops: bundle.hops });
                    }}
                  />
                ))}
              </group>
            ))}
          </group>
        ))}

      {/* Transmitters */}
      {txs.map((t, idx) => (
        <group key={t.id} position={t.pos}>
          <mesh>
            <sphereGeometry args={[2.2, 24, 24]} />
            <meshStandardMaterial
              color={"#" + t.color.getHexString()}
              emissive={"#" + t.color.getHexString()}
              emissiveIntensity={1.6}
              metalness={0.2}
              roughness={0.35}
            />
          </mesh>
          <Html distanceFactor={10} position={[0, 6, 0]}>
            <div className="rounded-md border border-white/10 bg-black/60 px-2 py-1 text-[10px] text-white/80">
              TX {idx + 1} • {t.freqMHz.toFixed(0)} MHz •{" "}
              {t.powerDbm.toFixed(0)} dBm
            </div>
          </Html>
        </group>
      ))}

      {/* Ray biography overlay */}
      {selectedRay && (
        <Html position={selectedRay.pos} distanceFactor={15} center>
          <div className="max-w-xs rounded-md border border-white/15 bg-black/70 p-2 text-[10px] text-white/85 shadow-xl">
            <div className="mb-1 flex items-center gap-1 font-semibold">
              <Info className="w-3 h-3" /> Ray path
            </div>
            <div className="max-h-40 overflow-y-auto space-y-1 pr-1">
              {selectedRay.hops.map((h, i) => (
                <div key={i} className="grid grid-cols-1 gap-0.5">
                  <div>
                    Hop {i + 1}:{" "}
                    {h.material === "los" ? "LOS" : `reflect ${h.material}`}
                  </div>
                  <div>
                    • d={h.distance.toFixed(1)} m • FSPL={h.fsplLoss.toFixed(1)}{" "}
                    dB
                    {h.reflLoss > 0
                      ? ` • refl=${h.reflLoss.toFixed(1)} dB`
                      : ""}
                  </div>
                  <div>• Pᵣ after: {h.prAfter.toFixed(1)} dBm</div>
                </div>
              ))}
            </div>
          </div>
        </Html>
      )}

      {/* Visuals */}
      <CityAtmosphere />
      <KeyboardNavigation controlsRef={controlsRef} bounds={bounds} />

      {/* Car probe HUD that follows the moving car */}
      <ProbeHUD probe={carProbe} title="Car RF (live)" />
    </>
  );
}

// ---------------------------
// Loading UI
// ---------------------------
function LoadingFallback() {
  return (
    <Html center>
      <div className="rounded-md border border-slate-700 bg-slate-950/90 px-6 py-4 text-sm text-slate-200">
        <div className="flex flex-col items-center gap-2">
          <div className="w-8 h-8 border-2 border-slate-600 border-t-slate-200 rounded-full animate-spin" />
          <p>Loading Radio City…</p>
        </div>
      </div>
    </Html>
  );
}

// ---------------------------
// Explain-pixel HUD (polished)
// ---------------------------
function ProbeHUD({
  probe,
  title = "RF Analysis",
}: {
  probe: { pos: THREE.Vector3; payload: ProbePayload } | null;
  title?: string;
}) {
  if (!probe) return null;
  const { pos, payload } = probe;
  const {
    rows,
    bestIdx,
    margin,
    bestPower,
    qualityTier,
    interferenceCount,
    handoverStable,
    weights,
  } = payload;

  const qualityColors = {
    excellent: "text-emerald-400",
    good: "text-green-400",
    fair: "text-yellow-400",
    poor: "text-orange-400",
    dead: "text-red-400",
  } as const;

  return (
    <Html position={pos} distanceFactor={20} center>
      <div className="min-w-[240px] rounded-md border border-white/15 bg-black/75 p-2 text-[10px] text-white/85 shadow-xl">
        <div className="mb-1 flex items-center gap-1 font-semibold">
          <Target className="w-3 h-3" /> {title}
        </div>

        <div className="mb-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
          <span className="text-white/50">Best server:</span>
          <span className="font-mono">TX {bestIdx}</span>
          <span className="text-white/50">Signal:</span>
          <span className={`font-mono ${qualityColors[qualityTier]}`}>
            {bestPower.toFixed(1)} dBm ({qualityTier.toUpperCase()})
          </span>
          <span className="text-white/50">Margin:</span>
          <span
            className={`font-mono ${
              handoverStable ? "text-emerald-400" : "text-red-400"
            }`}
          >
            {margin.toFixed(1)} dB {handoverStable ? "✓ Stable" : "⚠ Unstable"}
          </span>
          <span className="text-white/50">Interference:</span>
          <span
            className={`font-mono ${
              interferenceCount >= 3 ? "text-yellow-400" : "text-white/70"
            }`}
          >
            {interferenceCount} strong signal
            {interferenceCount !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="space-y-1 max-h-32 overflow-y-auto pr-1">
          {rows.map((r, i) => (
            <div
              key={i}
              className="rounded bg-white/5 px-1.5 py-1 border border-white/5"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px]">
                  TX {r.idx} • {r.freq} MHz
                </span>
                <span className="font-mono text-[10px]">
                  {r.pr.toFixed(1)} dBm {r.los ? "LOS" : "NLOS"}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1">
                <div className="w-10 text-[9px] text-white/60">
                  d={r.dist} m
                </div>
                <div className="flex-1 h-2 rounded bg-white/10 overflow-hidden">
                  <div
                    className="h-full bg-linear-to-r from-cyan-400 to-cyan-600"
                    style={{ width: `${(weights[i] || 0) * 100}%` }}
                  />
                </div>
                <div className="w-10 text-right text-[9px] font-mono text-white/70">
                  {((weights[i] || 0) * 100).toFixed(0)}%
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Html>
  );
}

// ---------------------------
// Instructions Modal
// ---------------------------
function InstructionsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center"
      data-ui-root
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal content */}
      <div className="relative z-10 max-w-lg rounded-xl border border-slate-700 bg-slate-950/95 p-4 text-sm text-slate-100 shadow-xl">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 text-emerald-300" />
            <h2 className="text-sm font-semibold">How to use Radio City</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-slate-800"
          >
            Got it
          </button>
        </div>

        <div className="space-y-2 text-[12px] leading-relaxed">
          <p className="text-slate-300">
            This is an RF sandbox over Hong Kong. You can place transmitters,
            trace rays and inspect signal quality anywhere in the city.
          </p>

          <ul className="space-y-1 list-disc pl-4">
            <li>
              <span className="font-mono text-emerald-300">Alt+Click</span> on
              the city to open the placement menu and add/remove transmitters.
            </li>
            <li>
              Use the top HUD buttons to toggle{" "}
              <span className="font-mono">Rays</span>,{" "}
              <span className="font-mono">Interf</span> and load presets.
            </li>
            <li>
              Enable <span className="font-mono">Path Builder</span>, then{" "}
              <span className="font-mono">Shift+Click</span> to drop waypoints
              and watch the car and RF along the route.
            </li>
            <li>
              Move around with <span className="font-mono">WASD</span>,{" "}
              <span className="font-mono">Q/E</span> or{" "}
              <span className="font-mono">Space/Ctrl</span> for up/down.
            </li>
          </ul>

          <p className="text-[11px] text-slate-400">
            This help overlay will auto-hide in 10 seconds. You can reopen it
            later from the <span className="font-mono">Help</span> button in the
            HUD.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------
// RF Explanation Modal
// ---------------------------
function RFExplanationModal({
  open,
  onClose,
  position,
  analysis,
  isLoading,
}: {
  open: boolean;
  onClose: () => void;
  position: THREE.Vector3 | null;
  analysis: {
    summary: string;
    signalStrength: {
      value: string;
      quality: string;
      factors: string[];
    };
    coverage: {
      voice: string;
      data: string;
      overall: string;
    };
    interference: {
      count: number;
      assessment: string;
    };
    handover: {
      stable: boolean;
      assessment: string;
    };
    keyMetrics: {
      bestTx: string;
      distance: string;
      frequency: string;
    };
  } | null;
  isLoading: boolean;
}) {
  if (!open) return null;

  const qualityColors = {
    excellent: "text-emerald-400",
    good: "text-green-400",
    fair: "text-yellow-400",
    poor: "text-orange-400",
    dead: "text-red-400",
  } as const;

  const coverageColors = {
    outstanding: "text-emerald-400",
    good: "text-green-400",
    adequate: "text-yellow-400",
    poor: "text-orange-400",
    none: "text-red-400",
  } as const;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2">
        <div className="rounded-lg border border-slate-700 bg-black/95 p-4 text-slate-100 shadow-2xl backdrop-blur">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-blue-400" />
              <h3 className="font-semibold">
                RF Analysis
                {position && (
                  <span className="ml-2 font-mono text-[11px] text-slate-400">
                    ({position.x.toFixed(1)}, {position.y.toFixed(1)},{" "}
                    {position.z.toFixed(1)})
                  </span>
                )}
              </h3>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="flex flex-col items-center gap-2">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
                  <p className="text-sm text-slate-400">
                    Analyzing RF conditions...
                  </p>
                </div>
              </div>
            ) : analysis ? (
              <div className="space-y-4 text-sm">
                {/* Summary */}
                <div className="rounded-md bg-slate-900/50 p-3 border border-slate-800">
                  <p className="text-slate-200 leading-relaxed">{analysis.summary}</p>
                </div>

                {/* Key Metrics */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-md bg-slate-900/50 p-2 border border-slate-800">
                    <div className="text-[10px] text-slate-400 mb-0.5">Best TX</div>
                    <div className="font-mono text-slate-100">{analysis.keyMetrics.bestTx}</div>
                  </div>
                  <div className="rounded-md bg-slate-900/50 p-2 border border-slate-800">
                    <div className="text-[10px] text-slate-400 mb-0.5">Distance</div>
                    <div className="font-mono text-slate-100">{analysis.keyMetrics.distance}m</div>
                  </div>
                  <div className="rounded-md bg-slate-900/50 p-2 border border-slate-800">
                    <div className="text-[10px] text-slate-400 mb-0.5">Frequency</div>
                    <div className="font-mono text-slate-100">{analysis.keyMetrics.frequency} MHz</div>
                  </div>
                </div>

                {/* Signal Strength */}
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
                    Signal Strength
                  </h4>
                  <div className="rounded-md bg-slate-900/50 p-3 border border-slate-800">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-mono text-slate-100">{analysis.signalStrength.value} dBm</span>
                      <span className={`text-xs font-semibold ${qualityColors[analysis.signalStrength.quality as keyof typeof qualityColors] || "text-slate-400"}`}>
                        {analysis.signalStrength.quality.toUpperCase()}
                      </span>
                    </div>
                    <ul className="space-y-1">
                      {analysis.signalStrength.factors.map((factor, i) => (
                        <li key={i} className="text-xs text-slate-400 flex items-start gap-1.5">
                          <span className="text-blue-400 mt-0.5">•</span>
                          <span>{factor}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* Coverage */}
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
                    Coverage Quality
                  </h4>
                  <div className="rounded-md bg-slate-900/50 p-3 border border-slate-800 space-y-2">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs text-slate-400">Overall:</span>
                      <span className={`text-xs font-semibold ${coverageColors[analysis.coverage.overall as keyof typeof coverageColors] || "text-slate-400"}`}>
                        {analysis.coverage.overall.toUpperCase()}
                      </span>
                    </div>
                    <div className="text-xs text-slate-300 space-y-1">
                      <div>
                        <span className="text-slate-400">Voice: </span>
                        {analysis.coverage.voice}
                      </div>
                      <div>
                        <span className="text-slate-400">Data: </span>
                        {analysis.coverage.data}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Interference & Handover */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-md bg-slate-900/50 p-3 border border-slate-800">
                    <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wide mb-2">
                      Interference
                    </h4>
                    <div className="text-xs text-slate-300">
                      <div className="font-mono text-slate-100 mb-1">{analysis.interference.count} signal(s)</div>
                      <div className="text-slate-400">{analysis.interference.assessment}</div>
                    </div>
                  </div>
                  <div className="rounded-md bg-slate-900/50 p-3 border border-slate-800">
                    <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wide mb-2">
                      Handover
                    </h4>
                    <div className="text-xs text-slate-300">
                      <div className={`font-semibold mb-1 ${analysis.handover.stable ? "text-emerald-400" : "text-orange-400"}`}>
                        {analysis.handover.stable ? "STABLE" : "UNSTABLE"}
                      </div>
                      <div className="text-slate-400">{analysis.handover.assessment}</div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-8 text-center text-sm text-slate-400">
                No analysis available
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------
// Placement Menu
// ---------------------------
function PlacementMenu({
  menu,
  onClose,
  onAddTx,
  onRemoveNearestTx,
  onExplainRf,
  hasTx,
}: {
  menu: PlacementMenuState;
  onClose: () => void;
  onAddTx: () => void;
  onRemoveNearestTx: () => void;
  onExplainRf: () => void;
  hasTx: boolean;
}) {
  if (!menu) return null;

  return (
    <>
      {/* click-away backdrop */}
      <div className="fixed inset-0 z-30 bg-black/0" onClick={onClose} />

      <div
        className="fixed z-40 translate-x-2 translate-y-2"
        style={{ left: menu.screen.x, top: menu.screen.y }}
      >
        <div className="w-56 rounded-lg border border-slate-700 bg-black/85 p-2 text-xs text-slate-100 shadow-xl backdrop-blur">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Target className="h-3.5 w-3.5 text-emerald-300" />
              <span className="font-semibold tracking-tight">Place object</span>
            </div>
          </div>

          <div className="space-y-1">
            <button
              type="button"
              onClick={onAddTx}
              className="flex w-full items-center gap-2 rounded-md bg-emerald-500/90 px-2 py-1 text-[11px] font-medium text-black hover:bg-emerald-400"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add transmitter here</span>
            </button>

            {hasTx && (
              <button
                type="button"
                onClick={onRemoveNearestTx}
                className="flex w-full items-center gap-2 rounded-md bg-slate-900 px-2 py-1 text-[11px] text-red-300 hover:bg-red-950/70"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Remove nearest transmitter</span>
              </button>
            )}

            <button
              type="button"
              onClick={onExplainRf}
              className="flex w-full items-center gap-2 rounded-md bg-slate-900 px-2 py-1 text-[11px] text-blue-300 hover:bg-blue-950/70"
            >
              <Lightbulb className="h-3.5 w-3.5" />
              <span>💡 Explain RF here</span>
            </button>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="mt-2 w-full rounded-md bg-transparent px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-900"
          >
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------
// UI Panel with Presets
// ---------------------------
const HudToggle = ({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
      active
        ? "bg-emerald-400 text-black shadow-[0_0_18px_rgba(16,185,129,0.8)]"
        : "bg-transparent text-slate-300 hover:bg-slate-800/70"
    }`}
  >
    <Icon className="h-3 w-3" />
    <span>{label}</span>
  </button>
);

const IconChip = ({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    title={label}
    className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-700/80 bg-black/70 text-slate-300 hover:bg-slate-800/80"
  >
    <Icon className="h-3.5 w-3.5" />
  </button>
);

const StatPill = ({ label, value }: { label: string; value: number }) => (
  <div className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-2 py-0.5 text-[11px] text-slate-300">
    <span className="text-slate-500">{label}</span>
    <span className="font-mono text-emerald-400">{value}</span>
  </div>
);

function ControlPanel({
  txs,
  setTxs,
  showRays,
  setShowRays,
  showInterf,
  setShowInterf,
  modelRef,
  pathMode,
  pathCount,
  onTogglePath,
  onUndoPath,
  onClearPath,
  chase,
  setChase,
  onOpenHelp,
}: {
  txs: Tx[];
  setTxs: React.Dispatch<React.SetStateAction<Tx[]>>;
  showRays: boolean;
  setShowRays: (b: boolean) => void;
  showInterf: boolean;
  setShowInterf: (b: boolean) => void;
  modelRef: React.RefObject<THREE.Group | null>;
  pathMode: boolean;
  pathCount: number;
  onTogglePath: () => void;
  onUndoPath: () => void;
  onClearPath: () => void;
  chase: boolean;
  setChase: (v: boolean) => void;
  onOpenHelp: () => void;
}) {
  const bounds = useBounds(modelRef);
  const { meshes } = useCityGeometry(modelRef); // mesh count for stats
  const [activePreset, setActivePreset] = useState<"URBAN" | "INTERF" | null>(
    null
  );
  const [detailsOpen, setDetailsOpen] = useState(false);

  // mirror Scene's rays-per-TX formula so numbers match
  const BASE_RAYS = 260;
  const raysPerTx = Math.max(120, BASE_RAYS - Math.max(0, txs.length - 1) * 60);
  const totalRays = raysPerTx * txs.length;

  const preset = (kind: "URBAN" | "INTERF") => {
    if (!bounds) return;
    const { min, max, center } = bounds;
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

    if (kind === "URBAN") {
      const txA = makeTx(
        v(center.x - (max.x - min.x) * 0.15, min.y + 20, center.z),
        0
      );
      setTxs([txA]);
      (
        window as Window & {
          __radioCityFlyTo?: (
            pos: THREE.Vector3,
            lookAt: THREE.Vector3
          ) => void;
        }
      ).__radioCityFlyTo?.(
        new THREE.Vector3(center.x - 80, center.y + 60, center.z + 160),
        center.clone()
      );
    } else if (kind === "INTERF") {
      const txA = makeTx(v(center.x - 120, min.y + 80, center.z - 60), 0);
      const txB = makeTx(v(center.x + 120, min.y + 80, center.z - 60), 1);
      const txC = makeTx(v(center.x, min.y + 80, center.z + 120), 2);
      setTxs([txA, txB, txC]);
      (
        window as Window & {
          __radioCityFlyTo?: (
            pos: THREE.Vector3,
            lookAt: THREE.Vector3
          ) => void;
        }
      ).__radioCityFlyTo?.(
        new THREE.Vector3(center.x, center.y + 150, center.z + 220),
        center.clone()
      );
    }
    setActivePreset(kind);
  };

  const addRandomTx = () => {
    setTxs((arr) =>
      arr.concat(
        makeTx(
          new THREE.Vector3(
            (Math.random() - 0.5) * 400,
            30 + Math.random() * 100,
            (Math.random() - 0.5) * 400
          ),
          arr.length
        )
      )
    );
  };

  const clearAll = () => {
    setTxs([]);
  };

  const randomizeColors = () =>
    setTxs((arr) =>
      arr.map((t, i) => ({
        ...t,
        color: TX_COLORS[(i + 1) % TX_COLORS.length].clone(),
      }))
    );

  return (
    <>
      {/* Main HUD overlay */}
      <div
        className="pointer-events-none absolute inset-0 z-10 flex flex-col"
        data-ui-root
      >
        {/* Top bar */}
        <div className="pointer-events-auto flex items-center justify-between px-4 pt-3">
          {/* Left: back + app tag */}
          <div className="flex items-center gap-3">
            <Link href="/" className="inline-flex">
              <Button
                variant="outline"
                size="sm"
                className="gap-2 border-slate-700 bg-black/70 text-slate-100 hover:bg-black/90"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
            </Link>
            <div className="hidden md:flex items-center gap-2 rounded-full border border-slate-700 bg-black/70 px-3 py-1.5 text-[11px] text-slate-300">
              <span className="font-semibold text-slate-100">Radio City</span>
              <span className="text-slate-500">·</span>
              <span>RF sandbox over Hong Kong</span>
            </div>
          </div>

          {/* Right: presets + toggles + stats/actions */}
          <div className="flex flex-col items-end gap-2">
            {/* Presets row */}
            <div className="flex items-center gap-2">
              <div className="hidden sm:flex items-center gap-2 rounded-full border border-slate-700 bg-black/70 px-2 py-1">
                <StatPill label="TX" value={txs.length} />
              </div>
              <div className="flex items-center gap-1 rounded-full border border-slate-700 bg-black/70 p-1">
                <HudToggle
                  label="Urban"
                  icon={Waypoints}
                  active={activePreset === "URBAN"}
                  onClick={() => preset("URBAN")}
                />
                <HudToggle
                  label="Interference"
                  icon={Layers}
                  active={activePreset === "INTERF"}
                  onClick={() => preset("INTERF")}
                />
              </div>
            </div>

            {/* Toggles + quick actions */}
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 rounded-full border border-slate-700 bg-black/70 p-1">
                <HudToggle
                  label="Rays"
                  icon={Layers}
                  active={showRays}
                  onClick={() => setShowRays(!showRays)}
                />
                <HudToggle
                  label="Interf"
                  icon={Layers}
                  active={showInterf}
                  onClick={() => setShowInterf(!showInterf)}
                />
              </div>
              {/* Path builder toggle */}
              <HudToggle
                label={pathMode ? `Path (${pathCount})` : "Path Builder"}
                icon={Waypoints}
                active={pathMode}
                onClick={onTogglePath}
              />
              {/* Chase cam toggle */}
              {pathMode && pathCount >= 2 && (
                <HudToggle
                  label={chase ? "Chase On" : "Chase Off"}
                  icon={Target}
                  active={chase}
                  onClick={() => setChase(!chase)}
                />
              )}
              {/* When active, show small actions */}
              {pathMode && (
                <div className="flex items-center gap-1 rounded-full border border-slate-700 bg-black/70 p-1 ml-2">
                  <button
                    type="button"
                    onClick={onUndoPath}
                    className="px-2 py-0.5 text-[11px] rounded-full bg-slate-900 hover:bg-slate-800 text-slate-200"
                  >
                    Undo
                  </button>
                  <button
                    type="button"
                    onClick={onClearPath}
                    className="px-2 py-0.5 text-[11px] rounded-full bg-slate-900 hover:bg-slate-800 text-slate-200"
                  >
                    Clear
                  </button>
                </div>
              )}
              {/* Quick stats pill */}
              <div className="hidden sm:flex items-center gap-2 rounded-full border border-slate-700 bg-black/70 px-3 py-1 text-[11px] text-slate-300">
                <span>Tracing</span>
                <span className="font-mono text-emerald-400">
                  {totalRays.toLocaleString()}
                </span>
                <span>rays across</span>
                <span className="font-mono text-emerald-400">
                  {meshes.length.toLocaleString()}
                </span>
                <span>meshes</span>
              </div>
              <div className="hidden sm:flex items-center gap-1">
                <IconChip
                  icon={Plus}
                  label="Add random TX"
                  onClick={addRandomTx}
                />
                <IconChip
                  icon={Shuffle}
                  label="Rotate TX colors"
                  onClick={randomizeColors}
                />
                <IconChip icon={Trash2} label="Clear all" onClick={clearAll} />
                <IconChip icon={Info} label="Help" onClick={onOpenHelp} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Compact details drawer (TX power/freq + sensors) */}
      <div className="pointer-events-auto absolute bottom-4 right-4 z-10">
        <button
          type="button"
          onClick={() => setDetailsOpen((o) => !o)}
          className="mb-2 inline-flex items-center gap-2 rounded-full border border-slate-700 bg-black/70 px-3 py-1 text-[11px] text-slate-200 hover:bg-slate-900/80"
        >
          <Layers className="h-3.5 w-3.5" />
          <span>Details</span>
          <span className="text-slate-500">· {txs.length} TX</span>
        </button>

        {detailsOpen && (
          <div className="w-72 rounded-lg border border-slate-700 bg-black/80 p-3 text-xs text-slate-100 shadow-xl backdrop-blur">
            {/* TX list */}
            <div className="mb-2 flex items-center justify-between">
              <span className="font-semibold tracking-tight">Transmitters</span>
              {txs.length > 0 && (
                <span className="text-[10px] text-slate-400">
                  Use placement menu to add or remove
                </span>
              )}
            </div>
            {txs.length === 0 ? (
              <div className="mb-2 text-[11px] text-slate-400">
                Use a preset or Alt+Click in the city to open the placement
                menu.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                {txs.map((t, idx) => (
                  <div
                    key={t.id}
                    className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 rounded-md bg-slate-900/70 px-2 py-1"
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className="h-3 w-3 rounded"
                        style={{
                          backgroundColor: "#" + t.color.getHexString(),
                        }}
                      />
                      <span className="font-mono text-[11px]">
                        TX {idx + 1}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 justify-end">
                      <input
                        key={t.id + "-pwr"}
                        type="number"
                        className="w-16 rounded border border-slate-700 bg-black/60 px-1 py-0.5 text-[11px]"
                        defaultValue={t.powerDbm}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isNaN(v)) return;
                          setTxs((arr) =>
                            arr.map((x) =>
                              x.id === t.id ? { ...x, powerDbm: v } : x
                            )
                          );
                        }}
                      />
                      <span className="text-[10px] text-slate-500">dBm</span>
                      <input
                        key={t.id + "-freq"}
                        type="number"
                        className="w-20 rounded border border-slate-700 bg-black/60 px-1 py-0.5 text-[11px]"
                        defaultValue={t.freqMHz}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isNaN(v)) return;
                          setTxs((arr) =>
                            arr.map((x) =>
                              x.id === t.id ? { ...x, freqMHz: v } : x
                            )
                          );
                        }}
                      />
                      <span className="text-[10px] text-slate-500">MHz</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------
// Page
// ---------------------------
export default function RadioCityPage() {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const modelRef = useRef<THREE.Group | null>(null);

  const [txs, setTxs] = useState<Tx[]>([]);
  const [showRays, setShowRays] = useState(true);
  const [showInterf, setShowInterf] = useState(true);
  const [carProbe, setCarProbe] = useState<{
    pos: THREE.Vector3;
    payload: ProbePayload;
  } | null>(null);
  const [placementMenu, setPlacementMenu] = useState<PlacementMenuState>(null);

  // Path builder
  const [pathMode, setPathMode] = useState(false);
  const [pathPoints, setPathPoints] = useState<THREE.Vector3[]>([]);

  // Chase cam
  const [chase, setChase] = useState(false);

  // Intro/help modal state
  const [showIntro, setShowIntro] = useState(true);

  // RF Explanation state
  const [rfExplanation, setRfExplanation] = useState<{
    position: THREE.Vector3;
    analysis: {
      summary: string;
      signalStrength: {
        value: string;
        quality: string;
        factors: string[];
      };
      coverage: {
        voice: string;
        data: string;
        overall: string;
      };
      interference: {
        count: number;
        assessment: string;
      };
      handover: {
        stable: boolean;
        assessment: string;
      };
      keyMetrics: {
        bestTx: string;
        distance: string;
        frequency: string;
        margin: string;
      };
    } | null;
    isLoading: boolean;
  } | null>(null);

  // Throttle car probe updates (10 Hz)
  const lastProbeTs = useRef(0);
  const PROBE_HZ = 10;

  // Auto-hide intro modal after 10 seconds
  useEffect(() => {
    if (!showIntro) return;

    const id = window.setTimeout(() => {
      setShowIntro(false);
    }, 10000); // 10 seconds

    return () => window.clearTimeout(id);
  }, [showIntro]);

  // Path builder helpers
  const addPathPoint = useCallback((p: THREE.Vector3) => {
    setPathPoints((pts) => pts.concat(p.clone()));
  }, []);

  const undoPathPoint = useCallback(() => {
    setPathPoints((pts) => pts.slice(0, -1));
  }, []);

  const clearPath = useCallback(() => setPathPoints([]), []);

  // Throttled car probe callback (10 Hz)
  const handleCarProbe = useCallback(
    (pos: THREE.Vector3, payload: ProbePayload) => {
      const now = performance.now();
      if (now - lastProbeTs.current > 1000 / PROBE_HZ) {
        setCarProbe({ pos, payload });
        lastProbeTs.current = now;
      }
    },
    []
  );

  const handleCityClick = useCallback(
    (payload: {
      worldPos: THREE.Vector3;
      screen: { x: number; y: number };
    }) => {
      setPlacementMenu(payload);
    },
    []
  );

  const handleAddTxHere = useCallback(() => {
    if (!placementMenu) return;
    const p = placementMenu.worldPos;
    setTxs((arr) => arr.concat(makeTx(p.clone(), arr.length)));
    setPlacementMenu(null);
  }, [placementMenu]);

  const handleRemoveNearestTx = useCallback(() => {
    if (!placementMenu) return;
    const p = placementMenu.worldPos;
    setTxs((arr) => {
      if (arr.length === 0) return arr;
      let bestIdx = 0;
      let bestD = Infinity;
      for (let i = 0; i < arr.length; i++) {
        const d = arr[i].pos.distanceTo(p);
        if (d < bestD) {
          bestD = d;
          bestIdx = i;
        }
      }
      const next = arr.slice();
      next.splice(bestIdx, 1);
      return next;
    });
    setPlacementMenu(null);
  }, [placementMenu]);

  // RF Explanation handler
  const handleExplainRf = useCallback(async () => {
    if (!placementMenu) return;

    const pos = placementMenu.worldPos;
    setPlacementMenu(null);

    setRfExplanation({
      position: pos.clone(),
      analysis: null,
      isLoading: true,
    });

    try {
      const response = await fetch("/api/explain-rf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          position: { x: pos.x, y: pos.y, z: pos.z },
          transmitters: txs.map((tx) => ({
            id: tx.id,
            position: { x: tx.pos.x, y: tx.pos.y, z: tx.pos.z },
            powerDbm: tx.powerDbm,
            freqMHz: tx.freqMHz,
          })),
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to get RF explanation");
      }

      const data = await response.json();
      setRfExplanation({
        position: pos.clone(),
        analysis: data.analysis,
        isLoading: false,
      });
    } catch (error) {
      console.error("Error explaining RF:", error);
      setRfExplanation({
        position: pos.clone(),
        analysis: null,
        isLoading: false,
      });
    }
  }, [placementMenu, txs]);

  return (
    <div className="relative w-full h-screen bg-black">
      {/* Intro / instructions modal */}
      <InstructionsModal open={showIntro} onClose={() => setShowIntro(false)} />

      <ControlPanel
        txs={txs}
        setTxs={setTxs}
        showRays={showRays}
        setShowRays={setShowRays}
        showInterf={showInterf}
        setShowInterf={setShowInterf}
        modelRef={modelRef}
        pathMode={pathMode}
        pathCount={pathPoints.length}
        onTogglePath={() => setPathMode((v) => !v)}
        onUndoPath={undoPathPoint}
        onClearPath={clearPath}
        chase={chase}
        setChase={setChase}
        onOpenHelp={() => setShowIntro(true)}
      />

      {/* Placement menu */}
      <PlacementMenu
        menu={placementMenu}
        onClose={() => setPlacementMenu(null)}
        onAddTx={handleAddTxHere}
        onRemoveNearestTx={handleRemoveNearestTx}
        onExplainRf={handleExplainRf}
        hasTx={txs.length > 0}
      />

      {/* RF Explanation Modal */}
      <RFExplanationModal
        open={rfExplanation !== null}
        onClose={() => setRfExplanation(null)}
        position={rfExplanation?.position || null}
        analysis={rfExplanation?.analysis || null}
        isLoading={rfExplanation?.isLoading || false}
      />

      <Canvas
        shadows
        gl={{ antialias: true, alpha: false }}
        dpr={[1, 2]}
        camera={{ position: [0, 0, 500], fov: 50, near: 5, far: 50000 }}
      >
        <Suspense fallback={<LoadingFallback />}>
          {/* Lights */}
          <ambientLight intensity={0.25} color="#ffffff" />
          <directionalLight
            position={[200, 300, 200]}
            intensity={1.0}
            color="#ffffff"
            castShadow
            shadow-mapSize={[2048, 2048]}
          />
          <directionalLight
            position={[-150, 200, -200]}
            intensity={0.5}
            color="#c7d2fe"
          />
          <hemisphereLight
            args={[new THREE.Color("#1e293b"), new THREE.Color("#020617"), 0.3]}
          />

          {/* Setup & Scene */}
          <CameraSetup modelRef={modelRef} controlsRef={controlsRef} />
          <MovingTxController txs={txs} />
          <Scene
            controlsRef={controlsRef}
            txs={txs}
            showRays={showRays}
            showInterf={showInterf}
            modelRef={modelRef}
            onCityClick={handleCityClick}
            pathMode={pathMode}
            onAddPathPoint={addPathPoint}
            pathPoints={pathPoints}
            carProbe={carProbe}
            chase={chase}
            onCarProbe={handleCarProbe}
          />

          <OrbitControls
            ref={controlsRef}
            enablePan
            enableZoom
            enableRotate
            minDistance={1}
            maxDistance={5000}
            enableDamping
            dampingFactor={0.08}
            target={[0, 0, 0]}
            makeDefault
          />

          <EffectComposer>
            <Bloom
              intensity={1.4}
              luminanceThreshold={0.25}
              luminanceSmoothing={0.85}
              mipmapBlur
            />
            <Noise
              premultiply
              blendFunction={BlendFunction.ADD}
              opacity={0.025}
            />
            <Vignette eskil={false} offset={0.2} darkness={0.35} />
          </EffectComposer>
        </Suspense>
      </Canvas>

      {/* Footer help – slimmer HUD pill */}
      <div className="absolute bottom-4 left-4 z-10 pointer-events-none">
        <div className="pointer-events-auto inline-flex max-w-xl items-center gap-2 rounded-full border border-slate-700 bg-black/70 px-3 py-1.5 text-[11px] text-slate-300">
          <Target className="h-3.5 w-3.5 text-emerald-300" />
          <span className="font-mono text-emerald-300">Alt+Click</span>
          <span>open placement menu</span>
          {pathMode && (
            <>
              <span className="text-slate-600">·</span>
              <span className="font-mono text-emerald-300">Shift+Click</span>
              <span>to add waypoints (ground-clamped)</span>
            </>
          )}
          <span className="text-slate-600">·</span>
          <span>WASD to move · Q/E or Space/Ctrl for up/down</span>
        </div>
      </div>
    </div>
  );
}
