ARG BASE=python:3.11-slim
FROM ${BASE}
COPY --chmod=755 codex /usr/local/bin/codex
COPY runner.py /opt/runner.py
COPY mcp.py /opt/mcp.py
ENV HOME=/tmp CODEX_HOME=/tmp/codex GIT_CONFIG_NOSYSTEM=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /work
USER 65534:65534
ENTRYPOINT ["/usr/bin/timeout","-k","1","12","python","-I","/opt/runner.py"]
