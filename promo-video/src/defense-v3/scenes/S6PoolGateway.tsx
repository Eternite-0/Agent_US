import React from "react";
import { AbsoluteFill, Img, useCurrentFrame } from "remotion";
import { MONO, PAL, mix, p, rise } from "../theme";
import { BlueText, BrandEmblem, BrandLogo, GlassSheen, TitleBlock, asset } from "../components";

const POOL_MODELS = [
  { name: "gpt-5.2", vendor: "OpenAI", logo: "logos/openai.png", ctx: 400, caps: ["推理", "视觉", "工具"], alias: "coder" },
  { name: "claude-sonnet-4.5", vendor: "Anthropic", logo: "logos/claude.png", ctx: 200, caps: ["推理", "视觉", "缓存"], alias: "reviewer" },
  { name: "gemini-2.5-pro", vendor: "Google", logo: "logos/gemini.png", ctx: 1000, caps: ["1M 长窗", "视觉"], alias: "vision" },
  { name: "deepseek-reasoner", vendor: "DeepSeek", logo: "logos/deepseek.png", ctx: 128, caps: ["深度思考", "低成本"], alias: "planner" },
  { name: "qwen3-coder-plus", vendor: "Qwen", logo: "logos/qwen.png", ctx: 256, caps: ["高速编码", "工具"], alias: "worker" },
  { name: "kimi-k2", vendor: "Moonshot", logo: "logos/kimi.png", ctx: 256, caps: ["长文", "压测"], alias: "tester" },
];

const NODES = [
  { x: 1170, name: "OpenAI 主力 #1", logo: "logos/openai.png", sub: "顺位 P1 · $128.4" },
  { x: 1455, name: "OpenAI 热备 #2", logo: "logos/openai.png", sub: "顺位 P2 · $264.8" },
  { x: 1740, name: "Anthropic 企业池", logo: "logos/claude.png", sub: "异构热备 · $186.2" },
];
const HUB = { x: 1455, y: 392 };
const ROW_Y = 674;

