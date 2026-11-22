import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  IconCheck,
  IconChevronDown,
  IconClose,
  IconPlus,
  IconPuzzle,
  IconRefresh,
  IconSearch,
  IconSettingsGear,
  IconSkillsNode,
} from './Icons';

export type PluginCategoryId =
  | 'Communication'
  | 'Creativity'
  | 'Data & Analytics'
  | 'Developer Tools'
  | 'Education & Research'
  | 'Finance'
  | 'Productivity'
  | 'Scientific Research'
  | 'Security';

export const PLUGIN_CATEGORY_ORDER: PluginCategoryId[] = [
  'Communication',
  'Creativity',
  'Data & Analytics',
  'Developer Tools',
  'Education & Research',
  'Finance',
  'Productivity',
  'Scientific Research',
  'Security',
];

export interface MarketplacePlugin {
  id: string;
  slug?: string;
  catalogId?: string;
  name: string;
  version?: string;
  category: PluginCategoryId;
  description: string;
  longDescription?: string;
  author: string;
  transport:
    | 'MCP · HTTP'
    | 'MCP · Stdio'
    | 'OAuth 2.0'
    | 'GitHub · Open Source'
    | 'Built-in · Skills';
  endpoint: string;
  websiteUrl?: string;
  repositoryUrl?: string;
  githubSkillSpec?: { repo: string; branch?: string; path: string };
  brandColor?: string;
  logoUrl?: string;
  logoUrlDark?: string;
  tools: string[];
  bundledSkills?: string[];
  defaultPrompts?: string[];
  tileBg: string;
  tileFg: string;
  custom?: boolean;
}

export interface MarketplaceSkill {
  id: string;
  slug?: string;
  name: string;
  scope: 'personal' | 'system' | 'recommended';
  description: string;
  instructions: string;
  githubSkillSpec?: { repo: string; branch?: string; path: string };
  hue: [string, string, string];
  installed: boolean;
  custom?: boolean;
}

export interface LocalCatalogSourceInfo {
  available: boolean;
  channelName?: string;
  totalCatalogPlugins: number;
  upstreamSkillsRepo?: string;
  localSkillsCount: number;
  extensionsDir?: string;
}

export const INITIAL_PLUGINS: MarketplacePlugin[] = [
  // Communication
  {
    id: 'slack',
    name: 'Slack',
    category: 'Communication',
    description: 'Read and manage Slack',
    author: 'Slack Official',
    transport: 'OAuth 2.0',
    endpoint: 'https://mcp.slack.com/sse',
    tools: ['slack_search_messages', 'slack_post_message', 'slack_list_channels', 'slack_read_thread'],
    tileBg: '#1c1c20',
    tileFg: '#ffffff',
  },

  // Creativity
  {
    id: 'remotion',
    name: 'Remotion',
    category: 'Creativity',
    description: 'Make videos agentically',
    author: 'Remotion',
    transport: 'MCP · Stdio',
    endpoint: 'npx -y @remotion/mcp@latest',
    tools: ['remotion_create_comp', 'remotion_render_mp4', 'remotion_preview_frame'],
    tileBg: '#111114',
    tileFg: '#ffffff',
  },
  {
    id: 'hyperframes',
    name: 'HyperFrames by HeyGen',
    category: 'Creativity',
    description: 'Write HTML, render video',
    author: 'HeyGen',
    transport: 'MCP · HTTP',
    endpoint: 'https://mcp.heygen.com/hyperframes',
    tools: ['hyperframes_render', 'hyperframes_preview', 'hyperframes_export'],
    tileBg: '#0b2220',
    tileFg: '#2dd4bf',
  },
  {
    id: 'figma',
    name: 'Figma',
    category: 'Creativity',
    description: 'Figma design-to-code workflows',
    author: 'Figma Partner',
    transport: 'MCP · HTTP',
    endpoint: 'https://mcp.figma.com/mcp',
    tools: ['figma_get_file', 'figma_get_node_styles', 'figma_export_assets', 'figma_code_connect'],
    tileBg: '#1a1a1f',
    tileFg: '#ffffff',
  },
  {
    id: 'canva',
    name: 'Canva',
    category: 'Creativity',
    description: 'Create, review, edit designs',
    author: 'Canva Partner',
    transport: 'OAuth 2.0',
    endpoint: 'https://mcp.canva.com/mcp',
    tools: ['canva_create_design', 'canva_resize', 'canva_export_png', 'canva_brand_check'],
    tileBg: 'linear-gradient(135deg, #00c4cc 0%, #7d2ae8 100%)',
    tileFg: '#ffffff',
  },
  {
    id: 'product-design',
    name: 'Product Design',
    category: 'Creativity',
    description: 'Explore and prototype ideas',
    author: 'Codex Creative',
    transport: 'MCP · HTTP',
    endpoint: 'https://plugins.codex.local/product-design',
    tools: ['design_wireframe', 'design_critique', 'design_system_tokens'],
    tileBg: 'linear-gradient(135deg, #a855f7 0%, #ec4899 100%)',
    tileFg: '#ffffff',
  },
  {
    id: 'higgsfield',
    name: 'Higgsfield',
    category: 'Creativity',
    description: 'Every image and video model',
    author: 'Higgsfield AI',
    transport: 'MCP · HTTP',
    endpoint: 'https://mcp.higgsfield.ai/sse',
    tools: ['higgsfield_generate_image', 'higgsfield_generate_video', 'higgsfield_upscale'],
    tileBg: '#d9f99d',
    tileFg: '#141416',
  },

  // Data & Analytics
  {
    id: 'mixpanel',
    name: 'Mixpanel Headless',
    category: 'Data & Analytics',
    description: 'Analyze Mixpanel data with Python',
    author: 'Mixpanel',
    transport: 'MCP · HTTP',
    endpoint: 'https://mcp.mixpanel.com/headless',
    tools: ['mixpanel_query_events', 'mixpanel_funnel', 'mixpanel_retention'],
    tileBg: '#ffffff',
    tileFg: '#4f46e5',
  },
  {
    id: 'posthog',
    name: 'PostHog',
    category: 'Data & Analytics',
    description: 'Analyze your product data',
    author: 'PostHog',
    transport: 'MCP · HTTP',
    endpoint: 'https://mcp.posthog.com/sse',
    tools: ['posthog_query_hogql', 'posthog_feature_flags', 'posthog_insights'],
    tileBg: '#f8fafc',
    tileFg: '#1d4ed8',
  },

  // Developer Tools
  {
    id: 'game-studio',
    name: 'Game Studio',
    category: 'Developer Tools',
    description: 'Design, prototype, and ship browser games',
    author: 'Codex Labs',
    transport: 'MCP · Stdio',
    endpoint: 'npx -y @codex/plugin-game-studio',
    tools: ['game_scaffold_canvas', 'game_asset_pack', 'game_playtest'],
    tileBg: '#f4f4f5',
    tileFg: '#18181b',
  },
  {
    id: 'superpowers',
    name: 'Superpowers',
    category: 'Developer Tools',
    description: 'Plan, develop, and debug code',
    author: 'Superpowers',
    transport: 'MCP · Stdio',
    endpoint: 'npx -y @superpowers/mcp',
    tools: ['sp_plan_spec', 'sp_subagent_tdd', 'sp_root_cause_trace'],
    tileBg: '#18181b',
    tileFg: '#e4e4e7',
  },
  {
    id: 'circleci',
    name: 'CircleCI',
    category: 'Developer Tools',
    description: 'Build, test, and deploy any application',
    author: 'CircleCI',
    transport: 'MCP · HTTP',
    endpoint: 'https://mcp.circleci.com/sse',
    tools: ['circleci_get_pipeline', 'circleci_build_logs', 'circleci_rerun_workflow'],
    tileBg: '#161618',
    tileFg: '#ffffff',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'Developer Tools',
    description: 'Inspect recent Sentry issues and events',
    author: 'Sentry Official',
    transport: 'OAuth 2.0',
    endpoint: 'https://mcp.sentry.dev/sse',
    tools: ['sentry_list_issues', 'sentry_get_stacktrace', 'sentry_resolve_issue'],
    tileBg: '#362d59',
    tileFg: '#e9d5ff',
  },
  {
    id: 'build-ios',
    name: 'Build iOS Apps',
    category: 'Developer Tools',
    description: 'Build, refine, and debug iOS apps with App Intents, SwiftUI...',
    author: 'Apple Platform Toolkit',
    transport: 'MCP · Stdio',
    endpoint: 'npx -y @codex/plugin-ios-apps',
    tools: ['ios_swiftui_preview', 'ios_xcode_build', 'ios_sim_screenshot'],
    tileBg: '#27272a',
    tileFg: '#f4f4f5',
  },
  {
    id: 'build-macos',
    name: 'Build macOS Apps',
    category: 'Developer Tools',
    description: 'Build, debug, and implement macOS apps with...',
    author: 'Apple Platform Toolkit',
    transport: 'MCP · Stdio',
    endpoint: 'npx -y @codex/plugin-macos-apps',
    tools: ['macos_swift_build', 'macos_appkit_inspect', 'macos_notarize_check'],
    tileBg: '#27272a',
    tileFg: '#f4f4f5',
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Developer Tools',
    description: 'Manage repositories, PRs, Issues, and Actions',
    author: 'GitHub Official',
    transport: 'MCP · HTTP',
    endpoint: 'https://api.githubcopilot.com/mcp/',
    tools: ['gh_list_prs', 'gh_read_issue', 'gh_create_pr', 'gh_workflow_logs'],
    tileBg: '#18181b',
    tileFg: '#ffffff',
  },
  {
    id: 'playwright',
    name: 'Playwright',
    category: 'Developer Tools',
    description: 'Automate browser checks, screenshots, and UI regressions',
    author: 'Microsoft / MCP',
    transport: 'MCP · Stdio',
    endpoint: 'npx -y @playwright/mcp@latest',
    tools: ['browser_navigate', 'browser_click', 'browser_screenshot', 'browser_evaluate'],
    tileBg: '#14291b',
    tileFg: '#4ade80',
  },

  // Education & Research
  {
    id: 'latex',
    name: 'LaTeX',
    category: 'Education & Research',
    description: 'Compile LaTeX with TeX tools',
    author: 'TeX Community',
    transport: 'MCP · Stdio',
    endpoint: 'npx -y @tex/mcp-latex',
    tools: ['latex_compile_pdf', 'latex_check_bib', 'latex_preview_eq'],
    tileBg: '#ffffff',
    tileFg: '#111111',
  },
  {
    id: 'life-science',
    name: 'Life Science Research',
    category: 'Education & Research',
    description: 'General life-sciences research with routing, evidence...',
    author: 'BioResearch',
    transport: 'MCP · HTTP',
    endpoint: 'https://mcp.bioresearch.org/general',
    tools: ['pubmed_search', 'protein_lookup', 'pathway_query'],
    tileBg: '#18181b',
    tileFg: '#f87171',
  },
  {
    id: 'zotero',
    name: 'Zotero',
    category: 'Education & Research',
    description: 'Find papers and add citations from Zotero',
    author: 'Zotero',
    transport: 'MCP · HTTP',
    endpoint: 'https://mcp.zotero.org/v1',
    tools: ['zotero_search_library', 'zotero_export_bibtex', 'zotero_read_notes'],
    tileBg: '#ffffff',
    tileFg: '#dc2626',
  },
  {
    id: 'life-science-ngs',
    name: 'Life Sciences NGS Analysis',
    category: 'Education & Research',
    description: 'Guided NGS routing and local execution for sequencing...',
    author: 'BioResearch',
    transport: 'MCP · Stdio',
    endpoint: 'npx -y @bioresearch/mcp-ngs',
    tools: ['ngs_qc_report', 'ngs_align_pipeline', 'ngs_variant_summary'],
    tileBg: '#0b192c',
    tileFg: '#38bdf8',
  },
  {
    id: 'consensus',
    name: 'Consensus',
    category: 'Education & Research',
    description: 'Explore scientific research',
    author: 'Consensus',
    transport: 'MCP · HTTP',
    endpoint: 'https://mcp.consensus.app/sse',
    tools: ['consensus_search_papers', 'consensus_synthesize', 'consensus_citations'],
    tileBg: '#4f46e5',
    tileFg: '#fde047',
  },

  // Finance
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Finance',
    description: 'Accept payments. Grow revenue.',
    author: 'Stripe Official',
    transport: 'OAuth 2.0',
    endpoint: 'https://mcp.stripe.com',
    tools: ['stripe_list_customers', 'stripe_create_payment_link', 'stripe_inspect_webhook'],
    tileBg: '#635bff',
    tileFg: '#ffffff',
  },

  // Productivity
  {
    id: 'linear',
    name: 'Linear',
    category: 'Productivity',
    description: 'Plan and build products',
    author: 'Linear Official',
    transport: 'OAuth 2.0',
    endpoint: 'https://mcp.linear.app/sse',
    tools: ['linear_list_issues', 'linear_create_issue', 'linear_update_cycle'],
    tileBg: '#18181c',
    tileFg: '#e4e4e7',
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'Productivity',
    description: 'Notion workflows for specs, research, meetings, and...',
    author: 'Notion Official',
    transport: 'MCP · HTTP',
    endpoint: 'https://mcp.notion.com/sse',
    tools: ['notion_search', 'notion_read_page', 'notion_create_page', 'notion_query_database'],
    tileBg: '#1c1c1e',
    tileFg: '#ffffff',
  },
  {
    id: 'atlassian-rovo',
    name: 'Atlassian Rovo',
    category: 'Productivity',
    description: 'Manage Jira and Confluence',
    author: 'Atlassian',
    transport: 'OAuth 2.0',
    endpoint: 'https://mcp.atlassian.com/v1/sse',
    tools: ['jira_search_issues', 'jira_transition', 'confluence_read_page'],
    tileBg: '#16161a',
    tileFg: '#ffffff',
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    category: 'Productivity',
    description: 'Access, save and share files',
    author: 'Dropbox Partner',
    transport: 'OAuth 2.0',
    endpoint: 'https://mcp.dropbox.com/sse',
    tools: ['dropbox_search', 'dropbox_read_file', 'dropbox_share_link'],
    tileBg: '#0061ff',
    tileFg: '#ffffff',
  },
  {
    id: 'granola',
    name: 'Granola',
    category: 'Productivity',
    description: 'Add your meeting context',
    author: 'Granola',
    transport: 'OAuth 2.0',
    endpoint: 'https://mcp.granola.ai/sse',
    tools: ['granola_list_meetings', 'granola_read_transcript', 'granola_extract_actions'],
    tileBg: '#84cc16',
    tileFg: '#142608',
  },
  {
    id: 'monday',
    name: 'monday.com',
    category: 'Productivity',
    description: 'Manage projects, tasks & CRM',
    author: 'monday.com',
    transport: 'OAuth 2.0',
    endpoint: 'https://mcp.monday.com/sse',
    tools: ['monday_list_boards', 'monday_update_item', 'monday_create_pulse'],
    tileBg: '#18181b',
    tileFg: '#ffffff',
  },

  // Scientific Research
  {
    id: 'boltz',
    name: 'Boltz',
    category: 'Scientific Research',
    description: 'Predict structures, screen molecules and proteins, and...',
    author: 'Boltz Lab',
    transport: 'MCP · HTTP',
    endpoint: 'https://mcp.boltz.bio/v1',
    tools: ['boltz_predict_structure', 'boltz_dock_ligand', 'boltz_score_affinity'],
    tileBg: '#d1fae5',
    tileFg: '#064e3b',
  },

  // Security
  {
    id: 'codex-security',
    name: 'Codex Security',
    category: 'Security',
    description: 'Audit repositories, secrets, and sandbox permissions',
    author: 'Codex Security Team',
    transport: 'MCP · Stdio',
    endpoint: 'npx -y @codex/plugin-security-audit',
    tools: ['sec_scan_secrets', 'sec_audit_deps', 'sec_check_sandbox_policy'],
    tileBg: '#0f172a',
    tileFg: '#38bdf8',
  },
];

