import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { PAL, mix, p, rise, spr } from "../theme";
import { BlueText, BrandEmblem, BrandLogo, TitleBlock } from "../components";

const COMPETITORS = [
  {
    name: "Claude Code",
    org: "Anthropic",
    logo: "logos/claudecode-color.png",
    subLogo: "logos/claude.png",
    tag: "单终端线性串行",
    accent: "#D97757",
    accentBg: "rgba(217,119,87,0.10)",
    points: [
      "强绑定单一厂商模型，缺乏跨模型路由",
      "单 Agent 串行循环，复杂大工程耗时高",
      "终端黑盒交互，缺乏可视化并行拓扑",
    ],
  },
  {
    name: "OpenAI Codex",
    org: "OpenAI",
    logo: "logos/codex-color.png",
    subLogo: "logos/openai.png",
    tag: "封闭单生态闭环",
    accent: "#3B82F6",
    accentBg: "rgba(59,130,246,0.10)",
    points: [
      "受限单一账号配额，限流即中断停摆",
      "云端封闭沙箱，难以自由接入国产/本地模型",
      "缺少开放式多角色 Router-Worker 自主编排",
    ],
  },
  {
    name: "Hermes Agent",
    org: "Nous Research",
    logo: "logos/hermes.png",
    subLogo: "logos/mcp.png",
    tag: "单智能体 CLI 范式",
    accent: "#0F172A",
    accentBg: "rgba(15,23,42,0.08)",
    points: [
      "偏重单 Agent 记忆学习与脚本自治",
      "缺乏多 Worker 隔离分工与交叉审查机制",
      "缺少工程级双栏 Diff 交付与审批门控工作台",
    ],
  },
];

