import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dependsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(dependsRoot, "renderer-base");
const version = option("--version")?.trim();
const outputRoot = resolve(
  option("--output") ?? join(dependsRoot, "release", "renderer-base", "windows-x86_64"),
);
const s3Uri = option("--s3-uri")?.replace(/\/$/u, "");
const uploadOnly = args.includes("--upload-only");
const publicBaseUrl = (
  option("--public-base-url") ?? "https://media.zoneclip.ai/renderer-base/windows-x86_64"
).replace(/\/$/u, "");
const chromeVersion = process.env.ZONECLIP_CHROME_VERSION ?? "149.0.7790.0";
const nodeVersion = "v24.16.0";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Renderer base packages currently support Windows x64 only");
}
if (process.version !== nodeVersion) {
  throw new Error(
    `Renderer base ${version ?? "<unknown>"} must be built with Node.js ${nodeVersion}; current runtime is ${process.version}`,
  );
}
if (!version || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/u.test(version)) {
  throw new Error("--version is required and may contain only letters, numbers, dot, dash, and underscore");
}

const archiveName = `renderer-base-windows-x86_64-${version}.zip`;
const archivePath = join(outputRoot, archiveName);
const publicManifestPath = join(outputRoot, "manifest.json");
const zoneClipManifestPath = join(outputRoot, "zoneclip-manifest.json");
const workspace = mkdtempSync(join(tmpdir(), "zoneclip-renderer-base-"));
const stage = join(workspace, "runtime");

try {
  if (!uploadOnly) {
    rmSync(outputRoot, { force: true, recursive: true });
    mkdirSync(outputRoot, { recursive: true });
    mkdirSync(stage, { recursive: true });
    copyFileSync(join(sourceRoot, "package.json"), join(stage, "package.json"));
    copyFileSync(join(sourceRoot, "package-lock.json"), join(stage, "package-lock.json"));
    execFileSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", "npm ci --omit=dev --no-audit --no-fund"],
      { cwd: stage, stdio: "inherit" },
    );
    prepareChrome(stage);
    execFileSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", "npx remotion browser ensure"],
      { cwd: stage, stdio: "inherit" },
    );

    const bin = join(stage, "bin");
    mkdirSync(bin, { recursive: true });
    const nodeName = "node-win32-x64.exe";
    copyFileSync(process.execPath, join(bin, nodeName));
    const rendererPackage = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
    const internalManifest = {
      schemaVersion: 1,
      id: `renderer-base-windows-x86_64-${version}`,
      platform: "windows",
      arch: "x86_64",
      version,
      nodeVersion,
      remotionVersion: rendererPackage.dependencies["@remotion/cli"],
      chromeVersion,
      nodeBinary: `bin/${nodeName}`,
      remotionCli: "node_modules/@remotion/cli/remotion-cli.js",
      browserExecutable:
        "node_modules/.remotion/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe",
    };
    writeFileSync(
      join(stage, "renderer-base-manifest.json"),
      `${JSON.stringify(internalManifest, null, 2)}\n`,
    );

    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(dependsRoot, "scripts", "sign-renderer-base-windows.ps1"),
        "-RootPath",
        stage,
      ],
      { stdio: "inherit", env: process.env },
    );

    execFileSync("tar.exe", ["-a", "-c", "-f", archivePath, "-C", stage, "."], {
      stdio: "inherit",
    });
    const sha256 = fileSha256(archivePath);
    const sizeBytes = statSync(archivePath).size;
    const packageRecord = {
      platform: "windows",
      arch: "x86_64",
      version,
      archive: archiveName,
      sha256,
      sizeBytes,
    };
    writeFileSync(
      publicManifestPath,
      `${JSON.stringify({ schemaVersion: 1, packages: [packageRecord] }, null, 2)}\n`,
    );
    writeFileSync(
      zoneClipManifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: "renderer-base-windows-x86_64",
          platform: "windows",
          arch: "x86_64",
          version,
          url: `${publicBaseUrl}/${archiveName}`,
          sha256,
          sizeBytes,
          nodeBinary: "bin/node-win32-x64.exe",
          remotionCli: "node_modules/@remotion/cli/remotion-cli.js",
          browserExecutable:
            "node_modules/.remotion/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe",
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Prepared ${archivePath}`);
    console.log(`ZoneClip manifest: ${zoneClipManifestPath}`);
  } else {
    requireFile(archivePath);
    requireFile(publicManifestPath);
    requireFile(zoneClipManifestPath);
  }

  if (s3Uri) {
    await uploadToS3([archivePath, publicManifestPath], s3Uri);
  } else if (uploadOnly) {
    throw new Error("--upload-only requires --s3-uri");
  }
} finally {
  rmSync(workspace, { force: true, recursive: true });
}

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requireFile(path) {
  if (!statSafe(path)?.isFile()) throw new Error(`Required file is missing: ${path}`);
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function fileSha256(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function prepareChrome(runtimeRoot) {
  const cacheRoot = join(
    runtimeRoot,
    "node_modules",
    ".remotion",
    "chrome-headless-shell",
  );
  const platformRoot = join(cacheRoot, "win64");
  const archive = join(cacheRoot, "chrome-headless-shell-win64.zip");
  const url = `https://cdn.npmmirror.com/binaries/chrome-for-testing/${chromeVersion}/win64/chrome-headless-shell-win64.zip`;
  mkdirSync(platformRoot, { recursive: true });
  console.log(`Downloading pinned Chrome Headless Shell from ${url}`);
  execFileSync(
    "curl.exe",
    [
      "-fL",
      "--retry",
      "3",
      "--retry-delay",
      "2",
      "--connect-timeout",
      "30",
      "-o",
      archive,
      url,
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Force -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${platformRoot.replaceAll("'", "''")}'`,
    ],
    { stdio: "inherit" },
  );
  rmSync(archive, { force: true });
  const executable = join(
    platformRoot,
    "chrome-headless-shell-win64",
    "chrome-headless-shell.exe",
  );
  requireFile(executable);
  writeFileSync(join(cacheRoot, "VERSION"), `${chromeVersion}\n`);
}

