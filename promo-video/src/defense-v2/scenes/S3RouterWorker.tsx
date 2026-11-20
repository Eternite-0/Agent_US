import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { EASE_IO, MONO, PAL, mix, p, rise, typed } from "../theme";
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
import { ComposerBox, DEMO_PROMPT } from "./S2Workbench";

/* ----------------- Exact Minimalist Diff Rows (Detail Pane) --------------- */
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

const SUMMARY_LINE = "已完成队列调度与多模型路由优化，并补齐单元测试与隔离沙箱压测报告。";

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

/* --- Floating Top-Right AgentCompanionCard (1:1 ui-thread-companion.png) --- */
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
      {/* Header */}
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

      {/* Row 1: 变更 */}
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

      {/* Section 2: 子智能体 */}
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

      {/* Section 3: 来源 */}
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

export const S3RouterWorker: React.FC = () => {
  const f = useCurrentFrame();

  // Timeline:
  // 0..270:   Airy Thread + Floating CompanionCard (Router plans -> spawns optimize_queue & update_router)
  // 270..625: Cursor clicks 子智能体 -> Right Split Drawer glides open (exact ui-thread-workers.png!)
  //           At f=410 cursor clicks optimize_queue -> glides into Subagent Detail Drill-down -> back at f=575
  // 625..950: Real Approval Gate Card (exact ui-thread-approval.png!) -> cursor clicks 批准一次 at f=748
  // 950..1560: Reviewer detects race -> Router partial rework (upstream locked!) -> Clean Markdown Table + FileChangeCard!

  const drawerOpen = p(f, 276, 26);
  const inDetail = f >= 412 && f < 595;
  const detailSlide = p(f, 412, 20) * (1 - p(f, 578, 16));
  const approved = f >= 748;
  const inRework = f >= 995 && f < 1215;
  const allDone = f >= 1215;

  const diffAdd = Math.round(79 * p(f, 220, 320, (t) => t));
  const diffDel = Math.round(6 * p(f, 220, 320, (t) => t));

  const drawerW = Math.round(drawerOpen * 490);
  const threadW = 1230 - drawerW;
  const contentW = Math.min(688, threadW - 96);
  const contentLeft = Math.round((threadW - contentW) / 2);

  // Smooth scroll inside the airy thread column as new items appear
  const scroll = interpolate(
    f,
    [0, 1190, 1255],
    [0, 0, 320],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_IO },
  );

  const workers: WorkerRow[] = [
    {
      id: "plan", v: 0, name: "plan_dag", role: "Router 规划", model: "deepseek-reasoner", logo: "logos/deepseek.png",
      state: f < 20 ? "waiting" : f < 135 ? "running" : inRework ? "locked" : "done",
      time: "3.2s",
    },
    {
      id: "q", v: 1, name: "optimize_queue", role: "Coder", model: "gpt-5.2", logo: "logos/openai.png",
      state: f < 140 ? "waiting" : f < 520 ? "running" : inRework ? "locked" : "done",
      time: "+42 -4",
    },
    {
      id: "r", v: 2, name: "update_router", role: "Coder", model: "qwen3-coder", logo: "logos/qwen.png",
      state: f < 150 ? "waiting" : f < 545 ? "running" : inRework && f < 1135 ? "rework" : "done",
      time: "+14 -2",
    },
    {
      id: "t", v: 3, name: "verify_bench", role: "Tester", model: "deepseek-v3.2", logo: "logos/deepseek.png",
      state: f < 610 ? "waiting" : f < 905 ? "running" : inRework && f >= 1130 && f < 1200 ? "rework" : "done",
      time: "56/56 通过",
    },
    {
      id: "rev", v: 4, name: "review_gate", role: "Reviewer", model: "claude-sonnet-4.5", logo: "logos/claude.png",
      state: f < 915 ? "waiting" : f < 1225 ? "running" : "done",
      time: "已验收",
    },
  ];

  const activeWorkers = workers.filter((w) => w.state === "running" || w.state === "rework");
  const doneWorkers = workers.filter((w) => w.state === "done" || w.state === "locked");

  const pendingApproval = f >= 630 && !approved;

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: (1920 - SHELL_W) / 2,
          top: 108,
          width: SHELL_W,
          height: SHELL_H,
          transform: "scale(1.06)",
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
            {/* LEFT / CENTER: Pure-White Airy Thread View (1:1 ui-thread-companion.png!) */}
            <div style={{ width: threadW, position: "relative", display: "flex", flexDirection: "column" }}>
              {/* Minimal Thread Header */}
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
                {/* Minimal right header icons (search / subagents / split panel) matching ui-thread-companion.png */}
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

              {/* Floating Top-Right AgentCompanionCard (visible before right split pane opens!) */}
              <CompanionCard
                activeCount={activeWorkers.length}
                doneCount={doneWorkers.length}
                add={diffAdd}
                del={diffDel}
                visible={1 - drawerOpen}
                hoverSubagents={f >= 250 && f < 280}
              />

              {/* Scrollable Pure-White Conversation Flow */}
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
                  {/* Timestamp */}
                  <div style={{ textAlign: "center", fontSize: 12, color: "#94A3B8" }}>今天 20:29</div>

                  {/* User Message Bubble (exact ui-thread-companion.png) */}
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

                  {/* Router Planning Line (exact whisper-clean style from ui-thread-approval.png!) */}
                  {f >= 24 && (
                    <div style={{ ...rise(f, 24, 20, 10), display: "flex", flexDirection: "column", gap: 9, fontSize: 13.5, color: "#64748B" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ color: PAL.blue }}>✦</span>
                        <span>
                          {allDone
                            ? "用时 1分钟 18秒  ›"
                            : `Router 已规划 5 个工作节点 · ${doneWorkers.length}/5 已完成 · complex / 零裸 Shell 权限 ›`}
                        </span>
                      </div>

                      {/* Clean worker dispatch activity lines (no cluttered boxes!) */}
                      {f >= 140 && (
                        <div style={{ ...rise(f, 140, 18, 8), display: "flex", alignItems: "center", gap: 9, paddingLeft: 2 }}>
                          <WorkerAvatar variant={1} size={15} />
                          <span style={{ color: "#1E293B", fontWeight: 520 }}>optimize_queue</span>
                          <span>并行启动（独立工作区 · gpt-5.2）</span>
                        </div>
                      )}
                      {f >= 165 && (
                        <div style={{ ...rise(f, 165, 18, 8), display: "flex", alignItems: "center", gap: 9, paddingLeft: 2 }}>
                          <WorkerAvatar variant={2} size={15} />
                          <span style={{ color: "#1E293B", fontWeight: 520 }}>update_router</span>
                          <span>并行启动（独立工作区 · qwen3-coder）</span>
                        </div>
                      )}
                      {f >= 210 && (
                        <div style={{ ...rise(f, 210, 18, 8), display: "flex", alignItems: "center", gap: 9, paddingLeft: 2 }}>
                          <span style={{ color: "#059642", fontSize: 14 }}>▤</span>
                          <span>
                            已并行读取 <strong style={{ color: "#1E293B", fontWeight: 560 }}>queue.js · router.js</strong>，完成最小堆与打分补丁
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Exact Real Interactive Approval Gate Card (1:1 ui-thread-approval.png!) */}
                  {f >= 630 && (
                    <div style={{ ...rise(f, 630, 22, 12), display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: "#64748B" }}>
                        <span style={{ color: approved ? "#059642" : "#D95D1E" }}>{approved ? "✓" : "✦"}</span>
                        <span>{approved ? "已批准 · 无网络隔离容器压测通过（56 项回归 100% 通过）" : "正在等待你的批准 · shell · verify_bench"}</span>
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
                            {approved ? "已批准执行 · 沙箱压测完成" : "正在等待你的批准"}
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
                            {approved ? "exit 0 · 1.2s" : "隔离容器"}
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
                          $ docker exec --network=none node --test test/queue.test.js
                        </div>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span style={{ fontSize: 12, color: "#64748B" }}>
                            在无网络隔离容器受控执行（已通过高危命令红线预检）
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
                                transform: f >= 742 && f <= 754 ? "scale(0.94)" : "scale(1)",
                              }}
                            >
                              {approved ? "✓ 已批准" : "批准一次"}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Reviewer Cross-Check & Partial Subgraph Rework Note (clean whisper-quiet line!) */}
                  {f >= 995 && (
                    <div style={{ ...rise(f, 995, 22, 10), display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: inRework ? "#B45309" : "#475569" }}>
                      <span style={{ width: 7, height: 7, borderRadius: 99, background: inRework ? "#D97706" : "#059642", flex: "none" }} />
                      <span>
                        {inRework
                          ? "Reviewer 检出 update_router 竞态边界：Router 计算受影响子图，锁定保留上游成果，仅定点返工该节点…"
                          : "Reviewer 验收通过：所有工作节点交付物与退出码 0 证据均已核验，上游零重跑，性能提升真实有效。"}
                      </span>
                    </div>
                  )}

                  {/* Final Clean Markdown Delivery Table + FileChangeCard (1:1 ui-thread-companion.png!) */}
                  {f >= 1215 && (
                    <div style={{ ...rise(f, 1215, 24, 14), display: "flex", flexDirection: "column", gap: 14 }}>
                      <div style={{ fontSize: 14, color: "#0D0D0D", lineHeight: "22px" }}>
                        {typed(SUMMARY_LINE, f, 1218, 1.1)}
                      </div>

                      {/* Clean Minimalist Borderless Markdown Table */}
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

                      {/* Exact FileChangeCard (1:1 ui-thread-companion.png) */}
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

              {/* Clean Minimalist Bottom Composer */}
              <div style={{ position: "absolute", left: contentLeft, bottom: 16 }}>
                <ComposerBox text="" width={contentW} running={!allDone} showTray={false} />
              </div>
            </div>

            {/* RIGHT SPLIT PANE: Pure-White Airy Native '子智能体' Drawer (1:1 ui-thread-workers.png!) */}
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
                {/* Exact Minimal Tab Bar matching ui-thread-workers.png */}
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

                {/* Drawer Body: List View <-> Clean Drill-Down Detail View */}
                <div style={{ flex: 1, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 22, overflow: "hidden" }}>
                  {inDetail ? (
                    /* Clean Borderless Drill-Down Detail View (← optimize_queue) */
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

                      {/* Clean Minimal Code Diff */}
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
                              opacity: p(f, 430 + idx * 14, 14),
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
                        ✓ 编辑后即时语法诊断 · 0 错误
                      </div>
                    </div>
                  ) : (
                    /* Exact Clean Subagents List View (1:1 ui-thread-workers.png!) */
                    <>
                      {/* 已开启 · N */}
                      <div>
                        <div style={{ fontSize: 12.5, color: "#94A3B8", fontWeight: 520, marginBottom: 10 }}>
                          已开启 · {activeWorkers.length}
                        </div>
                        {activeWorkers.length === 0 ? (
                          <div style={{ fontSize: 13.5, color: "#94A3B8", padding: "4px 6px" }}>没有已开启的子代理</div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {activeWorkers.map((w) => {
                              const hover = w.id === "q" && f >= 375 && f < 412;
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
                                    {w.state === "rework" ? "局部返工" : "运行中"}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {/* 完成 · M */}
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

        {/* Cursor 1: Clicks 子智能体 on floating CompanionCard -> Clicks optimize_queue -> Clicks ← back */}
        <Cursor
          show={[225, 610]}
          keys={[
            { f: 225, x: 1120, y: 360 },
            { f: 272, x: 1380, y: 242, click: true },
            { f: 360, x: 1140, y: 195 },
            { f: 408, x: 1120, y: 148, click: true },
            { f: 545, x: 1120, y: 148 },
            { f: 576, x: 1060, y: 114, click: true },
            { f: 610, x: 960, y: 220 },
          ]}
        />

        {/* Cursor 2: Clicks 批准一次 on Approval Gate Card */}
        <Cursor
          show={[695, 795]}
          keys={[
            { f: 695, x: 840, y: 650 },
            { f: 744, x: 916, y: 478, click: true },
            { f: 795, x: 960, y: 560 },
          ]}
        />
      </div>

      {/* Top Clean Keynote Callouts — zero overlap */}
      <CalloutBanner
        at={24}
        until={245}
        center
        y={22}
        badge="Router 调度中枢"
        title="自动拆解多节点任务，按角色动态路由异构模型"
        sub="Router 只负责规划与汇总，绝不直接持有高危 Shell 权限"
      />
      <CalloutBanner
        at={265}
        until={605}
        center
        y={22}
        badge="子智能体并行 × 下钻透视"
        title="双 Worker 独立工作区并发编码，随时点击透视执行明细"
        sub="读并行写屏障 · 4 级模糊编辑 · 即时语法诊断"
      />
      <CalloutBanner
        at={625}
        until={970}
        center
        y={22}
        badge="沙箱审批门控"
        title="高危命令强制人工确认，无网络容器安全隔离运行"
        sub="批准后自动完成 56 项回归压测，吞吐提升显著"
        tone="amber"
      />
      <CalloutBanner
        at={990}
        until={1520}
        center
        y={22}
        badge="独立验收 × 局部返工"
        title="Reviewer 交叉审查，Router 仅定点回炉受影响子代理"
        sub="锁定保留上游已通过成果，最终一键交付压测报告与文件变更"
        tone="green"
      />
    </AbsoluteFill>
  );
};
