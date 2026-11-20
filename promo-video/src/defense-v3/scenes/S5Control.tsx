import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { MONO, PAL, mix, p, rise } from "../theme";
import { BlueText, Glass3DImage, GlassSheen, TitleBlock } from "../components";

const ControlCard: React.FC<{
  at: number;
  sheenAt: number;
  visual: string;
  phase: number;
  cmd: string;
  metric: string;
  title: string;
  desc: string;
  active: number;
  children: React.ReactNode;
}> = ({ at, sheenAt, visual, phase, cmd, metric, title, desc, active, children }) => {
  const f = useCurrentFrame();
  const r = rise(f, at, 28, 38);
  return (
    <div
      style={{
        ...r,
        transform: `${r.transform} translate3d(0, ${-active * 12}px, 0)`,
        width: 538,
        height: 560,
        borderRadius: 30,
        background: "rgba(255,255,255,0.96)",
        border: `1.8px solid ${active > 0.2 ? PAL.blueMid : PAL.line}`,
        boxShadow: `0 34px 72px -36px rgba(22,66,190,${0.26 + active * 0.28})`,
        padding: "26px 30px 28px",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <GlassSheen start={sheenAt} dur={48} />
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <div
          style={{
            width: 100,
            height: 100,
            borderRadius: 24,
            background: "#FFFFFF",
            border: `1px solid ${PAL.lineSoft}`,
            boxShadow: "0 12px 28px -16px rgba(22,66,190,0.32)",
            display: "grid",
            placeItems: "center",
            overflow: "hidden",
            flex: "none",
          }}
        >
          <Glass3DImage src={visual} size={92} floatPhase={phase} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span
              style={{
                fontFamily: MONO,
                fontSize: 21,
                fontWeight: 800,
                color: PAL.blue,
                padding: "3px 12px",
                borderRadius: 10,
                background: PAL.ice,
              }}
            >
              {cmd}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 13.5, fontWeight: 800, color: PAL.green }}>{metric}</span>
          </div>
          <div style={{ fontSize: 28, fontWeight: 820, color: PAL.ink, marginTop: 10, letterSpacing: -0.4 }}>
            {title}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 17.5, color: PAL.sub, marginTop: 14, lineHeight: 1.48 }}>{desc}</div>
      <div style={{ flex: 1, position: "relative", marginTop: 18 }}>{children}</div>
    </div>
  );
};

const CompactViz: React.FC<{ f: number }> = ({ f }) => {
  const t = p(f, 105, 80);
  const pct = mix(t, 92, 20);
  const tok = Math.round(mix(t, 184, 40));
  const cache = (mix(p(f, 135, 55), 79.4, 91.4)).toFixed(1);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 16, color: PAL.sub, fontWeight: 650 }}>
        <span>上下文预算占用</span>
        <span style={{ fontFamily: MONO, fontWeight: 800, color: t > 0.5 ? PAL.blue : PAL.amber }}>
          {tok}K tok · {Math.round(pct)}%
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

      <div style={{ position: "relative", height: 178, marginTop: 22 }}>
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
            top: 16,
            padding: "16px 18px",
            borderRadius: 16,
            background: PAL.ice,
            border: `1.5px solid ${PAL.iceDeep}`,
            opacity: p(f, 156, 24),
            transform: `scale(${0.92 + p(f, 156, 24) * 0.08})`,
          }}
        >
          <div style={{ fontSize: 16.5, fontWeight: 800, color: PAL.blueDeep }}>
            ✦ 会话固定 Nonce 静态前缀 · 两阶段提纯
          </div>
          <div style={{ fontSize: 14.5, color: PAL.sub, marginTop: 6 }}>
            剔除工具噪声，完整保留架构决策、文件路径与关键契约
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
            fontSize: 15.5,
            fontWeight: 780,
            opacity: p(f, 170, 22),
          }}
        >
          <span>Prompt Cache 稳定命中率</span>
          <span style={{ fontFamily: MONO, fontSize: 20 }}>{cache}%</span>
        </div>
      </div>
    </div>
  );
};

const RewindViz: React.FC<{ f: number }> = ({ f }) => {
  const N = 6;
  const pos = interpolate(f, [245, 315], [5, 2], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const done = p(f, 315, 22);
  const W = 474;
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
              <div style={{ fontSize: 13.5, color: on ? PAL.blueDeep : PAL.muted, marginTop: 8, fontFamily: MONO, fontWeight: 700 }}>
                #{i + 1}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        {["src/queue.js", "src/router.js", "test/queue.test.js"].map((file, i) => {
          const restored = p(f, 315 + i * 8, 18);
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
                fontWeight: 680,
              }}
            >
              <span>{file}</span>
              <span style={{ fontSize: 13.5 }}>{restored > 0.5 ? "快照原子还原 ✓" : "脏变更"}</span>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 14.5, color: PAL.sub, marginTop: 12, opacity: done, fontWeight: 650 }}>
        turn_snapshots 事务级对齐：磁盘文件与对话记忆毫秒级同步回退
      </div>
    </div>
  );
};

