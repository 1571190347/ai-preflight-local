const TYPES = { 1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 12: 'PTR', 15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 64: 'SVCB', 65: 'HTTPS', 255: 'ANY' };
export const qtypeName = (number) => TYPES[number] ?? `TYPE${number}`;

export function validateZone(value) {
  const zone = String(value ?? '').replace(/\.$/, '').toLowerCase();
  // Leave room for the random hostname prefixes and ns1 label.
  if (zone.length > 180 || !zone.includes('.') || !zone.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('DNS_ZONE must be an ASCII delegated domain, at most 180 characters');
  }
  return zone;
}

export function readName(packet, start) {
  let offset = start, end = null, length = 1;
  const labels = [], visited = new Set();
  for (let hops = 0; hops < 128; hops++) {
    if (offset >= packet.length || visited.has(offset)) throw new Error('invalid DNS name');
    visited.add(offset);
    const size = packet[offset];
    if ((size & 0xc0) === 0xc0) {
      if (offset + 1 >= packet.length) throw new Error('truncated compression pointer');
      const target = ((size & 0x3f) << 8) | packet[offset + 1];
      // RFC 1035 compression points to an earlier occurrence, never forward.
      if (target >= offset || target < 12) throw new Error('invalid compression pointer');
      if (end === null) end = offset + 2;
      offset = target;
      continue;
    }
    if (size & 0xc0) throw new Error('unsupported label encoding');
    offset++;
    if (size === 0) return { name: labels.join('.'), end: end ?? offset };
    if (offset + size > packet.length || (length += size + 1) > 255) throw new Error('invalid DNS name length');
    const labelBytes = packet.subarray(offset, offset + size);
    // This authority only accepts ordinary ASCII domain labels, plus underscore.
    if ([...labelBytes].some((byte) => byte < 0x21 || byte > 0x7e || byte === 0x2e)) throw new Error('invalid label');
    labels.push(labelBytes.toString('ascii').toLowerCase());
    offset += size;
  }
  throw new Error('compression hop limit');
}

export function parseQuery(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 12 || packet.length > 4096) throw new Error('invalid packet size');
  const id = packet.readUInt16BE(0), flags = packet.readUInt16BE(2);
  if ((flags & 0xf800) !== 0 || (flags & 0x0200) !== 0 || (flags & 0x0040) !== 0) throw new Error('expected standard, nontruncated DNS query');
  if (packet.readUInt16BE(4) !== 1 || packet.readUInt16BE(6) !== 0 || packet.readUInt16BE(8) !== 0) throw new Error('one question required');
  const parsed = readName(packet, 12);
  if (parsed.end + 4 > packet.length) throw new Error('truncated question');
  const qtype = packet.readUInt16BE(parsed.end), qclass = packet.readUInt16BE(parsed.end + 2);
  let offset = parsed.end + 4;
  const extraCount = packet.readUInt16BE(10);
  if (extraCount > 1) throw new Error('only one EDNS record accepted');
  // Validate and ignore EDNS options. The response stays small, and no client
  // subnet value is trusted as the resolver address.
  for (let i = 0; i < extraCount; i++) {
    const extra = readName(packet, offset);
    offset = extra.end;
    if (offset + 10 > packet.length || extra.name !== '' || packet.readUInt16BE(offset) !== 41) throw new Error('invalid EDNS record');
    if (packet[offset + 5] !== 0) throw new Error('unsupported EDNS version');
    const rdlength = packet.readUInt16BE(offset + 8);
    offset += 10;
    const limit = offset + rdlength;
    if (limit > packet.length) throw new Error('truncated EDNS');
    while (offset < limit) {
      if (offset + 4 > limit) throw new Error('truncated EDNS option');
      const size = packet.readUInt16BE(offset + 2);
      offset += 4 + size;
      if (offset > limit) throw new Error('truncated EDNS option data');
    }
  }
  if (offset !== packet.length) throw new Error('trailing packet data');
  return { id, flags, name: parsed.name, qtype, qclass };
}

export function encodeName(name) {
  if (!name) return Buffer.from([0]);
  return Buffer.concat([...name.split('.').map((label) => {
    const text = Buffer.from(label, 'ascii');
    return Buffer.concat([Buffer.from([text.length]), text]);
  }), Buffer.from([0])]);
}

function u16(value) { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; }
function u32(value) { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; }
function rr(name, type, ttl, data) { return Buffer.concat([encodeName(name), u16(type), u16(1), u32(ttl), u16(data.length), data]); }
function soa(zone) {
  return rr(zone, 6, 0, Buffer.concat([encodeName(`ns1.${zone}`), encodeName(`hostmaster.${zone}`), u32(1), u32(300), u32(60), u32(3600), u32(0)]));
}

export function createDnsResponder({ zone, publicIpv4, store }) {
  const address = Buffer.from(publicIpv4.split('.').map(Number));
  return (packet, resolverIp) => {
    let query;
    try { query = parseQuery(packet); } catch { return null; }
    const { id, flags, name, qtype, qclass } = query;
    const inZone = name === zone || name.endsWith(`.${zone}`);
    let rcode = 0;
    const answers = [], authorities = [], additionals = [];
    if (!inZone || qclass !== 1) rcode = 5; // REFUSED, never recurse.
    else if (name === zone) {
      if (qtype === 2) {
        answers.push(rr(zone, 2, 300, encodeName(`ns1.${zone}`)));
        additionals.push(rr(`ns1.${zone}`, 1, 300, address));
      } else if (qtype === 6) answers.push(soa(zone));
      else authorities.push(soa(zone)); // Existing name, NODATA.
    } else if (name === `ns1.${zone}`) {
      if (qtype === 1) answers.push(rr(name, 1, 300, address));
      else authorities.push(soa(zone));
    } else {
      // Only exact, live, unguessable issued hostnames produce observations.
      store.observe(name, resolverIp.replace(/^::ffff:/, ''), qtypeName(qtype));
      rcode = 3;
      authorities.push(soa(zone));
    }
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(0x8000 | (inZone && qclass === 1 ? 0x0400 : 0) | (flags & 0x0100) | rcode, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(answers.length, 6);
    header.writeUInt16BE(authorities.length, 8);
    header.writeUInt16BE(additionals.length, 10);
    const question = Buffer.concat([encodeName(name), u16(qtype), u16(qclass)]);
    return Buffer.concat([header, question, ...answers, ...authorities, ...additionals]);
  };
}
