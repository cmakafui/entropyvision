"use client";

import { Suspense, useEffect, useRef, useMemo, useState } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, useGLTF, Html } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

// Set up Draco decoder path - using CDN for decoder files
useGLTF.setDecoderPath("https://www.gstatic.com/draco/v1/decoders/");

// Preload the model
const MODEL_URL = "/hk_compressed.glb";
useGLTF.preload(MODEL_URL);

// Camera setup component that frames & animates the model
function CameraSetup({
  modelRef,
  controlsRef,
}: {
  modelRef: React.RefObject<THREE.Group | null>;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}) {
  const { camera } = useThree();
  const hasInitialized = useRef(false);

  const modelCenterRef = useRef(new THREE.Vector3(0, 0, 0));
  const startPosRef = useRef(new THREE.Vector3());
  const targetPosRef = useRef(new THREE.Vector3());
  const animProgressRef = useRef(0);
  const isAnimatingRef = useRef(false);

  // Animate camera every frame while intro is running
  useFrame((_, delta) => {
    if (!isAnimatingRef.current) return;

    const duration = 4; // seconds
    animProgressRef.current += delta / duration;
    const t = Math.min(animProgressRef.current, 1);

    // Use smooth easing function for better animation
    const easedT = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    camera.position.lerpVectors(
      startPosRef.current,
      targetPosRef.current,
      easedT
    );
    camera.lookAt(modelCenterRef.current);

    if (controlsRef.current) {
      // Keep controls target locked to center during intro
      // Disable damping during animation to prevent jitter
      const wasDamping = controlsRef.current.enableDamping;
      controlsRef.current.enableDamping = false;
      controlsRef.current.target.copy(modelCenterRef.current);
      controlsRef.current.update();
      controlsRef.current.enableDamping = wasDamping;
    }

    if (t >= 1) {
      isAnimatingRef.current = false;
      if (controlsRef.current) {
        controlsRef.current.enabled = true; // user can move after intro
      }
    }
  });

  useEffect(() => {
    if (!modelRef.current || hasInitialized.current) return;

    // Ensure world matrices are up to date
    modelRef.current.updateWorldMatrix(true, true);

    // Compute bounding box of the whole city
    const box = new THREE.Box3().setFromObject(modelRef.current);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    if (maxDim <= 0) return;

    const modelCenter =
      center.length() < 0.001 ? new THREE.Vector3(0, 0, 0) : center;
    modelCenterRef.current.copy(modelCenter);

    // Perspective FOV (radians)
    const fov =
      camera instanceof THREE.PerspectiveCamera
        ? (camera.fov * Math.PI) / 180
        : (50 * Math.PI) / 180;

    // Distance needed to frame the model
    const frameDistance = (maxDim / (2 * Math.tan(fov / 2))) * 1.8;

    // Target: nice 45-degree hero view
    const angle = Math.PI / 4;
    const height = maxDim * 0.6;
    const horizontalDist = frameDistance * 0.9;

    targetPosRef.current.set(
      modelCenter.x + horizontalDist * Math.cos(angle),
      modelCenter.y + height,
      modelCenter.z + horizontalDist * Math.sin(angle)
    );

    // Start: high above, looking straight down-ish
    const startHeight = maxDim * 4; // tweak for "see whole city"
    startPosRef.current.set(
      modelCenter.x,
      modelCenter.y + startHeight,
      modelCenter.z
    );

    // Initialize camera at overview position
    camera.position.copy(startPosRef.current);
    camera.lookAt(modelCenter);
    camera.updateProjectionMatrix();

    // Lock controls during intro
    if (controlsRef.current) {
      controlsRef.current.target.copy(modelCenter);
      controlsRef.current.enabled = false;
      controlsRef.current.update();
    }

    // Kick off animation
    animProgressRef.current = 0;
    isAnimatingRef.current = true;
    hasInitialized.current = true;
  }, [camera, modelRef, controlsRef]);

  return null;
}

