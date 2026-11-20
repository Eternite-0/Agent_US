import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { AppWindow, Sidebar } from "../AppWindow";
import { C, EASE_IO, MONO, lerp, prog, rise, typed } from "../theme";
import { Callout, Icon, Shimmer } from "../ui";
import { Composer, PROMPT, WIN_SCALE, WindowStage } from "./S3Home";

const Spinner: React.FC<{ f: number; size?: number }> = ({ f, size = 13 }) => (
  <span
    style={{
      width: size,
      height: size,
      borderRadius: 99,
      border: `2px solid ${C.iceDeep}`,
      borderTopColor: C.blue,
      transform: `rotate(${f * 14}deg)`,
      display: "inline-block",
      flex: "none",
    }}
  />
);

const Done: React.FC<{ size?: number }> = ({ size = 15 }) => (
  <span
    style={{
      width: size,
      height: size,
      borderRadius: 99,
      background: C.green,
      display: "inline-grid",
      placeItems: "center",
      flex: "none",
    }}
  >
    <Icon name="check" size={size - 5} color="#fff" stroke={3} />
  </span>
);

const Status: React.FC<{ f: number; doneAt: number; size?: number }> = ({ f, doneAt, size }) =>
  f >= doneAt ? <Done size={size} /> : <Spinner f={f} size={size ? size - 2 : 13} />;

const Badge: React.FC<{ children: React.ReactNode; tone?: "blue" | "green" | "amber" }> = ({ children, tone = "blue" }) => {
  const m = {
    blue: [C.ice, C.blue],
    green: [C.greenSoft, C.green],
    amber: [C.amberSoft, C.amber],
  }[tone];
  return (
    <span style={{ fontSize: 11.5, fontWeight: 650, padding: "2px 8px", borderRadius: 6, background: m[0], color: m[1] }}>
      {children}
    </span>
  );
};

const Card: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div
    style={{
      border: `1px solid ${C.line}`,
      borderRadius: 14,
      background: "#fff",
      overflow: "hidden",
      ...style,
    }}
  >
    {children}
  </div>
);

const ROW_H: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  height: 32,
  padding: "0 14px",
  fontSize: 13.5,
  color: C.text,
};

type Item = { at: number; h: number; render: (f: number) => React.ReactNode };

const DIFF = [
  { t: " import jwt from 'jsonwebtoken';", k: 0 },
  { t: "-export const auth = (req, _res, next) => next();", k: -1 },
  { t: "+export function requireAuth(opts: AuthOptions) {", k: 1 },
  { t: "+  return async (req, res, next) => {", k: 1 },
  { t: "+    const token = extractBearer(req.headers);", k: 1 },
  { t: "+    if (!token) return res.status(401).end();", k: 1 },
  { t: "+    req.user = await verify(token, opts.secret);", k: 1 },
  { t: "+    next();", k: 1 },
];

const TERM = [
  { t: "$ npm test", c: C.sky },
  { t: " PASS  test/jwt.test.ts", c: "#4ADE80" },
  { t: "   ✓ 签发并校验访问令牌 (12 ms)", c: "#CBD5E1" },
  { t: "   ✓ 过期令牌返回 401 (4 ms)", c: "#CBD5E1" },
  { t: "   ✓ 篡改签名被拒绝 (3 ms)", c: "#CBD5E1" },
  { t: "   ✓ 刷新令牌自动轮换 (9 ms)", c: "#CBD5E1" },
  { t: " Tests:  24 passed, 24 total", c: "#4ADE80" },
];

const FINAL =
  "已完成 JWT 鉴权接入：新增 requireAuth 中间件并挂载到订单路由，支持令牌过期、签名篡改与刷新轮换；同步补齐 24 个单元测试，全部通过，语法诊断零错误。";

