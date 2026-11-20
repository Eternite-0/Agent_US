import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, prog, rise } from "../theme";
import { Blue, Icon } from "../ui";

const PAINS = [
  { icon: "lock", t: "单一模型锁定", d: "额度耗尽即停摆" },
  { icon: "layers", t: "长任务上下文爆炸", d: "越做越慢、越做越忘" },
  { icon: "stop", t: "黑盒式执行", d: "改错文件无法回退" },
];

export const S2Vision: React.FC = () => {
  const f = useCurrentFrame();
  const out = prog(f, 150, 26);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div
        style={{
          position: "absolute",
          top: 230,
          width: "100%",
          textAlign: "center",
          opacity: 1 - out,
          transform: `translateY(${-out * 40}px)`,
        }}
      >
        <div style={{ ...rise(f, 4), fontSize: 30, color: C.sub, letterSpacing: 3 }}>今天的 AI 编程助手，仍然面临三大难题</div>
        <div style={{ display: "flex", gap: 40, justifyContent: "center", marginTop: 70 }}>
          {PAINS.map((p, i) => {
            const st = 20 + i * 18;
            const strike = prog(f, 112 + i * 8, 20);
            return (
              <div
                key={p.t}
                style={{
                  ...rise(f, st, 28, 30),
                  width: 420,
                  padding: "40px 36px",
                  borderRadius: 26,
                  background: "#fff",
                  border: `1px solid ${C.line}`,
                  boxShadow: "0 24px 50px -30px rgba(11,27,58,0.35)",
                  textAlign: "left",
                  position: "relative",
                }}
              >
                <div style={{ width: 58, height: 58, borderRadius: 16, background: C.redSoft, display: "grid", placeItems: "center" }}>
                  <Icon name={p.icon} size={30} color={C.red} />
                </div>
                <div style={{ fontSize: 36, fontWeight: 750, marginTop: 26, color: C.ink, position: "relative", display: "inline-block" }}>
                  {p.t}
                  <span
                    style={{
                      position: "absolute",
                      left: 0,
                      top: "54%",
                      height: 4,
                      borderRadius: 4,
                      width: `${strike * 100}%`,
                      background: C.blue,
                    }}
                  />
                </div>
                <div style={{ fontSize: 23, color: C.sub, marginTop: 10 }}>{p.d}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ position: "absolute", width: "100%", textAlign: "center", top: 330 }}>
        <div style={{ ...rise(f, 172, 30), fontSize: 34, color: C.sub, letterSpacing: 6 }}>我们的答案</div>
        <div style={{ ...rise(f, 184, 34, 40), fontSize: 104, fontWeight: 800, color: C.ink, marginTop: 24, letterSpacing: -1 }}>
          一句话需求，<Blue>一次完整交付</Blue>
        </div>
        <div style={{ ...rise(f, 210, 30), fontSize: 30, color: C.sub, marginTop: 34 }}>
          自主规划 · 并行执行 · 即时验证 · 随时回溯 —— 全部运行在你的本地
        </div>
      </div>
    </AbsoluteFill>
  );
};
