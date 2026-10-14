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

## Package the Windows renderer base

The renderer base contains only stable Windows x64 dependencies: Node.js, the
Remotion production dependency tree, and Chrome Headless Shell. ZoneClip keeps
its generated renderer bundle and launch script in the application repository.

Prepare a signed immutable archive using the LAN signing Agent:

```powershell
npm install
npm run prepare:renderer-base -- --version v2
```

Renderer base `v1` is reproducibly pinned to Node.js `v24.16.0`; the packaging
command stops if it is run under a different Node.js version. Publish a new
immutable renderer-base version when changing Node.js, Remotion, or Chrome.

The command discovers ZoneClip's signing client when this repository is checked
out at `client/deps/local-ai-runtime`. For a standalone checkout, set
`ZONECLIP_SIGNING_CLIENT` to `windows-signing-agent.ps1`. Publish with:

```powershell
npm run prepare:renderer-base -- --version v2 --s3-uri s3://zoneclip-dev/renderer-base
```

Copy the generated `zoneclip-manifest.json` into ZoneClip only after the archive
has been published. The application pins the immutable URL, size, and SHA-256;
it never follows an unpinned online "latest" manifest.
