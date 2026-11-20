import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { MONO, PAL, mix, p, rise, spr } from "../theme";
import { BlueText, BrandEmblem, BrandLogo, GlassSheen, TitleBlock } from "../components";

const COMPETITORS = [
  {
    name: "Claude Code",
    org: "Anthropic · CLI + Task 子代理",
    logo: "logos/claudecode-color.png",
    subLogo: "logos/claude.png",
    tag: "临时子代理扇出 · 单厂商绑定",
    metric: "无持久拓扑 · 单点 429 易阻塞",
    accent: PAL.claude,
    accentBg: "rgba(217,119,87,0.10)",
    points: [
      "虽支持 Task 子代理，但属内存态临时扇出，崩溃难局部续跑",
      "强绑定单一厂商配额，无法按角色混用多生态高性价比模型",
      "依赖提示词与外挂 Hook，缺少内核级一次性令牌与 T0 门禁",
    ],
  },
  {
    name: "OpenAI Codex",
    org: "OpenAI · 云端并行 Worktree",
    logo: "logos/codex-color.png",
    subLogo: "logos/openai.png",
    tag: "封闭云端沙箱 · 粗粒度隔离",
    metric: "单云生态锁定 · 缺局部重跑",
    accent: PAL.codex,
    accentBg: "rgba(99,102,241,0.10)",
    points: [
      "虽支持云端多任务并行，但跨子任务缺少有状态 DAG 细粒度协同",
      "受限于单一云端黑盒与配额，无法本地私有化接入异构号池热备",
      "异步托管反馈链路长，难以实现 <50ms 本地快照回退与实时纠偏",
    ],
  },
  {
    name: "Hermes Agent",
    org: "Nous Research · 自治演进框架",
    logo: "logos/hermes.png",
    subLogo: "logos/mcp.png",
    tag: "轻量异步委派 · 缺事务锁",
    metric: "无租约防脑裂 · 演化缺门禁",
    accent: PAL.hermes,
    accentBg: "rgba(71,85,105,0.10)",
    points: [
      "支持轻量异步子代理，但缺少 WAL + Outbox + Fencing 租约自愈",
      "技能记忆自演化缺少三分集防过拟合评测门，易引发策略漂移",
      "偏重终端脚本形态，缺乏零网络容器强隔离与双栏可视化交付台",
    ],
  },
];

