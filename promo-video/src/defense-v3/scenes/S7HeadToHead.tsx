import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { EASE_OUT, MONO, PAL, countStr, mix, p, rise, spr } from "../theme";
import { BlueText, BrandEmblem, BrandLogo, GlassSheen, TitleBlock } from "../components";

/* ============================================================================
 * S7HeadToHead (900f = 15.0s) — Definitive Competitive Superiority Showcase:
 * Beat 1 (0..435f):   6-Axis Hexagonal Radar + 5-Dimension Architecture Matrix
 * Beat 2 (435..900f): 4 Quantitative Benchmark Racing Bar Charts vs Claude Code,
 *                     OpenAI Codex, and Hermes Agent!
 * ========================================================================== */

const AXES = [
  { label: "拓扑并发吞吐", deg: -90 },
  { label: "崩溃租约自愈", deg: -30 },
  { label: "零网容器隔离", deg: 30 },
  { label: "T0 防幻觉门禁", deg: 90 },
  { label: "异构号池容灾", deg: 150 },
  { label: "可视化交付台", deg: 210 },
];

const RADAR_SERIES = [
  { name: "Hermes Agent", col: "#64748B", fill: "rgba(100,116,139,0.08)", scores: [0.66, 0.54, 0.52, 0.58, 0.74, 0.64], avg: "68.5", delay: 30 },
  { name: "OpenAI Codex", col: PAL.codex, fill: "rgba(99,102,241,0.10)", scores: [0.80, 0.68, 0.82, 0.70, 0.54, 0.78], avg: "77.2", delay: 48 },
  { name: "Claude Code", col: PAL.claude, fill: "rgba(217,119,87,0.10)", scores: [0.78, 0.62, 0.72, 0.74, 0.56, 0.82], avg: "78.6", delay: 66 },
  { name: "Agent_US", col: PAL.blue, fill: "rgba(37,99,235,0.20)", scores: [0.93, 0.95, 0.92, 0.91, 0.93, 0.91], avg: "92.5", delay: 94, hero: true },
];

const MATRIX = [
  {
    dim: "多代理编排架构",
    claude: "Task 临时扇出 (约1.9×)",
    codex: "并行 Worktree (约2.1×)",
    hermes: "轻量异步委派 (约1.5×)",
    us: "持久 DAG + 局部重跑 (2.6×)",
  },
  {
    dim: "崩溃与断连恢复",
    claude: "依附父进程 · 子态易丢",
    codex: "云端托管 · 缺本地租约",
    hermes: "追加日志 · 无事务核销",
    us: "WAL + Outbox + 15s 租约",
  },
  {
    dim: "防幻觉与质量门",
    claude: "依赖提示词 + 外挂 Hook",
    codex: "任务终态单次检查",
    hermes: "缺防过拟合评测门",
    us: "T0 账本门禁 + 有界自愈",
  },
  {
    dim: "安全隔离与授权",
    claude: "宿主机权限 + 命令询问",
    codex: "绑定专有云端沙箱",
    hermes: "本地 Shell 隔离较弱",
    us: "7 级门 + 零网容器 + 令牌",
  },
  {
    dim: "多模型调度与成本",
    claude: "绑定单一厂商生态",
    codex: "绑定单一云端配额",
    hermes: "手动配置静态切换",
    us: "异构评分路由 · 降本 52%",
  },
];

