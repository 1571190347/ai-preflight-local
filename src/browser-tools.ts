/** Browser-only diagnostics. No analytics, persistent storage, camera or microphone access. */

export type WebRTCCandidate = {
  server: string;
  address: string;
  type: string;
  protocol: string;
  comparison: string;
};

export type WebRTCResult = {
  candidates: WebRTCCandidate[];
  errors: string[];
  conclusion: string;
};

const MASK = '[已隐藏]';

function isIPv4(value: string): boolean {
  const parts = value.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

function normalizeAddress(value: string): string {
  return value
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.+$/, '')
    .toLowerCase();
}

function addressKind(address: string): string {
  if (/\.local\.?$/i.test(address)) return 'mDNS';
  if (isIPv4(address)) return 'IPv4';
  if (address.includes(':')) return 'IPv6';
  return '未知地址';
}

function privateAddress(address: string): boolean {
  const value = normalizeAddress(address);
  if (value.startsWith('::ffff:')) return privateAddress(value.slice(7));
  if (isIPv4(value)) {
    const [a, b] = value.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return (
    value === '::' ||
    value === '::1' ||
    /^f[cd]/i.test(value) ||
    /^fe[89ab]/i.test(value)
  );
}

function comparison(address: string, type: string, baseline: string[]): string {
  const kind = addressKind(address);
  if (kind === 'mDNS') return 'mDNS：浏览器隐藏了本机地址，不代表已暴露公网 IP';
  if (privateAddress(address))
    return `${kind} 私有或本机地址：不等于公网出口泄漏`;
  if (kind === '未知地址') return '无法识别地址格式';
  if (baseline.some((ip) => normalizeAddress(ip) === normalizeAddress(address)))
    return `${kind}：与已知网络出口一致`;
  if (!baseline.length) return `${kind}：缺少网络出口基准，无法比较`;
  return `${kind} ${type}：与已知出口不同，需核对分流、IPv4/IPv6 和代理设置，不能据此认定泄漏`;
}

/** Only STUN URLs with a hostname and optional numeric port; no TURN credentials or URL extras. */
export function validateStunServer(input: string): string | null {
  const value = input.trim();
  const match =
    /^(stuns?):([a-z\d](?:[a-z\d.-]{0,251}[a-z\d])?)(?::(\d{1,5}))?$/i.exec(
      value,
    );
  if (!match) return null;
  const [, scheme, hostname, portText] = match;
  if (
    hostname
      .split('.')
      .some((label) => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
  )
    return null;
  if (portText && (Number(portText) < 1 || Number(portText) > 65535))
    return null;
  return `${scheme.toLowerCase()}:${hostname.toLowerCase()}${portText ? `:${Number(portText)}` : ''}`;
}

/** Makes no outgoing requests and does not persist any identifier. */
export async function inspectDevice(
  includeFingerprint: boolean,
): Promise<Record<string, unknown>> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined')
    return { available: false, reason: '需要在浏览器中运行' };
  const nav = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
      mobile?: boolean;
      brands?: { brand: string; version: string }[];
    };
    connection?: {
      effectiveType?: string;
      downlink?: number;
      rtt?: number;
      saveData?: boolean;
    };
    deviceMemory?: number;
    globalPrivacyControl?: boolean;
  };
  const ua = nav.userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome / Chromium'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '未知浏览器';
  const platform = nav.userAgentData?.platform || nav.platform;
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS / iPadOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac/.test(platform)
          ? 'macOS / iPadOS'
          : /Linux/.test(platform)
            ? 'Linux'
            : platform || '未知';
  let timezone = '未知';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* Restricted browser. */
  }
  const result: Record<string, unknown> = {
    available: true,
    timezone,
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
    languages: [...nav.languages],
    language: nav.language,
    userAgent: ua,
    os,
    browser,
    platform,
    touchPoints: nav.maxTouchPoints,
    doNotTrack: nav.doNotTrack ?? '浏览器未提供',
    globalPrivacyControl: nav.globalPrivacyControl ?? '浏览器未提供',
    onlineHint: nav.onLine,
    secureContext: window.isSecureContext,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemoryGiB: nav.deviceMemory ?? '浏览器未提供',
    screen: {
      width: screen.width,
      height: screen.height,
      pixelRatio: window.devicePixelRatio,
      colorDepth: screen.colorDepth,
    },
    networkHints: nav.connection
      ? {
          effectiveType: nav.connection.effectiveType,
          downlinkMbps: nav.connection.downlink,
          rttMilliseconds: nav.connection.rtt,
          saveData: nav.connection.saveData,
          note: '浏览器估计值；不是测速，也不能证明目标平台可连接',
        }
      : { available: false, note: '此浏览器未提供 Network Information API' },
    fingerprint: {
      enabled: false,
      note: '仅在明确开启后生成；不会上传或写入存储',
    },
  };
  if (!includeFingerprint) return result;
  const fingerprint: Record<string, unknown> = {
    enabled: true,
    note: '仅在本页内存中计算；不是平台风控结果',
  };
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 80;
    const context = canvas.getContext('2d');
    if (!context || !globalThis.crypto?.subtle)
      throw new Error('Canvas 或安全摘要 API 不可用');
    context.fillStyle = '#193c4c';
    context.fillRect(5, 6, 270, 62);
    context.fillStyle = '#c2f68c';
    context.font = '18px sans-serif';
    context.fillText('Local preflight / 本地体检 ◇', 12, 34);
    context.strokeStyle = '#f5ab79';
    context.beginPath();
    context.arc(250, 43, 20, 0, Math.PI * 1.7);
    context.stroke();
    const bytes = new TextEncoder().encode(canvas.toDataURL());
    fingerprint.canvasSha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
  } catch (error) {
    fingerprint.canvasError =
      error instanceof Error ? error.message : 'Canvas 不可用';
  }
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = document.createElement('canvas').getContext('webgl');
    if (!gl) throw new Error('WebGL 不可用或已关闭');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    fingerprint.webgl = {
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      unmaskedVendor: debug
        ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)
        : '浏览器未提供',
      unmaskedRenderer: debug
        ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : '浏览器未提供',
    };
  } catch (error) {
    fingerprint.webglError =
      error instanceof Error ? error.message : 'WebGL 不可用';
  } finally {
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
  result.fingerprint = fingerprint;
  return result;
}

