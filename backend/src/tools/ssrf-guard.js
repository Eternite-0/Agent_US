import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import { PolicyError } from '../kernel/errors.js';

function parseIpv4ToUint32(ip) {
  if (!net.isIPv4(ip)) return null;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function isPrivateIpv4Uint32(u32) {
  if (u32 === null) return true;
  const a = (u32 >>> 24) & 0xff;
  const b = (u32 >>> 16) & 0xff;
  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 0 && ((u32 >>> 8) & 0xff) === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if ((u32 >>> 28) === 14) return true; // 224.0.0.0/4 (multicast)
  if ((u32 >>> 28) === 15) return true; // 240.0.0.0/4 (reserved + 255.255.255.255 broadcast)
  return false;
}

function parseIpv6ToBigInt(rawIp) {
  let ip = String(rawIp ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!ip) return null;
  // Reject/flag any zone ID immediately via caller; strip cannot make zone-scoped link-local public
  if (ip.includes('%')) return null;
  if (!net.isIPv6(ip)) return null;

  // Convert embedded IPv4 tail (e.g. `::ffff:127.0.0.1`, `64:ff9b::127.0.0.1`, `::127.0.0.1`)
  const lastColon = ip.lastIndexOf(':');
  if (lastColon !== -1 && ip.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4ToUint32(ip.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;

  const groups = [...left, ...new Array(Math.max(0, missing)).fill('0'), ...right];
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

function isPrivateIpv6BigInt(v6) {
  if (v6 === null) return true;
  if (v6 === 0n || v6 === 1n) return true; // ::/128 (unspecified), ::1/128 (loopback)
  if ((v6 >> 32n) === 0xffffn) {
    // ::ffff:0:0/96 (IPv4-mapped IPv6)
    return isPrivateIpv4Uint32(Number(v6 & 0xffffffffn));
  }
  if ((v6 >> 32n) === 0xffff00000000n) {
    // ::ffff:0:0:0/96 (IPv4-translated)
    return isPrivateIpv4Uint32(Number(v6 & 0xffffffffn));
  }
  if ((v6 >> 32n) === 0n) {
    // ::/96 (deprecated IPv4-compatible IPv6 like ::127.0.0.1)
    return isPrivateIpv4Uint32(Number(v6 & 0xffffffffn));
  }
  if ((v6 >> 32n) === 0x0064ff9b0000000000000000n) {
    // 64:ff9b::/96 (NAT64 well-known prefix -> check embedded IPv4, or block private/reserved)
    return isPrivateIpv4Uint32(Number(v6 & 0xffffffffn));
  }
  if ((v6 >> 80n) === 0x0064ff9b0001n) {
    // 64:ff9b:1::/48 (NAT64 local-use)
    return true;
  }
  if ((v6 >> 112n) === 0x2002n) return true; // 2002::/16 (6to4 tunneling)
  if ((v6 >> 96n) === 0x20010000n) return true; // 2001::/32 (Teredo tunneling)
  if ((v6 >> 64n) === 0x0100000000000000n) return true; // 100::/64 (discard-only)
  if ((v6 >> 121n) === 0x7en) return true; // fc00::/7 (Unique Local Address fc00:: - fdff::)
  if ((v6 >> 118n) === 0x3fan) return true; // fe80::/10 (Link-Local fe80:: - febf::)
  if ((v6 >> 118n) === 0x3fbn) return true; // fec0::/10 (deprecated site-local)
  if ((v6 >> 120n) === 0xffn) return true; // ff00::/8 (Multicast)
  return false;
}

export function isPrivateIpAddress(ip) {
  const clean = String(ip ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!clean) return true;
  if (clean === 'localhost') return true;
  if (clean.includes('%')) return true; // IPv6 zone-scoped address (link-local/loopback)

  const v4 = parseIpv4ToUint32(clean);
  if (v4 !== null) {
    return isPrivateIpv4Uint32(v4);
  }
  const v6 = parseIpv6ToBigInt(clean);
  if (v6 !== null) {
    return isPrivateIpv6BigInt(v6);
  }
  // Fail-closed for malformed/non-IP strings passed to isPrivateIpAddress
  return true;
}

export function isPrivateHostnameLiteral(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.lan') ||
    h.includes('%')
  ) {
    return true;
  }
  if (net.isIP(h)) return isPrivateIpAddress(h);
  return false;
}

/**
 * Validates an external HTTPS URL syntactically AND against resolved DNS addresses
 * to prevent DNS rebinding and literal loopback/RFC1918/IPv6-private SSRF.
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

  const cleanHost = parsed.hostname.replace(/^\[|\]$/g, '');
  const literalIpFamily = net.isIP(cleanHost);
  const validatedAddrs = [];

  if (literalIpFamily === 4 || literalIpFamily === 6) {
    if (isPrivateIpAddress(cleanHost)) {
      throw new PolicyError('SSRF_BLOCKED', {
        message: `安全拦截：不允许访问本机或内网地址 (${parsed.hostname})`,
      });
    }
    validatedAddrs.push({ address: cleanHost, family: literalIpFamily });
  } else {
    let resolved;
    try {
      resolved = await lookupImpl(cleanHost, { all: true });
    } catch (err) {
      throw new PolicyError('DNS_RESOLUTION_FAILED', {
        message: `域名解析失败 (${parsed.hostname}): ${err?.message ?? err}`,
      });
    }
    const rawAddrs = Array.isArray(resolved) ? resolved : [resolved];
    for (const entry of rawAddrs) {
      const address = String(typeof entry === 'string' ? entry : entry?.address ?? '').trim();
      if (!address || isPrivateIpAddress(address)) {
        throw new PolicyError('SSRF_DNS_BLOCKED', {
          message: `安全拦截：域名 ${parsed.hostname} 解析到内网或保留 IP`,
        });
      }
      const family =
        Number(entry?.family) || (net.isIPv6(address) ? 6 : net.isIPv4(address) ? 4 : 0);
      if (family !== 4 && family !== 6) {
        throw new PolicyError('SSRF_DNS_BLOCKED', {
          message: `安全拦截：域名 ${parsed.hostname} 返回无效 IP 地址`,
        });
      }
      validatedAddrs.push({ address, family });
    }
  }
  if (!validatedAddrs.length) {
    throw new PolicyError('SSRF_DNS_BLOCKED', {
      message: `安全拦截：域名 ${parsed.hostname} 未解析到有效公网 IP`,
    });
  }
  Object.defineProperty(parsed, '_resolvedAddresses', {
    value: Object.freeze(validatedAddrs),
    enumerable: false,
    configurable: false,
  });
  return parsed;
}

function pinnedHttpsGet(parsedUrl, pinnedAddr, { signal }) {
  return new Promise((resolveReq, rejectReq) => {
    const pinnedLookup = (_hostname, options, cb) => {
      const callback = typeof options === 'function' ? options : cb;
      const all = typeof options === 'object' && options?.all;
      if (all) {
        callback(null, [{ address: pinnedAddr.address, family: pinnedAddr.family }]);
      } else {
        callback(null, pinnedAddr.address, pinnedAddr.family);
      }
    };
    const hostClean = parsedUrl.hostname.replace(/^\[|\]$/g, '');
    const req = https.request(
      {
        protocol: 'https:',
        hostname: hostClean,
        port: parsedUrl.port ? Number(parsedUrl.port) : 443,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method: 'GET',
        headers: {
          Host: parsedUrl.host,
          'User-Agent': 'Agent-US/1.0',
          Accept: '*/*',
        },
        servername: net.isIP(hostClean) ? undefined : hostClean,
        lookup: pinnedLookup,
        signal,
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          if (Array.isArray(v)) {
            for (const item of v) headers.append(k, item);
          } else {
            headers.set(k, String(v));
          }
        }
        const status = res.statusCode ?? 0;
        const body = Readable.toWeb(res);
        resolveReq({
          status,
          ok: status >= 200 && status < 300,
          headers,
          body,
          async text() {
            const reader = body.getReader();
            const chunks = [];
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(Buffer.from(value));
              }
            } finally {
              reader.releaseLock();
            }
            return Buffer.concat(chunks).toString('utf8');
          },
        });
      },
    );
    req.on('error', rejectReq);
    req.end();
  });
}

/**
 * Fetches an external HTTPS URL safely by pinning the validated IP address (eliminating
 * DNS rebinding TOCTOU), disabling automatic redirects, and re-validating every redirect hop.
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
    const pinned = parsed._resolvedAddresses?.[0] ?? null;

    const res =
      fetchImpl === fetch && pinned
        ? await pinnedHttpsGet(parsed, pinned, { signal: combined })
        : await fetchImpl(parsed.href, {
            headers: { 'User-Agent': 'Agent-US/1.0' },
            redirect: 'manual',
            signal: combined,
          });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel?.().catch(() => {});
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
