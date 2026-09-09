# ZoneClip Local AI runtimes

Versioned llama.cpp and whisper.cpp server runtimes, plus the scripts used to update, package, and upload them.

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