/** Explicit caller action must precede this function: it contacts the selected STUN servers. */
export async function collectWebRTC(
  stunServers: string[],
  baselineIps: string[],
  signal?: AbortSignal,
): Promise<WebRTCResult> {
  const candidates: WebRTCCandidate[] = [];
  const errors: string[] = [];
  if (typeof RTCPeerConnection === 'undefined')
    return {
      candidates,
      errors: ['此浏览器不支持 RTCPeerConnection'],
      conclusion: '无法判断：WebRTC 不可用',
    };
  if (signal?.aborted)
    return {
      candidates,
      errors: ['检测已取消'],
      conclusion: '检测已取消，无法判断',
    };
  const servers: string[] = [];
  if (stunServers.length > 4)
    errors.push('最多检测 4 个 STUN 节点，其余已忽略');
  for (const input of stunServers.slice(0, 4)) {
    const valid = validateStunServer(input);
    if (!valid)
      errors.push(
        `STUN 地址无效：${input.slice(0, 120)}；只接受无凭据的 stun:域名[:端口]`,
      );
    else if (!servers.includes(valid)) servers.push(valid);
  }
  // An empty list intentionally runs host-only gathering, without any STUN requests.
  if (!stunServers.length) servers.push('');
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          let peer: RTCPeerConnection | undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let done = false;
          const label = server || '本机（未使用 STUN）';
          const finish = () => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (peer) {
              peer.onicecandidate = null;
              peer.onicegatheringstatechange = null;
              peer.onicecandidateerror = null;
              try {
                peer.close();
              } catch {
                /* Already closed. */
              }
            }
            resolve();
          };
          const abort = () => {
            errors.push(`${label}：检测已取消`);
            finish();
          };
          try {
            peer = new RTCPeerConnection({
              iceServers: server ? [{ urls: server }] : [],
              iceCandidatePoolSize: 0,
            });
            peer.onicecandidate = (event) => {
              if (done) return;
              if (!event.candidate) {
                finish();
                return;
              }
              const raw = event.candidate;
              const parts = raw.candidate.trim().split(/\s+/);
              const address = (raw.address || parts[4] || '').replace(
                /^\[|\]$/g,
                '',
              );
              const type =
                raw.type || parts[parts.indexOf('typ') + 1] || 'unknown';
              const protocol =
                raw.protocol || parts[2]?.toLowerCase() || 'unknown';
              if (
                !address ||
                !['host', 'srflx', 'prflx', 'relay'].includes(type)
              )
                return;
              if (
                !candidates.some(
                  (item) =>
                    item.server === label &&
                    item.address === address &&
                    item.type === type &&
                    item.protocol === protocol,
                )
              ) {
                candidates.push({
                  server: label,
                  address,
                  type,
                  protocol,
                  comparison: comparison(address, type, baselineIps),
                });
              }
            };
            peer.onicegatheringstatechange = () => {
              if (peer?.iceGatheringState === 'complete') finish();
            };
            peer.onicecandidateerror = (event) => {
              if (!done)
                errors.push(
                  `${label}：ICE 错误 ${event.errorCode || '未知'}（节点超时或浏览器限制均可能导致，不等于泄漏）`,
                );
            };
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) {
              abort();
              return;
            }
            timer = setTimeout(() => {
              errors.push(
                `${label}：7 秒收集窗口结束，可能未收集到全部候选地址`,
              );
              finish();
            }, 7000);
            peer.createDataChannel('local-preflight');
            const activePeer = peer;
            void activePeer
              .createOffer()
              .then((offer) => {
                if (!done) return activePeer.setLocalDescription(offer);
              })
              .catch((error: unknown) => {
                if (!done)
                  errors.push(
                    `${label}：${error instanceof Error ? error.message : '候选地址收集失败'}`,
                  );
                finish();
              });
          } catch (error) {
            errors.push(
              `${label}：${error instanceof Error ? error.message : 'WebRTC 初始化失败'}`,
            );
            finish();
          }
        }),
    ),
  );
  const hasDifferent = candidates.some((candidate) =>
    candidate.comparison.includes('与已知出口不同'),
  );
  const hasComparable = candidates.some((candidate) =>
    candidate.comparison.includes('与已知网络出口一致'),
  );
  const conclusion = signal?.aborted
    ? '检测已取消，已有结果可能不完整'
    : !candidates.length
      ? '未获得候选地址：可能被浏览器限制或网络阻断，无法判断是否存在泄漏'
      : hasDifferent
        ? '发现与基准不同的地址，需核对分流、双栈出口与代理配置；这不是泄漏的确定证据'
        : hasComparable
          ? '本次可比较的公网地址与已知出口一致；这不保证其他连接或目标平台会使用相同出口'
          : '已获得本机、mDNS 或无基准地址；缺少可比较的公网结果，无法判断是否存在泄漏';
  return { candidates, errors: [...new Set(errors)], conclusion };
}

