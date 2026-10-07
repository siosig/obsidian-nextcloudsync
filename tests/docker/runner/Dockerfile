# syntax=docker/dockerfile:1
#
# Single runner image for the Docker test suite (a, b1, b2, b3 layers).
# Build from the repository root:
#   docker build -f tests/docker/runner/Dockerfile -t ncs-suite-runner:<tag> .
# The build context is restricted by Dockerfile.dockerignore to the package manifests and this
# directory, so local secrets such as .env never enter the image. The repository itself is mounted
# read-only at /src at run time and copied into /work by suite-entry.sh.
FROM node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Tooling for the suite plus the shared libraries Electron (Obsidian, b2) needs under Xvfb.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git curl openssl xvfb xauth libnss3-tools openjdk-17-jdk-headless unzip util-linux \
        libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxshmfence1 libdrm2 libxkbcommon0 \
    && rm -rf /var/lib/apt/lists/*

# pnpm version must match the "packageManager" field in package.json.
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH=${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}

# Android SDK (b3): same pinned commandline-tools build as the Android emulator setup.
RUN mkdir -p "${ANDROID_HOME}/cmdline-tools" \
    && curl -fsSL -o /tmp/cmdline-tools.zip \
        https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
    && unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools \
    && mv /tmp/cmdline-tools/cmdline-tools "${ANDROID_HOME}/cmdline-tools/latest" \
    && rm -rf /tmp/cmdline-tools /tmp/cmdline-tools.zip \
    && (yes | sdkmanager --licenses > /dev/null) \
    && sdkmanager "platform-tools" "build-tools;34.0.0"

# Dependencies are installed into the image; /work/node_modules is reused by every run.
WORKDIR /work
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

ENTRYPOINT ["bash", "/src/tests/docker/runner/bin/suite-entry.sh"]
