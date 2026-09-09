import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  cpSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dependsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = resolve(option("--app-root") ?? join(dependsRoot, "..", "app"));
const version = option("--version")?.trim();
const outputBase = resolve(option("--output") ?? join(dependsRoot, "release", "local-ai-runtime"));
const s3Uri = option("--s3-uri")?.replace(/\/$/, "");
const uploadOnly = args.includes("--upload-only");
if (!version || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version)) {
  throw new Error("--version is required and may contain only letters, numbers, dot, dash, and underscore");
}

const windows = process.platform === "win32";
if (!windows && process.platform !== "darwin") {
  throw new Error("Runtime packages can only be prepared on Windows or macOS");
}
const platform = windows ? "windows" : "macos";
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const platformKey = `${platform}-${arch}`;
const outputRoot = join(outputBase, platformKey);
const sourcePlatform = windows ? "win" : "mac";
const extension = windows ? ".exe" : "";
const stagingRoot = mkdtempSync(join(tmpdir(), "zoneclip-local-ai-runtime-"));
const packages = [];

try {
  if (!uploadOnly) {
    rmSync(outputRoot, { recursive: true, force: true });
    mkdirSync(outputRoot, { recursive: true });
    if (windows) {
      for (const component of ["asr", "llm"]) {
        for (const backend of ["cpu", "vulkan", "cuda"]) {
          createWindowsPackage(component, backend);
        }
      }
    } else {
      for (const component of ["asr", "llm"]) createMacPackages(component);
    }
    writeFileSync(
      join(outputRoot, "manifest.json"),
      `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`,
    );
    console.log(`Prepared ${packages.length} manifest entries in ${outputRoot}`);
  } else {
    requireFile(join(outputRoot, "manifest.json"));
    console.log(`Reusing runtime packages in ${outputRoot}`);
  }
  if (s3Uri) {
    try {
      await uploadToS3(outputRoot, `${s3Uri}/${platformKey}`);
    } catch (error) {
      if (error?.name === "CredentialsProviderError") {
        throw new Error(
          "No AWS credentials are available. Set AWS_PROFILE, configure ~/.aws/credentials, or run this command on a host with an IAM role.",
          { cause: error },
        );
      }
      throw error;
    }
  } else if (uploadOnly) {
    throw new Error("--upload-only requires --s3-uri");
  }
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}

function createWindowsPackage(component, backend) {
  const sourceName = component === "asr" ? "whisper" : "llama";
  const source = join(dependsRoot, sourceName, sourcePlatform, "bin");
  const stage = join(stagingRoot, `${component}-${backend}`);
  mkdirSync(stage, { recursive: true });
  const backendFiles = new Set([`ggml-${backend}.dll`]);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    const backendLibrary = lower === "ggml-cuda.dll" || lower === "ggml-vulkan.dll";
    const cudaLibrary = /^(cublas|cudart|nvrtc|nvjitlink)/i.test(entry.name);
    if ((backendLibrary && !backendFiles.has(lower)) || (cudaLibrary && backend !== "cuda")) continue;
    copyFileSync(join(source, entry.name), join(stage, entry.name));
  }
  if (component === "asr" && backend === "cuda") {
    const llamaSource = join(dependsRoot, "llama", sourcePlatform, "bin");
    for (const name of readdirSync(llamaSource)) {
      if (/^(cublas|cudart|nvrtc|nvjitlink)/i.test(name)) {
        copyFileSync(join(llamaSource, name), join(stage, name));
      }
    }
  }
  const executable = component === "asr" ? `whisper-server${extension}` : `llama-server${extension}`;
  requireFile(join(stage, executable));
  addArchive(component, backend, stage, executable);
}

function createMacPackages(component) {
  const sourceName = component === "asr" ? "whisper" : "llama";
  const source = join(dependsRoot, sourceName, sourcePlatform, "bin");
  const stage = join(stagingRoot, `${component}-metal`);
  cpSync(source, stage, { recursive: true });
  const executable = component === "asr" ? "whisper-server" : "llama-server";
  requireFile(join(stage, executable));
  execFileSync(
    "bash",
    [
      join(appRoot, "scripts", "macos-sign.sh"),
      join(stage, executable),
      component === "asr" ? "com.zoneclip.whisper-server" : "com.zoneclip.llama-server",
      join(appRoot, "src-tauri", "Entitlements.plist"),
    ],
    { stdio: "inherit", env: { ...process.env, ZONECLIP_RELEASE: "1" } },
  );
  const archive = addArchive(component, "metal", stage, executable);
  packages.push({ ...archive, backend: "cpu" });
}

function addArchive(component, backend, stage, executable) {
  const archiveName = `${component}-${platform}-${arch}-${backend}-${version}.zip`;
  const archivePath = join(outputRoot, archiveName);
  if (windows) {
    execFileSync("tar.exe", ["-a", "-c", "-f", archivePath, "-C", stage, "."], { stdio: "inherit" });
  } else {
    execFileSync("ditto", ["-c", "-k", "--keepParent", stage, archivePath], { stdio: "inherit" });
    // ditto --keepParent adds one directory; rebuild without it so executable paths stay stable.
    rmSync(archivePath, { force: true });
    execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", stage, archivePath], { stdio: "inherit" });
  }
  const record = {
    component,
    platform,
    arch,
    backend,
    version,
    archive: archiveName,
    sha256: sha256(archivePath),
    sizeBytes: statSync(archivePath).size,
    executable,
  };
  packages.push(record);
  return record;
}

function sha256(path) {
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

function requireFile(path) {
  if (!statSafe(path)?.isFile()) throw new Error(`Required runtime file is missing: ${path}`);
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function uploadToS3(sourceRoot, destinationUri) {
  let S3Client;
  let Upload;
  try {
    ({ S3Client } = await import("@aws-sdk/client-s3"));
    ({ Upload } = await import("@aws-sdk/lib-storage"));
  } catch (error) {
    throw new Error("S3 upload dependencies are missing. Run npm install in ZoneClip_depends.", {
      cause: error,
    });
  }
  const match = /^s3:\/\/([^/]+)(?:\/(.*))?$/.exec(destinationUri);
  if (!match) throw new Error(`Invalid S3 destination: ${destinationUri}`);
  const bucket = match[1];
  const prefix = (match[2] ?? "").replace(/^\/+|\/+$/g, "");
  const client = new S3Client({
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
  });
  const files = listFiles(sourceRoot).sort((left, right) => {
    if (left.endsWith("manifest.json")) return 1;
    if (right.endsWith("manifest.json")) return -1;
    return left.localeCompare(right);
  });
  for (const path of files) {
    const relativePath = path.slice(sourceRoot.length + 1).replaceAll("\\", "/");
    const key = prefix ? `${prefix}/${relativePath}` : relativePath;
    const size = statSync(path).size;
    console.log(`Uploading s3://${bucket}/${key} (${formatBytes(size)})`);
    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: size,
        ContentType: path.endsWith(".json") ? "application/json" : "application/zip",
        CacheControl: path.endsWith("manifest.json")
          ? "public,max-age=300"
          : "public,max-age=31536000,immutable",
      },
      queueSize: 4,
      partSize: 16 * 1024 * 1024,
      leavePartsOnError: false,
    });
    await upload.done();
  }
  console.log(`Uploaded ${files.length} files to ${destinationUri}`);
}

function listFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
