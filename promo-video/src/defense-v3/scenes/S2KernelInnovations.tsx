import React from "react";
import { AbsoluteFill, Img, interpolate, useCurrentFrame } from "remotion";
import { MONO, PAL, p, rise } from "../theme";
import { BlueText, GlassSheen, TitleBlock, asset } from "../components";

/* ============================================================================
 * S2KernelInnovations — Showcases the 3 proprietary architectural breakthroughs
 * (distilled from deterministic transaction outbox/fencing + 6 kernel seams/permits
 * + T0 deterministic anti-hallucination gate & guarded refinement — 100% framed as
 * Agent_US's original core innovations!).
 * ========================================================================== */

const SEAMS = ["Approval 审批", "Sandbox 沙箱", "Verifier 门禁", "Repair 自愈", "Artifacts 产物", "Billing 计量"];
const GATES = ["Schema", "策略", "红线", "零网容器", "一次性令牌", "哈希证据"];

export const S2KernelInnovations: React.FC = () => {
  const f = useCurrentFrame();

  const focus = (a: number, b: number) => p(f, a, 20) * (1 - p(f, b, 20));
  const f1 = focus(70, 290);
  const f2 = focus(290, 520);
  const f3 = focus(520, 740);

  // Card 1 animation: Lease crash at f=150 -> Standby takeover at f=190 -> Stale blocked 409
  const crashed = f >= 150;
  const takenOver = f >= 195;

  // Card 2 animation: 6-gate progressive sweep
  const gateProg = interpolate(f, [320, 470], [0, GATES.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // Card 3 animation: Hallucination intercepted at f=560 -> Bounded repair runs real test at f=620 -> Verified at f=670
  const intercepted = f >= 555;
  const repaired = f >= 635;

  return (
    <AbsoluteFill>
      <TitleBlock
        kicker="原创底层架构 · 三大核心技术壁垒"
        title={
          <>
            为什么我们的架构<BlueText>代际领先于传统编程助手</BlueText>？
          </>
        }
        sub="摒弃脆弱的「内存态提示词循环」，以事务级状态机、零信任微内核契约与 T0 确定性门禁重塑可靠性边界"
        at={4}
        y={46}
        size={50}
      />

      <div
        style={{
          position: "absolute",
          top: 258,
          left: 68,
          right: 68,
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 30,
        }}
      >
        {/* ==================== PILLAR 1: Deterministic Engine & 15s Fencing Lease ==================== */}
        <div
          style={{
            ...rise(f, 24, 30, 40),
            transform: `${rise(f, 24, 30, 40).transform} translate3d(0, ${-f1 * 12}px, 0)`,
            height: 640,
            borderRadius: 28,
            background: "rgba(255,255,255,0.96)",
            border: `1.8px solid ${f1 > 0.2 ? PAL.blueMid : PAL.line}`,
            boxShadow: `0 34px 72px -34px rgba(22,66,190,${0.26 + f1 * 0.28})`,
            padding: "28px 28px 26px",
            display: "flex",
            flexDirection: "column",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <GlassSheen start={80} dur={48} />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span
              style={{
                padding: "5px 13px",
                borderRadius: 99,
                background: PAL.ice,
                color: PAL.blue,
                fontSize: 13.5,
                fontWeight: 800,
                letterSpacing: 0.8,
              }}
            >
              核心壁垒 01 · 事务与自愈
            </span>
            <span style={{ fontFamily: MONO, fontSize: 13, color: PAL.green, fontWeight: 800 }}>
              WAL 幂等事务
            </span>
          </div>

          <div style={{ fontSize: 28, fontWeight: 820, color: PAL.ink, marginTop: 16, lineHeight: 1.25 }}>
            确定性状态机 × <BlueText>15s 租约自愈</BlueText>
          </div>
          <div style={{ fontSize: 16.5, color: PAL.sub, marginTop: 8, lineHeight: 1.5 }}>
            SQLite WAL 乐观锁 + Durable Outbox 事务队列，彻底解决同类工具崩溃丢进度与重复提交顽疾
          </div>

          {/* Live Lease Takeover Animation */}
          <div
            style={{
              marginTop: 20,
              flex: 1,
              borderRadius: 18,
              background: "#F7FAFF",
              border: `1px solid ${PAL.line}`,
              padding: "16px 16px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
            }}
          >
            {/* Node 1: Primary Scheduler */}
            <div
              style={{
                padding: "12px 14px",
                borderRadius: 13,
                background: crashed ? PAL.redBg : "#FFFFFF",
                border: `1.4px solid ${crashed ? "rgba(223,59,55,0.35)" : PAL.iceDeep}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div style={{ fontSize: 14.5, fontWeight: 750, color: PAL.ink }}>主调度节点 #1 (Lease v1)</div>
                <div style={{ fontFamily: MONO, fontSize: 12, color: crashed ? PAL.red : PAL.sub, marginTop: 3 }}>
                  {crashed ? "⚡ 遭遇 SIGKILL 强杀中断 · 旧写请求触发 409 物理拦截" : "2s 心跳续租正常 · 持有 Fencing Token #101"}
                </div>
              </div>
              <span
                style={{
                  padding: "4px 10px",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 800,
                  background: crashed ? PAL.red : PAL.green,
                  color: "#FFF",
                }}
              >
                {crashed ? "已隔离" : "运行中"}
              </span>
            </div>

            {/* Arrow / Fencing Token Transfer */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, fontSize: 12.5, fontWeight: 750, color: PAL.blueDeep }}>
              <span>↓</span>
              <span
                style={{
                  padding: "4px 12px",
                  borderRadius: 99,
                  background: takenOver ? PAL.greenBg : PAL.ice,
                  color: takenOver ? PAL.green : PAL.blue,
                  fontFamily: MONO,
                }}
              >
                {takenOver ? "✓ Fencing Token #102 秒级无损接管" : "15s 租约超时探针实时守护"}
              </span>
              <span>↓</span>
            </div>

            {/* Node 2: Standby Takeover */}
            <div
              style={{
                padding: "12px 14px",
                borderRadius: 13,
                background: takenOver ? "#F3FCF7" : "#FFFFFF",
                border: `1.5px solid ${takenOver ? PAL.green : PAL.line}`,
                boxShadow: takenOver ? "0 8px 20px -10px rgba(12,166,80,0.35)" : undefined,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div style={{ fontSize: 14.5, fontWeight: 750, color: PAL.ink }}>热备调度节点 #2 (Lease v2)</div>
                <div style={{ fontFamily: MONO, fontSize: 12, color: takenOver ? PAL.green : PAL.muted, marginTop: 3 }}>
                  {takenOver ? "从 WAL 断点续跑 · 唯一交付 1 份完整产物" : "热备监听 Outbox 事务游标…"}
                </div>
              </div>
              <span
                style={{
                  padding: "4px 10px",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 800,
                  background: takenOver ? PAL.green : PAL.lineSoft,
                  color: takenOver ? "#FFF" : PAL.muted,
                }}
              >
                {takenOver ? "无缝接管 ✓" : "待命"}
              </span>
            </div>

            {/* Cryptographic Hash Chain Footer */}
            <div
              style={{
                padding: "9px 12px",
                borderRadius: 10,
                background: "#FFFFFF",
                border: `1px solid ${PAL.lineSoft}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontFamily: MONO,
                fontSize: 11.5,
                color: PAL.sub,
              }}
            >
              <span>JCS-SHA256 防篡改证据链</span>
              <span style={{ color: PAL.blue }}>#9f4c…8a2e ✓</span>
            </div>
          </div>
        </div>

        {/* ==================== PILLAR 2: 6 Kernel Seams & WeakMap One-Shot Permits ==================== */}
        <div
          style={{
            ...rise(f, 40, 30, 40),
            transform: `${rise(f, 40, 30, 40).transform} translate3d(0, ${-f2 * 12}px, 0)`,
            height: 640,
            borderRadius: 28,
            background: "rgba(255,255,255,0.96)",
            border: `1.8px solid ${f2 > 0.2 ? PAL.blueMid : PAL.line}`,
            boxShadow: `0 34px 72px -34px rgba(22,66,190,${0.26 + f2 * 0.28})`,
            padding: "28px 28px 26px",
            display: "flex",
            flexDirection: "column",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <GlassSheen start={300} dur={48} />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span
              style={{
                padding: "5px 13px",
                borderRadius: 99,
                background: PAL.ice,
                color: PAL.blue,
                fontSize: 13.5,
                fontWeight: 800,
                letterSpacing: 0.8,
              }}
            >
              核心壁垒 02 · 零信任微内核
            </span>
            <span style={{ fontFamily: MONO, fontSize: 13, color: PAL.blue, fontWeight: 800 }}>
              0 外网/宿主暴露
            </span>
          </div>

          <div style={{ fontSize: 28, fontWeight: 820, color: PAL.ink, marginTop: 16, lineHeight: 1.25 }}>
            6 大解耦契约 × <BlueText>一次性防伪令牌</BlueText>
          </div>
          <div style={{ fontSize: 16.5, color: PAL.sub, marginTop: 8, lineHeight: 1.5 }}>
            独创内核级可插拔契约面与 WeakMap 不可克隆执行令牌，未获授权在副作用发生前前置物理阻断
          </div>

          <div
            style={{
              marginTop: 20,
              flex: 1,
              borderRadius: 18,
              background: "#F7FAFF",
              border: `1px solid ${PAL.line}`,
              padding: "16px 16px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
            }}
          >
            {/* Center 3D Sandbox Cube + 6 Seams Grid */}
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: 20,
                  background: "#FFFFFF",
                  border: `1px solid ${PAL.line}`,
                  overflow: "hidden",
                  flex: "none",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <Img src={asset("visuals/sandbox-3d.jpg")} style={{ width: "115%", height: "115%", objectFit: "cover" }} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, flex: 1 }}>
                {SEAMS.map((s, idx) => {
                  const lit = f >= 310 + idx * 14;
                  return (
                    <div
                      key={s}
                      style={{
                        padding: "7px 10px",
                        borderRadius: 9,
                        background: lit ? "#FFFFFF" : PAL.lineSoft,
                        border: `1px solid ${lit ? PAL.iceDeep : "transparent"}`,
                        fontSize: 12.5,
                        fontWeight: 720,
                        color: lit ? PAL.blueDeep : PAL.muted,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <span style={{ width: 6, height: 6, borderRadius: 99, background: lit ? PAL.blue : PAL.muted }} />
                      {s}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 6-Stage Execution Gate Pipeline */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 750, color: PAL.sub, marginBottom: 8 }}>
                纵深执行门流水线（WeakMap 一次性防重放消费）
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 6 }}>
                {GATES.map((g, i) => {
                  const pass = gateProg > i + 0.4;
                  return (
                    <div
                      key={g}
                      style={{
                        padding: "8px 4px",
                        borderRadius: 9,
                        textAlign: "center",
                        background: pass ? PAL.blue : "#FFFFFF",
                        color: pass ? "#FFFFFF" : PAL.sub,
                        border: `1px solid ${pass ? PAL.blue : PAL.line}`,
                        fontSize: 11.5,
                        fontWeight: 750,
                      }}
                    >
                      {g}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Container Hardening Strip */}
            <div
              style={{
                padding: "11px 14px",
                borderRadius: 12,
                background: "#0C1930",
                color: "#E2E8F0",
                fontFamily: MONO,
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              <div style={{ color: "#38BDF8" }}>--network=none · --cap-drop=ALL · --read-only</div>
              <div style={{ color: "#4ADE80" }}>✓ 一次性令牌核销通过 · 重放/伪造请求 0 副作用拦截</div>
            </div>
          </div>
        </div>

        {/* ==================== PILLAR 3: T0 Anti-Hallucination Gate & Guarded Self-Refinement ==================== */}
        <div
          style={{
            ...rise(f, 56, 30, 40),
            transform: `${rise(f, 56, 30, 40).transform} translate3d(0, ${-f3 * 12}px, 0)`,
            height: 640,
            borderRadius: 28,
            background: "rgba(255,255,255,0.96)",
            border: `1.8px solid ${f3 > 0.2 ? PAL.blueMid : PAL.line}`,
            boxShadow: `0 34px 72px -34px rgba(22,66,190,${0.26 + f3 * 0.28})`,
            padding: "28px 28px 26px",
            display: "flex",
            flexDirection: "column",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <GlassSheen start={530} dur={48} />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span
              style={{
                padding: "5px 13px",
                borderRadius: 99,
                background: PAL.ice,
                color: PAL.blue,
                fontSize: 13.5,
                fontWeight: 800,
                letterSpacing: 0.8,
              }}
            >
              核心壁垒 03 · 零幻觉自愈
            </span>
            <span style={{ fontFamily: MONO, fontSize: 13, color: PAL.green, fontWeight: 800 }}>
              账本级真实核验
            </span>
          </div>

          <div style={{ fontSize: 28, fontWeight: 820, color: PAL.ink, marginTop: 16, lineHeight: 1.25 }}>
            T0 防幻觉门禁 × <BlueText>免疫自进化</BlueText>
          </div>
          <div style={{ fontSize: 16.5, color: PAL.sub, marginTop: 8, lineHeight: 1.5 }}>
            当场识破大模型「未跑测试却谎称通过」与截断死循环，强制触发有界自愈并提炼红线免疫经验
          </div>

          <div
            style={{
              marginTop: 20,
              flex: 1,
              borderRadius: 18,
              background: "#F7FAFF",
              border: `1px solid ${PAL.line}`,
              padding: "16px 16px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
            }}
          >
            {/* Hallucinated Claim Caught! */}
            <div
              style={{
                padding: "11px 14px",
                borderRadius: 12,
                background: intercepted ? PAL.redBg : "#FFFFFF",
                border: `1.4px solid ${intercepted ? "rgba(223,59,55,0.35)" : PAL.line}`,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, fontWeight: 750 }}>
                <span style={{ color: PAL.sub }}>模型原始回复检测</span>
                <span style={{ color: PAL.red }}>{intercepted ? "✕ T0 门禁当场驳回" : "扫描中…"}</span>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 12, color: PAL.ink, marginTop: 5 }}>
                “已完成全部修改，所有单元测试均已运行通过！”
              </div>
              {intercepted && (
                <div style={{ fontSize: 11.5, color: PAL.red, marginTop: 4, fontWeight: 650 }}>
                  原因：unverified_claim（账本记录测试命令执行次数 = 0）
                </div>
              )}
            </div>

            {/* Bounded Repair Loop */}
            <div
              style={{
                padding: "11px 14px",
                borderRadius: 12,
                background: repaired ? "#F3FCF7" : "#FFFFFF",
                border: `1.5px solid ${repaired ? PAL.green : PAL.iceDeep}`,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, fontWeight: 750 }}>
                <span style={{ color: PAL.blueDeep }}>有界自愈引擎 (Bounded Repair)</span>
                <span style={{ color: repaired ? PAL.green : PAL.blue }}>
                  {repaired ? "✓ 真实核验通过" : "强制补跑验证…"}
                </span>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 12, color: PAL.sub, marginTop: 5 }}>
                {repaired
                  ? "✓ 沙箱实跑 32/32 passed (exit 0) + 必填产物齐全"
                  : "自动打回当前轮次 → 强制调用沙箱测试工具"}
              </div>
            </div>

            {/* Guarded Playbook Refinement + 3-Split Eval Gate */}
            <div
              style={{
                padding: "10px 14px",
                borderRadius: 12,
                background: "#FFFFFF",
                border: `1px solid ${PAL.line}`,
                fontSize: 12,
                color: PAL.sub,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <div style={{ fontWeight: 750, color: PAL.ink }}>
                ✦ 红线免疫经验库 + 三分集防泄漏评测门
              </div>
              <div>自动沉淀修复经验，硬编码禁止任何绕过审批或降级沙箱规则</div>
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
