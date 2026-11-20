import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import { C, D_TOTAL, SCENES } from "./theme";
import { Background, SceneWrap } from "./ui";
import { S1Intro } from "./scenes/S1Intro";
import { S2Vision } from "./scenes/S2Vision";
import { S3Home } from "./scenes/S3Home";
import { S4Agent } from "./scenes/S4Agent";
import { S5Control } from "./scenes/S5Control";
import { S6Pool } from "./scenes/S6Pool";
import { S7Eco } from "./scenes/S7Eco";
import { S8Arch } from "./scenes/S8Arch";
import { S9Stats } from "./scenes/S9Stats";
import { S10Finale } from "./scenes/S10Finale";

const MAP: Record<string, React.FC> = {
  intro: S1Intro,
  vision: S2Vision,
  home: S3Home,
  agent: S4Agent,
  control: S5Control,
  pool: S6Pool,
  eco: S7Eco,
  arch: S8Arch,
  stats: S9Stats,
  finale: S10Finale,
};

const Progress: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <div style={{ position: "absolute", left: 0, bottom: 0, height: 4, width: `${(f / D_TOTAL) * 100}%`, background: `linear-gradient(90deg, ${C.sky}, ${C.blue})`, opacity: 0.8 }} />
  );
};

export const DefenseVideo: React.FC = () => {
  let from = 0;
  return (
    <AbsoluteFill>
      <Background />
      {SCENES.map((s, i) => {
        const Comp = MAP[s.key];
        const start = from;
        from += s.dur;
        return (
          <Sequence key={s.key} from={start} durationInFrames={s.dur}>
            <SceneWrap dur={s.dur} noOut={i === SCENES.length - 1}>
              <Comp />
            </SceneWrap>
          </Sequence>
        );
      })}
      <Progress />
    </AbsoluteFill>
  );
};