export const INITIAL_SKILLS: MarketplaceSkill[] = [
  {
    id: 'code-review-pro',
    name: 'Code Review Pro',
    scope: 'personal',
    description: 'Review diffs for regressions, race conditions, and edge cases',
    instructions: '逐行审查改动文件，优先排查空指针、竞态、鉴权绕过和资源泄漏，并按严重程度给出最小修复建议。',
    hue: ['#a78bfa', '#f472b6', '#fbbf24'],
    installed: true,
  },
  {
    id: 'auto-mcm-pro',
    name: 'Auto Mcm Pro',
    scope: 'personal',
    description: 'AutoMCM-Pro v0.2.0 — 工业级数学建模智能体，支持多阶段求解',
    instructions: '建立问题假设、数学模型、灵敏度分析与可视化脚本，输出可复现论文级代码与结果总结。',
    hue: ['#fb923c', '#f472b6', '#c084fc'],
    installed: true,
  },
  {
    id: 'cc-imagegen',
    name: 'CC ImageGen',
    scope: 'personal',
    description: 'Generate images through CC Switch gpt-image-2',
    instructions: '根据需求拆解主体构图、材质光线与比例参数，调用图像生成工具并验证输出质量。',
    hue: ['#facc15', '#f472b6', '#818cf8'],
    installed: true,
  },
  {
    id: 'draw-image',
    name: 'Draw Image',
    scope: 'personal',
    description: 'Generate diagrams, flowcharts, and conceptual illustrations',
    instructions: '根据系统架构与交互流程绘制清晰结构图、时序图与示意图，突出核心数据流。',
    hue: ['#c084fc', '#fb923c', '#38bdf8'],
    installed: true,
  },
  {
    id: 'excel-workbook-completer',
    name: 'Excel Workbook Completer',
    scope: 'personal',
    description: 'Complete Excel workbooks with native formulas',
    instructions: '校验表格引用、补全原生 Excel 公式与汇总透视表，禁止硬编码覆盖计算单元格。',
    hue: ['#34d399', '#fbbf24', '#a78bfa'],
    installed: true,
  },
  {
    id: 'ui-pixel-polish',
    name: 'UI Pixel Polish',
    scope: 'personal',
    description: 'Match desktop design tokens, typography, spacing, and dark/light themes',
    instructions: '逐像素对齐视觉规范、字号行高、边框对比度与明暗主题，输出零冗余 CSS 补丁。',
    hue: ['#f472b6', '#a78bfa', '#38bdf8'],
    installed: true,
  },
  {
    id: 'figma-skill',
    name: 'Figma',
    scope: 'personal',
    description: 'Turn Figma layers and variables into clean React & CSS components',
    instructions: '读取 Figma 节点与样式变量，映射到现有设计令牌系统并生成语义化前端组件。',
    hue: ['#fb923c', '#a855f7', '#38bdf8'],
    installed: true,
  },
  {
    id: 'find-skills',
    name: 'Find Skills',
    scope: 'personal',
    description: 'Discover and recommend task-specific skills for your workspace',
    instructions: '根据当前仓库技术栈与任务目标推荐并配置合适的技能与规范。',
    hue: ['#60a5fa', '#c084fc', '#f472b6'],
    installed: true,
  },
  {
    id: 'sys-git-hygiene',
    name: 'Git Commit & PR Craft',
    scope: 'system',
    description: 'Generate concise conventional commits and structured PR summaries',
    instructions: '基于 git diff 提炼变更动机、关键文件与验证记录，生成简洁准确的提交信息。',
    hue: ['#60a5fa', '#34d399', '#a78bfa'],
    installed: true,
  },
  {
    id: 'sys-test-guard',
    name: 'Automated Test Guard',
    scope: 'system',
    description: 'Write deterministic unit tests and regression checks for changes',
    instructions: '覆盖核心逻辑与边界条件，保证测试可重复运行且不依赖不稳定外部状态。',
    hue: ['#818cf8', '#38bdf8', '#4ade80'],
    installed: true,
  },
  {
    id: 'sys-security-audit',
    name: 'Security Hygiene Audit',
    scope: 'system',
    description: 'Audit XSS, secrets exposure, injection vectors, and sandbox rules',
    instructions: '检查 dangerouslySetInnerHTML、敏感凭据落盘、命令拼接注入与不安全外链。',
    hue: ['#f59e0b', '#ef4444', '#a855f7'],
    installed: true,
  },
  {
    id: 'rec-notion-spec',
    name: 'Notion Spec Sync',
    scope: 'recommended',
    description: 'Sync architecture specs, ADRs, and sprint updates directly to Notion',
    instructions: '将仓库改动与验收结论整理为结构化 Notion 页面并更新关联任务数据库。',
    hue: ['#38bdf8', '#a78bfa', '#f472b6'],
    installed: false,
  },
  {
    id: 'rec-linear-triage',
    name: 'Linear Issue Triage',
    scope: 'recommended',
    description: 'Classify incoming bugs, link stacktraces, and draft minimal fix plans',
    instructions: '拉取 Linear 待分类 Issue，结合代码检索定位根因文件并附带优先级与修复计划。',
    hue: ['#818cf8', '#60a5fa', '#c084fc'],
    installed: false,
  },
  {
    id: 'rec-playwright-qa',
    name: 'Playwright Visual QA',
    scope: 'recommended',
    description: 'Capture desktop & mobile screenshots and assert layout regressions',
    instructions: '启动无头浏览器遍历关键交互路径，截图校验视觉回归并生成简洁验收报告。',
    hue: ['#34d399', '#38bdf8', '#a78bfa'],
    installed: false,
  },
  {
    id: 'rec-latex-paper',
    name: 'LaTeX Paper Assistant',
    scope: 'recommended',
    description: 'Format academic papers, equations, tables, and BibTeX references',
    instructions: '规范 LaTeX 公式、三线表与 BibTeX 引用格式，排查编译告警与排版溢出。',
    hue: ['#fbbf24', '#fb923c', '#f472b6'],
    installed: false,
  },
];

