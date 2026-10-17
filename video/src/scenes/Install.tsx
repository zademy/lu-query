import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Backdrop, enter} from '../Backdrop';
import {C, MONO, SANS} from '../theme';

const LINES = [
  {text: 'npx lu-query', tone: C.teal, at: 0.9},
  {text: '75 tools registered · 4 resources · 9 prompts', tone: C.muted, at: 1.9},
  {text: 'thin driver · lazy pool · stdio only', tone: C.muted, at: 2.9},
  {text: 'no Oracle Client, no JDBC, no Python', tone: C.muted, at: 3.9},
];

export const Install: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <AbsoluteFill style={{fontFamily: SANS}}>
      <Backdrop />
      <AbsoluteFill style={{padding: '150px 140px', color: C.ink, flexDirection: 'column'}}>
        <div style={{...enter(frame, fps, 0.05 * fps), fontSize: 78, fontWeight: 700, letterSpacing: -1}}>
          Nothing to install on the database side.
        </div>
        <div style={{...enter(frame, fps, 0.3 * fps), fontSize: 40, color: C.muted, marginTop: 18}}>
          node-oracledb talks to Oracle in thin mode. The pool is lazy: the server answers
          <span style={{fontFamily: MONO, color: C.ink}}> initialize </span>
          before it ever opens a connection.
        </div>

        <div style={{...enter(frame, fps, 0.6 * fps), marginTop: 72, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: '44px 52px', fontFamily: MONO, fontSize: 40}}>
          <div style={{color: C.muted}}>
            <span style={{color: C.accent}}>$</span> <span style={{color: C.ink}}>npx lu-query</span>
            <span style={{color: C.accent}}> ▍</span>
          </div>
          {LINES.map((l) => (
            <div key={l.text} style={{...enter(frame, fps, l.at * fps), color: l.tone, marginTop: 22}}>
              {l.text}
            </div>
          ))}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
