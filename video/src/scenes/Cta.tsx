import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Backdrop, enter} from '../Backdrop';
import {C, MONO, SANS} from '../theme';

const STATS = ['75 tools', '4 resources', '9 prompts', 'MIT'];
const SIZES = ['1920×1080', '30 fps', 'H.264'];

export const Cta: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <AbsoluteFill style={{fontFamily: SANS}}>
      <Backdrop />
      <AbsoluteFill style={{padding: '0 140px', color: C.ink, justifyContent: 'center'}}>
        <div style={{...enter(frame, fps, 0.1 * fps), fontSize: 120, fontWeight: 800, letterSpacing: -2}}>
          lu-query
        </div>
        <div style={{...enter(frame, fps, 0.35 * fps), fontSize: 42, color: C.muted, marginTop: 14}}>
          MIT-licensed MCP server for Oracle · Node ≥ 22 · TypeScript
        </div>

        <div style={{...enter(frame, fps, 0.7 * fps), marginTop: 66, fontFamily: MONO, fontSize: 52, color: C.teal}}>
          <span style={{color: C.accent}}>$</span> npx lu-query
        </div>

        <div style={{...enter(frame, fps, 0.95 * fps), marginTop: 18, fontFamily: MONO, fontSize: 40, color: C.ink}}>
          github.com/zademy/lu-query
        </div>

        <div style={{...enter(frame, fps, 1.3 * fps), display: 'flex', gap: 22, marginTop: 66, flexWrap: 'wrap'}}>
          {STATS.map((s) => (
            <span key={s} style={{fontFamily: MONO, fontSize: 28, color: C.ink, border: `1px solid ${C.line}`, borderRadius: 999, padding: '14px 30px', background: C.panel}}>
              {s}
            </span>
          ))}
          {SIZES.map((s) => (
            <span key={s} style={{fontFamily: MONO, fontSize: 28, color: C.muted, border: `1px solid ${C.line}`, borderRadius: 999, padding: '14px 30px'}}>
              {s}
            </span>
          ))}
        </div>

        <div style={{...enter(frame, fps, 1.7 * fps), marginTop: 54, fontFamily: MONO, fontSize: 24, color: C.muted, letterSpacing: 3}}>
          PARITY 1:1 WITH MCP-ORACLE-DB 2.13.0 (JAVA)
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
