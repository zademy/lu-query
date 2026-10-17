import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {Backdrop, enter} from '../Backdrop';
import {C, MONO, SANS} from '../theme';

const TOOLS: {name: string; group: string}[] = [
  {name: 'run_query', group: 'query'},
  {name: 'get_sample_data', group: 'query'},
  {name: 'describe_table', group: 'metadata'},
  {name: 'list_schemas', group: 'metadata'},
  {name: 'get_ddl', group: 'metadata'},
  {name: 'list_partitions', group: 'metadata'},
  {name: 'execute_dml', group: 'dml · plsql'},
  {name: 'call_procedure', group: 'dml · plsql'},
  {name: 'explain_plan', group: 'tuning'},
  {name: 'suggest_index', group: 'tuning'},
  {name: 'list_top_sql', group: 'performance'},
  {name: 'get_dependency_graph', group: 'performance'},
];

export const Tools: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const count = Math.round(interpolate(frame, [0.5 * fps, 2.6 * fps], [0, 75], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  }));

  return (
    <AbsoluteFill style={{fontFamily: SANS}}>
      <Backdrop />
      <AbsoluteFill style={{padding: '140px 140px', color: C.ink, flexDirection: 'row', gap: 90, alignItems: 'center'}}>
        <div style={{flex: '0 0 520px'}}>
          <div style={{...enter(frame, fps), fontFamily: MONO, fontSize: 28, letterSpacing: 5, color: C.accent}}>
            THE CATALOG
          </div>
          <div style={{...enter(frame, fps, 0.2 * fps), fontSize: 190, fontWeight: 800, lineHeight: 1, marginTop: 16, color: C.teal, fontVariantNumeric: 'tabular-nums'}}>
            {count}
          </div>
          <div style={{...enter(frame, fps, 0.4 * fps), fontSize: 40, color: C.muted, marginTop: 10}}>
            tools, one per job — from a
            <br />
            quick <span style={{fontFamily: MONO, color: C.ink}}>SELECT</span> to V$
            <span style={{fontFamily: MONO, color: C.ink}}>SESSSTAT</span> diagnostics.
          </div>
        </div>

        <div style={{flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px 40px', alignContent: 'center'}}>
          {TOOLS.map((t, i) => {
            const delay = 0.6 * fps + i * 0.13 * fps;
            const reveal = interpolate(frame, [delay, delay + 0.35 * fps], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            });
            return (
              <div key={t.name} style={{opacity: reveal, translate: `${(1 - reveal) * -18}px 0`, borderLeft: `3px solid ${C.accent}`, paddingLeft: 18}}>
                <div style={{fontFamily: MONO, fontSize: 30, color: C.ink}}>{t.name}</div>
                <div style={{fontFamily: MONO, fontSize: 20, color: C.muted, marginTop: 4, letterSpacing: 2}}>
                  {t.group.toUpperCase()}
                </div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
