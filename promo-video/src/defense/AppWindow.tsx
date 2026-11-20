import React from "react";
import { C, FONT } from "./theme";
import { Icon, Logo } from "./ui";

export const WIN_W = 1280;
export const WIN_H = 780;

const NAV = [
  { icon: "chat", label: "对话" },
  { icon: "pool", label: "账号号池" },
  { icon: "cube", label: "模型管理" },
  { icon: "calendar", label: "签到中心" },
  { icon: "clock", label: "定时任务" },
  { icon: "puzzle", label: "插件与技能" },
];

export const Sidebar: React.FC<{
  active?: number;
  recent?: { title: string; running?: boolean; active?: boolean }[];
}> = ({ active = 0, recent }) => {
  const items = recent ?? [
    { title: "重构支付模块并补齐测试" },
    { title: "排查 SSE 断流问题" },
    { title: "生成季度数据看板" },
  ];
  return (
    <div
      style={{
        width: 248,
        flex: "none",
        background: C.chrome,
        borderRight: `1px solid ${C.line}`,
        padding: "12px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        fontSize: 13.5,
        color: C.text,
      }}
    >
      <Row icon="edit" label="新聊天" strong />
      <Row icon="search" label="搜索" kbd="Ctrl K" />
      <div style={{ height: 10 }} />
      {NAV.map((n, i) => (
        <Row key={n.label} icon={n.icon} label={n.label} active={i === active} />
      ))}
      <SectionLabel>项目</SectionLabel>
      <Row icon="folder" label="Agent_US" active={false} />
      <Row icon="folder" label="web-shop" />
      <Row icon="folder" label="data-lab" />
      <SectionLabel>最近</SectionLabel>
      {items.map((r) => (
        <div
          key={r.title}
          style={{
            height: 30,
            borderRadius: 8,
            padding: "0 10px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: r.active ? "rgba(37,99,235,0.08)" : "transparent",
            color: r.active ? C.blueDeep : C.sub,
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
        >
          {r.running ? (
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: 99,
                border: `2px solid ${C.iceDeep}`,
                borderTopColor: C.blue,
                flex: "none",
              }}
            />
          ) : (
            <span style={{ width: 6, height: 6, borderRadius: 9, background: C.line, flex: "none", margin: "0 3px" }} />
          )}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</span>
        </div>
      ))}
      <div style={{ flex: 1 }} />
      <Row icon="settings" label="设置" />
    </div>
  );
};

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 12, color: C.muted, padding: "16px 10px 6px", fontWeight: 560 }}>{children}</div>
);

const Row: React.FC<{ icon: string; label: string; active?: boolean; strong?: boolean; kbd?: string }> = ({
  icon,
  label,
  active,
  strong,
  kbd,
}) => (
  <div
    style={{
      height: 32,
      borderRadius: 8,
      padding: "0 10px",
      display: "flex",
      alignItems: "center",
      gap: 10,
      background: active ? "#fff" : "transparent",
      boxShadow: active ? "0 1px 3px rgba(11,27,58,0.08)" : undefined,
      color: active ? C.blueDeep : C.text,
      fontWeight: strong || active ? 600 : 450,
    }}
  >
    <Icon name={icon} size={16} color={active ? C.blue : C.sub} />
    <span style={{ flex: 1 }}>{label}</span>
    {kbd && <span style={{ fontSize: 11, color: C.muted }}>{kbd}</span>}
  </div>
);

export const AppWindow: React.FC<{
  children: React.ReactNode;
  sidebar?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, sidebar, style }) => (
  <div
    style={{
      width: WIN_W,
      height: WIN_H,
      borderRadius: 16,
      background: "#fff",
      overflow: "hidden",
      boxShadow:
        "0 50px 120px -30px rgba(23,71,201,0.35), 0 20px 40px -20px rgba(11,27,58,0.25), 0 0 0 1px rgba(11,27,58,0.06)",
      display: "flex",
      flexDirection: "column",
      fontFamily: FONT,
      ...style,
    }}
  >
    <div
      style={{
        height: 38,
        flex: "none",
        background: C.chrome,
        borderBottom: `1px solid ${C.line}`,
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 14,
        fontSize: 12.5,
        color: C.sub,
      }}
    >
      <Logo size={20} />
      <span style={{ fontWeight: 700, color: C.ink, fontSize: 13 }}>Agent_US</span>
      {["文件", "编辑", "视图", "帮助"].map((m) => (
        <span key={m}>{m}</span>
      ))}
      <div style={{ flex: 1 }} />
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 10px",
          borderRadius: 999,
          background: C.greenSoft,
          color: C.green,
          fontWeight: 600,
          fontSize: 11.5,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 9, background: C.green }} />
        后端在线 · 127.0.0.1:8787
      </span>
      <span style={{ letterSpacing: 18, color: C.muted, fontSize: 14 }}>— ▢ ✕</span>
    </div>
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      {sidebar ?? <Sidebar />}
      <div style={{ flex: 1, position: "relative", minWidth: 0, overflow: "hidden" }}>{children}</div>
    </div>
  </div>
);
