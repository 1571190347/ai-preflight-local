import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { spawn } from 'node:child_process';

const blocked = new BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(ip, bits, 'ipv4');
for (const [ip, bits] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]) blocked.addSubnet(ip, bits, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicIp(value) {
  if (typeof value !== 'string' || value.includes('%')) return false;
  const family = isIP(value);
  if (family === 4) return !blocked.check(value, 'ipv4');
  return family === 6 && globalV6.check(value, 'ipv6') && !blocked.check(value, 'ipv6');
}

export function validateTarget(input) {
  if (typeof input !== 'string' || input.length > 253) throw new Error('目标格式无效');
  const value = input.trim();
  if (isIP(value)) {
    if (!isPublicIp(value)) throw new Error('仅允许公网 IP');
    return value;
  }
  if (/[\s/:?#@\\\[\]%]/.test(value)) throw new Error('域名不能包含路径、端口或凭据');
  const host = domainToASCII(value).toLowerCase();
  if (!host.includes('.') || host.length > 253 || host.split('.').some(part =>
    !part || part.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part)) ||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) {
    throw new Error('请输入公网域名或 IP，不能包含路径、端口或命令');
  }
  return host;
}

export async function resolveTarget(input, resolver = lookup) {
  const target = validateTarget(input);
  if (isIP(target)) return { target, address: target, family: isIP(target) };
  let timer;
  const addresses = await Promise.race([
    resolver(target, { all: true }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS 解析超时')), 4000); }),
  ]).finally(() => clearTimeout(timer));
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !isPublicIp(item.address))) {
    throw new Error('域名解析包含非公网地址，已拒绝');
  }
  const selected = addresses.find(item => isIP(item.address) === 4) ?? addresses[0];
  return { target, address: selected.address, family: isIP(selected.address) };
}

export function pingCommand(address, platform = process.platform) {
  if (!isPublicIp(address)) throw new Error('仅允许已验证的公网 IP');
  return {
    command: platform === 'darwin' && isIP(address) === 6 ? 'ping6' : 'ping',
    args: platform === 'win32' ? ['-n', '3', '-w', '2000', address] :
      ['-n', '-c', '3', '-W', platform === 'darwin' ? '2000' : '2', address],
  };
}

export function parsePing(output) {
  const stats = output.match(/min\/avg\/max(?:\/[^\s=]+)?\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/);
  const windows = output.match(/Minimum\s*=\s*(\d+)ms,\s*Maximum\s*=\s*(\d+)ms,\s*Average\s*=\s*(\d+)ms/i);
  const loss = output.match(/([\d.]+)%\s*(?:packet loss|loss)/i);
  return {
    state: stats || windows ? 'received' : 'unknown',
    min: stats ? Number(stats[1]) : windows ? Number(windows[1]) : null,
    avg: stats ? Number(stats[2]) : windows ? Number(windows[3]) : null,
    max: stats ? Number(stats[3]) : windows ? Number(windows[2]) : null,
    loss: loss ? Number(loss[1]) : null,
  };
}

export async function runPing(input, { signal, resolver = lookup, spawnProcess = spawn } = {}) {
  const resolved = await resolveTarget(input, resolver);
  if (signal?.aborted) throw new Error('请求已取消');
  const { command, args } = pingCommand(resolved.address);
  return new Promise((resolve, reject) => {
    let output = '', bytes = 0, settled = false, timedOut = false, killTimer;
    const child = spawnProcess(command, args, {
      shell: false, windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stop = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 300);
      killTimer.unref?.();
    };
    const onAbort = () => stop();
    const timer = setTimeout(() => { timedOut = true; stop(); }, 8000);
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve({ ...resolved, ...parsePing(output), timedOut, raw: output.slice(0, 16000) });
    };
    const collect = chunk => {
      bytes += chunk.length;
      if (bytes > 16000) { stop(); return; }
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', () => finish(new Error('系统 ping 命令不可用')));
    child.on('close', () => finish(signal?.aborted ? new Error('请求已取消') : undefined));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) stop();
  });
}
