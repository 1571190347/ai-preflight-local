import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectFiles,
  makeTar,
  makeZip,
  crc32,
  packageRelease,
} from "../scripts/package-release.mjs";

const shellInstaller = fileURLToPath(new URL("../install.sh", import.meta.url));
const shellOptions = {
  skip: process.platform === "win32" ? "POSIX installer; Windows uses install.ps1" : false,
};
const windowsOptions = {
  skip:
    process.platform !== "win32" ? "Windows PowerShell installer; exercised on Windows CI" : false,
};
const digest = (data) => createHash("sha256").update(data).digest("hex");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const launcherFixture = `import fs from 'node:fs';
fs.appendFileSync(process.env.FIXTURE_LAUNCH_LOG, JSON.stringify({args:process.argv.slice(2),root:process.env.PREFLIGHT_INSTALL_DIR||null,noOpen:process.env.PREFLIGHT_NO_OPEN})+'\\n');
`;

async function fixture(t, version = "0.3.0") {
  const base = await mkdtemp(join(tmpdir(), "preflight-installer-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = join(base, "source");
  const output = join(base, "downloads");
  const files = {
    "package.json": JSON.stringify({ name: "ai-preflight-local", version, type: "module" }),
    LICENSE: "MIT fixture\n",
    "dist/index.html": "<!doctype html><title>fixture</title>",
    "server/index.mjs": "// fixture server; lifecycle is tested independently\n",
    "scripts/launcher.mjs": launcherFixture,
    "install.sh": "#!/bin/sh\n",
    "install.ps1": "# PowerShell fixture\n",
    ".env.example": "PORT=4173\n",
    "docs/安装说明.md": "UTF-8 paths survive both release formats.\n",
  };
  for (const [name, body] of Object.entries(files)) {
    await mkdir(dirname(join(source, name)), { recursive: true });
    await writeFile(join(source, name), body);
  }
  await packageRelease(source, output);
  return { base, source, output, files };
}

async function shellFixture(t) {
  const value = await fixture(t);
  const fakeBin = join(value.base, "fake-bin");
  await mkdir(fakeBin);
  const curlScript = join(fakeBin, "curl.mjs");
  await writeFile(
    curlScript,
    `import fs from 'node:fs';
import path from 'node:path';
const args=process.argv.slice(2),url=args.find(value=>value.startsWith('https://'));
const out=args[args.indexOf('--output')+1];
if(!url||!out)process.exit(2);
fs.appendFileSync(process.env.FIXTURE_CURL_LOG,url+'\\n');
if(process.env.FIXTURE_DOWNLOAD_FAIL==='1')process.exit(22);
if(url.endsWith('/releases/latest'))fs.writeFileSync(out,JSON.stringify({tag_name:process.env.FIXTURE_RELEASE_VERSION||'v0.3.0',draft:false,prerelease:false}));
else if(url.startsWith('https://github.com/1571190347/ai-preflight-local/releases/download/')){
 const name=url.slice(url.lastIndexOf('/')+1);fs.copyFileSync(path.join(process.env.FIXTURE_DOWNLOADS,name),out);
}else throw new Error('Unexpected network destination: '+url);
`,
  );
  await writeFile(
    join(fakeBin, "curl"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(curlScript)} "$@"\n`,
    { mode: 0o700 },
  );
  const root = join(value.base, "install directory's local app");
  const launchLog = join(value.base, "launcher.jsonl");
  const curlLog = join(value.base, "downloads.log");
  const env = {
    ...process.env,
    PATH: fakeBin + ":" + dirname(process.execPath) + ":" + process.env.PATH,
    PREFLIGHT_INSTALL_DIR: root,
    PREFLIGHT_NO_START: "1",
    PREFLIGHT_NO_OPEN: "1",
    FIXTURE_DOWNLOADS: value.output,
    FIXTURE_LAUNCH_LOG: launchLog,
    FIXTURE_CURL_LOG: curlLog,
  };
  delete env.PREFLIGHT_REPOSITORY;
  delete env.PREFLIGHT_VERSION;
  delete env.NODE_OPTIONS;
  return { ...value, root, env, launchLog, curlLog };
}

function runInstall(value, extraEnv = {}) {
  const result = spawnSync("/bin/sh", [shellInstaller], {
    env: { ...value.env, ...extraEnv },
    encoding: "utf8",
    timeout: 20000,
  });
  if (result.error) throw result.error;
  return result;
}
const assertSuccess = (result) => assert.equal(result.status, 0, result.stderr + result.stdout);
async function launchEvents(value) {
  try {
    return (await readFile(value.launchLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
async function replaceArchive(value, data) {
  const name = "ai-preflight-local-v0.3.0.tar.gz";
  await writeFile(join(value.output, name), data);
  await writeFile(join(value.output, "SHA256SUMS"), `${digest(data)}  ${name}\n`);
}

async function windowsFixture(t) {
  const value = await fixture(t);
  const script = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const from = script.indexOf("    function Download-File(");
  const to = script.indexOf("    function Assert-Sha256(", from);
  assert.ok(
    from > 0 && to > from,
    "Locate only the installer download boundary for the offline fixture",
  );
  // Run the actual PowerShell install/extraction/update logic. The transport alone
  // is replaced so CI never downloads executable code or touches a user install.
  const transport = `    function Download-File([string] $Url, [string] $Destination, [long] $Limit = 134217728) {
        if ($Url -eq 'https://api.github.com/repos/1571190347/ai-preflight-local/releases/latest') {
            [IO.File]::WriteAllText($Destination, '{"tag_name":"v0.3.0","draft":false,"prerelease":false}')
        } elseif ($Url.StartsWith('https://github.com/1571190347/ai-preflight-local/releases/download/')) {
            [IO.File]::Copy((Join-Path $env:FIXTURE_DOWNLOADS ($Url.Substring($Url.LastIndexOf('/') + 1))), $Destination)
        } else { throw ('Unexpected fixture download: ' + $Url) }
    }

`;
  const harness = join(value.base, "offline-install.ps1");
  await writeFile(harness, script.slice(0, from) + transport + script.slice(to));
  const root = join(value.base, "install directory's local app");
  const launchLog = join(value.base, "launcher.jsonl");
  const env = {
    ...process.env,
    PREFLIGHT_INSTALL_DIR: root,
    PREFLIGHT_NO_START: "1",
    PREFLIGHT_NO_OPEN: "1",
    FIXTURE_DOWNLOADS: value.output,
    FIXTURE_LAUNCH_LOG: launchLog,
  };
  delete env.PREFLIGHT_VERSION;
  delete env.PREFLIGHT_REPOSITORY;
  delete env.NODE_OPTIONS;
  return { ...value, harness, root, env, launchLog };
}
function runWindows(value, extraEnv = {}) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      value.harness,
    ],
    { env: { ...value.env, ...extraEnv }, encoding: "utf8", timeout: 60000 },
  );
  if (result.error) throw result.error;
  return result;
}

test("release archives are deterministic, include UTF-8 source, and match their SHA256 manifest", async (t) => {
  const value = await fixture(t);
  const files = await collectFiles(value.source);
  const tar = makeTar(files),
    zip = makeZip(files);
  assert.deepEqual(tar, makeTar(files));
  assert.deepEqual(zip, makeZip(files));
  assert.deepEqual(await readFile(join(value.output, "ai-preflight-local-v0.3.0.tar.gz")), tar);
  assert.deepEqual(await readFile(join(value.output, "ai-preflight-local-v0.3.0.zip")), zip);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const tarData = gunzipSync(tar);
  assert.ok(tarData.includes(Buffer.from("ai-preflight-local/docs/安装说明.md")));
  const members = new Map();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(offset + 6), 0x800);
    assert.equal(zip.readUInt16LE(offset + 8), 8);
    const size = zip.readUInt32LE(offset + 18),
      nameSize = zip.readUInt16LE(offset + 26),
      extraSize = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameSize).toString("utf8");
    const start = offset + 30 + nameSize + extraSize,
      data = inflateRawSync(zip.subarray(start, start + size));
    assert.equal(data.length, zip.readUInt32LE(offset + 22));
    assert.equal(crc32(data), zip.readUInt32LE(offset + 14));
    members.set(name, data);
    offset = start + size;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  assert.equal(members.size, files.length);
  for (const file of files) assert.deepEqual(members.get(file.name), file.data);
  const manifest = await readFile(join(value.output, "SHA256SUMS"), "utf8");
  assert.equal(
    manifest,
    `${digest(tar)}  ai-preflight-local-v0.3.0.tar.gz\n${digest(zip)}  ai-preflight-local-v0.3.0.zip\n`,
  );
});

test("release collection excludes private environment variants, keys, state, and local configuration", async (t) => {
  const value = await fixture(t);
  for (const name of [
    ".env",
    ".env.local",
    "docs/.env.production",
    "docs/.env.example.local",
    "config/config.local.json",
    "server/private.key",
    "services/state/token.json",
    "scripts/node_modules/package/index.js",
    "docs/key.pem",
  ]) {
    await mkdir(dirname(join(value.source, name)), { recursive: true });
    await writeFile(join(value.source, name), "fixture-private-marker");
  }
  await mkdir(join(value.source, "services/example"), { recursive: true });
  await writeFile(join(value.source, "services/example/.env.example"), "SAFE_EXAMPLE=yes\n");
  const files = await collectFiles(value.source);
  assert.ok(files.some((file) => file.name === "ai-preflight-local/.env.example"));
  assert.ok(files.some((file) => file.name === "ai-preflight-local/services/example/.env.example"));
  assert.ok(files.every((file) => !file.data.includes(Buffer.from("fixture-private-marker"))));
});

test(
  "release collection rejects symlinks instead of reading files outside the source tree",
  {
    skip: process.platform === "win32" ? "Creating symlinks needs elevated Windows policy" : false,
  },
  async (t) => {
    const value = await fixture(t);
    await writeFile(join(value.base, "private"), "do not package");
    await symlink(join(value.base, "private"), join(value.source, "server/outside"));
    await assert.rejects(collectFiles(value.source), /符号链接/);
  },
);

test("release creation refuses a missing built UI or an invalid version", async (t) => {
  const value = await fixture(t);
  await rm(join(value.source, "dist/index.html"));
  await assert.rejects(packageRelease(value.source, value.output), /dist\/index.html/);
  await writeFile(
    join(value.source, "package.json"),
    '{"name":"ai-preflight-local","version":"0.3.0-beta"}',
  );
  await assert.rejects(packageRelease(value.source, value.output), /语义版本号/);
});

test(
  "shell one-line installation uses latest release, checksums, an existing Node, and a quoted local launcher",
  shellOptions,
  async (t) => {
    const value = await shellFixture(t);
    assertSuccess(runInstall(value));
    const installed = JSON.parse(await readFile(join(value.root, "app/package.json"), "utf8"));
    assert.equal(installed.version, "0.3.0");
    assert.deepEqual(await launchEvents(value), []);
    assert.equal((await stat(join(value.root, "bin/ai-preflight"))).mode & 0o777, 0o700);
    assert.equal((await stat(join(value.root, "config/.env"))).mode & 0o077, 0);
    const invoked = spawnSync(join(value.root, "bin/ai-preflight"), ["status"], {
      env: value.env,
      encoding: "utf8",
    });
    assertSuccess(invoked);
    assert.deepEqual((await launchEvents(value))[0], {
      args: ["status"],
      root: value.root,
      noOpen: "1",
    });
    const urls = (await readFile(value.curlLog, "utf8")).trim().split("\n");
    assert.equal(urls.length, 3);
    assert.equal(
      urls[0],
      "https://api.github.com/repos/1571190347/ai-preflight-local/releases/latest",
    );
    assert.ok(urls.every((url) => !url.includes("nodejs.org")));
    assert.ok(!(await readdir(value.root)).some((name) => name.startsWith(".install.")));
  },
);

test(
  "shell update preserves private configuration and stops the old app before starting the new version",
  shellOptions,
  async (t) => {
    const value = await shellFixture(t);
    assertSuccess(runInstall(value));
    await writeFile(
      join(value.root, "config/.env"),
      "PORT=4567\nPRIVATE_TEST_TOKEN=secret-fixture\n",
    );
    await writeFile(join(value.root, "config/config.local.json"), '{"custom":"preserve me"}\n');
    await writeFile(
      join(value.source, "package.json"),
      '{"name":"ai-preflight-local","version":"0.3.1","type":"module"}',
    );
    await packageRelease(value.source, value.output);
    assertSuccess(runInstall(value, { PREFLIGHT_VERSION: "v0.3.1", PREFLIGHT_NO_START: "0" }));
    assert.equal(
      JSON.parse(await readFile(join(value.root, "app/package.json"), "utf8")).version,
      "0.3.1",
    );
    assert.equal(
      JSON.parse(await readFile(join(value.root, "app.previous/package.json"), "utf8")).version,
      "0.3.0",
    );
    assert.equal(
      await readFile(join(value.root, "config/.env"), "utf8"),
      "PORT=4567\nPRIVATE_TEST_TOKEN=secret-fixture\n",
    );
    assert.equal(
      await readFile(join(value.root, "config/config.local.json"), "utf8"),
      '{"custom":"preserve me"}\n',
    );
    const events = await launchEvents(value);
    assert.deepEqual(
      events.map((event) => event.args[0]),
      ["stop", "start"],
    );
    assert.deepEqual(events[0].args, ["stop", "--install-dir", value.root]);
    assert.equal(events[1].root, value.root);
    assert.ok(!(await readdir(value.root)).some((name) => name.startsWith(".install.")));
  },
);

test(
  "shell checksum failure never replaces or stops an installed app and a retry succeeds",
  shellOptions,
  async (t) => {
    const value = await shellFixture(t);
    assertSuccess(runInstall(value));
    const validManifest = await readFile(join(value.output, "SHA256SUMS"));
    await writeFile(
      join(value.output, "SHA256SUMS"),
      `${"0".repeat(64)}  ai-preflight-local-v0.3.0.tar.gz\n`,
    );
    const bad = runInstall(value);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /SHA256/);
    assert.equal(
      JSON.parse(await readFile(join(value.root, "app/package.json"), "utf8")).version,
      "0.3.0",
    );
    assert.deepEqual(await launchEvents(value), []);
    await writeFile(join(value.output, "SHA256SUMS"), validManifest);
    assertSuccess(runInstall(value));
  },
);

test(
  "shell failed initial download can be retried without deleting its install directory",
  shellOptions,
  async (t) => {
    const value = await shellFixture(t);
    assert.notEqual(runInstall(value, { FIXTURE_DOWNLOAD_FAIL: "1" }).status, 0);
    assert.deepEqual(await launchEvents(value), []);
    assertSuccess(runInstall(value));
  },
);

test(
  "shell installer rejects an unrelated nonempty directory and does not alter it",
  shellOptions,
  async (t) => {
    const value = await shellFixture(t);
    await mkdir(value.root);
    await writeFile(join(value.root, "keep.txt"), "untouched");
    assert.notEqual(runInstall(value).status, 0);
    assert.deepEqual(await readdir(value.root), ["keep.txt"]);
    assert.equal(await readFile(join(value.root, "keep.txt"), "utf8"), "untouched");
  },
);

test(
  "shell extraction rejects traversal and secret environment files even with valid archive checksums",
  shellOptions,
  async (t) => {
    for (const name of [
      "ai-preflight-local/docs/../../escape",
      "ai-preflight-local/docs/.env.local",
    ]) {
      const value = await shellFixture(t);
      const files = await collectFiles(value.source);
      await replaceArchive(
        value,
        makeTar([...files, { name, data: Buffer.from("unsafe fixture") }]),
      );
      const result = runInstall(value);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /归档路径|环境|路径/);
      await assert.rejects(stat(join(value.root, "app")), { code: "ENOENT" });
      await assert.rejects(stat(join(value.root, "escape")), { code: "ENOENT" });
      assert.deepEqual(await launchEvents(value), []);
    }
  },
);

test(
  "shell extraction rejects archive content whose version disagrees with the selected release",
  shellOptions,
  async (t) => {
    const value = await shellFixture(t);
    await writeFile(
      join(value.source, "package.json"),
      '{"name":"ai-preflight-local","version":"99.0.0"}',
    );
    await replaceArchive(value, makeTar(await collectFiles(value.source)));
    const result = runInstall(value);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /版本/);
    assert.deepEqual(await launchEvents(value), []);
  },
);

test(
  "Windows PowerShell installs and updates verified ZIPs while preserving private configuration",
  windowsOptions,
  async (t) => {
    const value = await windowsFixture(t);
    assertSuccess(runWindows(value));
    assert.equal(
      JSON.parse(await readFile(join(value.root, "app/package.json"), "utf8")).version,
      "0.3.0",
    );
    assert.deepEqual(await launchEvents(value), []);
    await writeFile(join(value.root, "config/.env"), "PORT=4567\n");
    await writeFile(join(value.root, "config/config.local.json"), '{"custom":"preserve me"}\n');
    await writeFile(
      join(value.source, "package.json"),
      '{"name":"ai-preflight-local","version":"0.3.1","type":"module"}',
    );
    await packageRelease(value.source, value.output);
    assertSuccess(runWindows(value, { PREFLIGHT_VERSION: "v0.3.1", PREFLIGHT_NO_START: "0" }));
    assert.equal(
      JSON.parse(await readFile(join(value.root, "app/package.json"), "utf8")).version,
      "0.3.1",
    );
    assert.equal(
      JSON.parse(await readFile(join(value.root, "app.previous/package.json"), "utf8")).version,
      "0.3.0",
    );
    assert.equal(await readFile(join(value.root, "config/.env"), "utf8"), "PORT=4567\n");
    assert.equal(
      await readFile(join(value.root, "config/config.local.json"), "utf8"),
      '{"custom":"preserve me"}\n',
    );
    assert.deepEqual(
      (await launchEvents(value)).map((event) => event.args[0]),
      ["stop", "start"],
    );
    const wrapper = join(value.root, "bin/ai-preflight.cmd");
    // Use an environment variable so spaces and apostrophes are parsed by cmd,
    // exactly as they are when the installed shortcut is called by its full path.
    const invoked = spawnSync("cmd.exe", ["/d", "/s", "/c", '""%FIXTURE_WRAPPER%" status"'], {
      env: { ...value.env, FIXTURE_WRAPPER: wrapper },
      encoding: "utf8",
      windowsVerbatimArguments: true,
    });
    assertSuccess(invoked);
    assert.equal((await launchEvents(value)).at(-1).args[0], "status");
  },
);

test(
  "Windows PowerShell refuses checksum mismatches without replacing or stopping the current app",
  windowsOptions,
  async (t) => {
    const value = await windowsFixture(t);
    assertSuccess(runWindows(value));
    await writeFile(
      join(value.output, "SHA256SUMS"),
      `${"0".repeat(64)}  ai-preflight-local-v0.3.0.zip\n`,
    );
    const result = runWindows(value);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /SHA256 mismatch/);
    assert.equal(
      JSON.parse(await readFile(join(value.root, "app/package.json"), "utf8")).version,
      "0.3.0",
    );
    assert.deepEqual(await launchEvents(value), []);
  },
);

test(
  "Windows PowerShell rejects unsafe ZIP traversal and private environment variants",
  windowsOptions,
  async (t) => {
    for (const name of [
      "ai-preflight-local/docs/../../escape",
      "ai-preflight-local/docs/.env.production",
    ]) {
      const value = await windowsFixture(t);
      const zip = makeZip([
        ...(await collectFiles(value.source)),
        { name, data: Buffer.from("unsafe fixture") },
      ]);
      const asset = "ai-preflight-local-v0.3.0.zip";
      await writeFile(join(value.output, asset), zip);
      await writeFile(join(value.output, "SHA256SUMS"), `${digest(zip)}  ${asset}\n`);
      const result = runWindows(value);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr + result.stdout, /Unsafe|Private or unexpected/);
      await assert.rejects(stat(join(value.root, "app")), { code: "ENOENT" });
      await assert.rejects(stat(join(value.root, "escape")), { code: "ENOENT" });
      assert.deepEqual(await launchEvents(value), []);
    }
  },
);
