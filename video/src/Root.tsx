import React from 'react';
import {Composition} from 'remotion';
import {PROMO_FRAMES, PROMO_FPS, Promo} from './Promo';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Promo"
      component={Promo}
      durationInFrames={PROMO_FRAMES}
      fps={PROMO_FPS}
      width={1920}
      height={1080}
    />
  );
};
