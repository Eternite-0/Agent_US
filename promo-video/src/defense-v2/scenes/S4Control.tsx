import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { MONO, PAL, mix, p, rise } from "../theme";
import { BlueText, Glass3DImage, TitleBlock } from "../components";

const ControlCard: React.FC<{
  at: number;
  visual: string;
  phase: number;
  cmd: string;
  title: string;
  desc: string;
  active: number;
  children: React.ReactNode;
}> = ({ at, visual, phase, cmd, title, desc, active, children }) => {
  const f = useCurrentFrame();
  const r = rise(f, at, 30, 38);
  return (
    <div
      style={{
        ...r,
        transform: `${r.transform} translateY(${-active * 12}px)`,
        width: 536,
        height: 556,
        borderRadius: 30,
        background: "rgba(255,255,255,0.95)",
        border: `1.8px solid ${active > 0.2 ? PAL.sky : PAL.line}`,
        boxShadow: `0 34px 72px -38px rgba(23,69,196,${0.28 + active * 0.28})`,
        padding: "26px 32px 30px",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Top 3D visual header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <div
          style={{
            width: 104,
            height: 104,
            borderRadius: 24,
            background: "#FFFFFF",
            border: `1px solid ${PAL.lineSoft}`,
            boxShadow: "0 12px 28px -16px rgba(23,69,196,0.32)",
            display: "grid",
            placeItems: "center",
            overflow: "hidden",
            flex: "none",
          }}
        >
          <Glass3DImage src={visual} size={96} floatPhase={phase} />
        </div>
        <div>
          <span
            style={{
              display: "inline-block",
              fontFamily: MONO,
              fontSize: 22,
              fontWeight: 800,
              color: PAL.blue,
              padding: "4px 12px",
              borderRadius: 10,
              background: PAL.ice,
            }}
          >
            {cmd}
          </span>
          <div style={{ fontSize: 30, fontWeight: 800, color: PAL.ink, marginTop: 10, letterSpacing: -0.4 }}>
            {title}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 18.5, color: PAL.sub, marginTop: 14, lineHeight: 1.5 }}>{desc}</div>
      <div style={{ flex: 1, position: "relative", marginTop: 18 }}>{children}</div>
    </div>
  );
};

const CompactViz: React.FC<{ f: number }> = ({ f }) => {
  const t = p(f, 130, 86);
  const pct = mix(t, 92, 18);
  const tok = Math.round(mix(t, 182, 33));
  const cache = Math.round(mix(p(f, 165, 60), 78, 94));
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 16.5, color: PAL.sub, fontWeight: 600 }}>
        <span>上下文窗口占用</span>
        <span style={{ fontFamily: MONO, fontWeight: 800, color: t > 0.5 ? PAL.blue : PAL.amber }}>
          {tok}K tokens · {Math.round(pct)}%
        </span>
      </div>
      <div style={{ height: 13, borderRadius: 99, background: PAL.lineSoft, marginTop: 10, overflow: "hidden" }}>
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            borderRadius: 99,
            background:
              t > 0.5
                ? `linear-gradient(90deg, ${PAL.sky}, ${PAL.blue})`
                : `linear-gradient(90deg, #FBBF24, ${PAL.amber})`,
          }}
        />
      </div>

      <div style={{ position: "relative", height: 174, marginTop: 22 }}>
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: 0,
              top: mix(t, i * 22, 42),
              height: 14,
              width: `${mix(t, 58 + ((i * 29) % 40), 28)}%`,
              borderRadius: 8,
              background: PAL.iceDeep,
              opacity: 1 - t,
            }}
          />
        ))}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 18,
            padding: "16px 18px",
            borderRadius: 16,
            background: PAL.ice,
            border: `1.5px solid ${PAL.iceDeep}`,
            opacity: p(f, 186, 26),
            transform: `scale(${0.92 + p(f, 186, 26) * 0.08})`,
          }}
        >
          <div style={{ fontSize: 17, fontWeight: 780, color: PAL.blueDeep }}>
            ✦ 静态前缀锁定 · 语义摘要无损提纯
          </div>
          <div style={{ fontSize: 15, color: PAL.sub, marginTop: 6 }}>
            保留核心目标、关键 Diff 与架构决策，剔除冗余工具噪声
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "11px 16px",
            borderRadius: 12,
            background: PAL.greenBg,
            color: PAL.green,
            fontSize: 16,
            fontWeight: 750,
            opacity: p(f, 200, 24),
          }}
        >
          <span>Prompt Cache 命中率</span>
          <span style={{ fontFamily: MONO, fontSize: 20 }}>{cache}%</span>
        </div>
      </div>
    </div>
  );
};