const SteerViz: React.FC<{ f: number }> = ({ f }) => {
  const draw1 = p(f, 62, 50);
  const draw2 = p(f, 385, 60);
  const L1 = 330;
  const L2 = 320;
  return (
    <div style={{ position: "relative", height: 248 }}>
      <svg width={474} height={248} style={{ position: "absolute", inset: 0 }}>
        {/* Reference guide curve */}
        <path
          d="M 34 196 C 128 188, 210 148, 312 50"
          stroke={PAL.line}
          strokeWidth={3}
          strokeDasharray="6 6"
          fill="none"
        />
        <path
          d="M 192 146 C 276 112, 356 144, 428 184"
          stroke={PAL.iceDeep}
          strokeWidth={3}
          strokeDasharray="6 6"
          fill="none"
        />
        <circle cx={34} cy={196} r={12} fill={PAL.blue} />
        <path
          d="M 34 196 C 128 188, 210 148, 312 50"
          stroke={PAL.muted}
          strokeWidth={4.5}
          fill="none"
          strokeDasharray={L1}
          strokeDashoffset={L1 * (1 - Math.min(draw1, draw2 > 0 ? 0.56 : 0.72))}
          strokeLinecap="round"
          opacity={draw2 > 0 ? 0.38 : 0.85}
        />
        <path
          d="M 192 146 C 276 112, 356 144, 428 184"
          stroke={PAL.blue}
          strokeWidth={5.5}
          fill="none"
          strokeDasharray={L2}
          strokeDashoffset={L2 * (1 - draw2)}
          strokeLinecap="round"
        />
        <circle cx={192} cy={146} r={draw2 > 0 ? 7 : 5} fill={draw2 > 0 ? PAL.blue : PAL.muted} />
        <circle cx={312} cy={50} r={14} fill="none" stroke={PAL.muted} strokeWidth={2.5} strokeDasharray="5 5" opacity={0.55} />
        <circle
          cx={428}
          cy={184}
          r={16}
          fill={draw2 > 0.92 ? PAL.green : "#FFFFFF"}
          stroke={draw2 > 0.92 ? PAL.green : PAL.blue}
          strokeWidth={3.5}
        />
      </svg>
      <div style={{ position: "absolute", left: 268, top: 10, fontSize: 15, color: PAL.muted, fontWeight: 600 }}>
        原方案：本地内存锁
      </div>
      <div style={{ position: "absolute", left: 294, top: 208, fontSize: 16, color: PAL.green, fontWeight: 800 }}>
        Fencing 分布式锁 ✓
      </div>
      <div
        style={{
          position: "absolute",
          left: 16,
          top: 68,
          padding: "10px 15px",
          borderRadius: 14,
          background: f >= 362 ? PAL.ink : PAL.ice,
          color: f >= 362 ? "#FFFFFF" : PAL.blueDeep,
          border: f >= 362 ? "none" : `1px solid ${PAL.iceDeep}`,
          fontFamily: MONO,
          fontSize: 14.5,
          fontWeight: 700,
          opacity: 0.72 + 0.28 * p(f, 362, 20),
          transform: `scale(${f >= 362 ? 0.92 + p(f, 362, 20) * 0.08 : 0.95})`,
          transformOrigin: "0 100%",
          boxShadow: f >= 362 ? "0 18px 34px -14px rgba(9,23,48,0.48)" : "none",
        }}
      >
        /steer 切换为 Fencing 租约锁
      </div>
    </div>
  );
};

export const S5Control: React.FC = () => {
  const f = useCurrentFrame();
  const act = (a: number, b: number) => p(f, a, 18) * (1 - p(f, b, 18));
  return (
    <AbsoluteFill>
      <TitleBlock
        kicker="人机协同控制力 · 告别黑盒失控"
        title={
          <>
            长程不失忆，越界可回溯，<BlueText>运行可纠偏</BlueText>
          </>
        }
        sub="相比传统助手一旦跑偏只能强行终止重来，Agent_US 提供三大毫秒级运行时控制原语"
        at={4}
        y={52}
        size={52}
      />

      <div
        style={{
          position: "absolute",
          top: 288,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          gap: 34,
        }}
      >
        <ControlCard
          at={26}
          sheenAt={100}
          visual="visuals/compact-3d.jpg"
          phase={0}
          cmd="/compact"
          metric="-78% 窗口占用"
          title="两阶段语义压缩"
          desc="保持系统前缀静态锁定，无损释放长程任务窗口并维持超高缓存命中"
          active={act(95, 235)}
        >
          <CompactViz f={f} />
        </ControlCard>

        <ControlCard
          at={40}
          sheenAt={240}
          visual="visuals/rewind-3d.jpg"
          phase={2}
          cmd="/rewind"
          metric="<50ms 原子回退"
          title="确定性时空快照"
          desc="每一轮工具写入前自动生成不可变快照，随时一键无损回到任意历史节点"
          active={act(235, 355)}
        >
          <RewindViz f={f} />
        </ControlCard>

        <ControlCard
          at={54}
          sheenAt={360}
          visual="visuals/sandbox-3d.jpg"
          phase={4}
          cmd="/steer"
          metric="0 中断热注入"
          title="运行中实时纠偏"
          desc="在多 Worker 并发奔跑途中无缝注入新约束，动态平滑修正后续执行轨迹"
          active={act(355, 530)}
        >
          <SteerViz f={f} />
        </ControlCard>
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 54,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          gap: 16,
        }}
      >
        {[
          "防死循环熔断器",
          "哈希防脏写保护",
          "会话级命令前缀白名单",
          "生命周期 Hooks",
          "AGENTS.md 层级自动挂载",
        ].map((g, i) => (
          <span
            key={g}
            style={{
              ...rise(f, 465 + i * 7, 22, 14),
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "11px 22px",
              borderRadius: 999,
              background: "rgba(255,255,255,0.94)",
              border: `1.5px solid ${PAL.iceDeep}`,
              color: PAL.blueDeep,
              fontSize: 18,
              fontWeight: 720,
              boxShadow: "0 10px 24px -16px rgba(22,66,190,0.35)",
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
