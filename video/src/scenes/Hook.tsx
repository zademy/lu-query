import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {Backdrop, enter} from '../Backdrop';
import {C, MONO, SANS} from '../theme';

export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const sweep = interpolate(frame, [0.35 * fps, 1.3 * fps], [-30, 62], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{fontFamily: SANS}}>
      <Backdrop />
      <AbsoluteFill
        style={{
          justifyContent: 'center',
          padding: '0 140px',
          color: C.ink,
        }}
      >
        <div style={{...enter(frame, fps, 0.1 * fps), fontFamily: MONO, fontSize: 30, letterSpacing: 6, color: C.accent}}>
          MCP SERVER · ORACLE
        </div>

        <div style={{...enter(frame, fps, 0.35 * fps), fontSize: 112, fontWeight: 700, lineHeight: 1.04, marginTop: 26, letterSpacing: -2}}>
          Your AI agent
          <br />
          speaks <span style={{color: C.accent}}>Oracle</span>.
        </div>

        <div style={{...enter(frame, fps, 0.75 * fps), fontSize: 44, color: C.muted, marginTop: 34, maxWidth: 1080, lineHeight: 1.3}}>
          lu-query turns an Oracle database into 75 MCP tools — in TypeScript, over stdio,
          with a Markdown audit trail.
        </div>

        <div style={{...enter(frame, fps, 1.15 * fps), marginTop: 64, height: 6, width: `${sweep}%`, background: `linear-gradient(90deg, ${C.accent}, ${C.teal})`, borderRadius: 3}} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
