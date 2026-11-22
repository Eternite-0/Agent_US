import type { AppView, InspectorTab } from '../types/backend';
import {
  IconActivity, IconAgent, IconArchive, IconBranch, IconCompose, IconCopy, IconCpu,
  IconDagNodes, IconDatabase, IconDiffBox, IconFileDoc, IconFolder, IconFolderPlus,
  IconGlobe, IconHistory, IconKeyboard, IconPin, IconPlay, IconPlus, IconPuzzle,
  IconRailClock, IconReset, IconSearch, IconSettingsGear, IconShieldCheck, IconSparkle,
  IconStopSquare, IconSun, IconTerminal, IconUndo,
} from './Icons';

export type SwarmSection = 'plan' | 'messages' | 'artifacts';
export type CommandPopover = 'project' | 'branch' | 'permission' | 'effort' | 'models';
export type MentionExtension = { id: string; name: string; description: string; iconUrl?: string };
export type CommandAvailability = Readonly<Record<string, string | undefined>>;

export interface SlashCommand {
  cmd: string;
  desc: string;
  aliases?: string[];
  icon: typeof IconSearch;
  view?: AppView;
  inspector?: InspectorTab;
  swarmSection?: SwarmSection;
  popover?: CommandPopover;
  threadOnly?: boolean;
}

const settings = (section: string): AppView => ({ kind: 'settings', section });

