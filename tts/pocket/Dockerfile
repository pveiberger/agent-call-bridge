FROM python:3.12-slim-bookworm@sha256:44cf1793efa7c7a476bb0f2cff81443f4a072c90c1cb127e2924933daa3e8c64 AS download
COPY fetch.py /tmp/fetch.py
RUN python /tmp/fetch.py

FROM python:3.12-slim-bookworm@sha256:44cf1793efa7c7a476bb0f2cff81443f4a072c90c1cb127e2924933daa3e8c64
COPY --from=download /opt/voice /opt/voice
COPY ATTRIBUTION.txt /opt/voice/ATTRIBUTION.txt
ENV RAYON_NUM_THREADS=3 OMP_NUM_THREADS=3 RUST_LOG=error HF_HUB_OFFLINE=1
USER 65532:65532
EXPOSE 8090
HEALTHCHECK --interval=20s --timeout=4s --start-period=60s CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health',timeout=3).close()"]
ENTRYPOINT ["/opt/voice/pocket-tts","serve","--config","/opt/voice/german.yaml","--default-voice","/opt/voice/juergen.safetensors","--host","0.0.0.0","--port","8090"]
