# ZoneClip Local AI dependencies

Versioned llama.cpp and whisper.cpp server runtimes, pinned model files, and the scripts used to verify, package, and upload them.

These programs are optional. ZoneClip can build and run in ZoneCloud mode without initializing this repository. Native libraries required by the main desktop application remain in the main ZoneClip repository.

Generated Local AI runtime archives are intentionally not committed. `release/local-ai-runtime/` is ignored; publish those archives to S3 with the packaging command instead.

## Use from ZoneClip

Clone the main repository with its dependency submodule:

```bash
git clone --recurse-submodules https://github.com/EverZoneNas/ZoneClip.git
```

For an existing checkout:

```bash
git submodule update --init --recursive
```

## Update a dependency

Update or run the applicable script under `scripts/`, verify both Windows and macOS paths as applicable, then commit the changed runtime files and version metadata in this repository. Update the `client/deps/local-ai-runtime` submodule commit in ZoneClip in a separate commit.

The macOS helper scripts build pinned versions of llama.cpp and whisper.cpp, and fetch a checksum-verified Node.js runtime:

```bash
bash scripts/prepare-llama-runtime.sh
bash scripts/prepare-whisper-runtime.sh
```

## Package and upload Local AI runtimes

Install upload dependencies once:

```bash
npm install
```

Prepare packages for the current platform without committing the output:

```bash
npm run prepare:local-ai-runtimes -- --version <version>
```

Prepare and publish to S3:

```bash
npm run prepare:local-ai-runtimes -- --version <version> --s3-uri s3://<bucket>/<prefix>
```

The upload publishes archives first and `manifest.json` last. AWS credentials are read from the standard AWS profile, environment, or IAM role chain.

## Verify and upload Local AI models

Model object paths include their upstream revision or content-hash prefix and are immutable. The client pins each object's path, size, and SHA-256. Publish the models from an already verified ZoneClip model directory:

```bash
npm run prepare:local-ai-models -- --source-root <ZoneClip-model-directory>
npm run prepare:local-ai-models -- --source-root <ZoneClip-model-directory> --s3-uri s3://<bucket>/local-ai-model
```

The command verifies every source file before uploading model objects, then publishes `manifest.json` last. Do not overwrite an existing versioned object with different content; add a new revision path and update the client pins instead.
