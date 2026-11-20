import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import {
  COLORS,
  FONT_MONO,
  FONT_SANS,
  HEIGHT,
  WIDTH,
  countUp,
  fadeInUp,
  sceneEnvelopeOpacity,
  springSnappy,
} from "../theme";

interface MetricCard {
  title: string;
  subtitle: string;
  baselineLabel: string;
  baselineRatio: number;
  heroValueText: string;
  targetNum: number;
  suffix: string;
  decimals?: number;
  heroRatio: number;
  color: string;
  detail: string;
  delay: number;
}

const METRICS: MetricCard[] = [
  {
    title: "多节点任务并发吞吐",
    subtitle: "PARALLEL DAG THROUGHPUT",
    baselineLabel: "Claude / Codex / DSH 单会话串行: 1.0x",
    baselineRatio: 0.25,
    heroValueText: "4.0x",
    targetNum: 4.0,
    suffix: "x",
    decimals: 1,
    heroRatio: 1.0,
    color: COLORS.cyan,
    detail: "拓扑 DAG 自动识别无冲突节点，最高 4 个隔离容器 Worker 并行执行，消除串行阻塞",
    delay: 18,
  },
  {
    title: "SIGKILL 崩溃恢复准确率",
    subtitle: "EXACT-ONCE RECOVERY",
    baselineLabel: "普通进程内存态中断: 易丢失或重复提交",
    baselineRatio: 0.32,
    heroValueText: "100%",
    targetNum: 100,
    suffix: "%",
    heroRatio: 1.0,
    color: COLORS.emeraldBright,
    detail: "15s Fencing Token 租约 + 2s 续租 + SQLite WAL，强杀重启后第二个 Planner 接管且只发 1 份产物",
    delay: 42,
  },
  {
    title: "模型网关容灾连续性",
    subtitle: "GATEWAY FAILOVER AVAILABILITY",
    baselineLabel: "单通道直连/单一网关: 故障即任务中断",
    baselineRatio: 0.45,
    heroValueText: "100%",
    targetNum: 100,
    suffix: "%",
    heroRatio: 1.0,
    color: COLORS.magpie,
    detail: "Magpie v0.1.4490 网关异常时无缝切换原生 Direct Adapter，AES-256-GCM 密钥不落盘",
    delay: 66,
  },
  {
    title: "宿主机与网络暴露面",
    subtitle: "ZERO-TRUST ATTACK SURFACE",
    baselineLabel: "常规本地 CLI / 宿主机共享目录模式",
    baselineRatio: 0.78,
    heroValueText: "0",
    targetNum: 0,
    suffix: " 暴露",
    heroRatio: 0.04,
    color: COLORS.amber,
    detail: "Worker 容器零宿主机挂载、--network none 零外网接口、非 root UID + 只读根目录",
    delay: 90,
  },
];

const TEST_STAGES = [
  { stage: "01 底座事务与幂等", desc: "Cordis Bundle · 乐观锁 · 409 版本冲突拦截" },
  { stage: "02 拓扑并发调度", desc: "峰值并发 2 · 验收驳回后保留旧产物并返工" },
  { stage: "03 Docker + Codex 执行", desc: "真实无网络容器 · UID 校验 · 一次性审批消费" },
  { stage: "04 Magpie 双路网关", desc: "v0.1.4490 网关发现 · 停机切原生 · 加密 Vault" },
  { stage: "05 前后端 SSE 联调", desc: "断线 Last-Event-ID 游标重放 · 证据链对齐" },
  { stage: "06 强杀与竞争恢复", desc: "SIGKILL 后租约自动接管 · 双连接旧租约写入拒绝" },
];