// Model component that loads the GLB and centers it with improved material separation
function Model({
  url,
  modelRef,
}: {
  url: string;
  modelRef: React.RefObject<THREE.Group | null>;
}) {
  const { scene } = useGLTF(url);

  const centeredScene = useMemo(() => {
    // 1) Center the original scene
    const box = new THREE.Box3().setFromObject(scene);
    const center = box.getCenter(new THREE.Vector3());

    const newCenteredScene = scene.clone();
    newCenteredScene.position.x = -center.x;
    newCenteredScene.position.y = -center.y;
    newCenteredScene.position.z = -center.z;

    // 2) Global bounds
    const globalBox = new THREE.Box3().setFromObject(newCenteredScene);
    const globalMinY = globalBox.min.y;
    const globalMaxY = globalBox.max.y;
    const globalHeight = Math.max(globalMaxY - globalMinY, 1e-3);

    // 3) Shared materials - neutral city lab palette
    const waterMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#020617"), // almost black water
      roughness: 0.25,
      metalness: 0.9,
    });

    const terrainMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#0f172a"), // dark blue hills
      roughness: 0.95,
      metalness: 0.1,
    });

    const lowRiseMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#1f2937"), // dark grey
      roughness: 0.9,
      metalness: 0.2,
    });

    const midRiseMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#e5e7eb"), // light concrete
      roughness: 0.8,
      metalness: 0.3,
    });

    const highRiseMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#e5e7eb"),
      emissive: new THREE.Color("#38bdf8"), // soft cyan accent
      emissiveIntensity: 0.3, // dialed way down
      roughness: 0.6,
      metalness: 0.5,
    });

    const tmpPos = new THREE.Vector3();

    // 4) Classify meshes
    newCenteredScene.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        const geom = mesh.geometry;
        if (!geom.boundingBox) geom.computeBoundingBox();

        const bb = geom.boundingBox!;
        mesh.getWorldPosition(tmpPos);

        const localHeight = bb.max.y - bb.min.y;
        const sizeX = bb.max.x - bb.min.x;
        const sizeZ = bb.max.z - bb.min.z;
        const footprint = sizeX * sizeZ;

        const worldMaxY = tmpPos.y + bb.max.y;
        const normalizedHeight = (worldMaxY - globalMinY) / globalHeight;

        // Heuristics
        const flatish = localHeight < globalHeight * 0.03;
        const bigFootprint = footprint > globalHeight * globalHeight * 0.01;
        const waterLevel = globalMinY + globalHeight * 0.03;

        let material: THREE.Material;

        if (flatish && worldMaxY < waterLevel) {
          // Low & flat → water / harbour
          material = waterMaterial;
        } else if (flatish && bigFootprint) {
          // Flat but wide → terrain / hills
          material = terrainMaterial;
        } else {
          // Buildings: height bands
          if (normalizedHeight < 0.4) {
            material = lowRiseMaterial;
          } else if (normalizedHeight < 0.75) {
            material = midRiseMaterial;
          } else {
            material = highRiseMaterial;
          }
        }

        mesh.material = material;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });

    return newCenteredScene;
  }, [scene]);

  return (
    <group ref={modelRef}>
      <primitive object={centeredScene} />
    </group>
  );
}

// City atmosphere component for background and fog
function CityAtmosphere() {
  const { scene } = useThree();

  useEffect(() => {
    // Set background and fog - dark navy night sky
    const bg = new THREE.Color("#020617"); // deep navy
    const fog = new THREE.FogExp2(bg, 0.00012);

    Object.assign(scene, {
      background: bg,
      fog: fog,
    });
  }, [scene]);

  return null;
}

// Loading fallback
function LoadingFallback() {
  return (
    <Html center>
      <div className="rounded-md border border-slate-700 bg-slate-950/90 px-6 py-4 text-sm text-slate-200">
        <div className="flex flex-col items-center gap-2">
          <div className="w-8 h-8 border-2 border-slate-600 border-t-slate-200 rounded-full animate-spin" />
          <p>Loading model...</p>
        </div>
      </div>
    </Html>
  );
}

// City geometry type and hook
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
      queueMicrotask(() => {
        setMeshes([]);
        setBounds(null);
      });
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

    queueMicrotask(() => {
      setMeshes(collected);
      setBounds({
        min: box.min.clone(),
        max: box.max.clone(),
        size,
        center,
      });
    });
  }, [modelRef]);

  return { meshes, bounds };
}

