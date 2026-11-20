import React, { useEffect, useState } from 'react';

const LOGO_MODULES = import.meta.glob<string>('../assets/providers/*.{png,svg,webp}', {
  eager: true,
  import: 'default',
});

const LOGO_URL_BY_FILE: Record<string, string> = {};
for (const [path, url] of Object.entries(LOGO_MODULES)) {
  const filename = path.split('/').pop();
  if (filename) LOGO_URL_BY_FILE[filename] = url;
}

const PROVIDER_LOGO_FILE: Record<string, string> = {
  // Agent channels (1:1 with Agent2API assets/providers/)
  workbuddy: 'workbuddy.png',
  'workbuddy-cn': 'workbuddy.png',
  'workbuddy-intl': 'workbuddy.png',
  raccoon: 'raccoon.png',
  catpaw: 'catpaw.png',
  autoclaw: 'autoclaw.png',
  'autoclaw-cn': 'autoclaw.png',
  'autoclaw-intl': 'autoclaw.png',
  qoder: 'qoder.png',
  'qoder-cn': 'qoder.png',
  'qoder-intl': 'qoder.png',
  cline: 'cline.png',
  'cline-free': 'cline.png',
  'cline-pass': 'cline.png',
  clinepass: 'cline.png',
  accio: 'accio.png',
  'accio-cn': 'accio.png',
  zcode: 'zcode.png',
  'zcode-cn': 'zcode.png',
  'zcode-intl': 'zcode.png',
  codearts: 'codearts.png',
  trae: 'trae.png',
  loomy: 'loomy.png',
  kuku: 'kuku.png',
  kukuai: 'kuku.png',
  monkeycode: 'monkeycode.png',
  'monkeycode-intl': 'monkeycode.png',
  'command-code': 'commandcode.png',
  commandcode: 'commandcode.png',
  antigravity: 'antigravity.png',
  officeace: 'officeace.png',
  orcaterm: 'orcaterm.png',
  modelscope: 'modelscope.png',
  'modelscope-cn': 'modelscope.png',
  'modelscope-intl': 'modelscope.png',
  atomcode: 'atomcode.png',
  astudio: 'astudio.png',
  'doubao-work': 'doubaowork.png',
  doubaowork: 'doubaowork.png',
  kiro: 'kiro.svg',
  'qianwen-work': 'qwenwork.svg',
  'qianwen-work-cn': 'qwenwork.svg',
  qwenwork: 'qwenwork.svg',
  tabbit: 'tabbit.png',
  'tabbit-cn': 'tabbit.png',
  lobsterai: 'lobsterai.png',
  'claude-code': 'claude-code.svg',
  'openai-codex': 'codex.png',
  codex: 'codex.png',
  'github-copilot': 'copilot.svg',
  copilot: 'copilot.svg',
  'gemini-cli': 'gemini-cli.svg',
  cursor: 'cursor.svg',
  'qwen-code': 'qwenwork.svg',
  devin: 'devin.svg',
  factory: 'factory.svg',
  zed: 'zed.svg',
  'glm-coding': 'glm.png',
  'xiaomi-mimo': 'xiaomi-tokenplan.png',

  // Web channels
  'chatgpt-web': 'openai.png',
  'claude-web': 'anthropic.png',
  'gemini-web': 'gemini-cli.svg',
  'deepseek-web': 'deepseek.png',
  'kimi-web': 'kimi-work.svg',
  'doubao-web': 'doubaowork.png',

  // Official API templates
  openai: 'openai.png',
  anthropic: 'anthropic.png',
  deepseek: 'deepseek.png',
  gemini: 'gemini-cli.svg',
  openrouter: 'openrouter.png',
  siliconflow: 'siliconflow.png',
  kimi: 'kimi-work.svg',
  'kimi-work': 'kimi-work.svg',
  zhipu: 'glm-cn.png',
  glm: 'glm.png',
  'glm-cn': 'glm-cn.png',
  chatglm: 'chatglm.png',
  qwen: 'alicode.png',
  alicode: 'alicode.png',
  'alicode-intl': 'alicode-intl.png',
  'alims-intl': 'alims-intl.png',
  'alitp-intl': 'alitp-intl.png',
  minimax: 'minimax.png',
  'minimax-cn': 'minimax-cn.png',
  'minimax-code': 'minimax-code.svg',
  xai: 'grok.svg',
  grok: 'grok.svg',
  volcengine: 'volcengine-ark.png',
  'volcengine-ark': 'volcengine-ark.png',
  huggingface: 'huggingface.png',
  nvidia: 'nvidia.png',
  sensenova: 'sensenova.png',
  'opencode-go': 'opencode-go.png',
  'opencode-zen': 'opencode-zen.png',
  'xiaomi-tokenplan': 'xiaomi-tokenplan.png',

  // Built / local gateways & custom APIs
  agent2api: 'agent2api.png',
  'new-api': 'newapi.png',
  newapi: 'newapi.png',
  sub2api: 'sub2api.png',
  ollama: 'ollama-local.png',
  'ollama-local': 'ollama-local.png',
  'custom-openai': 'openai.png',
  'custom-anthropic': 'anthropic.png',
};