async function uploadToS3(paths, destinationUri) {
  const [{ HeadObjectCommand, S3Client }, { Upload }] = await Promise.all([
    import("@aws-sdk/client-s3"),
    import("@aws-sdk/lib-storage"),
  ]);
  const match = /^s3:\/\/([^/]+)(?:\/(.*))?$/u.exec(destinationUri);
  if (!match) throw new Error(`Invalid S3 destination: ${destinationUri}`);
  const bucket = match[1];
  const prefix = (match[2] ?? "").replace(/^\/+|\/+$/gu, "");
  const client = new S3Client({
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
  });
  const ordered = [...paths].sort((left, right) => {
    if (basename(left) === "manifest.json") return 1;
    if (basename(right) === "manifest.json") return -1;
    return left.localeCompare(right);
  });
  for (const path of ordered) {
    const name = relative(dirname(path), path).replaceAll("\\", "/");
    const key = prefix ? `${prefix}/${name}` : name;
    const size = statSync(path).size;
    const immutable = !path.endsWith(".json");
    const sha256 = immutable ? fileSha256(path) : undefined;
    if (immutable) {
      try {
        const existing = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        if (
          existing.ContentLength === size &&
          existing.Metadata?.sha256?.toLowerCase() === sha256
        ) {
          console.log(`Reusing immutable s3://${bucket}/${key}`);
          continue;
        }
        throw new Error(`Immutable renderer object already exists with different content: s3://${bucket}/${key}`);
      } catch (error) {
        if (error?.$metadata?.httpStatusCode !== 404) throw error;
      }
    }
    console.log(`Uploading s3://${bucket}/${key}`);
    await new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: size,
        ContentType: path.endsWith(".json") ? "application/json" : "application/zip",
        CacheControl: path.endsWith(".json")
          ? "public,max-age=300"
          : "public,max-age=31536000,immutable",
        Metadata: immutable ? { sha256 } : undefined,
      },
      queueSize: 4,
      partSize: 16 * 1024 * 1024,
      leavePartsOnError: false,
    }).done();
  }
}
