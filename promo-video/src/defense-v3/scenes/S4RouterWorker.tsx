import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { EASE_IO, MONO, PAL, p, rise, typed } from "../theme";
import {
  BrandLogo,
  CalloutBanner,
  Cursor,
  DefaultSidebar,
  DesktopShell,
  SHELL_H,
  SHELL_W,
  WorkerAvatar,
} from "../components";
import { ComposerBox, DEMO_PROMPT } from "./S3Workbench";

const QUEUE_DIFF = [
  { ln: 40, k: 0, t: " export class TaskQueue {" },
  { ln: 41, k: -1, t: "-  next() { return this.items.sort(byPrio).shift(); }" },
  { ln: 42, k: 1, t: "+  private heap = new MinHeap<LeaseJob>(byScore);" },
  { ln: 43, k: 1, t: "+  private readyByAccount = new Map<string, LeaseJob[]>();" },
  { ln: 44, k: 1, t: "+  popReady(acct: string) { return this.heap.pop(acct); }" },
];

const BENCH_ROWS = [
  { b: "队列调度扫描", c: "最小堆 + 账号 ready 队列", r: "325 → 453.9 任务/秒" },
  { b: "租约续期心跳", c: "2s fencing token 批更新", r: "P99 18.4ms → 4.1ms" },
  { b: "模型路由评分", c: "角色权重 + 成本对数惩罚", r: "56 项回归 100% 通过" },
];

const SUMMARY_LINE = "已完成队列调度与多模型路由优化，T0 确定性门禁与独立 Reviewer 交叉核验全部通过。";

type WorkerRow = {
  id: string;
  v: 0 | 1 | 2 | 3 | 4;
  name: string;
  role: string;
  model: string;
  logo: string;
  state: "waiting" | "running" | "rework" | "done" | "locked";
  time: string;
};

const CompanionCard: React.FC<{
  activeCount: number;
  doneCount: number;
  add: number;
  del: number;
  visible: number;
  hoverSubagents: boolean;
}> = ({ activeCount, doneCount, add, del, visible, hoverSubagents }) => {
  if (visible <= 0.01) return null;
  return (
    <div
      style={{
        position: "absolute",
        right: 22,
        top: 64,
        width: 228,
        borderRadius: 15,
        background: "#FFFFFF",
        border: "1px solid rgba(13,13,13,0.085)",
        boxShadow: "0 10px 28px -12px rgba(13,27,58,0.14)",
        padding: "13px 14px",
        opacity: visible,
        transform: `translateX(${(1 - visible) * 20}px)`,
        zIndex: 25,
        display: "flex",
        flexDirection: "column",
        gap: 11,
        fontSize: 13,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <WorkerAvatar variant={activeCount > 0 ? 1 : 0} size={17} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 620, color: "#0D0D0D", lineHeight: 1.2 }}>
              {activeCount > 0 ? "Coder" : "Agent_US"}
            </div>
            <div style={{ fontSize: 11.5, color: "#64748B", marginTop: 1 }}>
              {activeCount > 0 ? "正在工作" : "就绪"}
            </div>
          </div>
        </div>
        <span style={{ color: "#94A3B8", letterSpacing: 2, fontSize: 12 }}>···</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "3px 4px" }}>
        <span style={{ color: "#0D0D0D", fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 7 }}>
          <span style={{ fontSize: 12, color: "#64748B" }}>±</span> 变更
        </span>
        {add > 0 ? (
          <span style={{ fontFamily: MONO, fontSize: 12.5 }}>
            <span style={{ color: "#059642", fontWeight: 600 }}>+{add}</span>{" "}
            <span style={{ color: "#E03E3A", fontWeight: 600 }}>-{del}</span>
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "#94A3B8" }}>0 文件</span>
        )}
      </div>

      <div style={{ height: 1, background: "rgba(13,13,13,0.06)" }} />

      <div>
        <div style={{ fontSize: 11.5, color: "#94A3B8", marginBottom: 6 }}>子智能体</div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "5px 7px",
            borderRadius: 8,
            background: hoverSubagents ? PAL.ice : "transparent",
          }}
        >
          <span style={{ display: "inline-flex", gap: 4 }}>
            <WorkerAvatar variant={0} size={15} />
            <WorkerAvatar variant={1} size={15} />
            <WorkerAvatar variant={2} size={15} />
          </span>
          <span style={{ fontSize: 12.5, color: hoverSubagents ? PAL.blueDeep : "#475569", fontWeight: hoverSubagents ? 650 : 450 }}>
            {activeCount > 0 ? `${activeCount} 运行中 · ${doneCount} 完成` : `${doneCount} 完成`}
          </span>
        </div>
      </div>

      <div style={{ height: 1, background: "rgba(13,13,13,0.06)" }} />

      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11.5, color: "#94A3B8", marginBottom: 6 }}>
          <span>来源</span>
          <span>+</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12.5, color: "#475569" }}>
          <span>src/queue.js</span>
          <span>src/router.js</span>
          <span>test/queue.test.js</span>
        </div>
      </div>
    </div>
  );
};