const RewindViz: React.FC<{ f: number }> = ({ f }) => {
  const N = 6;
  const pos = interpolate(f, [275, 345], [5, 2], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const done = p(f, 345, 22);
  const W = 468;
  return (
    <div>
      <div style={{ position: "relative", height: 74 }}>
        <div style={{ position: "absolute", top: 22, left: 12, right: 12, height: 4, background: PAL.lineSoft, borderRadius: 4 }} />
        <div
          style={{
            position: "absolute",
            top: 22,
            left: 12,
            width: (pos / (N - 1)) * (W - 24),
            height: 4,
            background: `linear-gradient(90deg, ${PAL.sky}, ${PAL.blue})`,
            borderRadius: 4,
          }}
        />
        {Array.from({ length: N }).map((_, i) => {
          const x = 12 + (i / (N - 1)) * (W - 24);
          const on = i <= pos + 0.02;
          const active = Math.abs(i - pos) < 0.35;
          return (
            <div key={i} style={{ position: "absolute", left: x - 13, top: 11, width: 26, textAlign: "center" }}>
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 99,
                  background: on ? PAL.blue : "#FFFFFF",
                  border: `3px solid ${on ? PAL.blue : PAL.line}`,
                  boxShadow: active ? "0 0 0 9px rgba(37,99,235,0.16)" : undefined,
                }}
              />
              <div style={{ fontSize: 14, color: on ? PAL.blueDeep : PAL.muted, marginTop: 8, fontFamily: MONO, fontWeight: 700 }}>
                #{i + 1}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        {["src/scheduler/heap-queue.ts", "src/router/scorer.ts", "test/fencing-race.test.ts"].map((file, i) => {
          const restored = p(f, 345 + i * 9, 18);
          return (
            <div
              key={file}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "9px 14px",
                borderRadius: 12,
                fontFamily: MONO,
                fontSize: 15,
                background: restored > 0.5 ? PAL.greenBg : PAL.redBg,
                color: restored > 0.5 ? PAL.green : PAL.red,
                fontWeight: 650,
              }}
            >
              <span>{file}</span>
              <span style={{ fontFamily: "inherit", fontSize: 14 }}>
                {restored > 0.5 ? "已无损还原 ✓" : "待回滚"}
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 14.5, color: PAL.sub, marginTop: 12, opacity: done, fontWeight: 600 }}>
        SQLite WAL · 对话上下文 + 磁盘文件 + 链式账本同步回到快照 #3
      </div>
    </div>
  );
};

