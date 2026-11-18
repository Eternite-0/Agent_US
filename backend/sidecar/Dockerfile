ARG BASE=python:3.11-slim
FROM ${BASE}
COPY --chmod=755 magpie /usr/local/bin/magpie
COPY bridge.py /opt/bridge.py
USER 65534:65534
ENTRYPOINT ["python","-I","/opt/bridge.py"]