const ITEMS: Item[] = [
  {
    at: 0,
    h: 74,
    render: () => (
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div style={{ maxWidth: 520, padding: "12px 16px", borderRadius: 16, background: "rgba(11,27,58,0.05)", fontSize: 15, lineHeight: "23px" }}>
          {PROMPT}
        </div>
      </div>
    ),
  },
  {
    at: 24,
    h: 168,
    render: (f) => {
      const steps = ["分析现有路由与鉴权结构", "实现 JWT 鉴权中间件", "编写并补齐单元测试", "运行测试并即时诊断"];
      const doneAt = [210, 400, 520, 660];
      return (
        <div>
          <div style={{ fontSize: 14, display: "flex", alignItems: "center", gap: 8, color: C.sub }}>
            <Icon name="spark" size={15} color={C.blue} />
            {f < 110 ? <Shimmer f={f} text="正在思考 · 拆解任务与制定计划…" /> : <span>已思考 3.8s · 生成执行计划</span>}
          </div>
          <Card style={{ marginTop: 10, padding: "8px 0" }}>
            {steps.map((s, i) => {
              const a = prog(f, 70 + i * 8, 18);
              const done = f >= doneAt[i];
              const cur = !done && (i === 0 || f >= doneAt[i - 1]);
              return (
                <div key={s} style={{ ...ROW_H, height: 30, opacity: a, color: done ? C.muted : C.text }}>
                  {done ? <Done size={15} /> : cur ? <Spinner f={f} /> : <span style={{ width: 13, height: 13, borderRadius: 99, border: `1.5px solid ${C.line}` }} />}
                  <span style={{ textDecoration: done ? "line-through" : undefined }}>{s}</span>
                </div>
              );
            })}
          </Card>
        </div>
      );
    },
  },
  {
    at: 140,
    h: 186,
    render: (f) => {
      const files = ["src/server.ts", "src/routes/orders.ts", "src/config/env.ts", "package.json"];
      return (
        <Card>
          <div style={{ ...ROW_H, height: 38, borderBottom: `1px solid ${C.lineSoft}`, fontWeight: 600 }}>
            <Status f={f} doneAt={205} />
            并行读取 4 个文件
            <Badge>读并行</Badge>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: C.muted, fontWeight: 400 }}>{f >= 205 ? "38 ms" : ""}</span>
          </div>
          {files.map((p, i) => (
            <div key={p} style={{ ...ROW_H, opacity: prog(f, 146 + i * 4, 14) }}>
              <Status f={f} doneAt={180 + i * 6} size={14} />
              <Icon name="file" size={14} color={C.muted} />
              <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{p}</span>
              <span style={{ fontSize: 12, color: C.muted }}>{["142 行", "96 行", "38 行", "54 行"][i]}</span>
            </div>
          ))}
        </Card>
      );
    },
  },
  {
    at: 240,
    h: 286,
    render: (f) => (
      <Card>
        <div style={{ ...ROW_H, height: 38, borderBottom: `1px solid ${C.lineSoft}`, fontWeight: 600 }}>
          <Status f={f} doneAt={380} />
          编辑文件
          <span style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 500 }}>src/middleware/jwt.ts</span>
          <Badge>写屏障</Badge>
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.green }}>+48</span>
          <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.red }}>−6</span>
        </div>
        <div style={{ padding: "8px 0", fontFamily: MONO, fontSize: 12.5 }}>
          {DIFF.map((d, i) => {
            const a = prog(f, 258 + i * 13, 14);
            return (
              <div
                key={i}
                style={{
                  opacity: a,
                  transform: `translateX(${(1 - a) * -10}px)`,
                  height: 28,
                  lineHeight: "28px",
                  padding: "0 14px",
                  whiteSpace: "pre",
                  background: d.k > 0 ? C.greenSoft : d.k < 0 ? C.redSoft : undefined,
                  color: d.k > 0 ? "#0B7A3B" : d.k < 0 ? C.red : C.sub,
                }}
              >
                <span style={{ display: "inline-block", width: 28, color: C.muted }}>{i + 12}</span>
                {d.t}
              </div>
            );
          })}
        </div>
      </Card>
    ),
  },
  {
    at: 395,
    h: 150,
    render: (f) => {
      const rows = [
        ["src/routes/orders.ts", "+6", "−2"],
        ["src/server.ts", "+3", ""],
        ["test/jwt.test.ts", "+72", ""],
      ];
      return (
        <Card>
          <div style={{ ...ROW_H, height: 38, borderBottom: `1px solid ${C.lineSoft}`, fontWeight: 600 }}>
            <Status f={f} doneAt={448} />
            原子补丁 · 3 个文件
            <Badge tone="green">全部成功</Badge>
          </div>
          {rows.map((r, i) => (
            <div key={r[0]} style={{ ...ROW_H, height: 30, opacity: prog(f, 402 + i * 6, 14) }}>
              <Icon name="edit" size={14} color={C.muted} />
              <span style={{ fontFamily: MONO, fontSize: 12.5, flex: 1 }}>{r[0]}</span>
              <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.green }}>{r[1]}</span>
              <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.red, width: 22 }}>{r[2]}</span>
            </div>
          ))}
        </Card>
      );
    },
  },
  {
    at: 460,
    h: 40,
    render: (f) => (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 14px",
          borderRadius: 10,
          background: C.greenSoft,
          color: "#0B7A3B",
          fontSize: 13.5,
          fontWeight: 600,
        }}
      >
        <Status f={f} doneAt={478} /> 编辑后即时语法诊断 · 0 错误 · 0 警告
      </div>
    ),
  },
  {
    at: 505,
    h: 248,
    render: (f) => (
      <div style={{ borderRadius: 14, overflow: "hidden", background: "#0E1A33", boxShadow: "0 10px 30px -16px rgba(11,27,58,0.5)" }}>
        <div style={{ ...ROW_H, height: 36, color: "#CBD5E1", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          <Icon name="terminal" size={15} color={C.sky} />
          <span style={{ fontWeight: 600 }}>运行命令</span>
          <span style={{ fontFamily: MONO, fontSize: 12.5, color: "#93C5FD" }}>npm test</span>
          <div style={{ flex: 1 }} />
          {f >= 650 ? (
            <span style={{ fontSize: 12, color: "#4ADE80" }}>exit 0 · 1.42s</span>
          ) : (
            <Spinner f={f} />
          )}
        </div>
        <div style={{ padding: "10px 16px", fontFamily: MONO, fontSize: 13, lineHeight: "26px" }}>
          {TERM.map((l, i) => (
            <div key={i} style={{ color: l.c, opacity: f >= 520 + i * 18 ? 1 : 0 }}>
              {l.t}
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    at: 670,
    h: 80,
    render: (f) => (
      <div style={{ fontSize: 15, lineHeight: "26px", color: C.text }}>
        {typed(FINAL, f, 676, 0.42)}
        {f < 676 + FINAL.length / 0.42 && <span style={{ display: "inline-block", width: 8, height: 16, background: C.blue, marginLeft: 3, verticalAlign: -2, borderRadius: 2 }} />}
      </div>
    ),
  },
  {
    at: 860,
    h: 70,
    render: () => (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "14px 18px",
          borderRadius: 14,
          background: `linear-gradient(100deg, ${C.ice}, #fff)`,
          border: `1px solid ${C.iceDeep}`,
          fontSize: 14,
          color: C.blueDeep,
          fontWeight: 600,
        }}
      >
        <Done size={20} /> 任务完成
        <span style={{ color: C.sub, fontWeight: 500 }}>6 个文件变更</span>
        <span style={{ color: C.sub, fontWeight: 500 }}>24/24 测试通过</span>
        <span style={{ color: C.sub, fontWeight: 500 }}>总用时 41s</span>
        <span style={{ color: C.sub, fontWeight: 500 }}>快照 #7 已保存</span>
      </div>
    ),
  },
];

const GAP = 16;
const TOPS: number[] = [];
{
  let y = 0;
  for (const it of ITEMS) {
    TOPS.push(y);
    y += it.h + GAP;
  }
}
const VIEW = 742 - 44 - 170;

const SUBS = [
  { name: "测试工程师", task: "编写 test/jwt.test.ts", start: 560, end: 700 },
  { name: "安全审查员", task: "审查令牌泄漏与时序攻击", start: 580, end: 820 },
  { name: "文档同步员", task: "更新 README 鉴权章节", start: 600, end: 900 },
];

const Inspector: React.FC<{ f: number }> = ({ f }) => {
  const s = prog(f, 540, 40);
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 330,
        background: "#FBFCFE",
        borderLeft: `1px solid ${C.line}`,
        transform: `translateX(${(1 - s) * 340}px)`,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", gap: 4, padding: 3, borderRadius: 10, background: "rgba(11,27,58,0.04)", fontSize: 12.5 }}>
        {["子智能体", "变更", "事件与版本"].map((t, i) => (
          <span
            key={t}
            style={{
              flex: 1,
              textAlign: "center",
              padding: "6px 0",
              borderRadius: 8,
              background: i === 0 ? "#fff" : undefined,
              color: i === 0 ? C.ink : C.sub,
              fontWeight: i === 0 ? 650 : 450,
              boxShadow: i === 0 ? "0 1px 3px rgba(11,27,58,0.1)" : undefined,
            }}
          >
            {t}
          </span>
        ))}
      </div>
      {SUBS.map((a, i) => {
        const p = interpolate(f, [a.start, a.end], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const done = f >= a.end;
        return (
          <div
            key={a.name}
            style={{
              ...rise(f, 560 + i * 12, 22, 14),
              padding: "12px 14px",
              borderRadius: 12,
              background: "#fff",
              border: `1px solid ${done ? C.line : C.iceDeep}`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 650 }}>
              <span style={{ width: 26, height: 26, borderRadius: 8, background: C.ice, display: "grid", placeItems: "center" }}>
                <Icon name="bot" size={15} color={C.blue} />
              </span>
              {a.name}
              <div style={{ flex: 1 }} />
              {done ? <Badge tone="green">完成</Badge> : <Badge>运行中</Badge>}
            </div>
            <div style={{ fontSize: 12.5, color: C.sub, margin: "8px 0" }}>{a.task}</div>
            <div style={{ height: 5, borderRadius: 9, background: C.lineSoft }}>
              <div style={{ width: `${p * 100}%`, height: "100%", borderRadius: 9, background: done ? C.green : C.blue }} />
            </div>
          </div>
        );
      })}
      <div style={{ ...rise(f, 620, 24, 14), padding: "12px 14px", borderRadius: 12, background: "#fff", border: `1px solid ${C.line}` }}>
        <div style={{ fontSize: 12.5, color: C.sub, display: "flex", justifyContent: "space-between" }}>
          <span>上下文窗口</span>
          <span style={{ color: C.blue, fontWeight: 650 }}>{Math.round(lerp(prog(f, 600, 300), 21, 38))}%</span>
        </div>
        <div style={{ height: 5, borderRadius: 9, background: C.lineSoft, margin: "8px 0 12px" }}>
          <div style={{ width: `${lerp(prog(f, 600, 300), 21, 38)}%`, height: "100%", borderRadius: 9, background: C.blue }} />
        </div>
        <div style={{ fontSize: 12.5, color: C.sub, display: "flex", justifyContent: "space-between" }}>
          <span>Prompt Cache 命中</span>
          <span style={{ color: C.green, fontWeight: 650 }}>{Math.round(lerp(prog(f, 600, 300), 80, 94))}%</span>
        </div>
      </div>
    </div>
  );
};

export const S4Agent: React.FC = () => {
  const f = useCurrentFrame();

  // auto-scroll keyframes
  const keyF: number[] = [0];
  const keyS: number[] = [0];
  ITEMS.forEach((it, i) => {
    const bottom = TOPS[i] + it.h;
    const target = Math.max(0, bottom - VIEW);
    if (target > keyS[keyS.length - 1]) {
      keyF.push(it.at + 2, it.at + 32);
      keyS.push(keyS[keyS.length - 1], target);
    }
  });
  const scroll = interpolate(f, keyF, keyS, { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE_IO });

  const zoomIn = prog(f, 30, 90);
  const zoomOut = prog(f, 520, 60);
  const scale = WIN_SCALE * (1 + 0.08 * zoomIn - 0.08 * zoomOut);
  const tx = (zoomIn - zoomOut) * 50;
  const finished = f >= 860;

  return (
    <AbsoluteFill>
      <WindowStage transform={`translateX(${tx}px) scale(${scale})`}>
        <AppWindow
          sidebar={
            <Sidebar
              active={0}
              recent={[
                { title: "实现 JWT 鉴权中间件", running: !finished, active: true },
                { title: "重构支付模块并补齐测试" },
                { title: "排查 SSE 断流问题" },
              ]}
            />
          }
        >
          <div
            style={{
              height: 44,
              borderBottom: `1px solid ${C.lineSoft}`,
              display: "flex",
              alignItems: "center",
              padding: "0 20px",
              gap: 10,
              fontSize: 14,
              fontWeight: 650,
              color: C.ink,
            }}
          >
            实现 JWT 鉴权中间件
            {finished ? <Badge tone="green">已完成</Badge> : <Badge>运行中</Badge>}
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: C.muted, fontWeight: 450 }}>
              {Math.round(lerp(prog(f, 0, 860, (t) => t), 1.2, 48.6) * 10) / 10}K tokens
            </span>
          </div>
          <div
            style={{
              position: "absolute",
              top: 44,
              left: 0,
              width: 700,
              bottom: 0,
              overflow: "hidden",
              maskImage: "linear-gradient(to bottom, transparent 0, #000 24px, #000 calc(100% - 150px), transparent calc(100% - 110px))",
              WebkitMaskImage:
                "linear-gradient(to bottom, transparent 0, #000 24px, #000 calc(100% - 150px), transparent calc(100% - 110px))",
            }}
          >
            <div style={{ position: "absolute", left: 40, width: 640, top: 24 - scroll }}>
              {ITEMS.map((it, i) =>
                f >= it.at ? (
                  <div key={i} style={{ position: "absolute", top: TOPS[i], left: 0, right: 0, height: it.h, ...rise(f, it.at, 22, 16) }}>
                    {it.render(f)}
                  </div>
                ) : null,
              )}
            </div>
          </div>
          <div style={{ position: "absolute", left: 40, bottom: 22 }}>
            <Composer text="" width={640} running={!finished} placeholder="运行中也可随时输入，/steer 实时纠偏…" />
          </div>
          <Inspector f={f} />
        </AppWindow>
      </WindowStage>

      <Callout at={150} until={290} x={1380} y={300} icon="layers" title="读并行 · 写屏障调度" sub="只读工具并发，写操作自动串行加锁" />
      <Callout at={280} until={420} x={40} y={560} icon="edit" title="4 级模糊匹配编辑" sub="缩进 / 空白 / 近似行容错，精准落盘" />
      <Callout at={400} until={530} x={1380} y={520} icon="shield" title="多文件原子补丁" sub="要么全部成功，要么完整回滚" />
      <Callout at={470} until={600} x={40} y={300} icon="check" title="编辑即诊断" sub="每次写入后即时语法检查" />
      <Callout at={610} until={780} x={40} y={420} icon="bot" title="多智能体并行协作" sub="子智能体分工执行、实时汇总" />
      <Callout at={790} until={980} x={40} y={640} icon="zap" title="毫秒级流式输出" sub="Token · 思考 · 终端 全链路 SSE 实时推送" />
      <Callout at={900} until={1100} x={40} y={300} icon="rewind" title="每轮自动快照" sub="任意时刻一键回到过去" />
    </AbsoluteFill>
  );
};