/** Subtle small workspace/directory outline badge shown right next to plugin names (Screenshots 2 & 3) */
const PluginMetaIcon: React.FC = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    style={{ color: 'var(--text-tertiary)', opacity: 0.72, flex: 'none' }}
  >
    <path
      d="M2.4 4.2c0-.7.6-1.3 1.3-1.3h2.6l1.2 1.3h4.8c.7 0 1.3.6 1.3 1.3v6.2c0 .7-.6 1.3-1.3 1.3H3.7c-.7 0-1.3-.6-1.3-1.3V4.2z"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
    />
  </svg>
);

/** Crisp colorful 3D cube skill badge matching Screenshot 1 */
const SkillCubeIcon: React.FC<{ hue: [string, string, string]; size?: number }> = ({
  hue,
  size = 20,
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 2.6L20.2 7.3L12 12L3.8 7.3L12 2.6Z" fill={hue[2]} />
    <path d="M3.8 7.3L12 12V21.4L3.8 16.7V7.3Z" fill={hue[0]} />
    <path d="M20.2 7.3L12 12V21.4L20.2 16.7V7.3Z" fill={hue[1]} />
  </svg>
);

/** Bespoke brand glyphs for every plugin in User Screenshots 2 & 3 */
const PluginBrandIcon: React.FC<{ plugin: MarketplacePlugin; size?: number }> = ({
  plugin,
  size = 20,
}) => {
  switch (plugin.id) {
    case 'slack':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="4" y="10" width="5.4" height="2.6" rx="1.3" fill="#E01E5A" />
          <rect x="10" y="4" width="2.6" height="5.4" rx="1.3" fill="#36C5F0" />
          <rect x="14.6" y="11.4" width="5.4" height="2.6" rx="1.3" fill="#2EB67D" />
          <rect x="11.4" y="14.6" width="2.6" height="5.4" rx="1.3" fill="#ECB22E" />
        </svg>
      );
    case 'remotion':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M7.5 6.2c0-1 1.1-1.6 1.9-1.1l9.2 5.8c.8.5.8 1.7 0 2.2l-9.2 5.8c-.8.5-1.9-.1-1.9-1.1V6.2z" />
        </svg>
      );
    case 'hyperframes':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 6.5l-3 11" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'figma':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9.5 3.5h2.5v5.5H9.5a2.75 2.75 0 010-5.5z" fill="#F24E1E" />
          <path d="M12 3.5h2.5a2.75 2.75 0 010 5.5H12V3.5z" fill="#FF7262" />
          <path d="M12 9h2.5a2.75 2.75 0 110 5.5H12V9z" fill="#1ABCFE" />
          <path d="M9.5 9H12v5.5H9.5a2.75 2.75 0 010-5.5z" fill="#A259FF" />
          <path d="M9.5 14.5H12v2.75a2.75 2.75 0 11-2.5-2.75z" fill="#0ACF83" />
        </svg>
      );
    case 'canva':
      return (
        <span style={{ fontSize: Math.round(size * 0.78), fontWeight: 700, fontStyle: 'italic', fontFamily: 'Georgia, serif' }}>
          C
        </span>
      );
    case 'product-design':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.7" />
          <circle cx="16" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.7" />
          <circle cx="12" cy="16.2" r="2.2" stroke="currentColor" strokeWidth="1.7" />
          <path d="M10.2 8h3.6M9.2 10l1.8 4.2M14.8 10L13 14.2" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case 'higgsfield':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6.5 5.5v13M17.5 5.5v13M6.5 12h11" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      );
    case 'mixpanel':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      );
    case 'posthog':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="4" y="13" width="4" height="6" rx="1" fill="#1d4ed8" />
          <rect x="10" y="9" width="4" height="10" rx="1" fill="#f97316" />
          <rect x="16" y="5" width="4" height="14" rx="1" fill="#eab308" />
        </svg>
      );
    case 'game-studio':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3.5" y="7.5" width="17" height="9.5" rx="4.5" stroke="currentColor" strokeWidth="1.7" />
          <path d="M8.5 10.5v3.5M6.75 12.25h3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="15.2" cy="11.4" r="0.95" fill="currentColor" />
          <circle cx="17.2" cy="13.2" r="0.95" fill="currentColor" />
        </svg>
      );
    case 'superpowers':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M13 3.5L6.5 13h5l-1 7.5L17.5 11h-5l.5-7.5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
      );
    case 'circleci':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 4.5a7.5 7.5 0 11-7.2 5.4" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          <circle cx="12" cy="12" r="2.1" fill="currentColor" />
        </svg>
      );
    case 'sentry':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 4.5l7.5 13h-3.6c-.4-3.7-2.6-6.7-5.8-8.1L12 4.5zM8.1 11.2c2.2 1.1 3.7 3.4 4 6.3H4.5l3.6-6.3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      );
    case 'build-ios':
    case 'build-macos':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7 8.5l4 3.5-4 3.5M12.5 15.5h4.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'github':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M12 2.5C6.75 2.5 2.5 6.75 2.5 12c0 4.2 2.72 7.75 6.5 9 .47.09.65-.2.65-.46v-1.6c-2.64.57-3.2-1.27-3.2-1.27-.43-1.1-1.06-1.39-1.06-1.39-.86-.59.07-.58.07-.58.95.07 1.46.98 1.46.98.85 1.45 2.22 1.03 2.77.79.08-.61.33-1.03.6-1.27-2.11-.24-4.33-1.06-4.33-4.7 0-1.04.37-1.89.98-2.55-.1-.24-.42-1.21.09-2.52 0 0 .8-.26 2.62.97a9.1 9.1 0 014.76 0c1.82-1.23 2.62-.97 2.62-.97.51 1.31.19 2.28.09 2.52.61.66.98 1.51.98 2.55 0 3.65-2.22 4.46-4.34 4.69.34.29.64.87.64 1.76v2.6c0 .26.18.55.66.46A9.5 9.5 0 0021.5 12c0-5.25-4.25-9.5-9.5-9.5z"
          />
        </svg>
      );
    case 'playwright':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4.5 7.5c0-1.1.9-2 2-2h11c1.1 0 2 .9 2 2v7c0 2.5-2 4.5-4.5 4.5h-6C6.5 19 4.5 17 4.5 14.5v-7z" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="9.2" cy="11" r="1.2" fill="currentColor" />
          <circle cx="14.8" cy="11" r="1.2" fill="currentColor" />
          <path d="M9.2 14.6c1 .9 4.6.9 5.6 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case 'latex':
      return (
        <span style={{ fontSize: Math.round(size * 0.48), fontWeight: 700, fontFamily: 'Georgia, serif', letterSpacing: '-0.04em' }}>
          LaTeX
        </span>
      );
    case 'life-science':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9.5 4.5h5M10.5 4.5v4.8L5.8 17c-.6 1 .1 2.2 1.2 2.2h10c1.1 0 1.8-1.2 1.2-2.2l-4.7-7.7V4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M7.6 14.5h8.8" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case 'zotero':
      return (
        <span style={{ fontSize: Math.round(size * 0.8), fontWeight: 800, fontFamily: 'Georgia, serif' }}>
          Z
        </span>
      );
    case 'life-science-ngs':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7.5 4.5c0 4 9 4 9 7.5s-9 3.5-9 7.5M16.5 4.5c0 4-9 4-9 7.5s9 3.5 9 7.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      );
    case 'consensus':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 4.2l2.3 5.2 5.6.5-4.3 3.7 1.3 5.5L12 16.2l-4.9 2.9 1.3-5.5-4.3-3.7 5.6-.5L12 4.2z" />
        </svg>
      );
    case 'stripe':
      return (
        <span style={{ fontSize: Math.round(size * 0.82), fontWeight: 800, letterSpacing: '-0.03em' }}>
          S
        </span>
      );
    case 'linear':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6" />
          <path d="M5.6 15.2l3.2 3.2M4.5 11.4l8.1 8.1M6.6 8.2l9.2 9.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case 'notion':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M5.2 4.8L15.4 4c1 .1 1.4.4 2.1.9l2.2 1.6c.4.3.5.5.5.9v11.8c0 .8-.3 1.2-1.2 1.3L8.2 21c-.8.1-1.2-.1-1.6-.6L4.2 17.3c-.3-.4-.4-.7-.4-1.2V6.1c0-.8.4-1.2 1.4-1.3z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M9.6 16.9V9.6l4.8 7.1h.9V9.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'atlassian-rovo':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 4.8L5.2 18.8h4.2l2.6-5.6 2.6 5.6h4.2L12 4.8z" />
        </svg>
      );
    case 'dropbox':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M7.5 4.8L3 7.8l4.5 3L12 7.8l-4.5-3zm9 0L12 7.8l4.5 3 4.5-3-4.5-3zM3 13.8l4.5 3 4.5-3-4.5-3-4.5 3zm13.5-3l-4.5 3 4.5 3 4.5-3-4.5-3zM7.5 18l4.5 2.8 4.5-2.8-4.5-2.8L7.5 18z" />
        </svg>
      );
    case 'granola':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M16 9.5A5.2 5.2 0 1017 13h-4.8" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'monday':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6.2 15.8l2.5-6.6" stroke="#ff3d57" strokeWidth="2.8" strokeLinecap="round" />
          <path d="M11.6 15.8l2.5-6.6" stroke="#ffcb00" strokeWidth="2.8" strokeLinecap="round" />
          <circle cx="17.6" cy="15.2" r="2.1" fill="#00ca72" />
        </svg>
      );
    case 'boltz':
      return (
        <span style={{ fontSize: Math.round(size * 0.8), fontWeight: 800, letterSpacing: '-0.04em' }}>
          B
        </span>
      );
    case 'codex-security':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 3.5l7 2.8v5.2c0 4.4-3 7.8-7 9-4-1.2-7-4.6-7-9V6.3l7-2.8z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          <path d="M9.2 12.2l1.9 1.9 3.8-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '-0.02em' }}>
          {plugin.name.slice(0, 2).toUpperCase()}
        </span>
      );
  }
};

interface LocalPluginLogoSpec {
  light: string;
  dark?: string;
  fit?: 'cover' | 'contain';
  fitDark?: 'cover' | 'contain';
  pad?: number;
  bgLight?: string;
  bgDark?: string;
  darkInvert?: boolean;
  circular?: boolean;
}