function redactString(value: string): string {
  return (
    value
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, MASK)
      .replace(
        /^((?:registrant|admin|tech|billing) (?:name|organization|street|city|postal code|phone|fax|email)\s*:)[^\r\n]*$/gim,
        `$1 ${MASK}`,
      )
      // Whole credential-bearing lines (including textual WHOIS/header reports).
      .replace(
        /^([^\r\n]*(?:authorization|proxy-authorization|set-cookie|cookie|x-api-key)\s*[:=])[^\r\n]*$/gim,
        `$1 ${MASK}`,
      )
      .replace(/\bBearer\s+[A-Za-z\d._~+\/-]+=*/gi, `Bearer ${MASK}`)
      .replace(
        /([?&](?:token|access_token|refresh_token|api[_-]?key|secret|password|session|code)=)[^&#\s]*/gi,
        `$1${MASK}`,
      )
      .replace(
        /(\b(?:token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
        `$1${MASK}`,
      )
      .replace(/(https?:\/\/)[^/\s@]+@/gi, `$1${MASK}@`)
      // IPv6 first: also catches IPv4-mapped IPv6 and optional scope IDs.
      .replace(
        /(?<![\w:])(?:[\da-f]{0,4}:){2,}[\da-f:.]*(?:%[\w.-]+)?(?![\w:])/gi,
        (candidate) => {
          const colons = candidate.match(/:/g)?.length ?? 0;
          return candidate.includes('::') ||
            colons >= 7 ||
            (colons === 6 && /(?:\d{1,3}\.){3}\d{1,3}/.test(candidate))
            ? MASK
            : candidate;
        },
      )
      .replace(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, (candidate) =>
        isIPv4(candidate) ? MASK : candidate,
      )
      .replace(/\b[a-f\d]{8}-[a-f\d-]{12,}\.local\b/gi, MASK)
      .replace(
        /\b(?:sk-(?:proj-|ant-)?[\w-]{16,}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,})\b/g,
        MASK,
      )
  );
}

/** Best-effort conservative redaction for UI hiding and all shared reports. */
export function redact(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const sensitiveKey =
    /(?:fingerprint|canvas|webgl|authorization|cookie|password|passwd|secret|token|api.?key|session.?id|client.?secret|private.?key|vcardArray|e.?mail|telephone|phone|street|postal)/i;
  const sensitiveAddressKey =
    /^(?:ip|ipv4|ipv6|ipAddress|publicIp|remoteAddress|localAddress|clientIp|realIp|x-forwarded-for|x-real-ip|cf-connecting-ip)$/i;
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 40) return '[已省略深层数据]';
    if (typeof item === 'string') return redactString(item);
    if (item === null || typeof item === 'boolean' || typeof item === 'number')
      return item;
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'undefined') return null;
    if (typeof item !== 'object') return '[已省略]';
    if (seen.has(item)) return '[循环引用]';
    seen.add(item);
    if (item instanceof Date)
      return Number.isNaN(item.getTime()) ? null : item.toISOString();
    if (Array.isArray(item))
      return item.map((child) => visit(child, depth + 1));
    if (item instanceof Map) return visit(Object.fromEntries(item), depth + 1);
    if (item instanceof Set)
      return [...item].map((child) => visit(child, depth + 1));
    if (typeof Headers !== 'undefined' && item instanceof Headers)
      return visit(Object.fromEntries(item.entries()), depth + 1);
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(item),
    )) {
      if (!descriptor.enumerable) continue;
      const safeKey = redactString(key);
      result[safeKey] =
        sensitiveKey.test(key) || sensitiveAddressKey.test(key)
          ? MASK
          : 'value' in descriptor
            ? visit(descriptor.value, depth + 1)
            : '[已省略访问器]';
    }
    return result;
  };
  return visit(value, 0);
}