export function resolveProviderLogoUrl(providerId?: string | null, label?: string | null): string | null {
  const key = String(providerId || '').trim().toLowerCase();
  if (key && PROVIDER_LOGO_FILE[key]) {
    return LOGO_URL_BY_FILE[PROVIDER_LOGO_FILE[key]] ?? null;
  }
  // Fuzzy prefix/name match for dynamic check-in group labels or custom bridge IDs
  const combined = `${key} ${String(label || '').toLowerCase()}`;
  const hints: Array<[RegExp, string]> = [
    [/workbuddy/, 'workbuddy.png'],
    [/raccoon|小浣熊/, 'raccoon.png'],
    [/catpaw/, 'catpaw.png'],
    [/autoclaw/, 'autoclaw.png'],
    [/qoder/, 'qoder.png'],
    [/cline/, 'cline.png'],
    [/accio/, 'accio.png'],
    [/zcode/, 'zcode.png'],
    [/codearts/, 'codearts.png'],
    [/trae/, 'trae.png'],
    [/loomy/, 'loomy.png'],
    [/kuku/, 'kuku.png'],
    [/monkeycode/, 'monkeycode.png'],
    [/command.?code/, 'commandcode.png'],
    [/antigravity/, 'antigravity.png'],
    [/officeace|果办/, 'officeace.png'],
    [/orcaterm/, 'orcaterm.png'],
    [/modelscope|魔搭/, 'modelscope.png'],
    [/atomcode/, 'atomcode.png'],
    [/astudio/, 'astudio.png'],
    [/doubao|豆包/, 'doubaowork.png'],
    [/kiro/, 'kiro.svg'],
    [/qianwen|千问|qwen/, 'qwenwork.svg'],
    [/tabbit/, 'tabbit.png'],
    [/agent2api/, 'agent2api.png'],
    [/deepseek/, 'deepseek.png'],
    [/openai|chatgpt/, 'openai.png'],
    [/anthropic|claude/, 'anthropic.png'],
    [/gemini/, 'gemini-cli.svg'],
    [/openrouter/, 'openrouter.png'],
    [/siliconflow|硅基/, 'siliconflow.png'],
    [/kimi|moonshot/, 'kimi-work.svg'],
    [/zhipu|智谱|glm/, 'glm-cn.png'],
    [/minimax/, 'minimax.png'],
    [/grok|xai/, 'grok.svg'],
    [/volc|火山/, 'volcengine-ark.png'],
    [/ollama/, 'ollama-local.png'],
    [/new.?api/, 'newapi.png'],
  ];
  for (const [re, file] of hints) {
    if (re.test(combined)) return LOGO_URL_BY_FILE[file] ?? null;
  }
  return null;
}

interface ProviderLogoProps {
  providerId?: string | null;
  name?: string | null;
  icon?: string | null;
  color?: string | null;
  size?: 'md' | 'sm' | 'xs';
}

export const ProviderLogo: React.FC<ProviderLogoProps> = ({
  providerId,
  name,
  icon,
  color,
  size = 'md',
}) => {
  const url = resolveProviderLogoUrl(providerId, name);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [url]);

  const cls =
    size === 'xs'
      ? 'a2a-provider-badge-xs'
      : size === 'sm'
        ? 'a2a-provider-badge-sm'
        : 'a2a-provider-badge';

  if (url && !failed) {
    return (
      <span className={`${cls} has-icon`}>
        <img
          src={url}
          alt={name || providerId || 'provider'}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }

  const fallback =
    (icon && icon.trim()) ||
    (name && name.trim().slice(0, 2).toUpperCase()) ||
    (providerId && providerId.trim().slice(0, 2).toUpperCase()) ||
    'AI';

  return (
    <span className={cls} style={{ background: color || '#2563eb' }}>
      {fallback}
    </span>
  );
};