const normalizePluginKey = (value: string | undefined): string =>
  (value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-');

const pluginLogoAssets = import.meta.glob('../assets/plugins/*', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>;

/** Plugin graphics bundled with the frontend (zero external network dependency). */
const PLUGIN_LOGO_SPECS: Record<string, LocalPluginLogoSpec> = {
  'office-documents': { light: '/plugin-logos/office-documents.svg', fit: 'contain' },
  'office-pdf': { light: '/plugin-logos/office-pdf.svg', fit: 'contain' },
  'office-spreadsheets': { light: '/plugin-logos/office-spreadsheets.svg', fit: 'contain' },
  slack: { light: '/plugin-logos/slack.png', fit: 'contain', bgLight: '#1c1c20', bgDark: '#1c1c20' },
  gmail: { light: '/plugin-logos/gmail.png', fit: 'contain', bgLight: '#ffffff', bgDark: '#1c1c20' },
  remotion: {
    light: '/plugin-logos/remotion.png',
    dark: '/plugin-logos/remotion-dark.png',
    fit: 'contain',
    fitDark: 'contain',
    bgLight: '#ffffff',
    bgDark: '#141417',
  },
  hyperframes: { light: '/plugin-logos/hyperframes.png', fit: 'contain', bgLight: '#ffffff', bgDark: '#ffffff' },
  figma: { light: '/plugin-logos/figma.png', fit: 'contain', bgLight: '#1e1e22', bgDark: '#1e1e22' },
  canva: { light: '/plugin-logos/canva.png', fit: 'contain', bgLight: '#00c4cc', bgDark: '#00c4cc' },
  'product-design': {
    light: '/plugin-logos/product-design.png',
    fit: 'contain',
    bgLight: '#a855f7',
    bgDark: '#a855f7',
  },
  higgsfield: { light: '/plugin-logos/higgsfield.png', fit: 'contain', bgLight: '#d1fe17', bgDark: '#d1fe17' },
  adobe: { light: '/plugin-logos/adobe.svg', fit: 'contain', pad: 6, bgLight: '#ffffff', bgDark: '#1c1c20' },
  fal: { light: '/plugin-logos/fal.png', fit: 'contain', bgLight: '#ffffff', bgDark: '#1c1c20' },
  heygen: { light: '/plugin-logos/heygen.png', fit: 'contain', pad: 5, bgLight: '#ffffff', bgDark: '#1c1c20' },
  krea: { light: '/plugin-logos/krea.png', fit: 'contain', bgLight: '#ffffff', bgDark: '#ffffff' },
  pixverse: { light: '/plugin-logos/pixverse.png', fit: 'contain', bgLight: '#110216', bgDark: '#110216' },
  'kling-ai': { light: '/plugin-logos/kling-ai.png', fit: 'contain', bgLight: '#000000', bgDark: '#000000' },
  imagineart: { light: '/plugin-logos/imagineart.png', fit: 'contain', bgLight: '#3f2168', bgDark: '#3f2168' },
  picsart: { light: '/plugin-logos/picsart.png', fit: 'contain', bgLight: '#c026d3', bgDark: '#c026d3' },
  morphix: { light: '/plugin-logos/morphix.png', fit: 'contain', bgLight: '#0f172a', bgDark: '#0f172a' },
  riverside: { light: '/plugin-logos/riverside.png', fit: 'contain', bgLight: '#090a0c', bgDark: '#090a0c' },
  descript: { light: '/plugin-logos/descript.png', fit: 'contain', bgLight: '#651a39', bgDark: '#651a39' },
  gamma: { light: '/plugin-logos/gamma.png', fit: 'contain', bgLight: '#122448', bgDark: '#122448' },
  mixpanel: {
    light: '/plugin-logos/mixpanel.png',
    fit: 'contain',
    bgLight: '#ffffff',
    bgDark: 'transparent',
    circular: true,
  },
  posthog: { light: '/plugin-logos/posthog.png', fit: 'contain', bgLight: '#ffffff', bgDark: '#ffffff' },
  'game-studio': {
    light: '/plugin-logos/game-studio.png',
    fit: 'contain',
    pad: 2,
    bgLight: '#f4f4f5',
    bgDark: '#232327',
  },
  superpowers: {
    light: '/plugin-logos/superpowers.png',
    fit: 'contain',
    bgLight: '#f4f4f5',
    bgDark: '#18181b',
    darkInvert: true,
  },
  circleci: {
    light: '/plugin-logos/circleci.png',
    dark: '/plugin-logos/circleci-dark.png',
    fit: 'contain',
    bgLight: '#ffffff',
    bgDark: '#161618',
  },
  sentry: { light: '/plugin-logos/sentry.png', fit: 'contain', bgLight: '#362d59', bgDark: '#362d59' },
  'build-ios': { light: '/plugin-logos/build-ios.png', fit: 'contain', bgLight: '#27272a', bgDark: '#27272a' },
  'build-macos': { light: '/plugin-logos/build-macos.png', fit: 'contain', bgLight: '#27272a', bgDark: '#27272a' },
  github: {
    light: '/plugin-logos/github.png',
    dark: '/plugin-logos/github-dark.png',
    fit: 'contain',
    fitDark: 'contain',
    bgLight: '#ffffff',
    bgDark: '#18181b',
  },
  playwright: {
    light: '/plugin-logos/playwright.svg',
    fit: 'contain',
    pad: 5,
    bgLight: '#ffffff',
    bgDark: '#1c1c20',
  },
  latex: { light: '/plugin-logos/latex.svg', fit: 'contain', pad: 5, bgLight: '#ffffff', bgDark: '#ffffff' },
  'life-science': {
    light: '/plugin-logos/life-science.png',
    fit: 'contain',
    pad: 2,
    bgLight: '#f4f4f5',
    bgDark: '#1e1e22',
  },
  zotero: { light: '/plugin-logos/zotero.png', fit: 'contain', pad: 3, bgLight: '#ffffff', bgDark: '#1e1e22' },
  'life-science-ngs': {
    light: '/plugin-logos/life-science-ngs.png',
    fit: 'contain',
    bgLight: '#f0f9ff',
    bgDark: '#0f1d30',
  },
  consensus: { light: '/plugin-logos/consensus.png', fit: 'contain', bgLight: '#ffffff', bgDark: '#ffffff' },
  stripe: { light: '/plugin-logos/stripe.png', fit: 'contain', bgLight: '#635bff', bgDark: '#635bff' },
  linear: { light: '/plugin-logos/linear.png', fit: 'contain', bgLight: '#18181c', bgDark: '#18181c' },
  notion: {
    light: '/plugin-logos/notion.png',
    dark: '/plugin-logos/notion-dark.png',
    fit: 'contain',
    bgLight: '#ffffff',
    bgDark: '#1c1c1e',
  },
  'atlassian-rovo': {
    light: '/plugin-logos/atlassian-rovo.png',
    dark: '/plugin-logos/atlassian-rovo-dark.png',
    fit: 'contain',
    bgLight: '#ffffff',
    bgDark: '#16161a',
  },
  dropbox: {
    light: '/plugin-logos/dropbox.png',
    dark: '/plugin-logos/dropbox-dark.png',
    fit: 'contain',
    bgLight: '#0061ff',
    bgDark: '#0061ff',
  },
  granola: { light: '/plugin-logos/granola.png', fit: 'contain', bgLight: '#84cc16', bgDark: '#84cc16' },
  monday: { light: '/plugin-logos/monday.png', fit: 'contain', bgLight: '#ffffff', bgDark: '#1c1c20' },
  'google-drive': {
    light: '/plugin-logos/google-drive.png',
    fit: 'contain',
    bgLight: '#ffffff',
    bgDark: '#1c1c20',
  },
  boltz: { light: '/plugin-logos/boltz.png', fit: 'contain', bgLight: '#d1fae5', bgDark: '#d1fae5' },
  'codex-security': {
    light: '/plugin-logos/codex-security.png',
    fit: 'contain',
    pad: 2,
    bgLight: '#f8fafc',
    bgDark: '#161820',
  },
};

const PLUGIN_LOGO_ALIASES: Record<string, string> = {
  'mixpanel-headless': 'mixpanel',
  'monday-com': 'monday',
  'build-ios-apps': 'build-ios',
  'build-macos-apps': 'build-macos',
  'life-science-research': 'life-science',
  'life-sciences-ngs-analysis': 'life-science-ngs',
  'ngs-analysis': 'life-science-ngs',
  'boltz-api-cli': 'boltz',
  'hyperframes-by-heygen': 'hyperframes',
  'figma-skill': 'figma',
  'figma-design': 'figma',
  'google-drive-mcp': 'google-drive',
  atlassian: 'atlassian-rovo',
  'monday-mcp': 'monday',
  'code-review-pro': 'codex-security',
  'security-hygiene-audit': 'codex-security',
  'ui-pixel-polish': 'product-design',
};

function resolvePluginLogoSpec(plugin: MarketplacePlugin): LocalPluginLogoSpec | null {
  const idKey = normalizePluginKey(plugin.id);
  if (PLUGIN_LOGO_SPECS[idKey]) return PLUGIN_LOGO_SPECS[idKey];
  if (PLUGIN_LOGO_ALIASES[idKey]) return PLUGIN_LOGO_SPECS[PLUGIN_LOGO_ALIASES[idKey]];
  const slugKey = normalizePluginKey(plugin.slug);
  if (slugKey && PLUGIN_LOGO_SPECS[slugKey]) return PLUGIN_LOGO_SPECS[slugKey];
  if (slugKey && PLUGIN_LOGO_ALIASES[slugKey]) return PLUGIN_LOGO_SPECS[PLUGIN_LOGO_ALIASES[slugKey]];
  return null;
}

function resolvePluginLogoUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  const bundledPath = trimmed.match(/^\/?plugin-logos\/(.+)$/i);
  if (bundledPath) {
    return pluginLogoAssets[`../assets/plugins/${bundledPath[1]}`];
  }
  if (trimmed.startsWith('//')) return `${window.location.protocol}${trimmed}`;
  if (/^(data:|blob:|https?:|\/)/i.test(trimmed)) return trimmed;
  const normalized = trimmed.replace(/^\.\//, '').replace(/^public\//, '');
  if (normalized.toLowerCase().startsWith('plugin-logos/')) {
    return pluginLogoAssets[`../assets/plugins/${normalized.slice('plugin-logos/'.length)}`];
  }
  return trimmed;
}

export function getBundledPluginIcon(plugin: MarketplacePlugin, theme: 'light' | 'dark') {
  const spec = resolvePluginLogoSpec(plugin);
  const paths = theme === 'dark' ? [spec?.dark, spec?.light] : [spec?.light, spec?.dark];
  for (const path of paths) {
    const local = path?.match(/^\/?plugin-logos\/(.+)$/i);
    if (local && pluginLogoAssets[`../assets/plugins/${local[1]}`]) {
      return pluginLogoAssets[`../assets/plugins/${local[1]}`];
    }
  }
  return undefined;
}

function getPluginTileStyle(
  plugin: MarketplacePlugin,
  theme: 'light' | 'dark',
  extra?: React.CSSProperties,
): React.CSSProperties {
  const spec = resolvePluginLogoSpec(plugin);
  const hasLogo = Boolean(spec || plugin.logoUrl || plugin.logoUrlDark);
  const bg = spec
    ? theme === 'dark'
      ? spec.bgDark ?? spec.bgLight ?? 'transparent'
      : spec.bgLight ?? 'transparent'
    : hasLogo
      ? 'var(--bg-surface-secondary)'
      : plugin.tileBg;

  return {
    background: bg,
    color: plugin.tileFg,
    overflow: 'hidden',
    ...(spec?.circular
      ? {
          borderRadius: '9999px',
          border: theme === 'dark' ? 'none' : '1px solid var(--border-subtle)',
        }
      : {}),
    ...extra,
  };
}

/** Renders authentic local/official brand logo when available, seamlessly falling back to bespoke SVG */
const PluginTileGraphic: React.FC<{
  plugin: MarketplacePlugin;
  theme: 'light' | 'dark';
  size?: number;
}> = ({ plugin, theme, size = 19 }) => {
  const [failedLogoUrls, setFailedLogoUrls] = useState<string[]>([]);
  const spec = resolvePluginLogoSpec(plugin);
  const logoCandidates = useMemo(() => {
    const candidates =
      theme === 'dark'
        ? [
            resolvePluginLogoUrl(plugin.logoUrlDark),
            resolvePluginLogoUrl(spec?.dark),
            resolvePluginLogoUrl(plugin.logoUrl),
            resolvePluginLogoUrl(spec?.light),
          ]
        : [
            resolvePluginLogoUrl(plugin.logoUrl),
            resolvePluginLogoUrl(spec?.light),
            resolvePluginLogoUrl(plugin.logoUrlDark),
            resolvePluginLogoUrl(spec?.dark),
          ];
    return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
  }, [plugin.logoUrl, plugin.logoUrlDark, spec, theme]);
  const src = logoCandidates.find((candidate) => !failedLogoUrls.includes(candidate));

  useEffect(() => {
    setFailedLogoUrls([]);
  }, [logoCandidates]);

  if (src) {
    const fit = theme === 'dark' ? spec?.fitDark || spec?.fit || 'contain' : spec?.fit || 'contain';
    const basePad = spec?.pad ?? 0;
    const scaledPad = basePad > 0 ? Math.max(1, Math.round(basePad * (size / 19))) : 0;
    return (
      <img
        src={src}
        alt={plugin.name}
        loading="lazy"
        referrerPolicy="no-referrer"
        style={{
          width: '100%',
          height: '100%',
          objectFit: fit,
          padding: scaledPad > 0 ? scaledPad : undefined,
          boxSizing: 'border-box',
          borderRadius: 'inherit',
          maxWidth: '100%',
          maxHeight: '100%',
          display: 'block',
          filter: spec?.darkInvert && theme === 'dark' ? 'invert(0.92)' : undefined,
        }}
        onError={() => setFailedLogoUrls((failed) => [...failed, src])}
      />
    );
  }
  return <PluginBrandIcon plugin={plugin} size={size} />;
};

interface CapabilitiesViewProps {
  initialTab?: 'plugins' | 'skills';
  initialPluginId?: string;
  theme: 'light' | 'dark';
  catalogSource: LocalCatalogSourceInfo | null;
  plugins: MarketplacePlugin[];
  remoteSearchResults: MarketplacePlugin[] | null;
  remoteSearching?: boolean;
  installedPluginIds: string[];
  pluginTokens: Record<string, string>;
  skills: MarketplaceSkill[];
  onSearchRemotePlugins: (query: string) => void;
  onRefreshCatalog: (syncUpstream?: boolean) => Promise<void>;
  onToggleInstallPlugin: (plugin: MarketplacePlugin) => Promise<void> | void;
  onSavePluginConfig: (plugin: MarketplacePlugin, endpoint: string, token: string) => Promise<void> | void;
  onAddCustomPlugin: (plugin: MarketplacePlugin) => Promise<void> | void;
  onInstallGithubPlugin: (repoUrl: string, category: PluginCategoryId) => Promise<void> | void;
  onToggleInstallSkill: (skillId: string) => Promise<void> | void;
  onUpdateSkill: (skillId: string, patch: Partial<MarketplaceSkill>) => Promise<void> | void;
  onAddCustomSkill: (skill: MarketplaceSkill) => Promise<void> | void;
  onDeleteCustomSkill: (skillId: string) => Promise<void> | void;
  onTryPrompt: (prompt: string) => void;
  onOpenSettings: (section?: string) => void;
  onToast: (msg: string, tone?: 'default' | 'success' | 'warning' | 'danger') => void;
}

export const CapabilitiesView: React.FC<CapabilitiesViewProps> = ({
  initialTab = 'plugins',
  initialPluginId,
  theme,
  catalogSource,
  plugins,
  remoteSearchResults,
  remoteSearching = false,
  installedPluginIds,
  pluginTokens,
  skills,
  onSearchRemotePlugins,
  onRefreshCatalog,
  onToggleInstallPlugin,
  onSavePluginConfig,
  onAddCustomPlugin,
  onInstallGithubPlugin,
  onToggleInstallSkill,
  onUpdateSkill,
  onAddCustomSkill,
  onDeleteCustomSkill,
  onTryPrompt,
  onOpenSettings,
  onToast,
}) => {
  const [activeTab, setActiveTab] = useState<'plugins' | 'skills'>(initialTab);
  const [search, setSearch] = useState('');
  const [navSearchOpen, setNavSearchOpen] = useState(false);
  const [pluginScope, setPluginScope] = useState<'public' | 'creativity' | 'installed'>('public');
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});
  const [skillScope, setSkillScope] = useState<'personal' | 'system' | 'recommended'>('personal');
  const [showAllInstalledSkills, setShowAllInstalledSkills] = useState(false);
  const [showAllScopedSkills, setShowAllScopedSkills] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  // Modals
  const [selectedPlugin, setSelectedPlugin] = useState<MarketplacePlugin | null>(null);
  const openedPlugin = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialPluginId || openedPlugin.current === initialPluginId) return;
    const plugin = plugins.find(({ id }) => id === initialPluginId);
    if (!plugin) return;
    openedPlugin.current = initialPluginId;
    setSelectedPlugin(plugin);
    setEditEndpoint(plugin.endpoint);
    setEditToken(pluginTokens[plugin.id] ?? '');
  }, [initialPluginId, plugins, pluginTokens]);
  const [editEndpoint, setEditEndpoint] = useState('');
  const [editToken, setEditToken] = useState('');

  const [selectedSkill, setSelectedSkill] = useState<MarketplaceSkill | null>(null);
  const [editSkillInstructions, setEditSkillInstructions] = useState('');

  const [addModalMode, setAddModalMode] = useState<null | 'plugin' | 'github' | 'json' | 'skill'>(null);
  const [githubRepoUrl, setGithubRepoUrl] = useState('');
  const [githubCategory, setGithubCategory] = useState<PluginCategoryId>('Creativity');
  const [newPluginName, setNewPluginName] = useState('');
  const [newPluginCategory, setNewPluginCategory] = useState<PluginCategoryId>('Productivity');
  const [newPluginDesc, setNewPluginDesc] = useState('');
  const [newPluginTransport, setNewPluginTransport] = useState<MarketplacePlugin['transport']>('MCP · HTTP');
  const [newPluginEndpoint, setNewPluginEndpoint] = useState('');
  const [jsonImportText, setJsonImportText] = useState(
    '{\n  "mcpServers": {\n    "my-notion": {\n      "url": "https://mcp.notion.com/sse"\n    }\n  }\n}',
  );

  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillDesc, setNewSkillDesc] = useState('');
  const [newSkillScope, setNewSkillScope] = useState<'personal' | 'system'>('personal');
  const [newSkillInstructions, setNewSkillInstructions] = useState('');

  const addMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [addMenuOpen]);

  useEffect(() => {
    if (activeTab !== 'plugins') return;
    const t = window.setTimeout(() => {
      onSearchRemotePlugins(search.trim());
    }, 180);
    return () => window.clearTimeout(t);
  }, [activeTab, search, onSearchRemotePlugins]);

  const installedPluginSet = useMemo(() => new Set(installedPluginIds), [installedPluginIds]);
  const installedPlugins = useMemo(
    () => plugins.filter((p) => installedPluginSet.has(p.id)),
    [plugins, installedPluginSet],
  );

  const creativityCount = useMemo(
    () => plugins.filter((p) => p.category === 'Creativity').length,
    [plugins],
  );

  const groupedPlugins = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sourcePool = q && remoteSearchResults ? remoteSearchResults : plugins;
    const pool = sourcePool.filter((p) => {
      if (pluginScope === 'installed' && !installedPluginSet.has(p.id)) return false;
      if (pluginScope === 'creativity' && p.category !== 'Creativity') return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        (p.bundledSkills ?? p.tools).some((t) => t.toLowerCase().includes(q))
      );
    });

    const groups: Array<{ category: PluginCategoryId; items: MarketplacePlugin[] }> = [];
    for (const cat of PLUGIN_CATEGORY_ORDER) {
      const items = pool.filter((p) => p.category === cat);
      if (items.length > 0) groups.push({ category: cat, items });
    }
    return groups;
  }, [plugins, remoteSearchResults, pluginScope, installedPluginSet, search]);

  const installedSkills = useMemo(() => {
    const q = search.trim().toLowerCase();
    return skills.filter((s) => {
      if (!s.installed) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
    });
  }, [skills, search]);

  const scopedSkills = useMemo(() => {
    const q = search.trim().toLowerCase();
    return skills.filter((s) => {
      if (s.scope !== skillScope) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
    });
  }, [skills, skillScope, search]);

  const visibleInstalledSkills = showAllInstalledSkills
    ? installedSkills
    : installedSkills.slice(0, 6);
  const hiddenInstalledSkills = installedSkills.slice(6);

  const visibleScopedSkills = showAllScopedSkills ? scopedSkills : scopedSkills.slice(0, 6);
  const hiddenScopedSkills = scopedSkills.slice(6);

  const openPluginModal = (plugin: MarketplacePlugin) => {
    setSelectedPlugin(plugin);
    setEditEndpoint(plugin.endpoint);
    setEditToken(pluginTokens[plugin.id] ?? '');
  };

  const openSkillModal = (skill: MarketplaceSkill) => {
    setSelectedSkill(skill);
    setEditSkillInstructions(skill.instructions);
  };

  const handleInstallClick = async (plugin: MarketplacePlugin, e: React.MouseEvent) => {
    e.stopPropagation();
    if (installedPluginSet.has(plugin.id)) {
      openPluginModal(plugin);
      return;
    }
    setInstallingId(plugin.id);
    try {
      await onToggleInstallPlugin(plugin);
    } finally {
      window.setTimeout(() => setInstallingId(null), 160);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefreshCatalog(true);
      onToast(
        activeTab === 'plugins'
          ? '已刷新独立插件目录（GitHub / MCP）'
          : '已同步 GitHub 公开技能源（openai/skills）',
      );
    } finally {
      window.setTimeout(() => setRefreshing(false), 260);
    }
  };

  const handleCreateCustom = (e: React.FormEvent) => {
    e.preventDefault();
    if (addModalMode === 'github') {
      if (!githubRepoUrl.trim()) return;
      void onInstallGithubPlugin(githubRepoUrl.trim(), githubCategory);
      setGithubRepoUrl('');
      setAddModalMode(null);
      return;
    }
    if (addModalMode === 'plugin') {
      if (!newPluginName.trim()) return;
      const id = `custom-${Date.now().toString(36)}`;
      onAddCustomPlugin({
        id,
        name: newPluginName.trim(),
        category: newPluginCategory,
        description: newPluginDesc.trim() || 'Custom MCP server integration',
        author: 'Custom MCP',
        transport: newPluginTransport,
        endpoint: newPluginEndpoint.trim() || 'http://127.0.0.1:3000/mcp',
        tools: ['custom_tool_invoke'],
        tileBg: 'rgba(59, 130, 246, 0.16)',
        tileFg: 'var(--color-accent)',
        custom: true,
      });
      setNewPluginName('');
      setNewPluginDesc('');
      setNewPluginEndpoint('');
      setAddModalMode(null);
    } else if (addModalMode === 'json') {
      try {
        const parsed = JSON.parse(jsonImportText) as {
          mcpServers?: Record<string, { url?: string; command?: string; args?: string[] }>;
        };
        const servers = parsed.mcpServers ?? {};
        const entries = Object.entries(servers);
        if (!entries.length) {
          onToast('未在 JSON 中找到 mcpServers 条目', 'warning');
          return;
        }
        for (const [name, cfg] of entries) {
          const isStdio = Boolean(cfg.command);
          const endpoint = isStdio
            ? [cfg.command, ...(cfg.args ?? [])].join(' ')
            : cfg.url || 'https://localhost/mcp';
          onAddCustomPlugin({
            id: `mcp-${name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${Date.now().toString(36)}`,
            name,
            category: 'Developer Tools',
            description: `Imported MCP server (${isStdio ? 'stdio' : 'http'})`,
            author: 'JSON Import',
            transport: isStdio ? 'MCP · Stdio' : 'MCP · HTTP',
            endpoint,
            tools: [`${name}_invoke`],
            tileBg: '#1e293b',
            tileFg: '#60a5fa',
            custom: true,
          });
        }
        setAddModalMode(null);
      } catch {
        onToast('JSON 格式解析失败，请检查语法', 'danger');
      }
    } else if (addModalMode === 'skill') {
      if (!newSkillName.trim()) return;
      const id = `skill-${Date.now().toString(36)}`;
      onAddCustomSkill({
        id,
        name: newSkillName.trim(),
        scope: newSkillScope,
        description: newSkillDesc.trim() || 'Task-specific custom skill',
        instructions: newSkillInstructions.trim() || '按步骤完成任务并保持最终总结简短清晰。',
        hue: ['#a78bfa', '#38bdf8', '#fb923c'],
        installed: true,
        custom: true,
      });
      setNewSkillName('');
      setNewSkillDesc('');
      setNewSkillInstructions('');
      setAddModalMode(null);
    }
  };

  return (
    <div className="codex-settings">
      {/* Left 252px Chrome Navigation (Exact Screenshots 1, 2, 3) */}
      <aside className="codex-settings-nav" aria-label="自定义导航">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 8px 10px',
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-default)' }}>自定义</span>
          <button
            type="button"
            className="codex-icon-btn"
            style={{ width: 26, height: 26 }}
            title="搜索插件或技能"
            aria-label="搜索插件或技能"
            onClick={() => setNavSearchOpen((v) => !v)}
          >
            <IconSearch size={15} />
          </button>
        </div>

        {navSearchOpen && (
          <div className="codex-settings-search" style={{ marginBottom: 8 }}>
            <IconSearch size={13} />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={activeTab === 'plugins' ? '筛选插件…' : '筛选技能…'}
            />
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <button
            type="button"
            className="codex-sidebar-row"
            data-selected={activeTab === 'plugins' ? 'true' : undefined}
            onClick={() => setActiveTab('plugins')}
          >
            <IconPuzzle size={15} style={{ color: 'var(--text-secondary)', flex: 'none' }} />
            <span className="codex-sidebar-row-text">插件</span>
          </button>

          <button
            type="button"
            className="codex-sidebar-row"
            data-selected={activeTab === 'skills' ? 'true' : undefined}
            onClick={() => setActiveTab('skills')}
          >
            <IconSkillsNode size={15} style={{ color: 'var(--text-secondary)', flex: 'none' }} />
            <span className="codex-sidebar-row-text">技能</span>
          </button>
        </div>

        <div className="codex-section-header" style={{ paddingTop: 18 }}>
          <span className="codex-section-toggle" style={{ cursor: 'default' }}>
            已安装
          </span>
          {installedPlugins.length > 0 && (
            <span className="tabular-nums" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
              {installedPlugins.length}
            </span>
          )}
        </div>

        <div className="codex-sidebar-scroll" style={{ paddingTop: 2 }}>
          {installedPlugins.length === 0 ? (
            <div style={{ padding: '4px 10px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
              未安装任何插件
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {installedPlugins.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="codex-sidebar-row"
                  onClick={() => openPluginModal(p)}
                >
                  <span
                    style={getPluginTileStyle(p, theme, {
                      width: 18,
                      height: 18,
                      borderRadius: resolvePluginLogoSpec(p)?.circular ? 9999 : 5,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flex: 'none',
                    })}
                  >
                    <PluginTileGraphic plugin={p} theme={theme} size={11} />
                  </span>
                  <span className="codex-sidebar-row-text">{p.name}</span>
                  <span className="codex-status-dot" data-tone="live" title="已启用" />
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* Right Rounded Surface Card */}
      <section className="codex-settings-body">
        <div className="codex-custom-inner">
          {/* Header Row (Exact Screenshots 1 & 2) */}
          <div className="codex-custom-topbar">
            <div>
              <h1 className="codex-custom-title">
                {activeTab === 'plugins' ? '插件' : '技能'}
              </h1>
              <p className="codex-custom-sub">
                {activeTab === 'plugins'
                  ? '连接插件，让 Codex 在你的各类工具中协同工作'
                  : '通过任务专用技能扩展 Codex'}
              </p>
            </div>

            <div className="codex-custom-actions">
              <div className="codex-custom-search">
                <IconSearch size={14} style={{ flex: 'none' }} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={activeTab === 'plugins' ? '搜索插件' : '搜索技能'}
                />
                {search && (
                  <button
                    type="button"
                    className="codex-icon-btn"
                    style={{ width: 18, height: 18 }}
                    onClick={() => setSearch('')}
                  >
                    <IconClose size={11} />
                  </button>
                )}
              </div>

              <button
                type="button"
                className="codex-icon-btn"
                title="刷新目录"
                aria-label="刷新"
                onClick={handleRefresh}
              >
                <IconRefresh
                  size={15}
                  style={{
                    transition: 'transform 0.35s ease',
                    transform: refreshing ? 'rotate(360deg)' : 'none',
                  }}
                />
              </button>

              <button
                type="button"
                className="codex-icon-btn"
                title="模型与连接设置"
                aria-label="打开设置"
                onClick={() => onOpenSettings('providers')}
              >
                <IconSettingsGear size={15} />
              </button>

              {activeTab === 'plugins' ? (
                <div style={{ position: 'relative' }} ref={addMenuRef}>
                  <button
                    type="button"
                    className="codex-toolbar-btn"
                    data-variant="primary"
                    style={{
                      borderRadius: 9999,
                      height: 30,
                      padding: '0 12px 0 14px',
                      fontSize: 12.5,
                      fontWeight: 500,
                      gap: 4,
                    }}
                    onClick={() => setAddMenuOpen((v) => !v)}
                  >
                    <span>添加</span>
                    <IconChevronDown size={13} />
                  </button>
                  {addMenuOpen && (
                    <div className="codex-popover" data-side="bottom" style={{ right: 0, width: 224 }}>
                      <button
                        type="button"
                        className="codex-popover-item"
                        onClick={() => {
                          setAddMenuOpen(false);
                          setAddModalMode('github');
                        }}
                      >
                        <span>从 GitHub 仓库安装插件</span>
                      </button>
                      <button
                        type="button"
                        className="codex-popover-item"
                        onClick={() => {
                          setAddMenuOpen(false);
                          setAddModalMode('plugin');
                        }}
                      >
                        <span>添加自定义 MCP 插件</span>
                      </button>
                      <button
                        type="button"
                        className="codex-popover-item"
                        onClick={() => {
                          setAddMenuOpen(false);
                          setAddModalMode('json');
                        }}
                      >
                        <span>从 mcpServers JSON 导入</span>
                      </button>
                      <div className="codex-popover-divider" />
                      <button
                        type="button"
                        className="codex-popover-item"
                        onClick={() => {
                          setAddMenuOpen(false);
                          setActiveTab('skills');
                          setAddModalMode('skill');
                        }}
                      >
                        <span>创建新技能 (SKILL.md)</span>
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="primary"
                  style={{
                    borderRadius: 9999,
                    height: 30,
                    padding: '0 14px',
                    fontSize: 12.5,
                    fontWeight: 500,
                  }}
                  onClick={() => setAddModalMode('skill')}
                >
                  添加
                </button>
              )}
            </div>
          </div>

          {activeTab === 'plugins' ? (
            /* ============================================================
             * PLUGINS MARKETPLACE TAB (Real Codex Catalog + Creativity!)
             * ========================================================== */
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div className="codex-custom-pill-tabs">
                  <button
                    type="button"
                    className="codex-custom-pill"
                    data-active={pluginScope === 'public' ? 'true' : undefined}
                    onClick={() => setPluginScope('public')}
                  >
                    公开
                  </button>
                  <button
                    type="button"
                    className="codex-custom-pill"
                    data-active={pluginScope === 'creativity' ? 'true' : undefined}
                    onClick={() => setPluginScope('creativity')}
                  >
                    Creativity ({creativityCount})
                  </button>
                  {installedPlugins.length > 0 && (
                    <button
                      type="button"
                      className="codex-custom-pill"
                      data-active={pluginScope === 'installed' ? 'true' : undefined}
                      onClick={() => setPluginScope('installed')}
                    >
                      已安装 ({installedPlugins.length})
                    </button>
                  )}
                </div>

                {catalogSource?.available && (
                  <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }} className="tabular-nums">
                    独立插件与技能中心 · GitHub / MCP 开放源（无需本机安装 Codex）
                  </span>
                )}
              </div>

              {remoteSearching && search.trim() ? (
                <div style={{ padding: '18px 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                  正在检索 Codex 插件目录…
                </div>
              ) : groupedPlugins.length === 0 ? (
                <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--text-tertiary)' }}>
                  没有匹配的插件，点击右上角「添加 ⌄」可接入自定义 MCP 服务。
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                  {groupedPlugins.map((group) => {
                    const isExpanded =
                      Boolean(expandedCategories[group.category]) ||
                      pluginScope === 'creativity' ||
                      Boolean(search.trim());
                    const limit = group.category === 'Creativity' ? 6 : 8;
                    const visibleItems = isExpanded ? group.items : group.items.slice(0, limit);
                    const moreCount = Math.max(0, group.items.length - visibleItems.length);
                    return (
                      <div key={group.category} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 8,
                          }}
                        >
                          <div className="codex-custom-cat-heading">{group.category}</div>
                          {moreCount > 0 && (
                            <button
                              type="button"
                              style={{ fontSize: 12, color: 'var(--text-tertiary)' }}
                              onClick={() =>
                                setExpandedCategories((prev) => ({
                                  ...prev,
                                  [group.category]: true,
                                }))
                              }
                            >
                              查看全部 {group.items.length} 项 →
                            </button>
                          )}
                        </div>
                        <div className="codex-custom-grid">
                          {visibleItems.map((p) => {
                            const isInstalled = installedPluginSet.has(p.id);
                            const isBusy = installingId === p.id;
                            return (
                              <div
                                key={p.id}
                                role="button"
                                tabIndex={0}
                                className="codex-custom-card"
                                onClick={() => openPluginModal(p)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') openPluginModal(p);
                                }}
                              >
                                <div className="codex-custom-card-left">
                                  <span
                                    className="codex-custom-icon-tile"
                                    style={getPluginTileStyle(p, theme)}
                                  >
                                    <PluginTileGraphic plugin={p} theme={theme} size={19} />
                                  </span>
                                  <div className="codex-custom-card-meta">
                                    <span className="codex-custom-card-name">
                                      <span>{p.name}</span>
                                      <PluginMetaIcon />
                                      {p.transport === 'GitHub · Open Source' && (
                                        <span
                                          style={{
                                            fontSize: 10,
                                            padding: '0 5px',
                                            borderRadius: 999,
                                            background: 'var(--color-accent-soft)',
                                            color: 'var(--color-text-accent)',
                                            fontWeight: 500,
                                          }}
                                        >
                                          GitHub
                                        </span>
                                      )}
                                    </span>
                                    <span className="codex-custom-card-desc">{p.description}</span>
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  className="codex-custom-plus-btn"
                                  data-installed={isInstalled ? 'true' : undefined}
                                  disabled={isBusy}
                                  title={isInstalled ? `已安装 ${p.name}（点击配置）` : `安装 ${p.name}`}
                                  aria-label={isInstalled ? `已安装 ${p.name}` : `安装 ${p.name}`}
                                  onClick={(e) => void handleInstallClick(p, e)}
                                >
                                  {isBusy ? (
                                    <span className="codex-sidebar-spinner" />
                                  ) : isInstalled ? (
                                    <IconCheck size={15} />
                                  ) : (
                                    <IconPlus size={15} />
                                  )}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                        {isExpanded && group.items.length > limit && !search.trim() && pluginScope === 'public' && (
                          <button
                            type="button"
                            style={{ alignSelf: 'flex-start', fontSize: 12, color: 'var(--text-tertiary)' }}
                            onClick={() =>
                              setExpandedCategories((prev) => ({
                                ...prev,
                                [group.category]: false,
                              }))
                            }
                          >
                            收起 {group.category}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            /* ============================================================
             * SKILLS TAB (Exact 1:1 with Screenshot 1: 已安装 + 个人 / 系统 / 推荐)
             * ========================================================== */
            <>
              {/* Top Section: 已安装 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="codex-custom-section-label">已安装</div>
                {installedSkills.length === 0 ? (
                  <div style={{ padding: '14px 0', fontSize: 13, color: 'var(--text-tertiary)' }}>
                    暂无匹配的已安装技能
                  </div>
                ) : (
                  <>
                    <div className="codex-custom-grid">
                      {visibleInstalledSkills.map((sk) => (
                        <div
                          key={`inst-sk-${sk.id}`}
                          role="button"
                          tabIndex={0}
                          className="codex-custom-card"
                          onClick={() => openSkillModal(sk)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') openSkillModal(sk);
                          }}
                        >
                          <div className="codex-custom-card-left">
                            <span className="codex-custom-icon-tile">
                              <SkillCubeIcon hue={sk.hue} size={20} />
                            </span>
                            <div className="codex-custom-card-meta">
                              <span className="codex-custom-card-name">{sk.name}</span>
                              <span className="codex-custom-card-desc">{sk.description}</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="codex-custom-plus-btn"
                            data-installed="true"
                            title="已启用（点击停用）"
                            aria-label={`停用 ${sk.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleInstallSkill(sk.id);
                            }}
                          >
                            <IconCheck size={15} />
                          </button>
                        </div>
                      ))}
                    </div>

                    {(hiddenInstalledSkills.length > 0 || showAllInstalledSkills) &&
                      installedSkills.length > 6 && (
                        <button
                          type="button"
                          style={{
                            alignSelf: 'flex-start',
                            fontSize: 12,
                            color: 'var(--text-tertiary)',
                            padding: '4px 2px',
                          }}
                          onClick={() => setShowAllInstalledSkills((v) => !v)}
                        >
                          {showAllInstalledSkills
                            ? '收起已安装技能'
                            : `查看 ${hiddenInstalledSkills
                                .slice(0, 2)
                                .map((s) => s.name)
                                .join(', ')}，另有 ${hiddenInstalledSkills.length} 项`}
                        </button>
                      )}
                  </>
                )}
              </div>

              {/* Lower Scope Pill Switcher: 个人 | 系统 | 推荐 (Exact Screenshot 1!) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
                <div className="codex-custom-pill-tabs">
                  <button
                    type="button"
                    className="codex-custom-pill"
                    data-active={skillScope === 'personal' ? 'true' : undefined}
                    onClick={() => {
                      setSkillScope('personal');
                      setShowAllScopedSkills(false);
                    }}
                  >
                    个人
                  </button>
                  <button
                    type="button"
                    className="codex-custom-pill"
                    data-active={skillScope === 'system' ? 'true' : undefined}
                    onClick={() => {
                      setSkillScope('system');
                      setShowAllScopedSkills(false);
                    }}
                  >
                    系统
                  </button>
                  <button
                    type="button"
                    className="codex-custom-pill"
                    data-active={skillScope === 'recommended' ? 'true' : undefined}
                    onClick={() => {
                      setSkillScope('recommended');
                      setShowAllScopedSkills(false);
                    }}
                  >
                    推荐
                  </button>
                </div>

                {scopedSkills.length === 0 ? (
                  <div style={{ padding: '16px 0', fontSize: 13, color: 'var(--text-tertiary)' }}>
                    该分类下暂无匹配的技能，点击右上角「添加」创建新的技能。
                  </div>
                ) : (
                  <>
                    <div className="codex-custom-grid">
                      {visibleScopedSkills.map((sk) => (
                        <div
                          key={`scope-sk-${sk.id}`}
                          role="button"
                          tabIndex={0}
                          className="codex-custom-card"
                          onClick={() => openSkillModal(sk)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') openSkillModal(sk);
                          }}
                        >
                          <div className="codex-custom-card-left">
                            <span className="codex-custom-icon-tile">
                              <SkillCubeIcon hue={sk.hue} size={20} />
                            </span>
                            <div className="codex-custom-card-meta">
                              <span className="codex-custom-card-name">{sk.name}</span>
                              <span className="codex-custom-card-desc">{sk.description}</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="codex-custom-plus-btn"
                            data-installed={sk.installed ? 'true' : undefined}
                            title={sk.installed ? '已启用（点击停用）' : '安装此技能'}
                            aria-label={sk.installed ? `已启用 ${sk.name}` : `安装 ${sk.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleInstallSkill(sk.id);
                            }}
                          >
                            {sk.installed ? <IconCheck size={15} /> : <IconPlus size={15} />}
                          </button>
                        </div>
                      ))}
                    </div>

                    {(hiddenScopedSkills.length > 0 || showAllScopedSkills) &&
                      scopedSkills.length > 6 && (
                        <button
                          type="button"
                          style={{
                            alignSelf: 'flex-start',
                            fontSize: 12,
                            color: 'var(--text-tertiary)',
                            padding: '4px 2px',
                          }}
                          onClick={() => setShowAllScopedSkills((v) => !v)}
                        >
                          {showAllScopedSkills
                            ? '收起列表'
                            : `查看 ${hiddenScopedSkills
                                .slice(0, 2)
                                .map((s) => s.name)
                                .join(', ')}，另有 ${hiddenScopedSkills.length} 项`}
                        </button>
                      )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </section>

      {/* Plugin Detail & MCP Configuration Modal */}
      {selectedPlugin && (
        <div
          className="codex-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`配置插件 ${selectedPlugin.name}`}
          onClick={() => setSelectedPlugin(null)}
        >
          <div className="codex-modal" style={{ width: 520, maxHeight: '86vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span
                  className="codex-custom-icon-tile"
                  style={getPluginTileStyle(selectedPlugin, theme, {
                    width: 42,
                    height: 42,
                  })}
                >
                  <PluginTileGraphic plugin={selectedPlugin} theme={theme} size={22} />
                </span>
                <div>
                  <div style={{ fontSize: 15.5, fontWeight: 600, color: 'var(--text-default)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>{selectedPlugin.name}</span>
                    {selectedPlugin.version && (
                      <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-tertiary)' }}>
                        v{selectedPlugin.version}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                    {selectedPlugin.author} · {selectedPlugin.transport} · {selectedPlugin.category}
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="codex-icon-btn"
                aria-label="关闭"
                onClick={() => setSelectedPlugin(null)}
              >
                <IconClose size={15} />
              </button>
            </div>

            <p style={{ margin: '12px 0 14px', fontSize: 13, lineHeight: '20px', color: 'var(--text-secondary)' }}>
              {selectedPlugin.longDescription || selectedPlugin.description}
            </p>

            {/* Bundled Skills & Tools */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-tertiary)', marginBottom: 6 }}>
                内置技能与工具 ({(selectedPlugin.bundledSkills?.length ? selectedPlugin.bundledSkills : selectedPlugin.tools).length})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, maxHeight: 112, overflowY: 'auto' }}>
                {(selectedPlugin.bundledSkills?.length ? selectedPlugin.bundledSkills : selectedPlugin.tools).map((t) => (
                  <code key={t} className="codex-inline-code" style={{ fontSize: 11.5 }}>
                    {t}
                  </code>
                ))}
              </div>
            </div>

            {/* Official Default Prompts — 1-click try in chat! */}
            {selectedPlugin.defaultPrompts && selectedPlugin.defaultPrompts.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-tertiary)', marginBottom: 6 }}>
                  推荐示例（点击直接带入对话）
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {selectedPlugin.defaultPrompts.slice(0, 3).map((prompt, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className="codex-popover-item"
                      style={{
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 9,
                        padding: '6px 10px',
                        fontSize: 12.5,
                        color: 'var(--text-secondary)',
                        justifyContent: 'space-between',
                      }}
                      onClick={() => {
                        setSelectedPlugin(null);
                        onTryPrompt(`@${selectedPlugin.name} ${prompt}`);
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {prompt}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--color-link)', flex: 'none' }}>试一试 →</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Configure only plugins with a remote or local MCP endpoint. */}
            {selectedPlugin.transport !== 'Built-in · Skills' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  插件渠道 / MCP 服务地址
                </span>
                <input
                  className="codex-input"
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                  value={editEndpoint}
                  onChange={(e) => setEditEndpoint(e.target.value)}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  访问凭据 / OAuth Token（仅驻留当前会话内存，不写入磁盘）
                </span>
                <input
                  type="password"
                  className="codex-input"
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                  value={editToken}
                  onChange={(e) => setEditToken(e.target.value)}
                  placeholder="可选，例如 ntn_*** / lin_api_*** / figd_***"
                />
              </label>
            </div>

            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 18 }}>
              {installedPluginSet.has(selectedPlugin.id) ? (
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="danger"
                  onClick={() => {
                    void onToggleInstallPlugin(selectedPlugin);
                    setSelectedPlugin(null);
                  }}
                >
                  卸载插件
                </button>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                  {selectedPlugin.githubSkillSpec
                    ? `将直接从 GitHub (${selectedPlugin.githubSkillSpec.repo}) 下载并安装到本应用目录`
                    : '安装后将同步至左侧「已安装」并支持聊天 @ 调用'}
                </span>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="outline"
                  onClick={() => setSelectedPlugin(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="primary"
                  hidden={selectedPlugin.transport === 'Built-in · Skills' && installedPluginSet.has(selectedPlugin.id)}
                  onClick={() => {
                    if (selectedPlugin.transport !== 'Built-in · Skills') void onSavePluginConfig(selectedPlugin, editEndpoint.trim(), editToken);
                    if (!installedPluginSet.has(selectedPlugin.id)) {
                      void onToggleInstallPlugin(selectedPlugin);
                    }
                    setSelectedPlugin(null);
                  }}
                >
                  {installedPluginSet.has(selectedPlugin.id) ? '保存配置' : '安装并启用'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Skill Detail / Prompt Editor Modal */}
      {selectedSkill && (
        <div
          className="codex-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`技能详情 ${selectedSkill.name}`}
          onClick={() => setSelectedSkill(null)}
        >
          <div className="codex-modal" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="codex-custom-icon-tile" style={{ width: 38, height: 38 }}>
                  <SkillCubeIcon hue={selectedSkill.hue} size={20} />
                </span>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-default)' }}>
                    {selectedSkill.name}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                    {selectedSkill.scope === 'personal'
                      ? '个人技能'
                      : selectedSkill.scope === 'system'
                        ? '系统技能'
                        : '推荐技能'}{' '}
                    · {selectedSkill.installed ? '已启用' : '未安装'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="codex-icon-btn"
                aria-label="关闭"
                onClick={() => setSelectedSkill(null)}
              >
                <IconClose size={15} />
              </button>
            </div>

            <p style={{ margin: '10px 0 12px', fontSize: 13, color: 'var(--text-secondary)' }}>
              {selectedSkill.description}
            </p>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                技能指令（SKILL.md）
              </span>
              <textarea
                rows={4}
                className="codex-input"
                style={{
                  width: '100%',
                  height: 'auto',
                  padding: '8px 10px',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 12.5,
                  lineHeight: '19px',
                  resize: 'vertical',
                }}
                value={editSkillInstructions}
                onChange={(e) => setEditSkillInstructions(e.target.value)}
              />
            </label>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="outline"
                  onClick={() => {
                    onToggleInstallSkill(selectedSkill.id);
                    setSelectedSkill((cur) => (cur ? { ...cur, installed: !cur.installed } : null));
                  }}
                >
                  {selectedSkill.installed ? '停用技能' : '安装并启用'}
                </button>
                {selectedSkill.custom && (
                  <button
                    type="button"
                    className="codex-toolbar-btn"
                    data-variant="danger"
                    onClick={() => {
                      onDeleteCustomSkill(selectedSkill.id);
                      setSelectedSkill(null);
                    }}
                  >
                    删除
                  </button>
                )}
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="outline"
                  onClick={() => setSelectedSkill(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="codex-toolbar-btn"
                  data-variant="primary"
                  onClick={() => {
                    onUpdateSkill(selectedSkill.id, { instructions: editSkillInstructions.trim() });
                    setSelectedSkill(null);
                  }}
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Custom Plugin / JSON Import / New Skill Modal */}
      {addModalMode && (
        <div
          className="codex-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="添加插件或技能"
          onClick={() => setAddModalMode(null)}
        >
          <form
            className="codex-modal"
            style={{ width: 472 }}
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleCreateCustom}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ fontSize: 15.5, fontWeight: 600, color: 'var(--text-default)' }}>
                {addModalMode === 'github'
                  ? '从 GitHub 仓库安装开源插件'
                  : addModalMode === 'plugin'
                    ? '添加自定义第三方插件 (MCP)'
                    : addModalMode === 'json'
                      ? '从 mcpServers JSON 导入插件'
                      : '创建新技能 (SKILL.md)'}
              </span>
              <button
                type="button"
                className="codex-icon-btn"
                aria-label="关闭"
                onClick={() => setAddModalMode(null)}
              >
                <IconClose size={15} />
              </button>
            </div>

            {addModalMode === 'github' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                    GitHub 仓库链接（支持任意含 SKILL.md / README.md 的公开仓库）
                  </span>
                  <input
                    autoFocus
                    required
                    className="codex-input"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
                    placeholder="https://github.com/remotion-dev/remotion"
                    value={githubRepoUrl}
                    onChange={(e) => setGithubRepoUrl(e.target.value)}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>归属分类</span>
                  <select
                    className="codex-select"
                    value={githubCategory}
                    onChange={(e) => setGithubCategory(e.target.value as PluginCategoryId)}
                  >
                    {PLUGIN_CATEGORY_ORDER.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </label>
                <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                  直接拉取公开仓库内容并保存到本应用独立目录，完全不依赖本机安装其他客户端。
                </span>
              </div>
            ) : addModalMode === 'plugin' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>插件名称</span>
                  <input
                    autoFocus
                    required
                    className="codex-input"
                    placeholder="例如：Notion Team / Custom Wiki MCP"
                    value={newPluginName}
                    onChange={(e) => setNewPluginName(e.target.value)}
                  />
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 8 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>所属分类</span>
                    <select
                      className="codex-select"
                      value={newPluginCategory}
                      onChange={(e) => setNewPluginCategory(e.target.value as PluginCategoryId)}
                    >
                      {PLUGIN_CATEGORY_ORDER.map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>协议方式</span>
                    <select
                      className="codex-select"
                      value={newPluginTransport}
                      onChange={(e) =>
                        setNewPluginTransport(e.target.value as MarketplacePlugin['transport'])
                      }
                    >
                      <option value="MCP · HTTP">MCP · HTTP</option>
                      <option value="MCP · Stdio">MCP · Stdio</option>
                      <option value="OAuth 2.0">OAuth 2.0</option>
                    </select>
                  </label>
                </div>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>简介</span>
                  <input
                    className="codex-input"
                    placeholder="简述该插件提供的工具能力"
                    value={newPluginDesc}
                    onChange={(e) => setNewPluginDesc(e.target.value)}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>URL 或启动命令</span>
                  <input
                    className="codex-input"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
                    placeholder="https://... 或 npx -y @org/mcp"
                    value={newPluginEndpoint}
                    onChange={(e) => setNewPluginEndpoint(e.target.value)}
                  />
                </label>
              </div>
            ) : addModalMode === 'json' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                  粘贴标准 MCP 配置（兼容 Claude Desktop / Cursor / Codex `mcpServers` 格式）：
                </span>
                <textarea
                  rows={8}
                  className="codex-input"
                  style={{
                    height: 'auto',
                    padding: '9px 10px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    lineHeight: '18px',
                    resize: 'vertical',
                  }}
                  value={jsonImportText}
                  onChange={(e) => setJsonImportText(e.target.value)}
                />
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>技能名称</span>
                  <input
                    autoFocus
                    required
                    className="codex-input"
                    placeholder="例如：Release Notes Writer"
                    value={newSkillName}
                    onChange={(e) => setNewSkillName(e.target.value)}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>一句话描述</span>
                  <input
                    className="codex-input"
                    placeholder="何时激活以及此技能擅长完成的任务"
                    value={newSkillDesc}
                    onChange={(e) => setNewSkillDesc(e.target.value)}
                  />
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>归属作用域：</span>
                  <button
                    type="button"
                    className="codex-custom-pill"
                    data-active={newSkillScope === 'personal' ? 'true' : undefined}
                    onClick={() => setNewSkillScope('personal')}
                  >
                    个人
                  </button>
                  <button
                    type="button"
                    className="codex-custom-pill"
                    data-active={newSkillScope === 'system' ? 'true' : undefined}
                    onClick={() => setNewSkillScope('system')}
                  >
                    系统
                  </button>
                </div>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>执行指令 (SKILL.md)</span>
                  <textarea
                    rows={4}
                    className="codex-input"
                    style={{ height: 'auto', padding: '8px 10px', resize: 'vertical', lineHeight: '19px' }}
                    placeholder="描述此技能的步骤规范、约束条件和输出格式…"
                    value={newSkillInstructions}
                    onChange={(e) => setNewSkillInstructions(e.target.value)}
                  />
                </label>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button
                type="button"
                className="codex-toolbar-btn"
                data-variant="outline"
                onClick={() => setAddModalMode(null)}
              >
                取消
              </button>
              <button type="submit" className="codex-toolbar-btn" data-variant="primary">
                <IconPlus size={13} />
                <span>
                  {addModalMode === 'json'
                    ? '导入并安装'
                    : addModalMode === 'plugin'
                      ? '添加并安装'
                      : '创建并启用'}
                </span>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