export const S4RouterWorker: React.FC = () => {
  const f = useCurrentFrame();

  const drawerOpen = p(f, 255, 26);
  const inDetail = f >= 388 && f < 560;
  const detailSlide = p(f, 388, 20) * (1 - p(f, 544, 16));
  const approved = f >= 716;
  const inRework = f >= 930 && f < 1135;
  const allDone = f >= 1135;

  const diffAdd = Math.round(79 * p(f, 200, 300, (t) => t));
  const diffDel = Math.round(6 * p(f, 200, 300, (t) => t));

  const drawerW = Math.round(drawerOpen * 490);
  const threadW = 1230 - drawerW;
  const contentW = Math.min(688, threadW - 96);
  const contentLeft = Math.round((threadW - contentW) / 2);

  const scroll = interpolate(
    f,
    [0, 1110, 1175],
    [0, 0, 320],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_IO },
  );

  // Screen-Studio Multi-Point Camera Choreography:
  // 1) Overview (0..180)
  // 2) Focus zoom right onto CompanionCard & newly opened 子智能体 drill-down (180..570)
  // 3) Smooth pan left-center onto Approval Gate + One-Shot Permit (590..770)
  // 4) Smooth pull-back to balanced full desktop view for Reviewer Rework + Final Delivery (820..1440)
  const camScale = interpolate(
    f,
    [0, 180, 245, 545, 610, 665, 765, 835, 1440],
    [1.06, 1.06, 1.19, 1.19, 1.08, 1.17, 1.17, 1.06, 1.06],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_IO },
  );
  const camX = interpolate(
    f,
    [0, 180, 245, 545, 610, 665, 765, 835, 1440],
    [0, 0, -175, -175, 0, 55, 55, 0, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_IO },
  );
  const camY = interpolate(
    f,
    [0, 180, 245, 545, 610, 665, 765, 835, 1440],
    [0, 0, -18, -18, 0, -52, -52, 0, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_IO },
  );

  const workers: WorkerRow[] = [
    {
      id: "plan", v: 0, name: "plan_dag", role: "Router 规划", model: "deepseek-reasoner", logo: "logos/deepseek.png",
      state: f < 20 ? "waiting" : f < 130 ? "running" : inRework ? "locked" : "done",
      time: "3.2s",
    },
    {
      id: "q", v: 1, name: "optimize_queue", role: "Coder", model: "gpt-5.2", logo: "logos/openai.png",
      state: f < 135 ? "waiting" : f < 495 ? "running" : inRework ? "locked" : "done",
      time: "+42 -4",
    },
    {
      id: "r", v: 2, name: "update_router", role: "Coder", model: "qwen3-coder", logo: "logos/qwen.png",
      state: f < 145 ? "waiting" : f < 515 ? "running" : inRework && f < 1065 ? "rework" : "done",
      time: "+14 -2",
    },
    {
      id: "t", v: 3, name: "verify_bench", role: "Tester", model: "deepseek-v3.2", logo: "logos/deepseek.png",
      state: f < 580 ? "waiting" : f < 860 ? "running" : inRework && f >= 1060 && f < 1125 ? "rework" : "done",
      time: "56/56 通过",
    },
    {
      id: "rev", v: 4, name: "review_gate", role: "Reviewer", model: "claude-sonnet-4.5", logo: "logos/claude.png",
      state: f < 870 ? "waiting" : f < 1145 ? "running" : "done",
      time: "已验收",
    },
  ];

  const activeWorkers = workers.filter((w) => w.state === "running" || w.state === "rework");
  const doneWorkers = workers.filter((w) => w.state === "done" || w.state === "locked");
  const pendingApproval = f >= 595 && !approved;

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: (1920 - SHELL_W) / 2,
          top: 108,
          width: SHELL_W,
          height: SHELL_H,
          transform: `translate3d(${camX}px, ${camY}px, 0) scale(${camScale})`,
          transformOrigin: "50% 0%",
        }}
      >
        <DesktopShell
          activeRail={0}
          sidebarContent={
            <DefaultSidebar activeThread="main" running={!allDone} pendingApproval={pendingApproval} />
          }
        >
          <div style={{ display: "flex", height: "100%", background: "#FFFFFF" }}>
            {/* LEFT / CENTER: Pure-White Airy Thread View */}
            <div style={{ width: threadW, position: "relative", display: "flex", flexDirection: "column" }}>
              <div
                style={{
                  height: 46,
                  padding: "0 20px",
                  borderBottom: "1px solid rgba(13,13,13,0.06)",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontSize: 13.5,
                  fontWeight: 560,
                  color: "#0D0D0D",
                }}
              >
                <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#64748B" strokeWidth={1.7}>
                  <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                </svg>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 440 }}>
                  {DEMO_PROMPT}
                </span>
                <div style={{ flex: 1 }} />
                {pendingApproval && (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "3px 10px",
                      borderRadius: 99,
                      background: "rgba(217,93,30,0.10)",
                      color: "#D95D1E",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: 99, background: "#D95D1E" }} />1 项待审批
                  </span>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 12, color: "#64748B" }}>
                  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                    <circle cx="11" cy="11" r="7" />
                    <path d="M20 20l-3.5-3.5" />
                  </svg>
                  <svg
                    width={15}
                    height={15}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={drawerOpen > 0.5 ? PAL.blue : "currentColor"}
                    strokeWidth={1.8}
                  >
                    <circle cx="12" cy="8" r="3.5" />
                    <path d="M5 20c1-3.5 3.5-5 7-5s6 1.5 7 5" />
                  </svg>
                  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                    <rect x="3" y="4" width="18" height="16" rx="2.5" />
                    <path d="M15 4v16" />
                  </svg>
                </div>
              </div>

              <CompanionCard
                activeCount={activeWorkers.length}
                doneCount={doneWorkers.length}
                add={diffAdd}
                del={diffDel}
                visible={1 - drawerOpen}
                hoverSubagents={f >= 230 && f < 260}
              />

              <div
                style={{
                  flex: 1,
                  position: "relative",
                  overflow: "hidden",
                  maskImage: "linear-gradient(to bottom, transparent 0, #000 18px, #000 calc(100% - 134px), transparent calc(100% - 102px))",
                  WebkitMaskImage:
                    "linear-gradient(to bottom, transparent 0, #000 18px, #000 calc(100% - 134px), transparent calc(100% - 102px))",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: contentLeft,
                    width: contentW,
                    top: 24 - scroll,
                    display: "flex",
                    flexDirection: "column",
                    gap: 16,
                  }}
                >
                  <div style={{ textAlign: "center", fontSize: 12, color: "#94A3B8" }}>今天 20:29</div>

                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <div
                      style={{
                        maxWidth: 460,
                        padding: "11px 16px",
                        borderRadius: 18,
                        background: "rgba(13,13,13,0.048)",
                        color: "#0D0D0D",
                        fontSize: 14,
                        lineHeight: "22px",
                      }}
                    >
                      {DEMO_PROMPT}
                    </div>
                  </div>

                  {f >= 20 && (
                    <div style={{ ...rise(f, 20, 20, 10), display: "flex", flexDirection: "column", gap: 9, fontSize: 13.5, color: "#64748B" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ color: PAL.blue }}>✦</span>
                        <span>
                          {allDone
                            ? "用时 68 秒（4 路异构 DAG · 较主流子代理再提速 1.65×） ›"
                            : `Router 已拆解 5 个工作节点 · ${doneWorkers.length}/5 已完成 · Fencing 租约 #104 守护中 ›`}
                        </span>
                      </div>

                      {f >= 132 && (
                        <div style={{ ...rise(f, 132, 18, 8), display: "flex", alignItems: "center", gap: 9, paddingLeft: 2 }}>
                          <WorkerAvatar variant={1} size={15} />
                          <span style={{ color: "#1E293B", fontWeight: 520 }}>optimize_queue</span>
                          <span>并行启动（隔离快照 #1 · gpt-5.2）</span>
                        </div>
                      )}
                      {f >= 152 && (
                        <div style={{ ...rise(f, 152, 18, 8), display: "flex", alignItems: "center", gap: 9, paddingLeft: 2 }}>
                          <WorkerAvatar variant={2} size={15} />
                          <span style={{ color: "#1E293B", fontWeight: 520 }}>update_router</span>
                          <span>并行启动（隔离快照 #2 · qwen3-coder）</span>
                        </div>
                      )}
                      {f >= 195 && (
                        <div style={{ ...rise(f, 195, 18, 8), display: "flex", alignItems: "center", gap: 9, paddingLeft: 2 }}>
                          <span style={{ color: "#059642", fontSize: 14 }}>▤</span>
                          <span>
                            已并行读取 <strong style={{ color: "#1E293B", fontWeight: 560 }}>queue.js · router.js</strong>，完成最小堆与多维评分补丁
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Approval Gate + One-Shot Permit Consumption */}
                  {f >= 595 && (
                    <div style={{ ...rise(f, 595, 22, 12), display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: "#64748B" }}>
                        <span style={{ color: approved ? "#059642" : "#D95D1E" }}>{approved ? "✓" : "✦"}</span>
                        <span>
                          {approved
                            ? "一次性执行令牌已核销 · 零网容器实跑 56 项测试 100% 通过"
                            : "正在等待你的批准 · shell · verify_bench"}
                        </span>
                      </div>
                      <div
                        style={{
                          borderRadius: 14,
                          background: "#FFFFFF",
                          border: `1px solid ${approved ? "rgba(5,150,66,0.28)" : "rgba(217,93,30,0.42)"}`,
                          borderTopWidth: 2.5,
                          borderTopColor: approved ? "#059642" : "#D95D1E",
                          padding: "13px 16px",
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13.5 }}>
                          <span style={{ fontWeight: 620, color: "#0D0D0D", display: "inline-flex", alignItems: "center", gap: 7 }}>
                            <span style={{ color: approved ? "#059642" : "#D95D1E" }}>{approved ? "✓" : "!"}</span>
                            {approved ? "一次性令牌核销完成 · 沙箱压测通过" : "正在等待你的批准"}
                            <span style={{ color: "#94A3B8", fontWeight: 450, fontSize: 12.5 }}>shell · Tester</span>
                          </span>
                          <span
                            style={{
                              padding: "2px 10px",
                              borderRadius: 99,
                              fontSize: 12,
                              fontWeight: 600,
                              background: approved ? "rgba(5,150,66,0.10)" : "rgba(217,93,30,0.10)",
                              color: approved ? "#059642" : "#D95D1E",
                            }}
                          >
                            {approved ? "exit 0 · JCS 存证" : "零网容器"}
                          </span>
                        </div>
                        <div
                          style={{
                            padding: "9px 12px",
                            borderRadius: 9,
                            background: "#F5F7FA",
                            fontFamily: MONO,
                            fontSize: 12.5,
                            color: "#1E293B",
                          }}
                        >
                          $ docker exec --network=none --read-only node --test test/queue.test.js
                        </div>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span style={{ fontSize: 12, color: "#64748B" }}>
                            7 级执行门预检通过 · WeakMap 一次性防重放令牌就绪
                          </span>
                          <div style={{ display: "flex", gap: 8 }}>
                            {!approved && (
                              <span
                                style={{
                                  padding: "5px 13px",
                                  borderRadius: 8,
                                  border: "1px solid rgba(13,13,13,0.12)",
                                  fontSize: 12.5,
                                  color: "#475569",
                                  fontWeight: 520,
                                }}
                              >
                                拒绝
                              </span>
                            )}
                            <span
                              style={{
                                padding: "5px 14px",
                                borderRadius: 8,
                                background: approved ? "#059642" : PAL.blue,
                                color: "#FFFFFF",
                                fontSize: 12.5,
                                fontWeight: 620,
                                transform: f >= 710 && f <= 722 ? "scale(0.94)" : "scale(1)",
                              }}
                            >
                              {approved ? "✓ 已批准" : "批准一次"}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {f >= 930 && (
                    <div style={{ ...rise(f, 930, 22, 10), display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: inRework ? "#B45309" : "#475569" }}>
                      <span style={{ width: 7, height: 7, borderRadius: 99, background: inRework ? "#D97706" : "#059642", flex: "none" }} />
                      <span>
                        {inRework
                          ? "Reviewer 检出 update_router 竞态边界 → Router 锁定保留上游成果，仅触发受影响子图有界自愈…"
                          : "T0 门禁 + Reviewer 双重核验通过：真实退出码 0 证据链完整，上游零重跑，吞吐与延迟显著改善。"}
                      </span>
                    </div>
                  )}

                  {f >= 1135 && (
                    <div style={{ ...rise(f, 1135, 24, 14), display: "flex", flexDirection: "column", gap: 14 }}>
                      <div style={{ fontSize: 14, color: "#0D0D0D", lineHeight: "22px" }}>
                        {typed(SUMMARY_LINE, f, 1138, 1.15)}
                      </div>

                      <div style={{ fontSize: 13.2 }}>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "1.05fr 1.5fr 1.35fr",
                            padding: "7px 0",
                            borderBottom: "1px solid rgba(13,13,13,0.10)",
                            fontWeight: 700,
                            color: "#0D0D0D",
                          }}
                        >
                          <span>瓶颈</span>
                          <span>改动</span>
                          <span>实测 before → after</span>
                        </div>
                        {BENCH_ROWS.map((row) => (
                          <div
                            key={row.b}
                            style={{
                              display: "grid",
                              gridTemplateColumns: "1.05fr 1.5fr 1.35fr",
                              padding: "8px 0",
                              borderBottom: "1px solid rgba(13,13,13,0.06)",
                              color: "#1E293B",
                            }}
                          >
                            <span>{row.b}</span>
                            <span>{row.c}</span>
                            <span style={{ fontWeight: 680, color: PAL.blueDeep }}>{row.r}</span>
                          </div>
                        ))}
                      </div>

                      <div
                        style={{
                          borderRadius: 14,
                          border: "1px solid rgba(13,13,13,0.09)",
                          background: "#FFFFFF",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            padding: "11px 14px",
                            borderBottom: "1px solid rgba(13,13,13,0.06)",
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                          }}
                        >
                          <span
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 8,
                              background: "#F4F6FA",
                              display: "grid",
                              placeItems: "center",
                              fontSize: 13,
                              color: "#475569",
                            }}
                          >
                            ±
                          </span>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 620, color: "#0D0D0D" }}>已编辑 4 个文件</div>
                            <div style={{ fontFamily: MONO, fontSize: 12 }}>
                              <span style={{ color: "#059642" }}>+79</span>{" "}
                              <span style={{ color: "#E03E3A" }}>-6</span>
                            </div>
                          </div>
                          <div style={{ flex: 1 }} />
                          <span style={{ fontSize: 12.5, color: "#64748B", marginRight: 8 }}>撤销 ↶</span>
                          <span
                            style={{
                              padding: "5px 12px",
                              borderRadius: 8,
                              border: "1px solid rgba(13,13,13,0.10)",
                              fontSize: 12.5,
                              fontWeight: 560,
                              color: "#0D0D0D",
                            }}
                          >
                            查看变更
                          </span>
                        </div>
                        {[
                          { dir: "src/", name: "queue.js", add: "+42", del: "-4" },
                          { dir: "src/", name: "router.js", add: "+14", del: "-2" },
                          { dir: "test/", name: "queue.test.js", add: "+23", del: "-0" },
                        ].map((fl) => (
                          <div
                            key={fl.name}
                            style={{
                              height: 33,
                              padding: "0 14px",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              borderTop: "1px solid rgba(13,13,13,0.045)",
                              fontSize: 12.8,
                            }}
                          >
                            <span>
                              <span style={{ color: "#94A3B8" }}>› {fl.dir}</span>
                              <span style={{ color: "#0D0D0D", fontWeight: 520 }}>{fl.name}</span>
                            </span>
                            <span style={{ fontFamily: MONO, fontSize: 12 }}>
                              <span style={{ color: "#059642" }}>{fl.add}</span>{" "}
                              <span style={{ color: "#E03E3A" }}>{fl.del}</span>
                              <span style={{ color: "#94A3B8", marginLeft: 8 }}>↗</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div style={{ position: "absolute", left: contentLeft, bottom: 16 }}>
                <ComposerBox text="" width={contentW} running={!allDone} showTray={false} />
              </div>
            </div>

            {/* RIGHT SPLIT PANE: Clean Native '子智能体' Drawer */}
            {drawerW > 4 && (
              <div
                style={{
                  width: drawerW,
                  borderLeft: "1px solid rgba(13,13,13,0.08)",
                  background: "#FFFFFF",
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: 46,
                    padding: "0 14px",
                    borderBottom: "1px solid rgba(13,13,13,0.06)",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    whiteSpace: "nowrap",
                  }}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 7,
                      height: 28,
                      padding: "0 11px",
                      borderRadius: 8,
                      background: "rgba(13,13,13,0.05)",
                      color: "#0D0D0D",
                      fontSize: 12.8,
                      fontWeight: 560,
                    }}
                  >
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth={1.8}>
                      <circle cx="12" cy="8" r="3.5" />
                      <path d="M5 20c1-3.5 3.5-5 7-5s6 1.5 7 5" />
                    </svg>
                    子智能体
                    <span style={{ color: "#94A3B8", fontSize: 11 }}>×</span>
                  </span>
                  <span style={{ color: "#94A3B8", fontSize: 16, fontWeight: 350 }}>+</span>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: 12, color: "#94A3B8" }}>Router 5 节点</span>
                </div>

                <div style={{ flex: 1, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 22, overflow: "hidden" }}>
                  {inDetail ? (
                    <div
                      style={{
                        opacity: detailSlide,
                        transform: `translateX(${(1 - detailSlide) * 24}px)`,
                        display: "flex",
                        flexDirection: "column",
                        gap: 16,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          paddingBottom: 12,
                          borderBottom: "1px solid rgba(13,13,13,0.06)",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                          <span style={{ fontSize: 15, color: "#64748B" }}>←</span>
                          <WorkerAvatar variant={1} size={16} />
                          <span style={{ fontSize: 14, fontWeight: 620, color: "#0D0D0D" }}>optimize_queue</span>
                        </div>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#64748B", fontFamily: MONO }}>
                          <BrandLogo file="logos/openai.png" size={16} pad={2} radius={4} shadow={false} />
                          gpt-5.2 · Coder
                        </span>
                      </div>

                      <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.6 }}>
                        Router 派发目标：将 TaskQueue 线性扫描替换为最小堆与账号级 ready 队列。
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.8, color: "#64748B" }}>
                        <span>✓ 已读取 src/queue.js（读并行 · 34ms）</span>
                        <span>✓ 已应用 4 级模糊补丁 src/queue.js</span>
                      </div>

                      <div
                        style={{
                          borderRadius: 11,
                          border: "1px solid rgba(13,13,13,0.08)",
                          padding: "8px 0",
                          fontFamily: MONO,
                          fontSize: 11.8,
                          background: "#FAFBFD",
                        }}
                      >
                        {QUEUE_DIFF.map((row, idx) => (
                          <div
                            key={row.ln}
                            style={{
                              opacity: p(f, 405 + idx * 13, 14),
                              height: 25,
                              lineHeight: "25px",
                              padding: "0 12px",
                              whiteSpace: "pre",
                              background: row.k > 0 ? "rgba(4,184,76,0.09)" : row.k < 0 ? "rgba(224,62,58,0.09)" : undefined,
                              color: row.k > 0 ? "#059642" : row.k < 0 ? "#E03E3A" : "#64748B",
                            }}
                          >
                            <span style={{ display: "inline-block", width: 22, color: "#94A3B8" }}>{row.ln}</span>
                            {row.t}
                          </div>
                        ))}
                      </div>

                      <div style={{ fontSize: 12.5, color: "#059642", fontWeight: 560 }}>
                        ✓ T0 确定性门禁校验通过 · 语法 0 错误
                      </div>
                    </div>
                  ) : (
                    <>
                      <div>
                        <div style={{ fontSize: 12.5, color: "#94A3B8", fontWeight: 520, marginBottom: 10 }}>
                          已开启 · {activeWorkers.length}
                        </div>
                        {activeWorkers.length === 0 ? (
                          <div style={{ fontSize: 13.5, color: "#94A3B8", padding: "4px 6px" }}>没有已开启的子代理</div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {activeWorkers.map((w) => {
                              const hover = w.id === "q" && f >= 352 && f < 388;
                              return (
                                <div
                                  key={w.id}
                                  style={{
                                    height: 38,
                                    padding: "0 10px",
                                    borderRadius: 9,
                                    background: hover ? PAL.ice : "transparent",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    fontSize: 13.5,
                                  }}
                                >
                                  <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                                    <WorkerAvatar variant={w.v} size={16} />
                                    <span style={{ color: "#0D0D0D", fontWeight: 500 }}>{w.name}</span>
                                    <BrandLogo file={w.logo} size={16} pad={2} radius={4} shadow={false} />
                                    <span
                                      style={{
                                        width: 6,
                                        height: 6,
                                        borderRadius: 99,
                                        background: w.state === "rework" ? "#D97706" : PAL.blue,
                                        opacity: 0.45 + 0.55 * Math.sin(f / 8),
                                      }}
                                    />
                                  </span>
                                  <span style={{ fontSize: 12.5, color: w.state === "rework" ? "#D97706" : "#64748B" }}>
                                    {w.state === "rework" ? "有界自愈中" : "运行中"}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div>
                        <div style={{ fontSize: 12.5, color: "#94A3B8", fontWeight: 520, marginBottom: 10 }}>
                          完成 · {doneWorkers.length}
                        </div>
                        {doneWorkers.length === 0 ? (
                          <div style={{ fontSize: 13.5, color: "#94A3B8", padding: "4px 6px" }}>暂无已完成的子代理</div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {doneWorkers.map((w) => (
                              <div
                                key={w.id}
                                style={{
                                  height: 36,
                                  padding: "0 10px",
                                  borderRadius: 9,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  fontSize: 13.5,
                                }}
                              >
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                                  <WorkerAvatar variant={w.v} size={16} />
                                  <span style={{ color: "#0D0D0D", fontWeight: 480 }}>{w.name}</span>
                                  <BrandLogo file={w.logo} size={16} pad={2} radius={4} shadow={false} />
                                </span>
                                <span
                                  style={{
                                    fontSize: 12,
                                    color: w.state === "locked" ? "#059642" : "#94A3B8",
                                    fontFamily: MONO,
                                  }}
                                >
                                  {w.state === "locked" ? "上游保留" : w.time}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </DesktopShell>

        <Cursor
          show={[210, 575]}
          keys={[
            { f: 210, x: 1120, y: 360 },
            { f: 252, x: 1380, y: 242, click: true },
            { f: 340, x: 1140, y: 195 },
            { f: 384, x: 1120, y: 148, click: true },
            { f: 515, x: 1120, y: 148 },
            { f: 544, x: 1060, y: 114, click: true },
            { f: 575, x: 960, y: 220 },
          ]}
        />

        <Cursor
          show={[665, 760]}
          keys={[
            { f: 665, x: 840, y: 650 },
            { f: 712, x: 916, y: 478, click: true },
            { f: 760, x: 960, y: 560 },
          ]}
        />
      </div>

      <CalloutBanner
        at={18}
        until={235}
        center
        y={20}
        badge="Router 有状态 DAG 控制面"
        title="超越临时子代理扇出：持久拓扑依赖编排 + 异构角色按需选型"
        sub="较 Claude Code / Codex 子代理模式再提速 1.65×，局部返工免全图重算"
      />
      <CalloutBanner
        at={250}
        until={575}
        center
        y={20}
        badge="隔离并发 × 下钻透视"
        title="多 Worker 独占快照并发编码，实时透视内部补丁与 T0 门禁"
        sub="杜绝多任务共享目录互相污染"
      />
      <CalloutBanner
        at={595}
        until={910}
        center
        y={20}
        badge="7 级执行门 × 一次性令牌"
        title="高危命令强制审批 + WeakMap 一次性核销，零网容器安全执行"
        sub="每一条测试证据均写入 JCS-SHA256 防篡改账本"
        tone="amber"
      />
      <CalloutBanner
        at={930}
        until={1405}
        center
        y={20}
        badge="独立验收 × 局部自愈"
        title="Reviewer 交叉审查，仅定点返工受影响节点，保留上游成果"
        sub="最终交付实测压测表与不可变 Diff 证据包"
        tone="green"
      />
    </AbsoluteFill>
  );
};
