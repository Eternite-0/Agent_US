import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { C, MONO, lerp, prog, rise } from "../theme";
import { Blue, Icon, SceneTitle } from "../ui";

const CardShell: React.FC<{ at: number; icon: string; cmd: string; title: string; desc: string; children: React.ReactNode; active: number }> = ({
  at,
  icon,
  cmd,
  title,
  desc,
  children,
  active,
}) => {
  const f = useCurrentFrame();
  return (
    <div
      style={{
        ...rise(f, at, 30, 40),
        width: 520,
        height: 530,
        borderRadius: 28,
        background: "#fff",
        border: `1.5px solid ${active > 0 ? C.sky : C.line}`,
        boxShadow: `0 30px 60px -36px rgba(23,71,201,${0.35 + active * 0.25})`,
        padding: 34,
        display: "flex",
        flexDirection: "column",
        transform: `${rise(f, at, 30, 40).transform} translateY(${-active * 10}px)`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div
          style={{
            width: 54,
            height: 54,
            borderRadius: 16,
            background: `linear-gradient(140deg, ${C.blueMid}, ${C.blueDeep})`,
            display: "grid",
            placeItems: "center",
          }}
        >
          <Icon name={icon} size={28} color="#fff" stroke={2} />
        </div>
        <span style={{ fontFamily: MONO, fontSize: 26, fontWeight: 700, color: C.blue }}>{cmd}</span>
      </div>
      <div style={{ fontSize: 32, fontWeight: 760, color: C.ink, marginTop: 22 }}>{title}</div>
      <div style={{ fontSize: 19, color: C.sub, marginTop: 8, lineHeight: 1.5 }}>{desc}</div>
      <div style={{ flex: 1, position: "relative", marginTop: 18 }}>{children}</div>
    </div>
  );
};

const Compact: React.FC<{ f: number }> = ({ f }) => {
  const p = prog(f, 150, 80);
  const pct = lerp(p, 92, 18);
  const tokens = Math.round(lerp(p, 182, 33));
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 17, color: C.sub }}>
        <span>上下文占用</span>
        <span style={{ fontWeight: 700, color: p > 0.5 ? C.blue : C.amber, fontFamily: MONO }}>
          {tokens}K · {Math.round(pct)}%
        </span>
      </div>
      <div style={{ height: 12, borderRadius: 9, background: C.lineSoft, marginTop: 10 }}>
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            borderRadius: 9,
            background: p > 0.5 ? `linear-gradient(90deg, ${C.sky}, ${C.blue})` : `linear-gradient(90deg, #F5B041, ${C.amber})`,
          }}
        />
      </div>
      <div style={{ position: "relative", height: 150, marginTop: 22 }}>
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: 0,
              top: lerp(p, i * 21, 40),
              height: 14,
              width: `${lerp(p, 60 + ((i * 37) % 40), 30)}%`,
              borderRadius: 7,
              background: C.iceDeep,
              opacity: 1 - p,
            }}
          />
        ))}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 30,
            padding: "16px 18px",
            borderRadius: 14,
            background: C.ice,
            border: `1px solid ${C.iceDeep}`,
            opacity: prog(f, 200, 24),
            transform: `scale(${0.9 + prog(f, 200, 24) * 0.1})`,
            fontSize: 17,
            color: C.blueDeep,
            fontWeight: 600,
          }}
        >
          ✦ 语义摘要 · 保留目标、决策与关键文件
        </div>
      </div>
    </div>
  );
};

