import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { PAL, p, rise, spr } from "../theme";
import { BlueText, BrandEmblem, BrandLogo, TitleBlock } from "../components";

const ROW1 = [
  { name: "GitHub", sub: "代码仓 · PR", file: "plugins/github.png" },
  { name: "Figma", sub: "设计稿转组件", file: "plugins/figma.png" },
  { name: "Linear", sub: "需求与缺陷追踪", file: "plugins/linear.png" },
  { name: "Notion", sub: "知识库与文档", file: "plugins/notion.png" },
  { name: "Sentry", sub: "错误定位归因", file: "plugins/sentry.png" },
  { name: "Playwright", sub: "无头浏览器回归", file: "plugins/playwright.svg" },
  { name: "Stripe", sub: "支付与账单", file: "plugins/stripe.png" },
  { name: "Slack", sub: "团队协同推送", file: "plugins/slack.png" },
];

const ROW2 = [
  { name: "Remotion", sub: "程序化视频引擎", file: "plugins/remotion.png" },
  { name: "CircleCI", sub: "CI/CD 流水线", file: "plugins/circleci.png" },
  { name: "PostHog", sub: "产品埋点分析", file: "plugins/posthog.png" },
  { name: "Google Drive", sub: "云端资料检索", file: "plugins/google-drive.png" },
  { name: "Canva", sub: "视觉物料生成", file: "plugins/canva.png" },
  { name: "Atlassian", sub: "企业级研发协同", file: "plugins/atlassian-rovo.png" },
  { name: "LaTeX", sub: "论文公式排版", file: "plugins/latex.svg" },
  { name: "Zotero", sub: "文献引用管理", file: "plugins/zotero.png" },
];

const ROW3 = [
  { name: "Mixpanel", sub: "指标漏斗分析", file: "plugins/mixpanel.png" },
  { name: "Dropbox", sub: "文件同步存取", file: "plugins/dropbox.png" },
  { name: "Gmail", sub: "自动化邮件流", file: "plugins/gmail.png" },
  { name: "Monday", sub: "项目甘特排期", file: "plugins/monday.png" },
  { name: "Adobe", sub: "创意工作流", file: "plugins/adobe.svg" },
  { name: "Build iOS", sub: "原生应用构建", file: "plugins/build-ios.png" },
  { name: "HeyGen", sub: "数字人与演示", file: "plugins/heygen.png" },
  { name: "Kling AI", sub: "多模态生成", file: "plugins/kling-ai.png" },
];

const CARD_W = 266;
const CARD_GAP = 22;
const STRIDE = ROW1.length * (CARD_W + CARD_GAP);

