# QuantumOS: the web server, the Lean controller model and the course in one image.
#
#   docker build -t quantumos .
#   docker run -p 8080:8080 quantumos          then open http://localhost:8080
#
# The trapped-ion examples compile through QCCD Studio, a separate public repository. It is
# cloned at build time; set --build-arg QCCD_REF=<branch or tag> to pin it. If the clone fails,
# the image still builds and the trapped-ion examples report that QCCD Studio is missing.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 \
 && rm -rf /var/lib/apt/lists/*

# Lean, through elan, at the version in lean-toolchain.
ENV ELAN_HOME=/opt/elan PATH=/opt/elan/bin:$PATH
RUN curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
  | sh -s -- -y --default-toolchain none --no-modify-path

WORKDIR /app
# Build the Lean executable first, so code-only changes reuse this layer.
COPY lean-toolchain lakefile.toml lake-manifest.json QControl.lean Main.lean ./
COPY QControl ./QControl
COPY physical/qccd-installation.json ./physical/qccd-installation.json
RUN lake build

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ARG QCCD_REPO=https://github.com/yezhuoyang/QCCD.git
ARG QCCD_REF=compiler
ENV QCCD_HOME=/opt/qccd-home
# QCCD Studio and its prebuilt compiler (qccdc_cli), which `qccd toolchain install` fetches and
# checks against the SHA-256 pinned in the QCCD repository.
RUN (git clone --depth 1 --branch "$QCCD_REF" "$QCCD_REPO" /opt/QCCD \
  && cd /opt/QCCD && PYTHONPATH=/opt/QCCD python3 -m qccd.workspace.cli toolchain install) \
  || echo "QCCD Studio could not be installed: the trapped-ion examples will be unavailable."

ENV NODE_ENV=production \
    PORT=8080 \
    QUANTUMOS_HOST=0.0.0.0 \
    QCCD_STUDIO_ROOT=/opt/QCCD \
    QCONTROL_PYTHON=python3 \
    PYTHONDONTWRITEBYTECODE=1

# The bridge asks git for QCCD Studio's revision, as the runtime user.
RUN git config --system --add safe.directory /opt/QCCD \
 && chown -R node:node /app \
 && (chown -R node:node /opt/QCCD /opt/qccd-home 2>/dev/null || true)
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/riscq/examples').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
