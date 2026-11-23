import { PROVIDER_LOGO_FILE } from '../data/providerLogoFiles';
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
    [/opendesign/, 'opendesign.svg'],
    [/nous|nous-portal/, 'nous-portal.svg'],
    [/kimi.?code/, 'kimi-code.png'],
    [/opencode/, 'opencode.svg'],
    [/agent2api/, 'agent2api.png'],
    [/deepseek/, 'deepseek.png'],
    [/openai|chatgpt/, 'openai.png'],
    [/anthropic|claude/, 'anthropic.png'],
    [/gemini/, 'gemini-cli.svg'],
    [/openrouter/, 'openrouter.png'],
    [/siliconflow|硅基/, 'siliconcloud-color.svg'],
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
