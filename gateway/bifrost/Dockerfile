# Wavelength model gateway - Bifrost + our boot-time config rendering, baked into
# an image we own in ACR. Built with `az acr build` (no local Docker).
#
# Base is PINNED to an exact version (not :latest / :main-stable) - the LiteLLM
# floating-tag lesson: "pinned by accident of build date" is not pinned. Bump
# deliberately and rebuild.
#
# No secret is baked into this image. config.json is rendered at container start
# by wl-entrypoint.sh from environment variables, which arrive from Key Vault via
# the Container App's secret references (see ../bifrost.tf).
FROM docker.io/maximhq/bifrost:v1.5.11

COPY --chown=appuser:appuser config.json.tmpl /app/config.json.tmpl
COPY --chown=appuser:appuser wl-entrypoint.sh /app/wl-entrypoint.sh

# Upstream runs as appuser with ENTRYPOINT /app/docker-entrypoint.sh; we wrap it.
ENTRYPOINT ["/bin/sh", "/app/wl-entrypoint.sh"]
