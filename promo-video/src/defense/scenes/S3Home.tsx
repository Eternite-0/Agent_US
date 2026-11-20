import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { AppWindow, Sidebar, WIN_H, WIN_W } from "../AppWindow";
import { C, MONO, lerp, prog, rise, typed } from "../theme";
import { Callout, Cursor, Icon, Logo } from "../ui";

export const PROMPT = "为电商后端实现 JWT 鉴权中间件，补齐单元测试并确保全部通过";
export const WIN_SCALE = 1.2;

export const Composer: React.FC<{
  text: string;
  caret?: boolean;
  placeholder?: string;
  focus?: number;
  sendGlow?: number;
  width?: number;
  running?: boolean;
}> = ({ text, caret, placeholder = "随心输入，一起工作 · 输入 / 调用快捷命令，@ 引用文件", focus = 0, sendGlow = 0, width = 680, running }) => (
  <div
    style={{
      width,
      borderRadius: 20,
      background: "#fff",
      border: `1px solid ${focus > 0.5 ? C.sky : C.line}`,
      boxShadow: `0 0 0 ${focus * 4}px rgba(59,130,246,0.14), 0 12px 32px -16px rgba(11,27,58,0.22)`,
      padding: "16px 16px 12px 20px",
    }}
  >
    <div style={{ minHeight: 48, fontSize: 15.5, lineHeight: "24px", color: text ? C.text : C.muted }}>
      {text || placeholder}
      {caret && <span style={{ display: "inline-block", width: 2, height: 19, background: C.blue, marginLeft: 2, verticalAlign: -3 }} />}
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
      <span style={btn}>
        <Icon name="plus" size={15} color={C.sub} />
      </span>
      <span style={pill}>
        <Icon name="zap" size={13} color={C.blue} /> auto · 号池智能路由 <Icon name="chevron" size={12} color={C.muted} />
      </span>
      <span style={pill}>推理 · 高</span>
      <span style={pill}>
        <Icon name="shield" size={13} color={C.green} /> 隔离容器 · 自动审批
      </span>
      <div style={{ flex: 1 }} />
      <span
        style={{
          width: 34,
          height: 34,
          borderRadius: 99,
          display: "grid",
          placeItems: "center",
          background: text || running ? C.blue : "rgba(11,27,58,0.12)",
          boxShadow: `0 0 0 ${sendGlow * 8}px rgba(37,99,235,${0.25 * sendGlow})`,
        }}
      >
        <Icon name={running ? "stop" : "arrowUp"} size={17} color="#fff" stroke={2.4} />
      </span>
    </div>
  </div>
);

const btn: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 99,
  border: `1px solid ${C.line}`,
  display: "grid",
  placeItems: "center",
};
const pill: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 30,
  padding: "0 12px",
  borderRadius: 99,
  fontSize: 13,
  color: C.sub,
  background: "rgba(11,27,58,0.04)",
};

export const WindowStage: React.FC<{ children: React.ReactNode; transform?: string }> = ({ children, transform }) => (
  <div
    style={{
      position: "absolute",
      left: (1920 - WIN_W) / 2,
      top: (1080 - WIN_H) / 2 + 10,
      width: WIN_W,
      height: WIN_H,
      transform: transform ?? `scale(${WIN_SCALE})`,
      transformOrigin: "50% 50%",
    }}
  >
    {children}
  </div>
);

