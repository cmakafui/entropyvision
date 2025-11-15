import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import { z } from "zod";

export const maxDuration = 30;

// Free space path loss calculation
function fsplDb(dMeters: number, fMHz: number): number {
  const dKm = Math.max(dMeters / 1000, 0.001);
  return 32.4 + 20 * Math.log10(fMHz) + 20 * Math.log10(dKm);
}

// Calculate distance between two 3D points
function distance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export async function POST(req: Request) {
  try {
    const {
      position,
      transmitters,
    }: {
      position: { x: number; y: number; z: number };
      transmitters: Array<{
        id: string;
        position: { x: number; y: number; z: number };
        powerDbm: number;
        freqMHz: number;
      }>;
    } = await req.json();

    if (!position || !transmitters || transmitters.length === 0) {
      return new Response(
        JSON.stringify({ error: "Position and transmitters required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Calculate RF metrics for each transmitter
    const txAnalyses = transmitters.map((tx) => {
      const dist = distance(position, tx.position);
      const pathLoss = fsplDb(dist, tx.freqMHz);
      // Assume line-of-sight for now (we don't have mesh data on server)
      // In a real implementation, you'd want to send LOS info from client
      const receivedPower = tx.powerDbm - pathLoss;

      let quality: string;
      if (receivedPower > -70) quality = "excellent";
      else if (receivedPower > -85) quality = "good";
      else if (receivedPower > -100) quality = "fair";
      else if (receivedPower > -110) quality = "poor";
      else quality = "dead";

      return {
        id: tx.id,
        distance: dist,
        pathLoss: pathLoss.toFixed(1),
        receivedPower: receivedPower.toFixed(1),
        quality,
        frequency: tx.freqMHz,
        transmitPower: tx.powerDbm,
      };
    });

    // Sort by received power (best first)
    txAnalyses.sort(
      (a, b) => parseFloat(b.receivedPower) - parseFloat(a.receivedPower)
    );

    const best = txAnalyses[0];
    const secondBest = txAnalyses[1];
    const margin = secondBest
      ? parseFloat(best.receivedPower) - parseFloat(secondBest.receivedPower)
      : Infinity;

    // Build context for AI
    const context = {
      position: `(${position.x.toFixed(1)}, ${position.y.toFixed(
        1
      )}, ${position.z.toFixed(1)})`,
      bestSignal: {
        txId: best.id,
        power: best.receivedPower,
        quality: best.quality,
        distance: best.distance.toFixed(1),
        frequency: best.frequency,
      },
      margin: margin.toFixed(1),
      allTransmitters: txAnalyses.map((tx) => ({
        id: tx.id,
        power: tx.receivedPower,
        quality: tx.quality,
        distance: tx.distance.toFixed(1),
        frequency: tx.frequency,
      })),
      interferenceCount: txAnalyses.filter(
        (tx) => parseFloat(tx.receivedPower) > -80
      ).length,
      handoverStable: margin >= 3.0,
    };

    // Define structured output schema
    const rfAnalysisSchema = z.object({
      summary: z.string().describe("Brief 1-2 sentence overview of RF conditions"),
      signalStrength: z.object({
        value: z.string().describe("Signal strength in dBm"),
        quality: z.enum(["excellent", "good", "fair", "poor", "dead"]),
        factors: z.array(z.string()).describe("Key factors affecting signal strength (distance, path loss, frequency, etc.)"),
      }),
      coverage: z.object({
        voice: z.string().describe("Voice call quality assessment (1-2 sentences)"),
        data: z.string().describe("Data performance assessment (1-2 sentences)"),
        overall: z.enum(["outstanding", "good", "adequate", "poor", "none"]),
      }),
      interference: z.object({
        count: z.number(),
        assessment: z.string().describe("Brief assessment of interference situation"),
      }),
      handover: z.object({
        stable: z.boolean(),
        assessment: z.string().describe("Brief assessment of handover stability"),
      }),
      keyMetrics: z.object({
        bestTx: z.string().describe("Best transmitter ID"),
        distance: z.string().describe("Distance to best TX in meters"),
        frequency: z.string().describe("Frequency in MHz"),
      }),
    });

    // Generate structured explanation using AI
    const { object } = await generateObject({
      model: google("gemini-2.5-pro"),
      system: `You are an RF (radio frequency) engineering expert. Provide concise, technical but accessible analysis of signal conditions. Be brief and focused.`,
      prompt: `Analyze the RF conditions at position ${
        context.position
      } in a 3D city model.

Best Signal: TX ${context.bestSignal.txId} @ ${
        context.bestSignal.power
      }dBm (${context.bestSignal.quality.toUpperCase()})
- Distance: ${context.bestSignal.distance}m
- Frequency: ${context.bestSignal.frequency}MHz
- Margin over second best: ${context.margin}dB

All transmitters:
${context.allTransmitters
  .map(
    (tx) =>
      `- TX ${tx.id}: ${tx.power}dBm (${tx.quality}) at ${tx.distance}m, ${tx.frequency}MHz`
  )
  .join("\n")}

Interference: ${context.interferenceCount} strong signal(s)
Handover stability: ${context.handoverStable ? "Stable" : "Unstable"} (margin ${
        context.margin
      }dB)`,
      schema: rfAnalysisSchema,
    });

    return new Response(
      JSON.stringify({
        analysis: object,
        context,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("RF explanation error:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to generate RF explanation",
        explanation: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
