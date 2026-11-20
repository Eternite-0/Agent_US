import React from "react";
import { AbsoluteFill, Img, useCurrentFrame } from "remotion";
import { MONO, PAL, p, rise } from "../theme";
import { BlueText, BrandLogo, GlassSheen, TitleBlock, asset } from "../components";

const PLUGINS_A = [
  { name: "GitHub", file: "plugins/github.png" },
  { name: "Figma", file: "plugins/figma.png" },
  { name: "Linear", file: "plugins/linear.png" },
  { name: "Notion", file: "plugins/notion.png" },
  { name: "Sentry", file: "plugins/sentry.png" },
  { name: "Playwright", file: "plugins/playwright.svg" },
  { name: "Stripe", file: "plugins/stripe.png" },
  { name: "Slack", file: "plugins/slack.png" },
  { name: "Remotion", file: "plugins/remotion.png" },
  { name: "CircleCI", file: "plugins/circleci.png" },
];

const PLUGINS_B = [
  { name: "PostHog", file: "plugins/posthog.png" },
  { name: "Google Drive", file: "plugins/google-drive.png" },
  { name: "Canva", file: "plugins/canva.png" },
  { name: "Atlassian", file: "plugins/atlassian-rovo.png" },
  { name: "LaTeX", file: "plugins/latex.svg" },
  { name: "Zotero", file: "plugins/zotero.png" },
  { name: "Mixpanel", file: "plugins/mixpanel.png" },
  { name: "Dropbox", file: "plugins/dropbox.png" },
  { name: "Gmail", file: "plugins/gmail.png" },
  { name: "Adobe", file: "plugins/adobe.svg" },
];

const LAYERS = [
  { id: "L6", name: "桌面与流式交互", tags: ["Electron 原生壳", "SSE 游标断线重放", "双栏 Diff 工作台"] },
  { id: "L5", name: "拓扑路由控制面", tags: ["DAG 自动拆解", "多维能力评分路由", "受影响子图局部自愈"], core: true },
  { id: "L4", name: "零信任微内核契约", tags: ["6 大可插拔契约面", "T0 防幻觉门禁", "三分集防泄漏评测"], core: true },
  { id: "L3", name: "纵深防御沙箱层", tags: ["7 级执行门", "Docker 零网只读容器", "WeakMap 一次性令牌"] },
  { id: "L2", name: "高可用异构资源层", tags: ["双路网关 0.35s 秒切", "MCP Stdio 热挂载", "定时签到与巡检"] },
  { id: "L1", name: "事务与密码学底座", tags: ["SQLite WAL + Outbox", "15s Fencing 租约锁", "JCS-SHA256 哈希链"] },
];

const ITEM_W = 196;
const GAP = 16;
const STRIDE = PLUGINS_A.length * (ITEM_W + GAP);

