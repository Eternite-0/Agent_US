import React from "react";
import { Composition } from "remotion";
import { AgentUSPromo } from "./AgentUSPromo";
import { DefenseVideo } from "./defense/DefenseVideo";
import { D_FPS, D_H, D_TOTAL, D_W } from "./defense/theme";
import { DefenseVideoV2 } from "./defense-v2/DefenseVideoV2";
import { V2_FPS, V2_H, V2_TOTAL, V2_W } from "./defense-v2/theme";
import { DefenseVideoV3 } from "./defense-v3/DefenseVideoV3";
import { V3_FPS, V3_H, V3_TOTAL, V3_W } from "./defense-v3/theme";
import { FPS, HEIGHT, TOTAL_FRAMES, WIDTH } from "./theme";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="AgentUSDefenseV3"
        component={DefenseVideoV3}
        durationInFrames={V3_TOTAL}
        fps={V3_FPS}
        width={V3_W}
        height={V3_H}
      />
      <Composition
        id="AgentUSDefenseV2"
        component={DefenseVideoV2}
        durationInFrames={V2_TOTAL}
        fps={V2_FPS}
        width={V2_W}
        height={V2_H}
      />
      <Composition
        id="AgentUSDefense"
        component={DefenseVideo}
        durationInFrames={D_TOTAL}
        fps={D_FPS}
        width={D_W}
        height={D_H}
      />
      <Composition
        id="AgentUSPromo"
        component={AgentUSPromo}
        durationInFrames={TOTAL_FRAMES}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
    </>
  );
};
