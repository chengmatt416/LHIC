ARG PYTHON_IMAGE=python:3.12-slim-bookworm@sha256:d50fb7611f86d04a3b0471b46d7557818d88983fc3136726336b2a4c657aa30b
FROM ${PYTHON_IMAGE} AS dependencies

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AGENTLAB_EXP_ROOT=/results \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /runner

RUN python -m pip install --no-cache-dir --upgrade pip

RUN python -m pip install --no-cache-dir \
    agentlab==0.4.0 \
    browsergym==0.14.3 \
    browsergym-webarena==0.14.3 \
    browsergym-workarena==0.5.3 \
    && python -c "import nltk; nltk.download('punkt_tab', download_dir='/usr/local/share/nltk_data', raise_on_error=True)"

RUN playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.cache

FROM dependencies AS preflight

COPY preflight.py lhic_semantic_policy.py lhic_agent.py lhic_full_agent.py run_study.py /runner/

RUN useradd --create-home --uid 10001 agentlab \
    && mkdir -p /results \
    && chown -R agentlab:agentlab /ms-playwright /runner /results

USER agentlab

ENTRYPOINT ["python", "/runner/preflight.py"]

FROM dependencies AS runner

COPY preflight.py lhic_semantic_policy.py lhic_agent.py lhic_full_agent.py run_study.py /runner/

ARG LHIC_SOURCE_REVISION=unknown
ENV LHIC_SOURCE_REVISION=${LHIC_SOURCE_REVISION}
LABEL org.opencontainers.image.revision=${LHIC_SOURCE_REVISION}

RUN useradd --create-home --uid 10001 agentlab \
    && mkdir -p /results \
    && chown -R agentlab:agentlab /ms-playwright /runner /results

USER agentlab

ENTRYPOINT ["python", "/runner/run_study.py"]
CMD ["--help"]