export const S1Paradigm: React.FC = () => {
  const f = useCurrentFrame();

  const collapse = p(f, 305, 42);
  const reveal = p(f, 348, 36);
  const emblemS = spr(f, 356, 13, 120);
  const brandChars = "Agent_US".split("");

  return (
    <AbsoluteFill>
      {/* Beat 1: Mature Giants' Structural Ceilings */}
      <AbsoluteFill
        style={{
          opacity: 1 - collapse,
          transform: `scale(${mix(collapse, 1, 0.86)}) translate3d(0, ${-collapse * 38}px, 0)`,
          filter: `blur(${collapse * 12}px)`,
          pointerEvents: "none",
        }}
      >
        <TitleBlock
          kicker="行业深度对标 · 架构深水区突破"
          title={
            <>
              主流编程工具虽已支持子代理，仍受困于<BlueText>编排与可靠性瓶颈</BlueText>
            </>
          }
          sub="临时扇出难续跑、单一生态绑定、缺少确定性防幻觉门禁与事务租约锁，制约复杂工程落地"
          at={4}
          y={58}
          size={50}
        />

        <div
          style={{
            position: "absolute",
            top: 274,
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            gap: 34,
          }}
        >
          {COMPETITORS.map((c, idx) => {
            const st = 22 + idx * 16;
            const strike = p(f, 228 + idx * 12, 24);
            const cardIn = rise(f, st, 30, 44);
            const convX = (1 - idx) * collapse * 240;
            return (
              <div
                key={c.name}
                style={{
                  ...cardIn,
                  transform: `${cardIn.transform} translate3d(${convX}px, 0, 0)`,
                  width: 520,
                  padding: "32px 32px 30px",
                  borderRadius: 28,
                  background: "rgba(255,255,255,0.94)",
                  border: `1.5px solid ${PAL.line}`,
                  boxShadow: "0 30px 68px -34px rgba(9,23,48,0.22)",
                  display: "flex",
                  flexDirection: "column",
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                <GlassSheen start={st + 12} dur={50} />
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 5,
                    background: `linear-gradient(90deg, ${c.accent}, ${c.accent}44)`,
                  }}
                />

                {/* Real Brand Logo Header */}
                <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
                  <div style={{ position: "relative" }}>
                    <BrandLogo file={c.logo} size={74} pad={10} radius={20} />
                    <div style={{ position: "absolute", right: -6, bottom: -6 }}>
                      <BrandLogo file={c.subLogo} size={28} pad={4} radius={99} />
                    </div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 29, fontWeight: 820, color: PAL.ink, letterSpacing: -0.5 }}>
                      {c.name}
                    </div>
                    <div style={{ fontSize: 15, color: PAL.muted, fontWeight: 600, marginTop: 3 }}>
                      {c.org}
                    </div>
                  </div>
                </div>

                {/* Structural Bottleneck Badges */}
                <div style={{ marginTop: 22, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span
                    style={{
                      position: "relative",
                      display: "inline-flex",
                      alignItems: "center",
                      padding: "6px 14px",
                      borderRadius: 10,
                      background: c.accentBg,
                      color: c.accent,
                      fontSize: 16.5,
                      fontWeight: 780,
                    }}
                  >
                    {c.tag}
                    <span
                      style={{
                        position: "absolute",
                        left: 8,
                        right: 8,
                        top: "52%",
                        height: 3,
                        borderRadius: 4,
                        background: PAL.blue,
                        transformOrigin: "0 50%",
                        transform: `scaleX(${strike})`,
                      }}
                    />
                  </span>
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 14,
                      fontWeight: 700,
                      padding: "6px 12px",
                      borderRadius: 10,
                      background: PAL.redBg,
                      color: PAL.red,
                    }}
                  >
                    {c.metric}
                  </span>
                </div>

                {/* Concrete Architectural Weaknesses */}
                <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 14 }}>
                  {c.points.map((pt, k) => (
                    <div
                      key={pt}
                      style={{
                        ...rise(f, st + 14 + k * 7, 22, 12),
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 11,
                        fontSize: 18,
                        lineHeight: 1.48,
                        color: PAL.sub,
                      }}
                    >
                      <span
                        style={{
                          width: 21,
                          height: 21,
                          borderRadius: 99,
                          background: PAL.redBg,
                          color: PAL.red,
                          display: "grid",
                          placeItems: "center",
                          fontSize: 12,
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

        <div
          style={{
            ...rise(f, 200, 26, 14),
            position: "absolute",
            bottom: 72,
            left: 0,
            right: 0,
            textAlign: "center",
            fontSize: 24,
            fontWeight: 700,
            color: PAL.sub,
          }}
        >
          从「临时子代理扇出」升级为「有状态事务级多智能体内核」——<BlueText>我们从底层状态机与安全契约彻底重构</BlueText>
        </div>
      </AbsoluteFill>

      {/* Luminous Convergence Pulse */}
      {f >= 312 && f <= 412 && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: interpolate(f, [312, 412], [60, 1500]),
            height: interpolate(f, [312, 412], [60, 1500]),
            marginLeft: interpolate(f, [312, 412], [-30, -750]),
            marginTop: interpolate(f, [312, 412], [-30, -750]),
            borderRadius: 9999,
            background:
              "radial-gradient(circle, rgba(37,99,235,0.26) 0%, rgba(96,165,250,0.09) 46%, rgba(255,255,255,0) 72%)",
            opacity: Math.sin(((f - 312) / 100) * Math.PI),
            pointerEvents: "none",
          }}
        />
      )}

      {/* Beat 2: Agent_US Grand Reveal */}
      {f >= 335 && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: reveal }}>
          {[0, 1, 2].map((i) => {
            const rp = p(f, 355 + i * 14, 115);
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  width: 260 + rp * (540 + i * 260),
                  height: 260 + rp * (540 + i * 260),
                  borderRadius: 9999,
                  border: `1.5px solid rgba(37,99,235,${0.26 * (1 - rp * 0.72)})`,
                  marginTop: -54,
                }}
              />
            );
          })}

          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: -24 }}>
            <div style={{ transform: `scale(${emblemS})`, opacity: Math.min(1, emblemS * 1.6) }}>
              <BrandEmblem size={168} float />
            </div>

            <div
              style={{
                display: "flex",
                marginTop: 38,
                fontSize: 128,
                fontWeight: 860,
                letterSpacing: -2.5,
                lineHeight: 1,
              }}
            >
              {brandChars.map((ch, idx) => {
                const cp = spr(f, 380 + idx * 3, 14, 150);
                return (
                  <span
                    key={idx}
                    style={{
                      opacity: Math.min(1, cp * 1.4),
                      transform: `translate3d(0, ${(1 - cp) * 46}px, 0) scale(${0.8 + cp * 0.2})`,
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
                ...rise(f, 424, 28, 20),
                marginTop: 20,
                fontSize: 38,
                fontWeight: 740,
                color: PAL.text,
                letterSpacing: 2,
              }}
            >
              原创 <BlueText>零信任微内核 × 拓扑多智能体</BlueText> 自主工程操作系统
            </div>

            <div style={{ display: "flex", gap: 18, marginTop: 34 }}>
              {[
                { k: "82.5%", t: "复杂多模块一次通过率" },
                { k: "1.65×", t: "较主流子代理再提速" },
                { k: "-52%", t: "异构分级路由降本" },
              ].map((item, i) => (
                <div
                  key={item.t}
                  style={{
                    ...rise(f, 450 + i * 9, 24, 16),
                    padding: "12px 26px",
                    borderRadius: 999,
                    background: "rgba(255,255,255,0.94)",
                    border: `1.5px solid ${PAL.iceDeep}`,
                    boxShadow: "0 14px 34px -18px rgba(22,66,190,0.42)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 10,
                    fontSize: 20,
                    fontWeight: 700,
                    color: PAL.ink,
                  }}
                >
                  <span style={{ fontFamily: MONO, fontWeight: 850, color: PAL.blue, fontSize: 22 }}>{item.k}</span>
                  <span>{item.t}</span>
                </div>
              ))}
            </div>
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