export const S3Home: React.FC = () => {
  const f = useCurrentFrame();
  const enter = prog(f, 0, 70);
  const typeStart = 165;
  const text = typed(PROMPT, f, typeStart, 0.2);
  const sent = f >= 392;
  const after = prog(f, 396, 40);
  const focus = prog(f, 150, 12);
  const sendGlow = f > 384 && f < 410 ? Math.sin(((f - 384) / 26) * Math.PI) : 0;

  const rotX = lerp(enter, 24, 0);
  const ty = lerp(enter, 260, 0);
  const sc = lerp(enter, 0.82, 1) * WIN_SCALE;
  const zoomOut = prog(f, 440, 90);

  return (
    <AbsoluteFill style={{ perspective: 2400 }}>
      <WindowStage transform={`translateY(${ty}px) rotateX(${rotX}deg) scale(${sc * lerp(zoomOut, 1, 1.0)})`}>
        <AppWindow sidebar={<Sidebar active={0} />}>
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div
              style={{
                marginTop: lerp(after, 150, 60),
                opacity: 1 - after,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
              }}
            >
              <div style={rise(f, 40, 26)}>
                <Logo size={56} spin={f * 1.4} />
              </div>
              <div style={{ ...rise(f, 50, 28), fontSize: 30, fontWeight: 650, color: C.ink, marginTop: 24 }}>
                你想让我们在
                <span
                  style={{
                    margin: "0 8px",
                    padding: "2px 12px",
                    borderRadius: 10,
                    background: C.ice,
                    color: C.blueDeep,
                  }}
                >
                  Agent_US
                </span>
                中构建什么？
              </div>
            </div>
            {sent && (
              <div
                style={{
                  position: "absolute",
                  right: 352,
                  top: lerp(after, 520, 68),
                  opacity: after,
                  maxWidth: 520,
                  padding: "12px 16px",
                  borderRadius: 16,
                  background: "rgba(11,27,58,0.05)",
                  fontSize: 15,
                  lineHeight: "23px",
                }}
              >
                {PROMPT}
              </div>
            )}
            <div
              style={{
                ...rise(f, 62, 30),
                position: "absolute",
                top: lerp(after, 300, 742 - 22 - 132),
                left: lerp(after, (1032 - 680) / 2, 40),
              }}
            >
              <Composer
                text={sent ? "" : text}
                caret={!sent && f >= typeStart && f % 40 < 24}
                focus={focus}
                sendGlow={sendGlow}
                running={sent}
                placeholder={sent ? "运行中也可随时输入，/steer 实时纠偏…" : undefined}
                width={lerp(after, 680, 640)}
              />
              <div
                style={{
                  display: "flex",
                  gap: 14,
                  marginTop: 12,
                  fontSize: 12.5,
                  color: C.muted,
                  paddingLeft: 8,
                  opacity: 1 - after,
                }}
              >
                <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
                  <Icon name="folder" size={13} color={C.muted} /> Agent_US
                </span>
                <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
                  <Icon name="branch" size={13} color={C.muted} /> main
                </span>
                <span style={{ fontFamily: MONO }}>AGENTS.md 已加载</span>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 26, opacity: 1 - after }}>
                {["审查最近一次提交", "为模块生成测试", "解释项目架构", "修复失败的构建"].map((s, i) => (
                  <span
                    key={s}
                    style={{
                      ...rise(f, 84 + i * 6, 24, 10),
                      padding: "8px 14px",
                      borderRadius: 12,
                      border: `1px solid ${C.line}`,
                      fontSize: 13,
                      color: C.sub,
                      background: "#fff",
                    }}
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </AppWindow>
        <Cursor
          show={[110, 420]}
          keys={[
            { f: 110, x: 820, y: 640 },
            { f: 150, x: 560, y: 365, click: true },
            { f: 340, x: 560, y: 365 },
            { f: 384, x: 1066, y: 424, click: true },
            { f: 430, x: 1110, y: 520 },
          ]}
        />
      </WindowStage>
      <Callout at={100} until={300} x={40} y={600} icon="layers" title="一体化工作台" sub="对话 · 号池 · 模型 · 签到 · 定时 · 插件" />
      <Callout at={250} until={420} x={1330} y={130} icon="shield" title="双执行模式" sub="本地直连 / 每次写入独立隔离容器" />
      <Callout at={300} until={430} x={40} y={800} icon="zap" title="号池智能路由" sub="按额度、延迟、能力自动选模型" />
    </AbsoluteFill>
  );
};