export const Scene5Benchmarks: React.FC = () => {
  const frame = useCurrentFrame();
  const duration = 390;
  const envelope = sceneEnvelopeOpacity(frame, duration);
  const headerAnim = fadeInUp(frame, 4, 24);

  const testPassed = Math.round(countUp(frame, 130, 220, 14));

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        width: WIDTH,
        height: HEIGHT,
        opacity: envelope,
        fontFamily: FONT_SANS,
        color: COLORS.textPrimary,
      }}
    >
      {/* Header */}
      <div
        style={{
          position: "absolute",
          top: 96,
          left: 72,
          right: 72,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          ...headerAnim,
        }}
      >
        <div>
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 13,
              color: COLORS.emeraldBright,
              letterSpacing: "0.14em",
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            PRODUCTION TELEMETRY & VERIFICATION REPORT
          </div>
          <h2 style={{ margin: 0, fontSize: 42, fontWeight: 800 }}>
            实测架构跃升：高并发、强隔离与全链路自动化验证
          </h2>
        </div>

        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 13,
            color: COLORS.textSecondary,
            padding: "8px 14px",
            borderRadius: 10,
            backgroundColor: COLORS.bgCard,
            border: `1px solid ${COLORS.borderSubtle}`,
          }}
        >
          Node v24.19.0 · Docker Desktop 29.6.1 · Windows PowerShell 实测
        </div>
      </div>

      {/* Left 2x2 Comparative Benchmark Cards */}
      <div
        style={{
          position: "absolute",
          left: 72,
          top: 215,
          width: 1120,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 22,
        }}
      >
        {METRICS.map((m) => {
          const p = springSnappy(frame, m.delay);
          const barAnim = interpolate(
            frame,
            [m.delay + 18, m.delay + 78],
            [0, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );
          const numVal = countUp(frame, m.delay + 12, m.delay + 75, m.targetNum);
          const formattedNum =
            m.decimals !== undefined
              ? numVal.toFixed(m.decimals)
              : Math.round(numVal).toString();

          return (
            <div
              key={m.title}
              style={{
                height: 368,
                borderRadius: 20,
                padding: "24px 28px",
                backgroundColor: COLORS.bgCard,
                border: `1px solid ${m.color}45`,
                boxShadow: "0 12px 32px rgba(0,0,0,0.4)",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                opacity: p,
                transform: `translateY(${(1 - p) * 26}px)`,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                }}
              >
                <div>
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11.5,
                      color: m.color,
                      fontWeight: 700,
                      letterSpacing: "0.08em",
                    }}
                  >
                    {m.subtitle}
                  </div>
                  <div style={{ fontSize: 23, fontWeight: 800, marginTop: 4 }}>
                    {m.title}
                  </div>
                </div>
                <div
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 44,
                    fontWeight: 800,
                    color: m.color,
                    lineHeight: 1,
                  }}
                >
                  {formattedNum}
                  {m.suffix}
                </div>
              </div>

              {/* Animated Comparative Bars */}
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 13,
                      color: COLORS.textPrimary,
                      fontWeight: 700,
                      marginBottom: 6,
                    }}
                  >
                    <span>Agent_US 架构实测</span>
                    <span style={{ color: m.color, fontFamily: FONT_MONO }}>
                      {m.heroValueText}
                    </span>
                  </div>
                  <div
                    style={{
                      height: 14,
                      borderRadius: 99,
                      backgroundColor: "rgba(15, 23, 42, 0.9)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${m.heroRatio * barAnim * 100}%`,
                        height: "100%",
                        borderRadius: 99,
                        background: `linear-gradient(90deg, ${m.color}, #FFFFFF)`,
                      }}
                    />
                  </div>
                </div>

                <div>
                  <div
                    style={{
                      fontSize: 12.5,
                      color: COLORS.textSecondary,
                      marginBottom: 6,
                    }}
                  >
                    {m.baselineLabel}
                  </div>
                  <div
                    style={{
                      height: 10,
                      borderRadius: 99,
                      backgroundColor: "rgba(15, 23, 42, 0.9)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${m.baselineRatio * barAnim * 100}%`,
                        height: "100%",
                        borderRadius: 99,
                        backgroundColor: "rgba(148, 163, 184, 0.45)",
                      }}
                    />
                  </div>
                </div>
              </div>

              <div
                style={{
                  fontSize: 14,
                  color: "#CBD5E1",
                  lineHeight: 1.5,
                  paddingTop: 12,
                  borderTop: `1px solid ${COLORS.borderSubtle}`,
                }}
              >
                {m.detail}
              </div>
            </div>
          );
        })}
      </div>

      {/* Right Panel: 14 / 14 Test Suite Verification Report */}
      <div
        style={{
          position: "absolute",
          left: 1218,
          top: 215,
          width: 630,
          height: 758,
          borderRadius: 20,
          padding: 28,
          backgroundColor: COLORS.bgPanel,
          border: `1.5px solid rgba(16, 185, 129, 0.45)`,
          boxShadow: "0 0 45px rgba(16, 185, 129, 0.14)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          ...fadeInUp(frame, 30, 24),
        }}
      >
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  color: COLORS.emeraldBright,
                  fontWeight: 700,
                }}
              >
                backend/docs/test-report.md
              </div>
              <div style={{ fontSize: 24, fontWeight: 800, marginTop: 4 }}>
                全量集成与恢复验证报告
              </div>
            </div>

            <div
              style={{
                padding: "10px 18px",
                borderRadius: 12,
                backgroundColor: "rgba(16, 185, 129, 0.16)",
                border: "1px solid rgba(16, 185, 129, 0.45)",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 30,
                  fontWeight: 800,
                  color: COLORS.emeraldBright,
                  lineHeight: 1,
                }}
              >
                {testPassed} / 14
              </div>
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  color: COLORS.textSecondary,
                  marginTop: 4,
                }}
              >
                0 FAIL · 0 SKIP · 35.6s
              </div>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              marginTop: 22,
            }}
          >
            {TEST_STAGES.map((t, idx) => {
              const p = springSnappy(frame, 105 + idx * 18);
              return (
                <div
                  key={t.stage}
                  style={{
                    padding: "14px 16px",
                    borderRadius: 12,
                    backgroundColor: "rgba(15, 23, 42, 0.85)",
                    border: "1px solid rgba(16, 185, 129, 0.25)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    opacity: p,
                    transform: `translateX(${(1 - p) * 26}px)`,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 15.5, fontWeight: 700 }}>
                      {t.stage}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: COLORS.textSecondary,
                        marginTop: 3,
                      }}
                    >
                      {t.desc}
                    </div>
                  </div>
                  <span
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 12,
                      fontWeight: 800,
                      color: COLORS.emeraldBright,
                      padding: "4px 10px",
                      borderRadius: 6,
                      backgroundColor: "rgba(16, 185, 129, 0.15)",
                    }}
                  >
                    PASS ✓
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div
          style={{
            padding: "14px 16px",
            borderRadius: 12,
            backgroundColor: "rgba(56, 189, 248, 0.1)",
            border: "1px solid rgba(56, 189, 248, 0.3)",
            fontSize: 14,
            color: "#E2E8F0",
            lineHeight: 1.5,
          }}
        >
          真实运行 <strong style={{ color: COLORS.cyan }}>Docker + Codex CLI + Magpie 可执行网关</strong> 进程闭环，非纯 Mock 演示。
        </div>
      </div>
    </div>
  );
};
