import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, openSync, closeSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dependsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = option("--source-root");
const outputRoot = resolve(option("--output") ?? join(dependsRoot, "release", "local-ai-model"));
const s3Uri = option("--s3-uri")?.replace(/\/$/, "");

if (!sourceRoot) throw new Error("--source-root is required");

const models = [
  {
    id: "whisper-small",
    revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
    source: "whisper/ggml-small.bin",
    path: "whisper/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin",
    sizeBytes: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
  },
  {
    id: "gemma-4-e4b",
    revision: "b8093469224f83f5c38f691eb906c380e9e63114",
    source: "gemma-4-e4b/gemma-4-E4B-it-Q4_0.gguf",
    path: "gemma-4-e4b/b8093469224f83f5c38f691eb906c380e9e63114/gemma-4-E4B-it-Q4_0.gguf",
    sizeBytes: 4_590_807_392,
    sha256: "a555b900214b477d8880e7832e0b8925e139b0159640036b09fe472b6f2097f2",
  },
  {
    id: "gemma-4-e4b-mmproj",
    revision: "b8093469224f83f5c38f691eb906c380e9e63114",
    source: "gemma-4-e4b/mmproj-gemma-4-E4B-it-Q8_0.gguf",
    path: "gemma-4-e4b/b8093469224f83f5c38f691eb906c380e9e63114/mmproj-gemma-4-E4B-it-Q8_0.gguf",
    sizeBytes: 559_874_816,
    sha256: "197f49a93027f9843772bd24a6a9e0be2a32a788de5a3def330e9c585d86edd1",
  },
  {
    id: "pyannote-segmentation-3.0-int8",
    revision: "9403a69",
    source: "speaker-diarization/pyannote-segmentation-3.0.int8.onnx",
    path: "speaker-diarization/9403a69/pyannote-segmentation-3.0.int8.onnx",
    sizeBytes: 1_540_506,
    sha256: "d582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d",
  },
  {
    id: "eres2net-voxceleb-16k",
    revision: "c59158379255",
    source: "speaker-diarization/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx",
    path: "speaker-diarization/c59158379255/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx",
    sizeBytes: 26_485_263,
    sha256: "c59158379255ad66e161679cca6af8d52d51e389e3224ab7d7a7baae295c2db5",
  },
];

const prepared = [];
for (const model of models) {
  const sourcePath = resolve(sourceRoot, model.source);
  const size = statSync(sourcePath).size;
  if (size !== model.sizeBytes) {
    throw new Error(`${model.id} size mismatch: expected ${model.sizeBytes}, received ${size}`);
  }
  const actualHash = sha256(sourcePath);
  if (actualHash !== model.sha256) {
    throw new Error(`${model.id} SHA-256 mismatch: expected ${model.sha256}, received ${actualHash}`);
  }
  prepared.push({ ...model, sourcePath });
  console.log(`Verified ${model.id} (${formatBytes(size)})`);
}

mkdirSync(outputRoot, { recursive: true });
const manifestPath = join(outputRoot, "manifest.json");
writeFileSync(
  manifestPath,
  `${JSON.stringify({ schemaVersion: 1, models: prepared.map(({ sourcePath, source, ...model }) => model) }, null, 2)}\n`,
);
console.log(`Prepared model manifest at ${manifestPath}`);

if (s3Uri) await uploadToS3(prepared, manifestPath, s3Uri);

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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

async function uploadToS3(preparedModels, manifestPath, destinationUri) {
  let S3Client;
  let Upload;
  try {
    ({ S3Client } = await import("@aws-sdk/client-s3"));
    ({ Upload } = await import("@aws-sdk/lib-storage"));
  } catch (error) {
    throw new Error("S3 upload dependencies are missing. Run npm install first.", { cause: error });
  }
  const match = /^s3:\/\/([^/]+)(?:\/(.*))?$/.exec(destinationUri);
  if (!match) throw new Error(`Invalid S3 destination: ${destinationUri}`);
  const bucket = match[1];
  const prefix = (match[2] ?? "").replace(/^\/+|\/+$/g, "");
  const client = new S3Client({
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
  });
  for (const model of preparedModels) {
    await uploadFile(client, Upload, bucket, prefix, model.path, model.sourcePath, true);
  }
  await uploadFile(client, Upload, bucket, prefix, "manifest.json", manifestPath, false);
  console.log(`Uploaded ${preparedModels.length} models and manifest to ${destinationUri}`);
}

async function uploadFile(client, Upload, bucket, prefix, relativePath, sourcePath, immutable) {
  const key = prefix ? `${prefix}/${relativePath}` : relativePath;
  const size = statSync(sourcePath).size;
  console.log(`Uploading s3://${bucket}/${key} (${formatBytes(size)})`);
  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: createReadStream(sourcePath),
      ContentLength: size,
      ContentType: relativePath.endsWith(".json") ? "application/json" : "application/octet-stream",
      CacheControl: immutable ? "public,max-age=31536000,immutable" : "public,max-age=300",
    },
    queueSize: 4,
    partSize: 16 * 1024 * 1024,
    leavePartsOnError: false,
  });
  await upload.done();
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
