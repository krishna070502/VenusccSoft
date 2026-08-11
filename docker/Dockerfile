# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Venus Chicken Centers — Operations Console
# Multi-stage: wheels are built once, the runtime image stays small and has
# no compiler toolchain in it.
# ---------------------------------------------------------------------------

# ---------- build stage ----------------------------------------------------
FROM python:3.12-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# psycopg2 needs these to compile; they stay behind in this stage
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /wheels
COPY requirements.txt .
RUN pip wheel --wheel-dir /wheels -r requirements.txt


# ---------- runtime stage --------------------------------------------------
FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# libpq5 is the runtime half of libpq-dev; curl is for the healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 curl \
    && rm -rf /var/lib/apt/lists/*

# run as an unprivileged user, not root
RUN useradd --create-home --uid 10001 venus
WORKDIR /app

COPY --from=builder /wheels /wheels
RUN pip install --no-index --find-links=/wheels /wheels/*.whl \
    && rm -rf /wheels

COPY --chown=venus:venus . .
RUN chmod +x /app/docker/entrypoint.sh

USER venus

# The port is configurable; this is only documentation for `docker run -P`.
ARG APP_PORT=8000
ENV PORT=${APP_PORT}
EXPOSE ${APP_PORT}

# Compose also defines a healthcheck; this one covers `docker run` on its own.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:${PORT:-8000}/healthz || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]
# Shell form on purpose: free hosts (Render, Koyeb, Railway) hand you a PORT
# to bind to, and 4 workers will not fit in a 512 MB free instance.
CMD gunicorn --bind 0.0.0.0:${PORT:-8000} \
    --workers ${WEB_CONCURRENCY:-2} --threads ${WEB_THREADS:-4} \
    --timeout 120 --access-logfile - --error-logfile - wsgi:app
