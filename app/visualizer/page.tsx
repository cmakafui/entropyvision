"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Environment, PerspectiveCamera, Grid } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import { Physics, RigidBody } from "@react-three/rapier";
import { Suspense, useRef } from "react";
import { motion } from "motion/react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import * as THREE from "three";

// Simple building component
function Building({ position, size, color }: { position: [number, number, number]; size: [number, number, number]; color: string }) {
  return (
    <mesh position={position} castShadow receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} metalness={0.3} roughness={0.7} />
    </mesh>
  );
}

// Floating physics object
function FloatingCube({ position, color }: { position: [number, number, number]; color: string }) {
  const meshRef = useRef<THREE.Mesh>(null);
  
  useFrame((state) => {
    if (meshRef.current) {
      meshRef.current.rotation.x += 0.01;
      meshRef.current.rotation.y += 0.01;
    }
  });

  return (
    <RigidBody position={position} type="dynamic" colliders="cuboid" restitution={0.5}>
      <mesh ref={meshRef} castShadow>
        <boxGeometry args={[0.5, 0.5, 0.5]} />
        <meshStandardMaterial color={color} metalness={0.8} roughness={0.2} emissive={color} emissiveIntensity={0.3} />
      </mesh>
    </RigidBody>
  );
}

// Ground plane
function Ground() {
  return (
    <RigidBody type="fixed" colliders="cuboid">
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.5, 0]} receiveShadow>
        <planeGeometry args={[50, 50]} />
        <meshStandardMaterial color="#1e293b" />
      </mesh>
    </RigidBody>
  );
}

// Main scene component
function Scene() {
  const buildings = [
    { pos: [-8, 2, -8] as [number, number, number], size: [3, 4, 3] as [number, number, number], color: "#3b82f6" },
    { pos: [8, 2.5, -8] as [number, number, number], size: [3, 5, 3] as [number, number, number], color: "#8b5cf6" },
    { pos: [-8, 3, 8] as [number, number, number], size: [3, 6, 3] as [number, number, number], color: "#ec4899" },
    { pos: [8, 2, 8] as [number, number, number], size: [3, 4, 3] as [number, number, number], color: "#10b981" },
    { pos: [0, 4, 0] as [number, number, number], size: [4, 8, 4] as [number, number, number], color: "#f59e0b" },
  ];

  const cubes = [
    { pos: [2, 5, 2] as [number, number, number], color: "#60a5fa" },
    { pos: [-2, 6, -2] as [number, number, number], color: "#a78bfa" },
    { pos: [4, 7, -3] as [number, number, number], color: "#f472b6" },
    { pos: [-4, 5, 3] as [number, number, number], color: "#34d399" },
  ];

  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.3} />
      <directionalLight position={[10, 10, 5]} intensity={1.2} castShadow shadow-mapSize={[2048, 2048]} />
      <pointLight position={[-10, 5, -10]} intensity={0.6} color="#60a5fa" distance={20} decay={2} />
      <pointLight position={[10, 5, 10]} intensity={0.6} color="#a78bfa" distance={20} decay={2} />
      <spotLight position={[0, 15, 0]} angle={0.3} penumbra={1} intensity={0.5} castShadow />

      {/* Buildings */}
      {buildings.map((building, i) => (
        <Building key={i} position={building.pos} size={building.size} color={building.color} />
      ))}

      {/* Physics cubes */}
      {cubes.map((cube, i) => (
        <FloatingCube key={i} position={cube.pos} color={cube.color} />
      ))}

      {/* Ground */}
      <Ground />

      {/* Grid helper */}
      <Grid args={[50, 50]} cellColor="#334155" sectionColor="#1e293b" fadeDistance={30} fadeStrength={1} />
    </>
  );
}

export default function VisualizerPage() {
  return (
    <div className="relative w-full h-screen bg-black">
      {/* Header overlay */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="absolute top-0 left-0 right-0 z-10 p-6 flex items-center justify-between"
      >
        <Link href="/">
          <Button variant="outline" size="sm" className="gap-2">
            <ArrowLeft className="w-4 h-4" />
            Back
          </Button>
        </Link>
        <div className="text-white/80 text-sm">
          <span className="font-medium">React Three Fiber</span> • <span className="font-medium">Drei</span> •{" "}
          <span className="font-medium">Postprocessing</span> • <span className="font-medium">Rapier</span>
        </div>
      </motion.div>

      {/* 3D Canvas */}
      <Canvas shadows gl={{ antialias: true, alpha: false }} dpr={[1, 2]}>
        <Suspense fallback={null}>
          <PerspectiveCamera makeDefault position={[15, 10, 15]} fov={50} />
          
          <fog attach="fog" args={["#0a0a0a", 30, 60]} />
          
          <Physics gravity={[0, -9.81, 0]} debug={false}>
            <Scene />
          </Physics>

          <OrbitControls
            enablePan={true}
            enableZoom={true}
            enableRotate={true}
            minDistance={5}
            maxDistance={50}
            minPolarAngle={0}
            maxPolarAngle={Math.PI / 2}
            autoRotate={false}
            autoRotateSpeed={0.5}
          />

          <Environment preset="city" />

          {/* Post-processing effects */}
          <EffectComposer>
            <Bloom intensity={0.5} luminanceThreshold={0.9} luminanceSmoothing={0.9} />
            <Vignette eskil={false} offset={0.1} darkness={0.5} />
          </EffectComposer>
        </Suspense>
      </Canvas>

      {/* Info overlay */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1 }}
        className="absolute bottom-6 left-6 right-6 z-10"
      >
        <div className="bg-black/40 backdrop-blur-sm border border-white/10 rounded-lg p-4 max-w-md">
          <h3 className="text-white font-semibold mb-2">3D City Visualizer</h3>
          <p className="text-white/70 text-sm leading-relaxed">
            Interactive 3D scene powered by React Three Fiber, Drei helpers, Rapier physics, and post-processing effects.
            Drag to rotate, scroll to zoom. Watch the physics cubes interact with the environment.
          </p>
        </div>
      </motion.div>
    </div>
  );
}

