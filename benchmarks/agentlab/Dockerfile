FROM python:3.12-slim-bookworm AS dependencies

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AGENTLAB_EXP_ROOT=/results \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /runner

RUN python -m pip install --no-cache-dir --upgrade pip

RUN python -m pip install --no-cache-dir \
    browsergym-core==0.14.3 \
    browsergym-experiments==0.14.3 \
    pandas \
    tqdm

RUN python -m pip install --no-cache-dir --no-deps agentlab==0.4.2

FROM dependencies AS preflight

RUN playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.cache

COPY preflight.py lhic_semantic_policy.py lhic_agent.py /runner/

RUN useradd --create-home --uid 10001 agentlab \
    && mkdir -p /results \
    && chown -R agentlab:agentlab /ms-playwright /runner /results

USER agentlab

ENTRYPOINT ["python", "/runner/preflight.py"]
