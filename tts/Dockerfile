FROM python:3.12-slim-bookworm@sha256:44cf1793efa7c7a476bb0f2cff81443f4a072c90c1cb127e2924933daa3e8c64
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2
WORKDIR /app
COPY requirements.txt ./
RUN python -m pip install --disable-pip-version-check --no-cache-dir --require-hashes --only-binary=:all: -r requirements.txt
COPY fetch_voice.py ./
RUN python fetch_voice.py
COPY server.py ./
USER 65532:65532
EXPOSE 8090
HEALTHCHECK --interval=20s --timeout=5s --start-period=40s CMD ["python","-c","import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=3).close()"]
CMD ["python", "server.py"]
