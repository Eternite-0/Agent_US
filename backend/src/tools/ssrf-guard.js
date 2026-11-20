import dns from 'node:dns';
import net from 'node:net';
import { PolicyError } from '../kernel/errors.js';

export function isPrivateIpAddress(ip) {
  const clean = String(ip ?? '').trim().toLowerCase();
  if (!clean) return true;
  if (clean === '::1' || clean === '::' || clean === 'localhost') return true;
  const v4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(clean);
  if (v4Mapped) return isPrivateIpAddress(v4Mapped[1]);
  const v4HexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(clean);
  if (v4HexMapped) {
    const hi = parseInt(v4HexMapped[1], 16);
    const lo = parseInt(v4HexMapped[2], 16);
    return isPrivateIpAddress(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
  }
  if (clean.startsWith('fc') || clean.startsWith('fd') || clean.startsWith('fe80:')) {
    return true;
  }
  if (net.isIPv4(clean)) {
    const [a, b] = clean.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  return false;
}

export function isPrivateHostnameLiteral(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.lan')
  ) {
    return true;
  }
  if (net.isIP(h)) return isPrivateIpAddress(h);
  return false;
}

/**
 * Validates an external HTTPS URL syntactically AND against resolved DNS addresses
 * to prevent DNS rebinding and literal loopback/RFC1918 SSRF.
 */
export async function validateExternalUrl(rawUrl, { lookupImpl = dns.promises.lookup } = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl ?? ''));
  } catch {
    throw new PolicyError('INVALID_URL', { message: '无效 URL' });
  }
  if (parsed.protocol !== 'https:') {
    throw new PolicyError('URL_PROTOCOL_BLOCKED', {
      message: 'web_fetch 仅允许公开 https:// 链接',
    });
  }
  if (parsed.username || parsed.password) {
    throw new PolicyError('URL_CREDENTIALS_BLOCKED', {
      message: '不允许在 URL 中携带凭据',
    });
  }
  if (isPrivateHostnameLiteral(parsed.hostname)) {
    throw new PolicyError('SSRF_BLOCKED', {
      message: `安全拦截：不允许访问本机或内网地址 (${parsed.hostname})`,
    });
  }

  let resolved;
  try {
    resolved = await lookupImpl(parsed.hostname, { all: true });
  } catch (err) {
    throw new PolicyError('DNS_RESOLUTION_FAILED', {
      message: `域名解析失败 (${parsed.hostname}): ${err?.message ?? err}`,
    });
  }
  const addrs = Array.isArray(resolved) ? resolved : [resolved];
  if (!addrs.length || addrs.some((a) => isPrivateIpAddress(a?.address ?? a))) {
    throw new PolicyError('SSRF_DNS_BLOCKED', {
      message: `安全拦截：域名 ${parsed.hostname} 解析到内网或保留 IP`,
    });
  }
  return parsed;
}

/**
 * Fetches an external HTTPS URL safely by disabling automatic redirects and
 * re-validating every redirect hop via validateExternalUrl().
 */
export async function safeFetchExternal(
  rawUrl,
  {
    lookupImpl = dns.promises.lookup,
    fetchImpl = fetch,
    maxRedirects = 3,
    timeoutMs = 12000,
    signal = undefined,
  } = {},
) {
  let currentUrl = String(rawUrl ?? '');
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = await validateExternalUrl(currentUrl, { lookupImpl });
    const timeoutSig = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
    const res = await fetchImpl(parsed.href, {
      headers: { 'User-Agent': 'Agent-US/1.0' },
      redirect: 'manual',
      signal: combined,
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw new PolicyError('SSRF_REDIRECT_INVALID', {
          message: `HTTP ${res.status} redirect missing Location header`,
        });
      }
      currentUrl = new URL(location, parsed.href).href;
      continue;
    }
    return res;
  }
  throw new PolicyError('TOO_MANY_REDIRECTS', {
    message: `超过最大重定向次数 (${maxRedirects})`,
  });
}
