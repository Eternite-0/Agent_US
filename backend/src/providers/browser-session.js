// Provider sessions never accept a caller-supplied upstream URL. The pool's
// two public protocols and the agent SDK all use the same scoped transport.
import {
  startWorkBuddy,
  workBuddyRequest,
  refreshWorkBuddy,
} from './workbuddy.js';
import { startCodeArts, codeArtsRequest, refreshCodeArts } from './codearts.js';

import { startTrae, refreshTrae, traeRequest } from './trae.js';
const trae = (name, web, auth, api, version, plugin, us) => ({
  name,
  web,
  auth,
  api,
  us,
  version,
  plugin,
  endpoint: api + '/v1',
  start: startTrae,
  refresh: refreshTrae,
  request: traeRequest,
});
const cn = trae(
  'Trae 中国版',
  'https://www.trae.cn',
  'https://api.trae.cn',
  'https://trae-api-cn.mchost.guru',
  '3.3.65',
  '2.3.24254',
);
const globalTrae = trae(
  'Trae 国际版',
  'https://www.trae.ai',
  'https://growsg-normal.trae.ai',
  'https://coresg-normal.trae.ai',
  '3.5.51',
  '2.3.62834',
  'https://coreva-normal.trae.ai',
);
const wb = (name, origin, platform) => ({
  name,
  origin,
  platform,
  endpoint: origin + '/v2',
  start: startWorkBuddy,
  request: workBuddyRequest,
  refresh: refreshWorkBuddy,
});
const intl = wb('WorkBuddy 国际版', 'https://www.workbuddy.ai', 'workbuddy-ai');
export const nativeProviders = new Map(
  Object.entries({
    trae: cn,
    'trae-cn': cn,
    'trae-global': globalTrae,
    workbuddy: wb('WorkBuddy', 'https://copilot.tencent.com', 'workbuddy'),
    'workbuddy-intl': intl,
    'workbuddy-ai': intl,
    codearts: {
      name: 'CodeArts',
      endpoint: 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2',
      start: startCodeArts,
      request: codeArtsRequest,
      refresh: refreshCodeArts,
    },
  }),
);

export async function nativeRequest(provider, getSession, input, init) {
  const req = new Request(input, init);
  const models =
    req.method === 'GET' && req.url === provider.endpoint + '/models';
  if (
    !models &&
    !(
      req.method === 'POST' &&
      req.url === provider.endpoint + '/chat/completions'
    )
  ) {
    throw new Error('原生登录账号只允许请求供应商自己的模型目录和对话端点');
  }
  let response;
  try {
    const session = await getSession();
    response = await provider.request(provider, session, models, req);
  } catch (err) {
    req.signal.throwIfAborted();
    // JSON parse errors can include excerpts of an STS or other credential response.
    if (err instanceof SyntaxError || err instanceof TypeError)
      throw new Error(`${provider.name} 请求失败，请检查网络或重新授权`);
    throw err;
  }
  if (response.ok) return response;
  // Never persist arbitrary vendor response bodies in pool diagnostics.
  await response.body?.cancel();
  return Response.json(
    { error: { message: `${provider.name} HTTP ${response.status}` } },
    {
      status: response.status,
      headers: response.headers.has('retry-after')
        ? { 'retry-after': response.headers.get('retry-after') }
        : {},
    },
  );
}
