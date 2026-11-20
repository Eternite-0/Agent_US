import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import { PAL, V3_SCENES, V3_TOTAL } from "./theme";
import { SceneFrame, StudioBackdrop } from "./components";
import { S1Paradigm } from "./scenes/S1Paradigm";
import { S2KernelInnovations } from "./scenes/S2KernelInnovations";
import { S3Workbench } from "./scenes/S3Workbench";
import { S4RouterWorker } from "./scenes/S4RouterWorker";
import { S5Control } from "./scenes/S5Control";
import { S6PoolGateway } from "./scenes/S6PoolGateway";
import { S7HeadToHead } from "./scenes/S7HeadToHead";
import { S8EcoAndArch } from "./scenes/S8EcoAndArch";
import { S9Finale } from "./scenes/S9Finale";

const MAP: Record<string, React.FC> = {
  paradigm: S1Paradigm,
  kernel: S2KernelInnovations,
  workbench: S3Workbench,
  router: S4RouterWorker,
  control: S5Control,
  pool: S6PoolGateway,
  head2head: S7HeadToHead,
  ecoarch: S8EcoAndArch,
  finale: S9Finale,
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
        width: `${(f / V3_TOTAL) * 100}%`,
        background: `linear-gradient(90deg, ${PAL.sky}, ${PAL.blue})`,
        opacity: 0.88,
        zIndex: 200,
      }}
    />
  );
};

export const DefenseVideoV3: React.FC = () => {
  let cursor = 0;
  return (
    <AbsoluteFill>
      <StudioBackdrop intensity={0.76} />
      {V3_SCENES.map((s, idx) => {
        const Comp = MAP[s.key];
        const from = cursor;
        cursor += s.dur;
        return (
          <Sequence key={s.key} from={from} durationInFrames={s.dur}>
            <SceneFrame
              dur={s.dur}
              noIn={idx === 0 || s.key === "router"}
              noOut={idx === V3_SCENES.length - 1 || s.key === "workbench"}
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