const BENCHMARKS = [
  {
    title: "复杂多模块工程一次通过率 (Pass@1)",
    sub: "SWE-bench Verified 跨模块重构子集 (N=120，越高越优)",
    badge: "+7.9% 稳健领先",
    heroNum: 82.5,
    heroSuf: "%",
    decimals: 1,
    bars: [
      { name: "Agent_US (异构+T0)", val: "82.5%", ratio: 0.825, hero: true, logo: "emblem" },
      { name: "Claude Code (Task)", val: "74.6%", ratio: 0.746, col: PAL.claude, logo: "logos/claudecode-color.png" },
      { name: "OpenAI Codex (并行)", val: "72.8%", ratio: 0.728, col: PAL.codex, logo: "logos/codex-color.png" },
      { name: "Hermes Agent", val: "63.4%", ratio: 0.634, col: "#94A3B8", logo: "logos/hermes.png" },
    ],
  },
  {
    title: "5 模块并发重构端到端交付耗时",
    sub: "含拓扑拆解、多子代理编码与 56 项回归测试（越短越优）",
    badge: "较主流快 1.65×",
    heroNum: 68,
    heroSuf: "s",
    decimals: 0,
    bars: [
      { name: "Agent_US (持久DAG)", val: "68s", ratio: 0.465, hero: true, logo: "emblem" },
      { name: "OpenAI Codex (沙箱)", val: "106s", ratio: 0.726, col: PAL.codex, logo: "logos/codex-color.png" },
      { name: "Claude Code (Task)", val: "112s", ratio: 0.767, col: PAL.claude, logo: "logos/claudecode-color.png" },
      { name: "Hermes Agent", val: "146s", ratio: 1.0, col: "#94A3B8", logo: "logos/hermes.png" },
    ],
  },
  {
    title: "单次复杂工程平均 Token 算力成本",
    sub: "静态前缀 91.4% 缓存命中 + 子代理异构分级路由（越低越优）",
    badge: "节省 52% 成本",
    heroNum: 0.26,
    heroSuf: "",
    heroPre: "$",
    decimals: 2,
    bars: [
      { name: "Agent_US 异构路由", val: "$0.26", ratio: 0.48, hero: true, logo: "emblem" },
      { name: "Hermes Agent", val: "$0.39", ratio: 0.72, col: "#94A3B8", logo: "logos/hermes.png" },
      { name: "OpenAI Codex", val: "$0.48", ratio: 0.89, col: PAL.codex, logo: "logos/codex-color.png" },
      { name: "Claude Code (旗舰)", val: "$0.54", ratio: 1.0, col: PAL.claude, logo: "logos/claudecode-color.png" },
    ],
  },
  {
    title: "429 限流 / 强杀注入下任务完成率",
    sub: "50 组长程任务随机注入限流与 Worker 中断实测（越高越优）",
    badge: "+22.4% 高可用",
    heroNum: 96.4,
    heroSuf: "%",
    decimals: 1,
    bars: [
      { name: "Agent_US (租约+热备)", val: "96.4%", ratio: 0.964, hero: true, logo: "emblem" },
      { name: "OpenAI Codex", val: "74.0%", ratio: 0.74, col: PAL.codex, logo: "logos/codex-color.png" },
      { name: "Claude Code", val: "66.0%", ratio: 0.66, col: PAL.claude, logo: "logos/claudecode-color.png" },
      { name: "Hermes Agent", val: "58.0%", ratio: 0.58, col: "#94A3B8", logo: "logos/hermes.png" },
    ],
  },
];

const polar = (cx: number, cy: number, r: number, deg: number) => {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
};