const PluginRibbon: React.FC<{ items: typeof PLUGINS_A; y: number; speed: number; f: number }> = ({
  items,
  y,
  speed,
  f,
}) => {
  const raw = (f * speed) % STRIDE;
  const offset = raw < 0 ? raw + STRIDE : raw;
  const tripled = [...items, ...items, ...items];
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: y,
        height: 62,
        overflow: "hidden",
        opacity: p(f, 14, 24),
        maskImage: "linear-gradient(90deg, transparent 0%, #000 8%, #000 92%, transparent 100%)",
        WebkitMaskImage: "linear-gradient(90deg, transparent 0%, #000 8%, #000 92%, transparent 100%)",
      }}
    >
      <div style={{ display: "flex", gap: GAP, transform: `translate3d(${-offset}px, 0, 0)` }}>
        {tripled.map((pl, idx) => (
          <div
            key={`${pl.name}-${idx}`}
            style={{
              width: ITEM_W,
              height: 56,
              flex: "none",
              borderRadius: 15,
              background: "rgba(255,255,255,0.94)",
              border: `1px solid ${PAL.line}`,
              boxShadow: "0 10px 22px -16px rgba(9,23,48,0.22)",
              padding: "0 14px",
              display: "flex",
              alignItems: "center",
              gap: 11,
            }}
          >
            <BrandLogo file={pl.file} size={34} pad={5} radius={9} shadow={false} />
            <span style={{ fontSize: 15.5, fontWeight: 750, color: PAL.ink, whiteSpace: "nowrap" }}>{pl.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export const S8EcoAndArch: React.FC = () => {
  const f = useCurrentFrame();
  const dy = Math.sin(f / 28) * 6;
  const scanIdx = f > 110 ? Math.floor(((f - 110) / 42) % LAYERS.length) : -1;

  return (
    <AbsoluteFill>
      <TitleBlock
        kicker="全栈自研架构 × 开放工具生态"
        title={
          <>
            六层解耦微内核，<BlueText>连通 44+ 工程工具生态</BlueText>
          </>
        }
        at={4}
        y={34}
        size={48}
      />

      {/* Top Marquee Ribbons of 44+ Real Plugin Logos */}
      <PluginRibbon items={PLUGINS_A} y={168} speed={1.65} f={f} />
      <PluginRibbon items={PLUGINS_B} y={238} speed={-1.45} f={f} />

      {/* Bottom Left: 3D 6-Layer Glass Stack Card */}
      <div
        style={{
          ...rise(f, 26, 28, 32),
          position: "absolute",
          left: 84,
          top: 324,
          width: 640,
          height: 690,
          borderRadius: 28,
          background: "#FFFFFF",
          border: `1.5px solid ${PAL.line}`,
          boxShadow: "0 30px 68px -36px rgba(22,66,190,0.32)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "24px 26px",
          overflow: "hidden",
        }}
      >
        <GlassSheen start={60} dur={52} />
        <Img
          src={asset("visuals/arch-3d.jpg")}
          style={{
            width: "92%",
            height: "78%",
            objectFit: "contain",
            transform: `translate3d(0, ${dy}px, 0)`,
          }}
        />
        <div
          style={{
            width: "100%",
            padding: "14px 18px",
            borderRadius: 16,
            background: PAL.ice,
            border: `1px solid ${PAL.iceDeep}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <BrandLogo file="logos/mcp.png" size={34} pad={5} radius={9} shadow={false} />
            <div>
              <div style={{ fontSize: 15.5, fontWeight: 820, color: PAL.blueDeep }}>42,000+ 行全栈自研代码</div>
              <div style={{ fontSize: 12.5, color: PAL.sub }}>MCP 协议热挂载 · 15+ 原生工具 · 20 套回归测试集</div>
            </div>
          </div>
          <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 850, color: PAL.blue }}>100% 本地</span>
        </div>
      </div>

      {/* Bottom Right: 6 Illuminated Self-Developed Layers */}
      <div
        style={{
          position: "absolute",
          left: 752,
          top: 324,
          right: 84,
          height: 690,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        {LAYERS.map((layer, i) => {
          const at = 36 + i * 14;
          const pr = p(f, at, 26);
          const lit = scanIdx === i || (scanIdx === -1 && layer.core && f > 70);
          return (
            <div
              key={layer.id}
              style={{
                height: 104,
                borderRadius: 20,
                padding: "0 24px",
                background: lit
                  ? `linear-gradient(100deg, ${PAL.ice} 0%, #FFFFFF 100%)`
                  : "rgba(255,255,255,0.95)",
                border: `1.6px solid ${lit ? PAL.blueMid : PAL.line}`,
                boxShadow: lit
                  ? "0 20px 44px -24px rgba(37,99,235,0.45)"
                  : "0 14px 32px -26px rgba(9,23,48,0.22)",
                display: "flex",
                alignItems: "center",
                gap: 18,
                opacity: pr,
                transform: `translate3d(${(1 - pr) * 56}px, 0, 0)`,
              }}
            >
              <span
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 13,
                  background: layer.core || lit ? `linear-gradient(135deg, ${PAL.blueMid}, ${PAL.blueDeep})` : PAL.ice,
                  color: layer.core || lit ? "#FFFFFF" : PAL.blue,
                  display: "grid",
                  placeItems: "center",
                  fontFamily: MONO,
                  fontSize: 16.5,
                  fontWeight: 850,
                  flex: "none",
                }}
              >
                {layer.id}
              </span>
              <div style={{ width: 196, fontSize: 21, fontWeight: 820, color: PAL.ink }}>{layer.name}</div>
              <div style={{ display: "flex", gap: 10, flex: 1 }}>
                {layer.tags.map((tag, k) => (
                  <span
                    key={tag}
                    style={{
                      opacity: p(f, at + 8 + k * 5, 18),
                      padding: "8px 13px",
                      borderRadius: 10,
                      background: PAL.chrome,
                      border: `1px solid ${PAL.lineSoft}`,
                      fontSize: 15,
                      fontWeight: 650,
                      color: PAL.text,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
