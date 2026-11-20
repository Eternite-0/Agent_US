import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { HudChrome } from "./components/HudChrome";
import { Scene1HeroProblem } from "./scenes/Scene1HeroProblem";
import { Scene2Architecture } from "./scenes/Scene2Architecture";
import { Scene3LiveWorkflow } from "./scenes/Scene3LiveWorkflow";
import { Scene4ComparisonMatrix } from "./scenes/Scene4ComparisonMatrix";
import { Scene5Benchmarks } from "./scenes/Scene5Benchmarks";
import { Scene6Finale } from "./scenes/Scene6Finale";
import { COLORS, SCENE_RANGES } from "./theme";

export const AgentUSPromo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bgDeep }}>
      <HudChrome />

      <Sequence
        from={SCENE_RANGES[0].start}
        durationInFrames={SCENE_RANGES[0].duration}
      >
        <Scene1HeroProblem />
      </Sequence>

      <Sequence
        from={SCENE_RANGES[1].start}
        durationInFrames={SCENE_RANGES[1].duration}
      >
        <Scene2Architecture />
      </Sequence>

      <Sequence
        from={SCENE_RANGES[2].start}
        durationInFrames={SCENE_RANGES[2].duration}
      >
        <Scene3LiveWorkflow />
      </Sequence>

      <Sequence
        from={SCENE_RANGES[3].start}
        durationInFrames={SCENE_RANGES[3].duration}
      >
        <Scene4ComparisonMatrix />
      </Sequence>

      <Sequence
        from={SCENE_RANGES[4].start}
        durationInFrames={SCENE_RANGES[4].duration}
      >
        <Scene5Benchmarks />
      </Sequence>

      <Sequence
        from={SCENE_RANGES[5].start}
        durationInFrames={SCENE_RANGES[5].duration}
      >
        <Scene6Finale />
      </Sequence>
    </AbsoluteFill>
  );
};
