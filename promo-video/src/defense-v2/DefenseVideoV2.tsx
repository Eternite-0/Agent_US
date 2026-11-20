import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import { PAL, V2_SCENES, V2_TOTAL } from "./theme";
import { SceneFrame, StudioBackdrop } from "./components";
import { S1Paradigm } from "./scenes/S1Paradigm";
import { S2Workbench } from "./scenes/S2Workbench";
import { S3RouterWorker } from "./scenes/S3RouterWorker";
import { S4Control } from "./scenes/S4Control";
import { S5PoolGateway } from "./scenes/S5PoolGateway";
import { S6Ecosystem } from "./scenes/S6Ecosystem";
import { S7Architecture } from "./scenes/S7Architecture";
import { S8Finale } from "./scenes/S8Finale";

const MAP: Record<string, React.FC> = {
  paradigm: S1Paradigm,
  workbench: S2Workbench,
  router: S3RouterWorker,
  control: S4Control,
  pool: S5PoolGateway,
  eco: S6Ecosystem,
  arch: S7Architecture,
  finale: S8Finale,
};

const ProgressLine: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        bottom: 0,
        height: 4,
        width: `${(f / V2_TOTAL) * 100}%`,
        background: `linear-gradient(90deg, ${PAL.sky}, ${PAL.blue})`,
        opacity: 0.85,
        zIndex: 200,
      }}
    />
  );
};

export const DefenseVideoV2: React.FC = () => {
  let cursor = 0;
  return (
    <AbsoluteFill>
      <StudioBackdrop intensity={0.78} />
      {V2_SCENES.map((s, idx) => {
        const Comp = MAP[s.key];
        const from = cursor;
        cursor += s.dur;
        return (
          <Sequence key={s.key} from={from} durationInFrames={s.dur}>
            <SceneFrame
              dur={s.dur}
              noIn={idx === 0 || s.key === "router"}
              noOut={idx === V2_SCENES.length - 1 || s.key === "workbench"}
            >
              <Comp />
            </SceneFrame>
          </Sequence>
        );
      })}
      <ProgressLine />
    </AbsoluteFill>
  );
};