const MarqueeRow: React.FC<{
  items: typeof ROW1;
  y: number;
  speed: number;
  f: number;
  appear: number;
}> = ({ items, y, speed, f, appear }) => {
  const op = p(f, appear, 28);
  const raw = (f * speed) % STRIDE;
  const offset = raw < 0 ? raw + STRIDE : raw;
  const doubled = [...items, ...items, ...items];
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: y,
        height: 92,
        overflow: "hidden",
        opacity: op,
        maskImage: "linear-gradient(90deg, transparent 0%, #000 10%, #000 90%, transparent 100%)",
        WebkitMaskImage: "linear-gradient(90deg, transparent 0%, #000 10%, #000 90%, transparent 100%)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: CARD_GAP,
          transform: `translateX(${-offset}px)`,
          willChange: "transform",
        }}
      >
        {doubled.map((item, idx) => (
          <div
            key={`${item.name}-${idx}`}
            style={{
              width: CARD_W,
              height: 82,
              flex: "none",
              borderRadius: 20,
              background: "rgba(255,255,255,0.92)",
              border: `1px solid ${PAL.line}`,
              boxShadow: "0 14px 30px -20px rgba(10,25,53,0.22)",
              padding: "0 16px",
              display: "flex",
              alignItems: "center",
              gap: 14,
            }}
          >
            <BrandLogo file={item.file} size={48} pad={8} radius={13} shadow={false} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 18, fontWeight: 780, color: PAL.ink, whiteSpace: "nowrap" }}>{item.name}</div>
              <div style={{ fontSize: 13.5, color: PAL.sub, marginTop: 2, whiteSpace: "nowrap" }}>{item.sub}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const PILLARS = [
  { tag: "MCP Hub", title: "Stdio 协议工具热挂载", sub: "零重启动态接入外部服务" },
  { tag: "Skills", title: "专业领域技能体系", sub: "数学建模 · 架构制图 · 安全审计" },
  { tag: "Memory", title: "跨会话持久记忆中心", sub: "全局 / 工作区 / 会话三级作用域" },
  { tag: "Git", title: "分支与差异原生集成", sub: "一键检出、提交与冲突隔离" },
];

export const S6Ecosystem: React.FC = () => {
  const f = useCurrentFrame();
  const coreS = spr(f, 36, 14, 120);

  return (
    <AbsoluteFill>
      <TitleBlock
        kicker="开放生态 · 无限延展"
        title={
          <>
            一个智能体内核，<BlueText>连通整个工程生态</BlueText>
          </>
        }
        sub="内置 40+ 主流开发、设计与协作插件生态，原生支持 MCP 标准协议即插即用"
        at={4}
        y={52}
        size={52}
      />

      {/* 3 Counter-Scrolling Real Plugin Logo Marquee Tracks */}
      <MarqueeRow items={ROW1} y={288} speed={1.55} f={f} appear={20} />
      <MarqueeRow items={ROW2} y={404} speed={-1.35} f={f} appear={34} />
      <MarqueeRow items={ROW3} y={520} speed={1.65} f={f} appear={48} />

      {/* Central Luminous Core Overlay: Agent_US × MCP Hub */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 446,
          transform: `translate(-50%, -50%) scale(${coreS})`,
          opacity: Math.min(1, coreS * 1.5),
          zIndex: 30,
        }}
      >
        <div
          style={{
            padding: "26px 38px",
            borderRadius: 34,
            background: "rgba(255,255,255,0.96)",
            border: `2px solid ${PAL.iceDeep}`,
            boxShadow:
              "0 36px 86px -22px rgba(23,69,196,0.48), 0 0 0 12px rgba(37,99,235,0.08)",
            display: "flex",
            alignItems: "center",
            gap: 24,
          }}
        >
          <BrandEmblem size={88} float />
          <div style={{ fontSize: 32, fontWeight: 300, color: PAL.muted }}>×</div>
          <BrandLogo file="logos/mcp.png" size={82} pad={14} radius={22} />
          <div style={{ paddingLeft: 6 }}>
            <div style={{ fontSize: 30, fontWeight: 850, color: PAL.ink, letterSpacing: -0.5 }}>
              Agent_<BlueText>US</BlueText> 生态枢纽
            </div>
            <div style={{ fontSize: 17, color: PAL.sub, marginTop: 6, fontWeight: 600 }}>
              44+ 开箱插件 · MCP 标准协议 · AGENTS.md 规范
            </div>
          </div>
        </div>
      </div>

      {/* Bottom 4 Ecosystem Pillars */}
      <div
        style={{
          position: "absolute",
          top: 668,
          left: 108,
          right: 108,
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 24,
        }}
      >
        {PILLARS.map((pl, i) => (
          <div
            key={pl.tag}
            style={{
              ...rise(f, 92 + i * 12, 28, 28),
              padding: "26px 26px 28px",
              borderRadius: 24,
              background: "rgba(255,255,255,0.94)",
              border: `1.5px solid ${PAL.line}`,
              boxShadow: "0 24px 50px -34px rgba(23,69,196,0.36)",
            }}
          >
            <span
              style={{
                display: "inline-block",
                padding: "5px 12px",
                borderRadius: 9,
                background: PAL.ice,
                color: PAL.blue,
                fontSize: 14,
                fontWeight: 800,
              }}
            >
              {pl.tag}
            </span>
            <div style={{ fontSize: 22, fontWeight: 800, color: PAL.ink, marginTop: 14 }}>{pl.title}</div>
            <div style={{ fontSize: 16, color: PAL.sub, marginTop: 8, lineHeight: 1.5 }}>{pl.sub}</div>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
