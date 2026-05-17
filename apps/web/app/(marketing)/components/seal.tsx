"use client";
import { useMemo } from "react";
import { motion, MotionValue } from "framer-motion";
import { SignetMark } from "./signet-mark";

interface SealProps {
  scrollRotate?: MotionValue<number>;
}

export function Seal({ scrollRotate }: SealProps) {
  const motto = "VERITAS · IN · OPERIBUS · ◆ · SIGNET · ◆ · ";
  const mottoRepeated = motto.repeat(3);
  const hashRing =
    "4a8f9c12bd0e3f87a162e9d04c5b8e72f1903ab74e6c95d0f283b419c7e6d5a8".repeat(2);
  const ticks = useMemo(() => Array.from({ length: 72 }, (_, i) => i * 5), []);

  return (
    <motion.div
      className="relative h-full w-full"
      style={scrollRotate ? { rotate: scrollRotate } : undefined}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 1.4, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
      aria-hidden="true"
    >
      {/* Outer motto ring — slow forward rotation */}
      <motion.div
        className="absolute inset-0"
        animate={{ rotate: 360 }}
        transition={{ duration: 140, repeat: Infinity, ease: "linear" }}
      >
        <svg viewBox="-300 -300 600 600" className="h-full w-full">
          <defs>
            <path
              id="outer-ring-path"
              d="M 0,-262 A 262,262 0 1,1 0,262 A 262,262 0 1,1 0,-262"
            />
          </defs>
          <text
            fontSize="13"
            letterSpacing="6"
            style={{ fontFamily: "var(--font-mono)" }}
            fill="#b8b5a8"
          >
            <textPath href="#outer-ring-path" startOffset="0">
              {mottoRepeated}
            </textPath>
          </text>
        </svg>
      </motion.div>

      {/* Tick marks ring + outer/inner borders */}
      <motion.div
        className="absolute inset-0"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.2, delay: 0.5, ease: [0.16, 1, 0.3, 1] }}
      >
        <svg viewBox="-300 -300 600 600" className="h-full w-full">
          {ticks.map((angle) => {
            const isMajor = angle % 30 === 0;
            const isMid = angle % 15 === 0 && !isMajor;
            const r1 = 232;
            const r2 = isMajor ? 218 : isMid ? 224 : 227;
            const rad = (angle * Math.PI) / 180;
            return (
              <line
                key={angle}
                x1={Math.cos(rad) * r1}
                y1={Math.sin(rad) * r1}
                x2={Math.cos(rad) * r2}
                y2={Math.sin(rad) * r2}
                stroke={isMajor ? "#f5f4ee" : isMid ? "#5e5b51" : "#3d3a33"}
                strokeWidth={isMajor ? 1 : 0.6}
              />
            );
          })}
          <circle r="242" fill="none" stroke="#3d3a33" strokeWidth="0.6" />
          <circle r="210" fill="none" stroke="#3d3a33" strokeWidth="0.6" />
        </svg>
      </motion.div>

      {/* Inner hash ring — counter-rotating */}
      <motion.div
        className="absolute inset-0"
        animate={{ rotate: -360 }}
        transition={{ duration: 100, repeat: Infinity, ease: "linear" }}
      >
        <svg viewBox="-300 -300 600 600" className="h-full w-full">
          <defs>
            <path
              id="middle-ring-path"
              d="M 0,-188 A 188,188 0 1,1 0,188 A 188,188 0 1,1 0,-188"
            />
          </defs>
          <text
            fontSize="9.5"
            letterSpacing="4"
            style={{ fontFamily: "var(--font-mono)" }}
            fill="#5e5b51"
          >
            <textPath href="#middle-ring-path" startOffset="0">
              {hashRing}
            </textPath>
          </text>
        </svg>
      </motion.div>

      {/* Ornaments — 8 evenly placed wax-red markers */}
      <motion.div
        className="absolute inset-0"
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 1, delay: 0.8, ease: [0.16, 1, 0.3, 1] }}
      >
        <svg viewBox="-300 -300 600 600" className="h-full w-full">
          {Array.from({ length: 8 }).map((_, i) => {
            const angle = (i * 360) / 8 - 90;
            const rad = (angle * Math.PI) / 180;
            const r = 158;
            const cx = Math.cos(rad) * r;
            const cy = Math.sin(rad) * r;
            return (
              <g key={i} transform={`translate(${cx}, ${cy})`}>
                <circle r="8" fill="none" stroke="#3d3a33" strokeWidth="0.6" />
                <circle r="2.5" fill="#8b1a1a" />
              </g>
            );
          })}
          <circle r="172" fill="none" stroke="#3d3a33" strokeWidth="0.6" />
          <circle r="142" fill="none" stroke="#3d3a33" strokeWidth="0.6" />
        </svg>
      </motion.div>

      {/* Crosshair guides */}
      <div className="absolute inset-0">
        <svg viewBox="-300 -300 600 600" className="h-full w-full">
          <line x1="-272" y1="0" x2="-252" y2="0" stroke="#5e5b51" strokeWidth="0.6" />
          <line x1="272" y1="0" x2="252" y2="0" stroke="#5e5b51" strokeWidth="0.6" />
          <line x1="0" y1="-272" x2="0" y2="-252" stroke="#5e5b51" strokeWidth="0.6" />
          <line x1="0" y1="272" x2="0" y2="252" stroke="#5e5b51" strokeWidth="0.6" />
        </svg>
      </div>

      {/* Central mark */}
      <motion.div
        className="absolute inset-0 flex items-center justify-center"
        initial={{ opacity: 0, scale: 0.7 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.9, delay: 1.05, ease: [0.16, 1, 0.3, 1] }}
      >
        <SignetMark />
      </motion.div>

      {/* Subtle breathing pulse */}
      <motion.div
        className="absolute inset-0"
        animate={{ scale: [1, 1.012, 1], opacity: [0.5, 1, 0.5] }}
        transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
      >
        <svg viewBox="-300 -300 600 600" className="h-full w-full">
          <circle r="270" fill="none" stroke="#8b1a1a" strokeWidth="0.5" opacity="0.25" />
        </svg>
      </motion.div>
    </motion.div>
  );
}
