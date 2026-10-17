import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {C} from './theme';

// Fondo del repo: rejilla tenue + halo de acento. Sin imagenes externas.
export const Backdrop: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const drift = (frame / fps) * 12;

  return (
    <AbsoluteFill style={{backgroundColor: C.bg}}>
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${C.line} 1px, transparent 1px), linear-gradient(90deg, ${C.line} 1px, transparent 1px)`,
          backgroundSize: '64px 64px',
          opacity: 0.35,
          backgroundPosition: `${drift}px ${drift}px`,
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(900px 520px at 78% 12%, ${C.accent}22, transparent 70%), radial-gradient(700px 420px at 12% 92%, ${C.teal}18, transparent 72%)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: `${height * 0.06}px ${width * 0.04}px`,
          border: `1px solid ${C.line}`,
          borderRadius: 18,
        }}
      />
    </AbsoluteFill>
  );
};

// Entrada estandar de escena: sube y aparece.
export const enter = (frame: number, fps: number, delayFrames = 0) => {
  const t = frame - delayFrames;
  const span = 0.5 * fps;
  return {
    opacity: Math.max(0, Math.min(1, t / span)),
    translate: `0 ${Math.max(0, 26 - t * 0.8)}px`,
  };
};

export const SceneFade: React.FC<{children: React.ReactNode}> = ({children}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const fade = 0.4 * (durationInFrames / 30);
  const opacity = Math.min(
    interpolate(frame, [0, fade], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}),
    interpolate(frame, [durationInFrames - fade, durationInFrames], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
  );

  return (
    <AbsoluteFill style={{opacity, scale: interpolate(frame, [0, fade], [1.02, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}}>
      {children}
    </AbsoluteFill>
  );
};
