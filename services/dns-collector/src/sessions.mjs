import { randomBytes } from 'node:crypto';

export class SessionStore {
  constructor({ zone, ttlMs = 120_000, maxSessions = 1000, maxObservations = 256, now = Date.now }) {
    this.zone = zone;
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this.maxObservations = maxObservations;
    this.now = now;
    this.sessions = new Map();
    this.hosts = new Map();
  }
  sweep() {
    for (const [id, session] of this.sessions) if (session.until <= this.now()) this.delete(id);
  }
  create(count) {
    if (count !== 3 && count !== 10) throw new TypeError('count must be 3 or 10');
    this.sweep();
    if (this.sessions.size >= this.maxSessions) return null;
    const id = randomBytes(16).toString('hex');
    // A single label avoids empty intermediate names. A recursive resolver
    // using QNAME minimization must never cache NXDOMAIN for a session parent.
    const hostnames = Array.from({ length: count }, () => `${randomBytes(12).toString('hex')}-${id}.${this.zone}`);
    const until = this.now() + this.ttlMs;
    const timer = setTimeout(() => this.delete(id), this.ttlMs);
    timer.unref();
    const session = { id, hostnames, until, observations: [], keys: new Set(), timer };
    this.sessions.set(id, session);
    for (const hostname of hostnames) this.hosts.set(hostname, id);
    return { id, hostnames: [...hostnames], expiresAt: new Date(until).toISOString() };
  }
  get(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.until <= this.now()) { this.delete(id); return null; }
    return { id, observations: session.observations.map((item) => ({ ...item })), expiresAt: new Date(session.until).toISOString() };
  }
  observe(hostname, resolverIp, qtype) {
    const id = this.hosts.get(hostname);
    if (!id || !this.get(id)) return false;
    const session = this.sessions.get(id);
    const key = `${resolverIp}|${qtype}`;
    if (!session.keys.has(key) && session.observations.length < this.maxObservations) {
      session.keys.add(key);
      session.observations.push({ resolverIp, qtype, seenAt: new Date(this.now()).toISOString() });
    }
    return true;
  }
  delete(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    clearTimeout(session.timer);
    for (const hostname of session.hostnames) this.hosts.delete(hostname);
    this.sessions.delete(id);
    return true;
  }
}

// Fixed windows; maps are bounded even when traffic arrives from many sources.
export class RateLimiter {
  constructor({ limit, windowMs = 60_000, maxKeys = 10_000, now = Date.now }) {
    Object.assign(this, { limit, windowMs, maxKeys, now });
    this.buckets = new Map();
  }
  allow(key) {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (!bucket && this.buckets.size >= this.maxKeys) {
        for (const [oldKey, old] of this.buckets) if (old.until <= now) this.buckets.delete(oldKey);
        if (this.buckets.size >= this.maxKeys) return false;
      }
      bucket = { count: 0, until: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    return ++bucket.count <= this.limit;
  }
}