const SteerViz: React.FC<{ f: number }> = ({ f }) => {
  const draw1 = p(f, 390, 56);
  const draw2 = p(f, 476, 60);
  const L1 = 330;
  const L2 = 320;
  return (
    <div style={{ position: "relative", height: 248 }}>
      <svg width={468} height={248} style={{ position: "absolute", inset: 0 }}>
        <circle cx={34} cy={196} r={12} fill={PAL.blue} />
        {/* Original path fades as new trajectory branches */}
        <path
          d="M 34 196 C 128 188, 210 148, 312 50"
          stroke={PAL.muted}
          strokeWidth={4}
          fill="none"
          strokeDasharray={L1}
          strokeDashoffset={L1 * (1 - Math.min(draw1, 0.65))}
          strokeLinecap="round"
          opacity={draw2 > 0 ? 0.3 : 0.9}
        />
        {/* Live Steered Path */}
        <path
          d="M 192 146 C 276 112, 356 144, 424 184"
          stroke={PAL.blue}
          strokeWidth={5.5}
          fill="none"
          strokeDasharray={L2}
          strokeDashoffset={L2 * (1 - draw2)}
          strokeLinecap="round"
        />
        <circle cx={312} cy={50} r={14} fill="none" stroke={PAL.muted} strokeWidth={2.5} strokeDasharray="5 5" opacity={0.5} />
        <circle
          cx={424}
          cy={184}
          r={16}
          fill={draw2 > 0.92 ? PAL.green : "#FFFFFF"}
          stroke={draw2 > 0.92 ? PAL.green : PAL.blue}
          strokeWidth={3.5}
        />
      </svg>
      <div style={{ position: "absolute", left: 268, top: 10, fontSize: 15, color: PAL.muted, fontWeight: 600 }}>
        原计划：内存锁
      </div>
      <div style={{ position: "absolute", left: 300, top: 208, fontSize: 16, color: PAL.green, fontWeight: 780 }}>
        Redis 分布式锁 ✓
      </div>
      <div
        style={{
          position: "absolute",
          left: 16,
          top: 76,
          padding: "11px 16px",
          borderRadius: 14,
          background: PAL.ink,
          color: "#FFFFFF",
          fontFamily: MONO,
          fontSize: 15.5,
          fontWeight: 650,
          opacity: p(f, 444, 20),
          transform: `scale(${0.86 + p(f, 444, 20) * 0.14})`,
          transformOrigin: "0 100%",
          boxShadow: "0 18px 34px -14px rgba(10,25,53,0.48)",
        }}
      >
        /steer 改用 Redis 分布式锁
      </div>
    </div>
  );
};

const GUARDS = [
  "防死循环熔断器",
  "文件防脏写校验",
  "会话级命令白名单",
  "生命周期 Hooks",
  "AGENTS.md 层级规范",
  "JCS-SHA256 链式审计",
];

export const S4Control: React.FC = () => {
  const f = useCurrentFrame();
  const act = (a: number, b: number) => p(f, a, 18) * (1 - p(f, b, 18));
  return (
    <AbsoluteFill>
      <TitleBlock
        kicker="核心创新 · 全程可控智能"
        title={
          <>
            长任务不失忆，<BlueText>随时回到过去</BlueText>
          </>
        }
        sub="三大原创运行时控制原语，让自主智能体彻底告别黑盒与失控"
        at={4}
        y={56}
        size={54}
      />

      <div
        style={{
          position: "absolute",
          top: 294,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          gap: 36,
        }}
      >
        <ControlCard
          at={32}
          visual="visuals/compact-3d.jpg"
          phase={0}
          cmd="/compact"
          title="两阶段语义压缩"
          desc="自动提纯超长会话上下文，锁定静态前缀保持高缓存命中"
          active={act(120, 265)}
        >
          <CompactViz f={f} />
        </ControlCard>

        <ControlCard
          at={48}
          visual="visuals/rewind-3d.jpg"
          phase={2}
          cmd="/rewind"
          title="确定性时空快照"
          desc="每轮执行自动存盘快照，对话记忆与工作区文件一键无损回溯"
          active={act(265, 395)}
        >
          <RewindViz f={f} />
        </ControlCard>

        <ControlCard
          at={64}
          visual="visuals/sandbox-3d.jpg"
          phase={4}
          cmd="/steer"
          title="运行中实时纠偏"
          desc="无需中断正在并发执行的 Workers，一句话实时改写执行航向"
          active={act(395, 570)}
        >
          <SteerViz f={f} />
        </ControlCard>
      </div>

      {/* Bottom Governance Pills */}
      <div
        style={{
          position: "absolute",
          bottom: 58,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          gap: 16,
        }}
      >
        {GUARDS.map((g, i) => (
          <span
            key={g}
            style={{
              ...rise(f, 520 + i * 7, 24, 14),
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "11px 20px",
              borderRadius: 999,
              background: "rgba(255,255,255,0.92)",
              border: `1.5px solid ${PAL.iceDeep}`,
              color: PAL.blueDeep,
              fontSize: 18,
              fontWeight: 700,
              boxShadow: "0 10px 24px -16px rgba(23,69,196,0.35)",
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: 99, background: PAL.blue }} />
            {g}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
};