// 🔥 NEW: Keyboard navigation component (WASD + Q/E)
function KeyboardNavigation({
  controlsRef,
  bounds,
}: {
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  bounds?: CityGeometry["bounds"] | null;
}) {
  const { camera } = useThree();

  const keys = useRef<{ [code: string]: boolean }>({
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
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't steal focus from inputs / textareas
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }

      if (event.code in keys.current) {
        keys.current[event.code] = true;
        // Prevent space from scrolling the page, and Q/E from triggering browser shortcuts
        if (
          event.code === "Space" ||
          event.code === "KeyQ" ||
          event.code === "KeyE"
        ) {
          event.preventDefault();
        }
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code in keys.current) {
        keys.current[event.code] = false;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  useFrame((_, dt) => {
    const ctr = controlsRef.current;
    if (!ctr || !ctr.enabled) return; // wait until intro is done

    const st = keys.current;
    const move = moveRef.current.set(0, 0, 0);
    const fwd = fwdRef.current;
    const right = rightRef.current;
    const up = upRef.current.copy(camera.up).normalize();

    camera.getWorldDirection(fwd);
    fwd.y = 0; // keep horizontal movement level
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

    if (ctr.enableDamping) {
      ctr.update();
    }
  });

  return null;
}

// Scene component that manages the model and camera
function Scene({
  modelUrl,
  controlsRef,
}: {
  modelUrl: string;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}) {
  const modelRef = useRef<THREE.Group | null>(null);
  const { bounds } = useCityGeometry(modelRef);

  return (
    <>
      {/* Model */}
      <Model url={modelUrl} modelRef={modelRef} />

      {/* Camera setup - frames the model */}
      <CameraSetup modelRef={modelRef} controlsRef={controlsRef} />

      {/* City atmosphere */}
      <CityAtmosphere />

      {/* Keyboard navigation (WASD + Q/E) */}
      <KeyboardNavigation controlsRef={controlsRef} bounds={bounds} />
    </>
  );
}

export default function GLBViewerPage() {
  const modelUrl = MODEL_URL;
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  return (
    <div className="relative w-full h-screen bg-black">
      {/* Header overlay */}
      <div className="absolute top-0 left-0 right-0 z-10 p-6 flex items-center justify-between pointer-events-none">
        <Link href="/" className="pointer-events-auto">
          <Button variant="outline" size="sm" className="gap-2">
            <ArrowLeft className="w-4 h-4" />
            Back
          </Button>
        </Link>
        <div className="text-white/80 text-sm pointer-events-auto">
          <span className="font-medium">Draco GLB Viewer</span>
        </div>
      </div>

      {/* 3D Canvas */}
      <Canvas
        shadows
        gl={{ antialias: true, alpha: false }}
        dpr={[1, 2]}
        camera={{ position: [0, 0, 500], fov: 50, near: 0.5, far: 50000 }}
      >
        <Suspense fallback={<LoadingFallback />}>
          {/* Lighting - neutral city lab baseline */}
          <ambientLight intensity={0.35} color="#ffffff" />
          <directionalLight
            position={[200, 300, 200]}
            intensity={1.5}
            color="#ffffff"
            castShadow
            shadow-mapSize={[2048, 2048]}
          />
          <directionalLight
            position={[-150, 200, -200]}
            intensity={0.7}
            color="#c7d2fe"
          />
          <hemisphereLight
            args={[new THREE.Color("#1e293b"), new THREE.Color("#020617"), 0.4]}
          />

          {/* Scene with model, camera setup & keyboard nav */}
          <Scene modelUrl={modelUrl} controlsRef={controlsRef} />

          {/* Controls */}
          <OrbitControls
            ref={controlsRef}
            enablePan={true}
            enableZoom={true}
            enableRotate={true}
            minDistance={1}
            maxDistance={5000}
            autoRotate={false}
            enableDamping
            dampingFactor={0.08}
            target={[0, 0, 0]}
            makeDefault
          />

          {/* Post-processing effects - gentle for city lab baseline */}
          <EffectComposer>
            <Bloom
              intensity={0.4}
              luminanceThreshold={0.25}
              luminanceSmoothing={0.9}
            />
            <Vignette eskil={false} offset={0.2} darkness={0.35} />
          </EffectComposer>
        </Suspense>
      </Canvas>

      {/* Info overlay */}
      <div className="absolute bottom-6 left-6 right-6 z-10 pointer-events-none">
        <div className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-lg p-4 max-w-md pointer-events-auto">
          <h3 className="text-white font-semibold mb-2">GLB Viewer</h3>
          <p className="text-white/70 text-sm leading-relaxed">
            Drag to rotate • Scroll to zoom • Right-click and drag to pan •{" "}
            <span className="font-medium">WASD</span> to move •{" "}
            <span className="font-medium">Q/E</span> or{" "}
            <span className="font-medium">Space/Ctrl</span> to move down/up •{" "}
            <span className="font-medium">Shift</span> to move faster
          </p>
        </div>
      </div>
    </div>
  );
}
