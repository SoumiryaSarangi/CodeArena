# The plagiarism job (PL-05). Build from the repository root:
#   docker build -f apps/plag/Dockerfile -t codearena-plag apps/plag
# It polls the API for runs and scores them on CPU: `serve --api http://api:4000` (see infra/prod/docker-compose.yml).
# The UniXcoder model (about 500 MB) is baked into the image, so a run never depends on a download at the time.
FROM python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
# Dependencies first, so this layer is cached until the lockfile changes (CPU-only torch comes from the lockfile).
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev
ENV HF_HOME=/models
RUN /app/.venv/bin/python -c "from transformers import AutoModel, AutoTokenizer; AutoTokenizer.from_pretrained('microsoft/unixcoder-base'); AutoModel.from_pretrained('microsoft/unixcoder-base')"

FROM python:3.12-slim
RUN useradd --uid 10001 --create-home plag
COPY --from=build /app /app
COPY --from=build /models /models
ENV PATH="/app/.venv/bin:$PATH" HF_HOME=/models HF_HUB_OFFLINE=1 PYTHONUNBUFFERED=1
USER plag
WORKDIR /app
ENTRYPOINT ["python", "-m", "plag"]
CMD ["--help"]