export const S6PoolGateway: React.FC = () => {
  const f = useCurrentFrame();
  const syncing = f >= 80 && f < 118;

  const req1 = p(f, 285, 42);
  const hit429 = f >= 330;
  const req2 = p(f, 368, 40);
  const recovered = f >= 410;

  const pk1x = mix(req1, HUB.x, NODES[0].x);
  const pk1y = mix(req1, HUB.y + 56, ROW_Y - 64);
  const pk2x = mix(req2, HUB.x, NODES[1].x);
  const pk2y = mix(req2, HUB.y + 56, ROW_Y - 64);

  return (
    <AbsoluteFill>
      <TitleBlock
        kicker="打破单一厂商锁定 · 双路高可用网关"
        title={
          <>
            多维能力评分路由 × <BlueText>0.35s 无感容灾</BlueText>
          </>
        }
        sub="突破 Claude Code / Codex 单一生态配额瓶颈：按子代理角色动态分配异构模型，综合算力成本节省 52%"
        at={4}
        align="left"
        x={92}
        y={48}
        width={1740}
        size={50}
      />

      {/* LEFT CARD */}
      <div
        style={{
          ...rise(f, 20, 28, 36),
          position: "absolute",
          left: 92,
          top: 262,
          width: 908,
          borderRadius: 26,
          background: "rgba(255,255,255,0.96)",
          border: `1.5px solid ${PAL.line}`,
          boxShadow: "0 36px 76px -40px rgba(22,66,190,0.34)",
          overflow: "hidden",
        }}
      >
        <GlassSheen start={45} dur={50} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "18px 24px",
            borderBottom: `1px solid ${PAL.lineSoft}`,
          }}
        >
          <BrandEmblem size={34} style={{ borderRadius: 9, boxShadow: "none" }} />
          <div>
            <div style={{ fontSize: 21, fontWeight: 820, color: PAL.ink }}>异构号池与能力元数据中心</div>
            <div style={{ fontSize: 13.5, color: PAL.sub }}>
              {f >= 118 ? "双协议统一代理 · 自动同步真实上下文窗口与视觉/推理能力" : "本地聚合网关 + 原生直连双通路热备"}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <span
            style={{
              padding: "9px 18px",
              borderRadius: 12,
              background: `linear-gradient(135deg, ${PAL.blueMid}, ${PAL.blueDeep})`,
              color: "#FFFFFF",
              fontSize: 15,
              fontWeight: 750,
              boxShadow: "0 10px 22px -10px rgba(37,99,235,0.68)",
            }}
          >
            {syncing ? "⟳ 同步元数据中…" : "⚡ 热同步 8+ 模型"}
          </span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.75fr 0.75fr 1.4fr 0.9fr",
            padding: "10px 24px",
            background: PAL.chrome,
            fontSize: 13.5,
            fontWeight: 720,
            color: PAL.muted,
          }}
        >
          <span>上游模型 · 厂商</span>
          <span>上下文</span>
          <span>能力画像</span>
          <span>最优角色路由</span>
        </div>

        {POOL_MODELS.map((m, i) => {
          const at = 118 + i * 12;
          const a = p(f, at, 20);
          const ctxVal = Math.round(mix(p(f, at, 36), 0, m.ctx));
          return (
            <div
              key={m.name}
              style={{
                display: "grid",
                gridTemplateColumns: "1.75fr 0.75fr 1.4fr 0.9fr",
                alignItems: "center",
                padding: "0 24px",
                height: 62,
                borderTop: `1px solid ${PAL.lineSoft}`,
                opacity: a,
                transform: `translate3d(0, ${(1 - a) * 14}px, 0)`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <BrandLogo file={m.logo} size={36} pad={6} radius={10} shadow={false} />
                <div>
                  <div style={{ fontFamily: MONO, fontSize: 15.5, fontWeight: 760, color: PAL.ink }}>{m.name}</div>
                  <div style={{ fontSize: 12, color: PAL.muted }}>{m.vendor}</div>
                </div>
              </div>
              <span style={{ fontFamily: MONO, fontSize: 16, fontWeight: 780, color: PAL.blueDeep }}>
                {ctxVal >= 1000 ? "1M" : `${ctxVal}K`}
              </span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {m.caps.map((c) => (
                  <span
                    key={c}
                    style={{
                      padding: "3px 9px",
                      borderRadius: 7,
                      background: PAL.ice,
                      color: PAL.blueDeep,
                      fontSize: 12.5,
                      fontWeight: 700,
                    }}
                  >
                    {c}
                  </span>
                ))}
              </div>
              <div>
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 13.5,
                    fontWeight: 780,
                    padding: "4px 11px",
                    borderRadius: 99,
                    background: PAL.greenBg,
                    color: PAL.green,
                  }}
                >
                  @{m.alias}
                </span>
              </div>
            </div>
          );
        })}

        <div
          style={{
            ...rise(f, 440, 24, 14),
            padding: "16px 24px",
            background: `linear-gradient(95deg, ${PAL.chrome}, #FFFFFF)`,
            borderTop: `1px solid ${PAL.line}`,
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}
        >
          <div
            style={{
              flex: 1,
              padding: "11px 16px",
              borderRadius: 14,
              background: "#FFFFFF",
              border: `1px solid ${PAL.greenBorder}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: PAL.ink }}>自动签到中心 · 持续续航</div>
              <div style={{ fontSize: 12.5, color: PAL.sub, marginTop: 2 }}>协议桥接 + 本地插件双模定时补签</div>
            </div>
            <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 800, color: PAL.green }}>
              5/5 已签 · 34天
            </span>
          </div>
          <div
            style={{
              flex: 1,
              padding: "11px 16px",
              borderRadius: 14,
              background: "#FFFFFF",
              border: `1px solid ${PAL.iceDeep}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: PAL.ink }}>Cron 无人值守巡检</div>
              <div style={{ fontSize: 12.5, color: PAL.sub, marginTop: 2 }}>每日安全回归 & 号池健康探测</div>
            </div>
            <span style={{ fontSize: 13.5, fontWeight: 800, color: PAL.blue }}>● 99.4% 在线</span>
          </div>
        </div>
      </div>

      {/* RIGHT STAGE: Failover Visualizer */}
      <div style={{ position: "absolute", inset: 0, opacity: p(f, 185, 28), pointerEvents: "none" }}>
        <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
          {NODES.map((n, i) => {
            const isBad = i === 0 && hit429;
            const isGood = i === 1 && recovered;
            return (
              <path
                key={n.name}
                d={`M ${HUB.x} ${HUB.y + 58} C ${HUB.x} ${HUB.y + 130}, ${n.x} ${ROW_Y - 130}, ${n.x} ${ROW_Y - 64}`}
                fill="none"
                stroke={isBad ? PAL.amber : isGood ? PAL.blue : PAL.iceDeep}
                strokeWidth={isGood ? 4.5 : 3}
                strokeDasharray={isBad ? "8 8" : undefined}
              />
            );
          })}

          {recovered &&
            Array.from({ length: 5 }).map((_, k) => {
              const t = (((f - 410) / 44 + k / 5) % 1 + 1) % 1;
              return (
                <circle
                  key={k}
                  cx={mix(t, NODES[1].x, HUB.x)}
                  cy={mix(t, ROW_Y - 64, HUB.y + 58)}
                  r={7}
                  fill={PAL.blue}
                  opacity={Math.sin(t * Math.PI)}
                />
              );
            })}

          {f >= 285 && f < 334 && <circle cx={pk1x} cy={pk1y} r={9} fill={PAL.blueMid} />}
          {f >= 368 && f < 412 && <circle cx={pk2x} cy={pk2y} r={9} fill={PAL.blueMid} />}
        </svg>

        <div
          style={{
            position: "absolute",
            left: HUB.x - 200,
            top: HUB.y - 62,
            width: 400,
            height: 124,
            borderRadius: 28,
            background: `linear-gradient(135deg, ${PAL.blueMid} 0%, ${PAL.blueDeep} 100%)`,
            boxShadow: "0 30px 56px -22px rgba(22,66,190,0.68)",
            display: "flex",
            alignItems: "center",
            padding: "0 24px",
            gap: 18,
            color: "#FFFFFF",
          }}
        >
          <BrandEmblem size={68} style={{ borderRadius: 18, boxShadow: "none" }} />
          <div>
            <div style={{ fontSize: 24, fontWeight: 820 }}>双路高可用号池网关</div>
            <div style={{ fontSize: 14.5, opacity: 0.9, marginTop: 4 }}>AES-256-GCM 内存密封密钥库 · 零明文落盘</div>
          </div>
        </div>

        {NODES.map((n, i) => {
          const bad = i === 0 && hit429;
          const good = i === 1 && recovered;
          const s = p(f, 205 + i * 10, 22);
          return (
            <div
              key={n.name}
              style={{
                position: "absolute",
                left: n.x - 130,
                top: ROW_Y - 64,
                width: 260,
                height: 156,
                borderRadius: 24,
                background: "#FFFFFF",
                border: `2px solid ${bad ? PAL.amber : good ? PAL.blue : PAL.line}`,
                boxShadow: good
                  ? "0 0 0 9px rgba(37,99,235,0.12), 0 24px 46px -24px rgba(22,66,190,0.52)"
                  : "0 20px 40px -28px rgba(9,23,48,0.32)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "14px 12px",
                opacity: s,
                transform: `scale(${0.88 + s * 0.12})`,
              }}
            >
              <BrandLogo file={n.logo} size={46} pad={8} radius={13} shadow={false} />
              <div style={{ fontSize: 18.5, fontWeight: 800, color: PAL.ink, marginTop: 10 }}>{n.name}</div>
              <div style={{ fontSize: 13.5, color: PAL.sub, marginTop: 2 }}>{n.sub}</div>
              <div
                style={{
                  marginTop: 9,
                  fontFamily: MONO,
                  fontSize: 13,
                  fontWeight: 800,
                  padding: "4px 12px",
                  borderRadius: 99,
                  background: bad ? PAL.amberBg : good ? PAL.greenBg : PAL.chrome,
                  color: bad ? PAL.amber : good ? PAL.green : PAL.muted,
                }}
              >
                {bad
                  ? `HTTP 429 · 冷却 ${Math.max(1, 42 - Math.floor((f - 330) / 14))}s`
                  : good
                    ? "0.35s 瞬切 · 流式接管"
                    : "热备待命"}
              </div>
            </div>
          );
        })}

        <div
          style={{
            ...rise(f, 425, 24, 16),
            position: "absolute",
            left: 1065,
            top: 814,
            width: 780,
            padding: "18px 24px",
            borderRadius: 20,
            background: "rgba(255,255,255,0.96)",
            border: `1.5px solid ${PAL.iceDeep}`,
            boxShadow: "0 20px 44px -22px rgba(22,66,190,0.38)",
            display: "flex",
            alignItems: "center",
            gap: 18,
          }}
        >
          <div
            style={{
              width: 58,
              height: 58,
              borderRadius: 16,
              overflow: "hidden",
              border: `1px solid ${PAL.line}`,
              flex: "none",
              background: "#fff",
            }}
          >
            <Img src={asset("visuals/sandbox-3d.jpg")} style={{ width: "115%", height: "115%", objectFit: "cover" }} />
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 820, color: PAL.blueDeep }}>
              ⚡ 0.35 秒跨账号/跨厂商热备切换 · 限流压测存活率达 96.4%
            </div>
            <div style={{ fontSize: 16, color: PAL.sub, marginTop: 4 }}>
              避免旗舰模型全量消耗，按子代理角色分级调度，综合 Token 成本直降 52%
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
