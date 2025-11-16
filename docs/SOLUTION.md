# City of Echoes – Technical Overview

## Project Metadata

- **Challenge:** Sensofusion – Radio City (Junction 2025: Utopia & Dystopia)
- **Team:** City of Echoes
- **Team Lead:** Carl Kugblenu
- **Deployment:** http://entropyvision.vercel.app/
- **Repository:** https://github.com/cmakafui/entropyvision

## Problem & Goal

Radio waves power navigation, communication, and sensing, yet they remain invisible. Sensofusion asked teams to make Hong Kong's radio landscape explorable: put transmitters into a dense 3D city, explain how materials block or reflect energy, and help non-specialists build intuition about coverage, interference, and handovers.

## Solution Summary

City of Echoes is a browser-based sandbox that combines a 3D Hong Kong model, a lightweight RF propagation solver, a GPU interference shader, and an AI assistant that explains signal quality. Users can place static or moving transmitters, paint drive-test paths, and immediately see how coverage shifts as signals bounce around towers. Everything runs inside a Next.js 16 app with zero plugins or external native binaries, so it can be deployed straight to Vercel.

## Architecture

### 1. Client scene graph (`app/radio-city/page.tsx`)

- Built with Next.js App Router + React 19 + React Three Fiber.
- The Hong Kong GLB is centered, normalized, and tagged with semantic materials (water, terrain, glass, concrete) before being wrapped in a `<Bvh>` for fast ray queries.
- Controls support WASD flight, touch long-press, and HUD toggles. The UI layer (shadcn/ui + Tailwind) sits outside the `<Canvas>` so it stays responsive while WebGL saturates the GPU.

### 2. Propagation solver

Each transmitter (`Tx`) tracks power, frequency, color, and optional mobility. When transmitters change, the system rebuilds ray bundles by sampling a Fibonacci sphere and marching against the BVH meshes:

```ts
const fsplDb = (dMeters: number, fMHz: number) => {
  const dKm = Math.max(dMeters / 1000, 0.001);
  return 32.4 + 20 * Math.log10(fMHz) + 20 * Math.log10(dKm);
};

function buildRayBundle(tx: Tx, meshes: THREE.Object3D[], rays: number) {
  const dirs = fibonacciSphereDirs(rays);
  for (const dir of dirs) {
    let origin = tx.pos.clone().add(dir.clone().multiplyScalar(0.5));
    let power = tx.powerDbm;
    while (power > -110 && bounces <= MAX_BOUNCES) {
      const hit = raycaster.intersectObjects(meshes, true)[0];
      if (!hit) break;
      const fspl = fsplDb(hit.distance, tx.freqMHz);
      power -= fspl;
      power -= materialReflectionLossDb(hit.object, normal, dir);
      // segment + hop bookkeeping...
    }
  }
}
```

The solver keeps hop-by-hop metadata (`distance`, `fsplLoss`, `reflLoss`, `prAfter`) so the HUD can report why a ray faded out. Instanced meshes draw ray particles and pulsing wavefront rings without exploding draw calls.

### 3. Interference shader (`InterferenceField`)

A fragment shader rendered over the ground plane sums electric-field contributions from up to eight transmitters:

```glsl
float lambda = C / uFreq[i];
float k = 2.0 * PI / lambda * uSpatialScale;
float phase = (omega * uTime * uPhaseTimeScale) - (k * d);
E += amplitude * cos(phase);
```

The shader stretches wavelengths by ~30× for legibility, but it maintains true constructive/destructive behavior, so fading pockets emerge exactly where multiple transmitters overlap.

### 4. Path builder & drive test overlay

Shift+Click populates waypoints. `PathMover` interpolates between points, samples RF at ~10 Hz, and emits probe packets that populate a HUD table. `PathRfOverlay` resamples the path every few meters, measures best-power via the same ray bundle data, and writes the colors into a custom `BufferGeometry`, producing a heat-trail plus handover markers whenever `softmaxDbm` selects a new serving cell.

### 5. AI RF inspector (`app/api/explain-rf/route.ts`)

When the user Alt+Clicks, the client captures the 3D coordinate plus current transmitter definitions and posts them to `/api/explain-rf`. The handler:

1. Recomputes FSPL for each transmitter (server has no mesh context, so it assumes LOS but keeps real power budgets).
2. Ranks transmitters, derives signal quality buckets, interference counts, and a serving-cell margin.
3. Calls `generateObject` with Google Gemini 2.5 Pro (`@ai-sdk/google`) and a Zod schema to obtain structured prose.
4. Returns both the structured analysis and the numeric context so the UI can display charts or copyable summaries.

Latency stays under ~1.5 s for typical payloads, and the schema guarantees every response includes summary, signal strength reasoning, coverage expectations, interference notes, and handover stability.

## User Experience

1. **Learn the space:** Intro card explains controls; the HUD shows ray count, interference status, and transmitter inventory.
2. **Place sources:** Alt+Click or long-press to position transmitters. You can tether a source to an orbit or waypoint path to simulate moving emitters.
3. **Inspect coverage:** Toggle ray bundles and the interference slice. Hover rays to read hop-by-hop losses, or use AI analysis for contextual explanations.
4. **Drive test:** Enable Path Builder, drop points, watch the probe car paint the path, and read handover markers in the HUD table.

## Tech Stack & Data

- **Framework:** Next.js 16, React 19, TypeScript.
- **3D:** Three.js 0.181, @react-three/fiber, @react-three/drei, @react-three/postprocessing.
- **UI:** Tailwind CSS, shadcn/ui, Lucide icons.
- **AI:** `@ai-sdk/google`, `ai`, Zod. Requires `GOOGLE_GENERATIVE_AI_API_KEY` (or compatible key supported by the AI SDK).
- **Assets:** `public/hk_compressed.glb` (DRACO-compressed Hong Kong skyline) streamed with Google's DRACO decoders.

## Deployment & Local Setup

1. `npm install`
2. `cp .env.example .env.local` and set `GOOGLE_GENERATIVE_AI_API_KEY`.
3. `npm run dev` locally or `npm run build && npm run start` for production checks.
4. Deploy to Vercel (default Next.js settings work; the AI route runs as an Edge Function by default).

## Future Extensions

- Multi-frequency comparison (e.g., 700 MHz vs 3.5 GHz vs mmWave) using the same shader + ray engine.
- Material calibration from real data instead of heuristics.
- Import/export for real cell-site inventories and drive logs.
- Multiplayer planning canvas so multiple teammates can iterate on the same layout.

City of Echoes turns electromagnetic theory into something you can fly through, poke, and understand without memorizing formulas. The combination of ray-based physics, GPU interference, and AI explanations meets the Sensofusion brief while running entirely in the browser.