export const S1Paradigm: React.FC = () => {
  const f = useCurrentFrame();

  // Beat 1: Competitor ceiling cards (0 - 345f)
  const collapse = p(f, 315, 42);
  // Beat 2: Agent_US grand reveal (355 - 690f)
  const reveal = p(f, 360, 38);
  const emblemS = spr(f, 368, 13, 115);

  const brandChars = "Agent_US".split("");

  return (
    <AbsoluteFill>
      {/* Beat 1: Industry Bottlenecks with Real Logos */}
      <AbsoluteFill
        style={{
          opacity: 1 - collapse,
          transform: `scale(${mix(collapse, 1, 0.88)}) translateY(${-collapse * 36}px)`,
          filter: `blur(${collapse * 12}px)`,
          pointerEvents: "none",
        }}
      >
        <TitleBlock
          kicker="行业现状 · 范式天花板"
          title={
            <>
              当今主流 AI 编程助手，正在触碰<BlueText>三重边界</BlueText>
            </>
          }
          sub="从单终端循环到封闭生态，现有工具在面对大型复杂工程时仍受限于单点智能"
          at={6}
          y={76}
          size={54}
        />

        <div
          style={{
            position: "absolute",
            top: 300,
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            gap: 36,
          }}
        >
          {COMPETITORS.map((c, idx) => {
            const st = 28 + idx * 18;
            const strike = p(f, 240 + idx * 14, 24);
            const cardIn = rise(f, st, 32, 42);
            const convergenceX = (1 - idx) * collapse * 220;
            return (
              <div
                key={c.name}
                style={{
                  ...cardIn,
                  transform: `${cardIn.transform} translateX(${convergenceX}px)`,
                  width: 510,
                  padding: "36px 34px 34px",
                  borderRadius: 28,
                  background: "rgba(255,255,255,0.92)",
                  border: `1.5px solid ${PAL.line}`,
                  boxShadow: "0 30px 70px -36px rgba(10,25,53,0.22)",
                  display: "flex",
                  flexDirection: "column",
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                {/* Top brand accent bar */}
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 5,
                    background: `linear-gradient(90deg, ${c.accent}, ${c.accent}55)`,
                  }}
                />

                {/* Brand Logo Row */}
                <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
                  <div style={{ position: "relative" }}>
                    <BrandLogo file={c.logo} size={76} pad={10} radius={20} />
                    <div style={{ position: "absolute", right: -6, bottom: -6 }}>
                      <BrandLogo file={c.subLogo} size={30} pad={5} radius={99} />
                    </div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 30, fontWeight: 800, color: PAL.ink, letterSpacing: -0.5 }}>
                      {c.name}
                    </div>
                    <div style={{ fontSize: 16, color: PAL.muted, fontWeight: 600, marginTop: 3 }}>
                      {c.org}
                    </div>
                  </div>
                </div>

                {/* Paradigm Tag with animated breakthrough slash */}
                <div style={{ marginTop: 26, display: "flex", alignItems: "center" }}>
                  <span
                    style={{
                      position: "relative",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 16px",
                      borderRadius: 12,
                      background: c.accentBg,
                      color: c.accent,
                      fontSize: 18,
                      fontWeight: 750,
                    }}
                  >
                    瓶颈 · {c.tag}
                    <span
                      style={{
                        position: "absolute",
                        left: 10,
                        right: 10,
                        top: "52%",
                        height: 3.5,
                        borderRadius: 4,
                        background: PAL.blue,
                        transformOrigin: "0 50%",
                        transform: `scaleX(${strike})`,
                      }}
                    />
                  </span>
                </div>

                {/* Limitation Points */}
                <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 16 }}>
                  {c.points.map((pt, k) => (
                    <div
                      key={pt}
                      style={{
                        ...rise(f, st + 16 + k * 8, 22, 12),
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 12,
                        fontSize: 19,
                        lineHeight: 1.5,
                        color: PAL.sub,
                      }}
                    >
                      <span
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 99,
                          background: PAL.redBg,
                          color: PAL.red,
                          display: "grid",
                          placeItems: "center",
                          fontSize: 13,
                          fontWeight: 800,
                          marginTop: 3,
                          flex: "none",
                        }}
                      >
                        ✕
                      </span>
                      <span>{pt}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Bottom teaser line */}
        <div
          style={{
            ...rise(f, 220, 28, 16),
            position: "absolute",
            bottom: 86,
            left: 0,
            right: 0,
            textAlign: "center",
            fontSize: 26,
            fontWeight: 650,
            color: PAL.sub,
          }}
        >
          下一代自主软件工程，需要一套<BlueText>彻底重构的多智能体协同架构</BlueText>
        </div>
      </AbsoluteFill>

      {/* Convergence Light Burst */}
      {f >= 325 && f <= 425 && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: interpolate(f, [325, 425], [80, 1400]),
            height: interpolate(f, [325, 425], [80, 1400]),
            marginLeft: interpolate(f, [325, 425], [-40, -700]),
            marginTop: interpolate(f, [325, 425], [-40, -700]),
            borderRadius: 9999,
            background: "radial-gradient(circle, rgba(37,99,235,0.22) 0%, rgba(96,165,250,0.08) 45%, rgba(255,255,255,0) 72%)",
            opacity: Math.sin(((f - 325) / 100) * Math.PI),
            pointerEvents: "none",
          }}
        />
      )}

      {/* Beat 2: Agent_US Grand Reveal */}
      {f >= 345 && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: reveal }}>
          {/* Subtle expanding sapphire rings */}
          {[0, 1, 2].map((i) => {
            const rp = p(f, 365 + i * 14, 110);
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  width: 280 + rp * (520 + i * 260),
                  height: 280 + rp * (520 + i * 260),
                  borderRadius: 9999,
                  border: `1.5px solid rgba(37,99,235,${0.26 * (1 - rp * 0.72)})`,
                  marginTop: -60,
                }}
              />
            );
          })}

          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: -24 }}>
            <div style={{ transform: `scale(${emblemS})`, opacity: Math.min(1, emblemS * 1.6) }}>
              <BrandEmblem size={172} float />
            </div>

            <div
              style={{
                display: "flex",
                marginTop: 42,
                fontSize: 130,
                fontWeight: 850,
                letterSpacing: -2.5,
                lineHeight: 1,
              }}
            >
              {brandChars.map((ch, idx) => {
                const cp = p(f, 392 + idx * 4, 28);
                return (
                  <span
                    key={idx}
                    style={{
                      opacity: cp,
                      transform: `translateY(${(1 - cp) * 44}px)`,
                      filter: `blur(${(1 - cp) * 8}px)`,
                      display: "inline-block",
                      color: ch === "U" || ch === "S" ? PAL.blue : PAL.ink,
                    }}
                  >
                    {ch}
                  </span>
                );
              })}
            </div>

            <div
              style={{
                ...rise(f, 444, 30, 22),
                marginTop: 22,
                fontSize: 38,
                fontWeight: 700,
                color: PAL.text,
                letterSpacing: 2.5,
              }}
            >
              原创 <BlueText>Router-Worker 协同</BlueText> 本地多模型自主编程工作台
            </div>

            <div style={{ display: "flex", gap: 18, marginTop: 36 }}>
              {[
                "Router 拓扑编排 × 多 Worker 隔离并发",
                "多厂商号池异构调度 · 429 无感容灾",
                "沙箱门控 · 快照回溯 · 全链路可控",
              ].map((tag, i) => (
                <div
                  key={tag}
                  style={{
                    ...rise(f, 470 + i * 10, 26, 16),
                    padding: "12px 24px",
                    borderRadius: 999,
                    background: "rgba(255,255,255,0.92)",
                    border: `1.5px solid ${PAL.iceDeep}`,
                    boxShadow: "0 14px 32px -18px rgba(23,69,196,0.4)",
                    color: PAL.blueDeep,
                    fontSize: 20,
                    fontWeight: 680,
                  }}
                >
                  {tag}
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              position: "absolute",
              bottom: 62,
              fontSize: 17,
              letterSpacing: 7,
              color: PAL.muted,
              fontWeight: 600,
              opacity: p(f, 515, 30),
            }}
          >
            PROJECT DEFENSE · ORIGINAL ARCHITECTURE
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
