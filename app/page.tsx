"use client";

import { motion } from "motion/react";
import { Radio, Waves, Eye, Zap, Sparkles, Brain } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useRef } from "react";
import Link from "next/link";

// Radio Wave Component
function RadioWave({
  delay = 0,
  size = 200,
  colorClass = "border-primary/30",
}: {
  delay?: number;
  size?: number;
  colorClass?: string;
}) {
  return (
    <motion.div
      className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transform-gpu will-change-transform ${colorClass}`}
      style={{ width: size, height: size }}
      initial={{ scale: 0, opacity: 0.8 }}
      animate={{ scale: 4, opacity: 0 }}
      transition={{
        duration: 3,
        delay,
        repeat: Infinity,
        ease: "easeOut",
      }}
    />
  );
}

// Animated Grid Background
function AnimatedGrid() {
  return (
    <div className="fixed inset-0 opacity-[0.03] dark:opacity-[0.05] pointer-events-none">
      <svg className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern
            id="grid"
            width="40"
            height="40"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 40 0 L 0 0 0 40"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>
      <motion.div
        className="absolute inset-0 transform-gpu will-change-transform"
        style={{
          background:
            "linear-gradient(90deg, transparent, hsl(var(--primary) / 0.1), transparent)",
        }}
        animate={{
          x: ["-100%", "200%"],
        }}
        transition={{
          duration: 8,
          repeat: Infinity,
          ease: "linear",
        }}
      />
    </div>
  );
}

// Scan Line Component
function ScanLine() {
  const h = typeof window !== "undefined" ? window.innerHeight : 1000;

  return (
    <motion.div
      className="fixed left-0 right-0 top-0 h-[2px] pointer-events-none opacity-10 transform-gpu will-change-transform"
      style={{
        background:
          "linear-gradient(to bottom, transparent 0%, hsl(var(--primary) / 0.1) 50%, transparent 100%)",
      }}
      animate={{
        y: [0, h],
      }}
      transition={{
        duration: 4,
        repeat: Infinity,
        ease: "linear",
      }}
    />
  );
}

export default function Home() {
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={containerRef}
      className="relative min-h-screen overflow-hidden bg-linear-to-br from-background via-background to-muted/20"
    >
      {/* Animated Grid Background */}
      <AnimatedGrid />

      {/* Multiple animated background orbs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        {[...Array(6)].map((_, i) => (
          <motion.div
            key={i}
            className={`absolute w-96 h-96 rounded-full blur-3xl transform-gpu will-change-transform ${
              i % 3 === 0
                ? "bg-primary/10"
                : i % 3 === 1
                ? "bg-chart-1/10"
                : "bg-chart-2/10"
            }`}
            style={{
              left: `${20 + i * 15}%`,
              top: `${15 + i * 12}%`,
            }}
            animate={{
              scale: [1, 1.3 + i * 0.1, 1],
              opacity: [0.2, 0.4 + i * 0.05, 0.2],
            }}
            transition={{
              duration: 8 + i * 2,
              repeat: Infinity,
              ease: "easeInOut",
              delay: i * 0.5,
            }}
          />
        ))}
      </div>

      {/* Radio Wave Emitters */}
      <div className="fixed inset-0 pointer-events-none">
        {/* Top left emitter */}
        <div className="absolute top-20 left-20">
          {[...Array(3)].map((_, i) => (
            <RadioWave
              key={i}
              delay={i * 1}
              size={150}
              colorClass="border-primary/30"
            />
          ))}
        </div>
        {/* Bottom right emitter */}
        <div className="absolute bottom-32 right-32">
          {[...Array(3)].map((_, i) => (
            <RadioWave
              key={i}
              delay={i * 1 + 0.5}
              size={200}
              colorClass="border-chart-1/30"
            />
          ))}
        </div>
        {/* Center emitter */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
          {[...Array(2)].map((_, i) => (
            <RadioWave
              key={i}
              delay={i * 1.5}
              size={300}
              colorClass="border-chart-2/30"
            />
          ))}
        </div>
      </div>

      {/* Scan Line Effect */}
      <ScanLine />

      {/* Main content */}
      <div className="relative z-10 container mx-auto px-4 py-8 h-screen flex flex-col">
        {/* Header */}
        <motion.header
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="flex items-center justify-between mb-8"
        >
          <motion.div
            className="flex items-center gap-2 relative"
            whileHover={{ scale: 1.05 }}
          >
            <Radio className="w-6 h-6 text-primary" />
            <span className="text-xl font-bold">City of Echoes</span>
          </motion.div>
          <Link href="/radio-city">
            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
              <Button
                variant="outline"
                size="sm"
                className="relative overflow-hidden group"
              >
                <span className="relative z-10">Launch Radio City</span>
                <motion.div
                  className="absolute inset-0 bg-primary/10"
                  initial={{ x: "-100%" }}
                  whileHover={{ x: "100%" }}
                  transition={{ duration: 0.5 }}
                />
              </Button>
            </motion.div>
          </Link>
        </motion.header>

        {/* Main hero section */}
        <div className="flex-1 grid grid-cols-12 gap-6 items-center">
          {/* Left column - Hero text */}
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className="col-span-12 lg:col-span-6 space-y-6"
          >
            <motion.div
              whileHover={{ scale: 1.05 }}
              transition={{ type: "spring", stiffness: 400, damping: 17 }}
            >
              <Badge variant="secondary" className="w-fit">
                <Waves className="w-3 h-3 mr-1" />
                Radio Waves Sandbox
              </Badge>
            </motion.div>

            <motion.h1
              className="text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.3 }}
            >
              See the{" "}
              <span className="relative inline-block">
                <motion.span
                  className="text-primary"
                  animate={{
                    backgroundPosition: ["0%", "100%"],
                  }}
                  transition={{
                    duration: 4,
                    repeat: Infinity,
                    repeatType: "reverse",
                    ease: "easeInOut",
                  }}
                  style={{
                    backgroundImage:
                      "linear-gradient(90deg, hsl(var(--primary)), hsl(var(--chart-1)), hsl(var(--primary)))",
                    backgroundSize: "200% 100%",
                    backgroundClip: "text",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                  }}
                >
                  invisible
                </motion.span>
                <motion.div
                  className="absolute -bottom-2 left-0 right-0 h-0.5 bg-primary/30 rounded-full"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ duration: 0.8, delay: 0.6 }}
                />
              </span>
            </motion.h1>

            <motion.p
              className="text-xl md:text-2xl text-muted-foreground leading-relaxed max-w-xl"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 0.5 }}
            >
              An interactive{" "}
              <span className="text-foreground font-medium">
                radio waves sandbox
              </span>{" "}
              over Hong Kong. Place transmitters, trace signals, and explore how
              wireless waves travel through the city.
            </motion.p>

            <motion.div
              className="flex flex-col sm:flex-row gap-4"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.7 }}
            >
              <Link href="/radio-city">
                <motion.div
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                >
                  <Button size="lg" className="text-lg px-8">
                    <Eye className="w-5 h-5 mr-2" />
                    Explore the City
                    <span className="ml-2">→</span>
                  </Button>
                </motion.div>
              </Link>
            </motion.div>
          </motion.div>

          {/* Right column - Feature cards */}
          <motion.div
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.8, delay: 0.4 }}
            className="col-span-12 lg:col-span-6 grid grid-cols-2 gap-4"
          >
            {[
              {
                icon: Radio,
                title: "Signal Tracing",
                desc: "See how radio waves travel through the city, bouncing off buildings and creating coverage patterns you can visualize.",
                color: "primary",
                delay: 0.6,
              },
              {
                icon: Zap,
                title: "Real-Time",
                desc: "See signal coverage update instantly as you place transmitters and explore the city in real-time.",
                color: "chart-2",
                delay: 0.8,
              },
              {
                icon: Sparkles,
                title: "Interactive",
                desc: "Alt+Click anywhere to place transmitters or analyze RF conditions. Explore how waves interact across the city in real-time.",
                color: "chart-3",
                delay: 0.9,
              },
              {
                icon: Brain,
                title: "AI RF Inspector",
                desc: "Alt+Click anywhere for instant AI-powered RF analysis. Understand signal strength, interference, and coverage at any point.",
                color: "chart-1",
                delay: 1.0,
              },
            ].map((feature, idx) => (
              <motion.div
                key={idx}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: feature.delay }}
                whileHover={{
                  y: -12,
                  scale: 1.02,
                  transition: { duration: 0.2 },
                }}
                className="group"
              >
                <Card
                  className={`h-full transition-all duration-300 relative overflow-hidden ${
                    feature.color === "primary"
                      ? "border-primary/20 hover:border-primary/60"
                      : feature.color === "chart-1"
                      ? "border-chart-1/20 hover:border-chart-1/60"
                      : feature.color === "chart-2"
                      ? "border-chart-2/20 hover:border-chart-2/60"
                      : "border-chart-3/20 hover:border-chart-3/60"
                  }`}
                >
                  <CardHeader className="relative z-10">
                    <motion.div
                      className={`w-12 h-12 rounded-lg flex items-center justify-center mb-2 relative overflow-hidden ${
                        feature.color === "primary"
                          ? "bg-primary/10"
                          : feature.color === "chart-1"
                          ? "bg-chart-1/10"
                          : feature.color === "chart-2"
                          ? "bg-chart-2/10"
                          : "bg-chart-3/10"
                      }`}
                      whileHover={{ rotate: 360 }}
                      transition={{ duration: 0.6 }}
                    >
                      <feature.icon
                        className={`w-6 h-6 ${
                          feature.color === "primary"
                            ? "text-primary"
                            : feature.color === "chart-1"
                            ? "text-chart-1"
                            : feature.color === "chart-2"
                            ? "text-chart-2"
                            : "text-chart-3"
                        }`}
                      />
                    </motion.div>
                    <CardTitle className="text-lg">{feature.title}</CardTitle>
                  </CardHeader>
                  <CardContent className="relative z-10">
                    <p className="text-sm text-muted-foreground">
                      {feature.desc}
                    </p>
                  </CardContent>
                  {/* Hover effect overlay */}
                  <motion.div
                    className={`absolute inset-0 bg-linear-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-300 ${
                      feature.color === "primary"
                        ? "from-primary/5 to-transparent"
                        : feature.color === "chart-1"
                        ? "from-chart-1/5 to-transparent"
                        : feature.color === "chart-2"
                        ? "from-chart-2/5 to-transparent"
                        : "from-chart-3/5 to-transparent"
                    }`}
                  />
                </Card>
              </motion.div>
            ))}
          </motion.div>
        </div>

        {/* Bottom tagline */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 1 }}
          className="text-center mt-8"
        >
          <p className="text-sm text-muted-foreground italic">
            Radio waves sandbox over Hong Kong: See how wireless signals travel
            through the city
          </p>
        </motion.div>
      </div>
    </div>
  );
}