const Rewind: React.FC<{ f: number }> = ({ f }) => {
  const N = 6;
  const pos = interpolate(f, [300, 360], [5, 2], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const back = prog(f, 360, 20);
  const W = 452;
  return (
    <div>
      <div style={{ position: "relative", height: 70 }}>
        <div style={{ position: "absolute", top: 22, left: 10, right: 10, height: 3, background: C.lineSoft, borderRadius: 3 }} />
        <div
          style={{
            position: "absolute",
            top: 22,
            left: 10,
            width: (pos / (N - 1)) * (W - 20),
            height: 3,
            background: C.blue,
            borderRadius: 3,
          }}
        />
        {Array.from({ length: N }).map((_, i) => {
          const x = 10 + (i / (N - 1)) * (W - 20);
          const on = i <= pos + 0.01;
          return (
            <div key={i} style={{ position: "absolute", left: x - 12, top: 12, textAlign: "center", width: 24 }}>
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 99,
                  background: on ? C.blue : "#fff",
                  border: `3px solid ${on ? C.blue : C.line}`,
                  boxShadow: Math.abs(i - pos) < 0.3 ? "0 0 0 8px rgba(37,99,235,0.15)" : undefined,
                }}
              />
              <div style={{ fontSize: 14, color: on ? C.blueDeep : C.muted, marginTop: 8, fontFamily: MONO }}>#{i + 1}</div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 10 }}>
        {["src/payment/refund.ts", "src/db/schema.sql", "test/refund.test.ts"].map((p, i) => {
          const r = prog(f, 362 + i * 8, 18);
          return (
            <div
              key={p}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 16,
                fontFamily: MONO,
                padding: "8px 14px",
                borderRadius: 10,
                background: r > 0.5 ? C.greenSoft : C.redSoft,
                color: r > 0.5 ? "#0B7A3B" : C.red,
              }}
            >
              <span style={{ flex: 1 }}>{p}</span>
              <span style={{ fontFamily: "inherit", fontSize: 14 }}>{r > 0.5 ? "已还原" : "已修改"}</span>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 15, color: C.sub, marginTop: 12, opacity: back }}>文件与对话状态同步回到快照 #3</div>
    </div>
  );
};

const Steer: React.FC<{ f: number }> = ({ f }) => {
  const draw1 = prog(f, 380, 60);
  const draw2 = prog(f, 470, 60);
  const L1 = 300;
  const L2 = 300;
  return (
    <div style={{ position: "relative", height: 260 }}>
      <svg width={452} height={250} style={{ position: "absolute", left: 0, top: 0 }}>
        <circle cx={30} cy={210} r={12} fill={C.blue} />
        <path
          d="M30 210 C 120 200, 200 160, 300 60"
          stroke={C.muted}
          strokeWidth={4}
          fill="none"
          strokeDasharray={L1}
          strokeDashoffset={L1 * (1 - Math.min(draw1, 0.6))}
          strokeLinecap="round"
          opacity={draw2 > 0 ? 0.35 : 1}
        />
        <path
          d="M 188 153 C 260 120, 340 150, 410 190"
          stroke={C.blue}
          strokeWidth={5}
          fill="none"
          strokeDasharray={L2}
          strokeDashoffset={L2 * (1 - draw2)}
          strokeLinecap="round"
        />
        <g opacity={0.5}>
          <circle cx={300} cy={60} r={16} fill="none" stroke={C.muted} strokeWidth={2.5} strokeDasharray="5 5" />
        </g>
        <circle cx={410} cy={190} r={16} fill={draw2 > 0.95 ? C.green : "#fff"} stroke={draw2 > 0.95 ? C.green : C.blue} strokeWidth={3} />
      </svg>
      <div style={{ position: "absolute", left: 250, top: 18, fontSize: 15, color: C.muted }}>内存会话</div>
      <div style={{ position: "absolute", left: 330, top: 214, fontSize: 15, color: C.green, fontWeight: 650 }}>Redis 会话 ✓</div>
      <div
        style={{
          position: "absolute",
          left: 20,
          top: 92,
          padding: "10px 14px",
          borderRadius: 14,
          background: C.ink,
          color: "#fff",
          fontSize: 16,
          fontFamily: MONO,
          opacity: prog(f, 440, 20),
          transform: `scale(${0.85 + prog(f, 440, 20) * 0.15})`,
          transformOrigin: "0 100%",
          boxShadow: "0 16px 30px -14px rgba(11,27,58,0.5)",
        }}
      >
        /steer 改用 Redis 存储会话
      </div>
    </div>
  );
};

const GUARDS = ["防死循环熔断", "防脏写保护", "命令前缀审批白名单", "生命周期 Hooks", "AGENTS.md 层级发现", "MCP 工具热挂载"];

export const S5Control: React.FC = () => {
  const f = useCurrentFrame();
  const act = (a: number, b: number) => prog(f, a, 16) * (1 - prog(f, b, 16));
  return (
    <AbsoluteFill>
      <SceneTitle kicker="核心创新 · 可控智能" title={<>全程可控，<Blue>随时回到过去</Blue></>} at={4} align="center" y={70} />
      <div style={{ position: "absolute", top: 320, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 40 }}>
        <CardShell at={40} icon="compress" cmd="/compact" title="两阶段语义压缩" desc="超长任务不失忆，窗口预算瞬间释放" active={act(140, 290)}>
          <Compact f={f} />
        </CardShell>
        <CardShell at={56} icon="rewind" cmd="/rewind" title="确定性快照回溯" desc="每轮自动快照，文件与对话精准回退" active={act(290, 400)}>
          <Rewind f={f} />
        </CardShell>
        <CardShell at={72} icon="steer" cmd="/steer" title="运行中实时纠偏" desc="无需中断任务，一句话改变执行方向" active={act(400, 560)}>
          <Steer f={f} />
        </CardShell>
      </div>
      <div style={{ position: "absolute", top: 870, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 16 }}>
        {GUARDS.map((g, i) => (
          <span
            key={g}
            style={{
              ...rise(f, 520 + i * 7, 24, 16),
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 20px",
              borderRadius: 999,
              background: "#fff",
              border: `1px solid ${C.iceDeep}`,
              fontSize: 20,
              fontWeight: 600,
              color: C.blueDeep,
            }}
          >
            <Icon name="shield" size={18} color={C.blue} /> {g}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
};