export const commandGroups: Array<{ label: string; commands: SlashCommand[] }> = [
  { label: '会话', commands: [
    { cmd: '/new', desc: '开始新对话', icon: IconCompose, view: { kind: 'home' } },
    { cmd: '/search', desc: '搜索全部聊天和工作区', icon: IconSearch, aliases: ['history', '历史'] },
    { cmd: '/compact', desc: '压缩当前会话的上下文', icon: IconDatabase, threadOnly: true },
    { cmd: '/rewind', desc: '回退上一轮对话和文件变更', icon: IconUndo, threadOnly: true },
    { cmd: '/pin', desc: '置顶或取消置顶当前聊天', icon: IconPin, threadOnly: true },
    { cmd: '/archive-chat', desc: '归档当前聊天', icon: IconArchive, threadOnly: true },
    { cmd: '/restore', desc: '恢复当前归档聊天', icon: IconHistory, threadOnly: true },
    { cmd: '/archive', desc: '查找和恢复已归档的聊天', icon: IconArchive, view: settings('archived') },
    { cmd: '/copy-link', desc: '复制当前聊天链接', icon: IconCopy, threadOnly: true },
    { cmd: '/clear', desc: '清空输入与附件', icon: IconReset },
  ] },
  { label: '执行', commands: [
    { cmd: '/goal', desc: '输入目标并启动自主任务', icon: IconSparkle, aliases: ['目标'] },
    { cmd: '/swarm', desc: '查看自主任务的执行计划', icon: IconDagNodes, inspector: 'autonomous', swarmSection: 'plan', aliases: ['autonomous', 'swarm-plan'] },
    { cmd: '/messages', desc: '查看 Swarm 协作消息', icon: IconActivity, inspector: 'autonomous', swarmSection: 'messages', aliases: ['swarm-messages'] },
    { cmd: '/artifacts', desc: '查看 Swarm 文件产物', icon: IconArchive, inspector: 'autonomous', swarmSection: 'artifacts', aliases: ['swarm-artifacts'] },
    { cmd: '/agents', desc: '查看子智能体和运行详情', icon: IconAgent, inspector: 'subagents', aliases: ['dag', 'subagents'] },
    { cmd: '/plan', desc: '切换为 Work 规划与审批模式', icon: IconDagNodes },
    { cmd: '/run', desc: '切换为 Codex 执行模式', icon: IconPlay },
    { cmd: '/chat', desc: '切换为 Chat 对话模式', icon: IconCompose },
    { cmd: '/stop', desc: '暂停当前正在执行的对话任务', aliases: ['pause'], icon: IconStopSquare, threadOnly: true },
    { cmd: '/approvals', desc: '打开审批中心', icon: IconShieldCheck, view: settings('approvals') },
    { cmd: '/events', desc: '查看实时事件与版本记录', icon: IconActivity, inspector: 'events' },
    { cmd: '/tasks', desc: '打开定时任务', icon: IconRailClock, view: { kind: 'tasks' }, aliases: ['schedule', 'cron'] },
  ] },
  { label: '工作区', commands: [
    { cmd: '/project', desc: '选择工作区项目', icon: IconFolder, popover: 'project' },
    { cmd: '/new-project', desc: '新建工作区项目', icon: IconFolderPlus },
    { cmd: '/review', desc: '准备审查未提交变更的请求', icon: IconShieldCheck },
    { cmd: '/diff', desc: '查看当前会话的文件变更', icon: IconDiffBox, inspector: 'diff', threadOnly: true },
    { cmd: '/branch', desc: '查看和切换 Git 分支', icon: IconBranch, popover: 'branch', aliases: ['git'] },
    { cmd: '/attach', desc: '打开本地文件选择器', icon: IconPlus, aliases: ['upload'] },
    { cmd: '/folder', desc: '搜索并引用工作区文件夹', icon: IconFolder },
    { cmd: '/file', desc: '搜索并引用工作区文件', icon: IconFileDoc, aliases: ['mention'] },
    { cmd: '/plugins', desc: '打开插件管理', icon: IconPuzzle, view: { kind: 'capabilities' }, aliases: ['capabilities'] },
    { cmd: '/mcp', desc: '查看当前工作区的 MCP 服务状态', icon: IconTerminal, view: { kind: 'capabilities', section: 'mcp' } },
    { cmd: '/memory', desc: '查看工作区经验和持久记忆', icon: IconDatabase, view: settings('memory') },
    { cmd: '/skills', desc: '打开技能管理', icon: IconPuzzle, view: { kind: 'capabilities', section: 'skills' }, aliases: ['skill'] },
  ] },
  { label: '模型与设置', commands: [
    { cmd: '/model', desc: '选择当前对话的模型', icon: IconCpu, popover: 'models' },
    { cmd: '/effort', desc: '调整推理强度', icon: IconCpu, popover: 'effort' },
    { cmd: '/permissions', desc: '查看执行权限选项', icon: IconShieldCheck, popover: 'permission' },
    { cmd: '/models', desc: '打开模型管理', icon: IconCpu, view: settings('models') },
    { cmd: '/providers', desc: '查看和管理模型账号池', icon: IconGlobe, view: settings('providers') },
    { cmd: '/eval', desc: '打开评测中心和历史对比', icon: IconShieldCheck, view: { kind: 'evaluations' }, aliases: ['benchmark', 'evaluations'] },
    { cmd: '/usage', desc: '查看用量和费用', icon: IconActivity, view: settings('usage') },
    { cmd: '/connection', desc: '检查后端连接与端点', icon: IconTerminal, view: settings('connection') },
    { cmd: '/theme', desc: '切换浅色或深色主题', icon: IconSun },
    { cmd: '/appearance', desc: '打开外观和排版设置', icon: IconSun, view: settings('appearance') },
    { cmd: '/shortcuts', desc: '查看键盘快捷键', icon: IconKeyboard, view: settings('shortcuts'), aliases: ['keys'] },
    { cmd: '/security', desc: '打开安全护栏设置', icon: IconShieldCheck, view: settings('environment') },
    { cmd: '/checkin', desc: '打开签到中心', icon: IconActivity, view: settings('checkin') },
    { cmd: '/settings', desc: '打开常规设置', icon: IconSettingsGear, view: settings('general') },
    { cmd: '/help', desc: '显示全部快捷命令', icon: IconKeyboard, aliases: ['commands', '?'] },
  ] },
];

const commands = commandGroups.flatMap((group) => group.commands);

export function findSlashCommand(input: string) {
  if (!input.startsWith('/')) return undefined;
  const query = input.toLowerCase();
  return commands.find(({ cmd, aliases }) => cmd === query || aliases?.includes(query.slice(1)));
}

export function matchesSlashCommand(command: SlashCommand, query: string) {
  return command.cmd.includes(query) || command.desc.toLowerCase().includes(query.slice(1)) ||
    command.aliases?.some((alias) => alias.includes(query.slice(1)));
}