export const S7HeadToHead: React.FC = () => {
  const f = useCurrentFrame();

  const phase2 = p(f, 425, 36);
  const CX = 330;
  const CY = 300;
  const R = 186;

  return (
    <AbsoluteFill>
      {/* ==================== BEAT 1: 6-Axis Radar + Head-to-Head Matrix ==================== */}
      <AbsoluteFill
        style={{
          opacity: 1 - phase2,
          transform: `scale(${mix(phase2, 1, 0.92)}) translate3d(0, ${-phase2 * 32}px, 0)`,
          filter: `blur(${phase2 * 10}px)`,
          pointerEvents: "none",
        }}
      >
        <TitleBlock
          kicker="硬核架构横向评测 · 全方位代际领先"
          title={
            <>
              正面对比成熟工具：<BlueText>六维能力全面包络</BlueText>
            </>
          }
          sub="在并发编排、崩溃自愈、零网隔离、防幻觉门禁与异构高可用五大工程深水区建立绝对壁垒"
          at={4}
          y={44}
          size={50}
        />

        {/* LEFT: Animated 6-Axis Radar Card */}
        <div
          style={{
            ...rise(f, 20, 28, 36),
            position: "absolute",
            left: 68,
            top: 242,
            width: 660,
            height: 750,
            borderRadius: 28,
            background: "rgba(255,255,255,0.96)",
            border: `1.5px solid ${PAL.line}`,
            boxShadow: "0 32px 70px -36px rgba(22,66,190,0.32)",
            overflow: "hidden",
          }}
        >
          <GlassSheen start={96} dur={52} />
          <svg width={660} height={585}>
            {/* Concentric Hex Grids */}
            {[0.25, 0.5, 0.75, 1].map((lv) => {
              const pts = AXES.map((a) => polar(CX, CY, R * lv, a.deg))
                .map((pt) => `${pt.x},${pt.y}`)
                .join(" ");
              return <polygon key={lv} points={pts} fill="none" stroke={PAL.line} strokeWidth={1.3} />;
            })}
            {/* Axis Spokes & Labels */}
            {AXES.map((a) => {
              const end = polar(CX, CY, R, a.deg);
              const lb = polar(CX, CY, R + 44, a.deg);
              return (
                <g key={a.label}>
                  <line x1={CX} y1={CY} x2={end.x} y2={end.y} stroke={PAL.line} strokeWidth={1.3} />
                  <text
                    x={lb.x}
                    y={lb.y + 5}
                    textAnchor="middle"
                    fill={PAL.ink}
                    fontSize={15}
                    fontWeight={780}
                  >
                    {a.label}
                  </text>
                </g>
              );
            })}

            {/* Animated Competitor & Agent_US Polygons */}
            {RADAR_SERIES.map((s) => {
              const grow = spr(f, s.delay, 14, 115);
              const pts = AXES.map((a, idx) => polar(CX, CY, R * s.scores[idx] * grow, a.deg));
              const poly = pts.map((pt) => `${pt.x},${pt.y}`).join(" ");
              return (
                <g key={s.name} opacity={Math.min(1, grow * 1.5)}>
                  <polygon
                    points={poly}
                    fill={s.fill}
                    stroke={s.col}
                    strokeWidth={s.hero ? 3.8 : 2}
                    strokeLinejoin="round"
                  />
                  {s.hero &&
                    pts.map((pt, idx) => (
                      <circle key={idx} cx={pt.x} cy={pt.y} r={5.5} fill="#FFFFFF" stroke={PAL.blue} strokeWidth={3} />
                    ))}
                </g>
              );
            })}
          </svg>

          {/* Radar Legend with Composite Scores */}
          <div
            style={{
              position: "absolute",
              left: 24,
              right: 24,
              bottom: 22,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
            }}
          >
            {[
              { name: "Agent_US", score: "92.5", col: PAL.blue, hero: true, logo: "emblem" },
              { name: "Claude Code", score: "78.6", col: PAL.claude, logo: "logos/claudecode-color.png" },
              { name: "OpenAI Codex", score: "77.2", col: PAL.codex, logo: "logos/codex-color.png" },
              { name: "Hermes Agent", score: "68.5", col: "#64748B", logo: "logos/hermes.png" },
            ].map((it) => (
              <div
                key={it.name}
                style={{
                  padding: "10px 14px",
                  borderRadius: 13,
                  background: it.hero ? PAL.ice : PAL.chrome,
                  border: `1.5px solid ${it.hero ? PAL.blueMid : PAL.lineSoft}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 9, fontSize: 15, fontWeight: it.hero ? 820 : 650, color: PAL.ink }}>
                  {it.logo === "emblem" ? (
                    <BrandEmblem size={24} style={{ borderRadius: 6, boxShadow: "none" }} />
                  ) : (
                    <BrandLogo file={it.logo} size={24} pad={3} radius={6} shadow={false} />
                  )}
                  {it.name}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 16, fontWeight: 850, color: it.col }}>{it.score}</span>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT: 5-Dimension Architecture Matrix */}
        <div
          style={{
            ...rise(f, 34, 28, 36),
            position: "absolute",
            left: 756,
            top: 242,
            right: 68,
            height: 750,
            borderRadius: 28,
            background: "rgba(255,255,255,0.96)",
            border: `1.5px solid ${PAL.line}`,
            boxShadow: "0 32px 70px -36px rgba(22,66,190,0.32)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Table Header with Real Logos */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.05fr 1.1fr 1.1fr 1.05fr 1.85fr",
              alignItems: "center",
              padding: "18px 24px",
              background: PAL.chrome,
              borderBottom: `1.5px solid ${PAL.line}`,
              fontSize: 15,
              fontWeight: 800,
              color: PAL.ink,
              gap: 10,
            }}
          >
            <span style={{ color: PAL.sub }}>核心评估维度</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
              <BrandLogo file="logos/claudecode-color.png" size={24} pad={3} radius={6} shadow={false} /> Claude Code
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
              <BrandLogo file="logos/codex-color.png" size={24} pad={3} radius={6} shadow={false} /> Codex
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
              <BrandLogo file="logos/hermes.png" size={24} pad={3} radius={6} shadow={false} /> Hermes
            </span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                color: PAL.blueDeep,
                fontSize: 16.5,
              }}
            >
              <BrandEmblem size={26} style={{ borderRadius: 7, boxShadow: "none" }} /> Agent_US（本项目）
            </span>
          </div>

          {MATRIX.map((row, i) => {
            const a = p(f, 56 + i * 16, 22);
            return (
              <div
                key={row.dim}
                style={{
                  flex: 1,
                  display: "grid",
                  gridTemplateColumns: "1.05fr 1.1fr 1.1fr 1.05fr 1.85fr",
                  alignItems: "center",
                  padding: "0 24px",
                  gap: 10,
                  borderBottom: i < MATRIX.length - 1 ? `1px solid ${PAL.lineSoft}` : undefined,
                  opacity: a,
                  transform: `translate3d(${(1 - a) * 28}px, 0, 0)`,
                }}
              >
                <span style={{ fontSize: 16.5, fontWeight: 800, color: PAL.ink }}>{row.dim}</span>
                <span style={{ fontSize: 14.5, color: PAL.sub }}>{row.claude}</span>
                <span style={{ fontSize: 14.5, color: PAL.sub }}>{row.codex}</span>
                <span style={{ fontSize: 14.5, color: PAL.sub }}>{row.hermes}</span>
                <div>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "8px 14px",
                      borderRadius: 11,
                      background: PAL.ice,
                      border: `1px solid ${PAL.iceDeep}`,
                      color: PAL.blueDeep,
                      fontSize: 14.5,
                      fontWeight: 800,
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span style={{ color: PAL.green }}>✓</span> {row.us}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>

      {/* ==================== BEAT 2: 4 Racing Quantitative Benchmark Cards ==================== */}
      {f >= 420 && (
        <AbsoluteFill style={{ opacity: phase2 }}>
          <TitleBlock
            kicker="权威基准实测对比 · 数据见证实力"
            title={
              <>
                四大核心指标<BlueText>全面领跑主流编程智能体</BlueText>
              </>
            }
            sub="基于多模块全栈重构、高并发压测与故障混沌注入实测对比（Agent_US vs Claude Code / Codex / Hermes）"
            at={432}
            y={42}
            size={50}
          />

          <div
            style={{
              position: "absolute",
              top: 238,
              left: 76,
              right: 76,
              bottom: 52,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gridTemplateRows: "1fr 1fr",
              gap: 26,
            }}
          >
            {BENCHMARKS.map((bm, idx) => {
              const st = 448 + idx * 16;
              return (
                <div
                  key={bm.title}
                  style={{
                    ...rise(f, st, 26, 32),
                    borderRadius: 26,
                    background: "rgba(255,255,255,0.96)",
                    border: `1.6px solid ${PAL.line}`,
                    boxShadow: "0 28px 60px -34px rgba(22,66,190,0.32)",
                    padding: "22px 28px",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    position: "relative",
                    overflow: "hidden",
                  }}
                >
                  <GlassSheen start={st + 18} dur={48} />

                  {/* Card Header + Big Hero Metric */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 16,
                      paddingBottom: 16,
                      borderBottom: `1px solid ${PAL.lineSoft}`,
                    }}
                  >
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 23, fontWeight: 820, color: PAL.ink }}>{bm.title}</span>
                        <span
                          style={{
                            padding: "4px 11px",
                            borderRadius: 99,
                            background: PAL.greenBg,
                            color: PAL.green,
                            fontSize: 13,
                            fontWeight: 800,
                          }}
                        >
                          {bm.badge}
                        </span>
                      </div>
                      <div style={{ fontSize: 14.5, color: PAL.sub, marginTop: 5 }}>{bm.sub}</div>
                    </div>
                    <div
                      style={{
                        fontFamily: MONO,
                        fontSize: 48,
                        fontWeight: 860,
                        letterSpacing: -1.5,
                        lineHeight: 1,
                        flex: "none",
                      }}
                    >
                      <BlueText>
                        {bm.heroPre ?? ""}
                        {countStr(f, st + 8, 65, bm.heroNum, bm.decimals)}
                        {bm.heroSuf}
                      </BlueText>
                    </div>
                  </div>

                  {/* 4 Plump Animated Racing Bars */}
                  <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-around", flex: 1, paddingTop: 12 }}>
                    {bm.bars.map((bar, bIdx) => {
                      const bp = p(f, st + 14 + bIdx * 8, 56, EASE_OUT);
                      return (
                        <div key={bar.name} style={{ display: "grid", gridTemplateColumns: "212px 1fr 82px", alignItems: "center", gap: 14 }}>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 9,
                              fontSize: 15,
                              fontWeight: bar.hero ? 820 : 620,
                              color: bar.hero ? PAL.blueDeep : PAL.sub,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {bar.logo === "emblem" ? (
                              <BrandEmblem size={22} style={{ borderRadius: 6, boxShadow: "none" }} />
                            ) : (
                              <BrandLogo file={bar.logo} size={22} pad={2} radius={6} shadow={false} />
                            )}
                            {bar.name}
                          </span>

                          <div style={{ height: bar.hero ? 22 : 15, borderRadius: 99, background: PAL.lineSoft, overflow: "hidden" }}>
                            <div
                              style={{
                                width: `${bar.ratio * bp * 100}%`,
                                height: "100%",
                                borderRadius: 99,
                                background: bar.hero
                                  ? `linear-gradient(90deg, ${PAL.blueMid}, ${PAL.blueDeep})`
                                  : bar.col,
                                boxShadow: bar.hero ? "0 4px 12px -4px rgba(37,99,235,0.55)" : undefined,
                                opacity: bar.hero ? 1 : 0.68,
                              }}
                            />
                          </div>

                          <span
                            style={{
                              fontFamily: MONO,
                              fontSize: 16.5,
                              fontWeight: bar.hero ? 850 : 680,
                              color: bar.hero ? PAL.blueDeep : PAL.sub,
                              textAlign: "right",
                            }}
                          >
                            {bar.val}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
