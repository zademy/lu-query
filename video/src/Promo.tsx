import React from 'react';
import {Sequence, Track, useVideoConfig} from 'remotion';
import {SceneFade} from './Backdrop';
import {Hook} from './scenes/Hook';
import {Install} from './scenes/Install';
import {Tools} from './scenes/Tools';
import {Audit} from './scenes/Audit';
import {Cta} from './scenes/Cta';

export const Promo: React.FC = () => {
  const {fps} = useVideoConfig();
  const s = (n: number) => Math.round(n * fps);

  return (
    <Track name="Scenes">
      <Sequence name="Hook" durationInFrames={s(5)} premountFor={s(0.5)}>
        <SceneFade>
          <Hook />
        </SceneFade>
      </Sequence>
      <Sequence name="Install" from={s(5)} durationInFrames={s(6)} premountFor={s(0.5)}>
        <SceneFade>
          <Install />
        </SceneFade>
      </Sequence>
      <Sequence name="Tools" from={s(11)} durationInFrames={s(8)} premountFor={s(0.5)}>
        <SceneFade>
          <Tools />
        </SceneFade>
      </Sequence>
      <Sequence name="Audit" from={s(19)} durationInFrames={s(8)} premountFor={s(0.5)}>
        <SceneFade>
          <Audit />
        </SceneFade>
      </Sequence>
      <Sequence name="CallToAction" from={s(27)} durationInFrames={s(6)} premountFor={s(0.5)}>
        <SceneFade>
          <Cta />
        </SceneFade>
      </Sequence>
    </Track>
  );
};

export const PROMO_FRAMES = 33 * 30;
export const PROMO_FPS = 30;
