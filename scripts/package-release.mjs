import { readFile, readdir, lstat, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync, deflateRawSync } from "node:zlib";

export const releaseRoots = [
  "app",
  "components",
  "config",
  "docs",
  "hooks",
  "lib",
  "public",
  "scripts",
  "server",
  "services",
  "src",
  "tests",
  "dist",
  ".dockerignore",
  ".env.example",
  ".gitignore",
  "Dockerfile",
  "compose.yaml",
  "config.example.json",
  "components.json",
  "index.html",
  "LICENSE",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "README.md",
  "README.en.md",
  "THIRD_PARTY_NOTICES.md",
  "CONTRIBUTING.md",
  "tsconfig.json",
  "vite.config.ts",
  "start.bat",
  "start.command",
  "install.sh",
  "install.ps1",
];
const forbidden =
  /^(?:\.git|\.env(?:\.(?!example$)[^/]+)?|config\.local\.json|node_modules|\.local|state|runtime|release|coverage|\.DS_Store)$|\.(?:pem|key|p12|pfx)$/i;
const prefix = "ai-preflight-local/";
export async function collectFiles(root) {
  const files = [];
  async function visit(path) {
    const name = relative(root, path).split(sep).join("/");
    if (name.split("/").some((part) => forbidden.test(part))) return;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`发布目录不允许符号链接：${name}`);
    if (stat.isDirectory()) {
      for (const item of (await readdir(path)).sort()) await visit(resolve(path, item));
    } else if (stat.isFile()) {
      if (stat.size > 64 * 1024 * 1024) throw new Error(`发布文件过大：${name}`);
      files.push({
        name: prefix + name,
        data: await readFile(path),
        mode: /\.(?:sh|command)$/.test(name) ? 0o755 : 0o644,
      });
    } else throw new Error(`不支持的文件类型：${name}`);
  }
  for (const name of releaseRoots) {
    try {
      await lstat(resolve(root, name));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    await visit(resolve(root, name));
  }
  for (const name of [
    "package.json",
    "LICENSE",
    "dist/index.html",
    "server/index.mjs",
    "scripts/launcher.mjs",
    "install.sh",
    "install.ps1",
  ]) {
    if (!files.some((file) => file.name === prefix + name))
      throw new Error(`缺少发布文件：${name}`);
  }
  if (
    files.length > 5000 ||
    files.reduce((sum, file) => sum + file.data.length, 0) > 256 * 1024 * 1024
  )
    throw new Error("发布包超过体积限制");
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function octal(buffer, number, start, length) {
  const value = number.toString(8).padStart(length - 1, "0") + "\0";
  if (value.length !== length) throw new Error("TAR 数字超出格式限制");
  buffer.write(value, start, length, "ascii");
}
export function makeTar(files) {
  const blocks = [];
  for (const file of files) {
    let name = file.name,
      pathPrefix = "";
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf("/", 155);
      pathPrefix = name.slice(0, cut);
      name = name.slice(cut + 1);
      if (cut < 0 || Buffer.byteLength(pathPrefix) > 155 || Buffer.byteLength(name) > 100)
        throw new Error("TAR 路径太长");
    }
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    octal(header, file.mode || 0o644, 100, 8);
    octal(header, 0, 108, 8);
    octal(header, 0, 116, 8);
    octal(header, file.data.length, 124, 12);
    octal(header, 946684800, 136, 12);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write(pathPrefix, 345, 155);
    const sum = header.reduce((total, value) => total + value, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(header, file.data, Buffer.alloc((512 - (file.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
export function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}
export function makeZip(files) {
  const locals = [],
    central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name),
      compressed = deflateRawSync(file.data, { level: 9 }),
      crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x2821, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x0314, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0x2821, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(((0o100000 | (file.mode || 0o644)) << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
export async function packageRelease(root, output = resolve(root, "release")) {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("仅支持稳定语义版本号");
  const files = await collectFiles(root),
    version = `v${pkg.version}`;
  await mkdir(output, { recursive: true });
  const artifacts = [
    [`ai-preflight-local-${version}.tar.gz`, makeTar(files)],
    [`ai-preflight-local-${version}.zip`, makeZip(files)],
  ];
  for (const [name, data] of artifacts) await writeFile(resolve(output, name), data);
  const checksums =
    artifacts
      .map(([name, data]) => `${createHash("sha256").update(data).digest("hex")}  ${name}`)
      .join("\n") + "\n";
  await writeFile(resolve(output, "SHA256SUMS"), checksums);
  return { version, files: files.length, output, artifacts: artifacts.map(([name]) => name) };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const outputAt = process.argv.indexOf("--output");
  console.log(
    JSON.stringify(
      await packageRelease(root, outputAt < 0 ? undefined : resolve(process.argv[outputAt + 1])),
      null,
      2,
    ),
  );
}
