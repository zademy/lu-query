import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Backdrop, enter} from '../Backdrop';
import {C, MONO, SANS} from '../theme';

const AUDIT: {text: string; tone: string; at: number}[] = [
  {text: '### #1 · 11:33:52 · run_query · SELECT · READ · ✅ OK', tone: C.ink, at: 1.0},
  {text: '| Inicio | 11:33:52.410 | Fin | 11:33:52.492 |', tone: C.muted, at: 1.5},
  {text: '| Duración | 82 ms | Filas | 1 |', tone: C.muted, at: 1.9},
  {text: '', tone: C.ink, at: 2.2},
  {text: '```sql', tone: C.accent, at: 2.4},
  {text: 'SELECT * FROM V$VERSION', tone: C.teal, at: 2.8},
  {text: '```', tone: C.accent, at: 3.2},
];

export const Audit: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <AbsoluteFill style={{fontFamily: SANS}}>
      <Backdrop />
      <AbsoluteFill style={{padding: '140px 140px', color: C.ink, flexDirection: 'column'}}>
        <div style={{...enter(frame, fps, 0.05 * fps), fontSize: 78, fontWeight: 700, letterSpacing: -1}}>
          Every statement, in Markdown.
        </div>
        <div style={{...enter(frame, fps, 0.3 * fps), fontSize: 40, color: C.muted, marginTop: 18, maxWidth: 1350}}>
          One audit file per session: kind, type, duration, rows and the SQL verbatim — readable
          by your agent through the <span style={{fontFamily: MONO, color: C.ink}}>oracle://audit/session/&#123;id&#125;</span> resource.
        </div>

        <div style={{...enter(frame, fps, 0.6 * fps), marginTop: 66, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: '46px 56px', fontFamily: MONO, fontSize: 36, lineHeight: 1.55}}>
          <div style={{color: C.muted, marginBottom: 18}}>mcp-audit-logs/lu-query-20261017T113349-log.md</div>
          {AUDIT.map((l, i) => (
            <div key={i} style={{...enter(frame, fps, l.at * fps), color: l.tone, whiteSpace: 'pre'}}>
              {l.text === '' ? ' ' : l.text}
            </div>
          ))}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
