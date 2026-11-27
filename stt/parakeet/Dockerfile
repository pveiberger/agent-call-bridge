# syntax=docker/dockerfile:1.7
FROM scratch AS assets
ARG ONNX=https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/ed5d745623472f97cfc2e6c2916ee248798fc5a8
ADD --checksum=sha256:1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479 ${ONNX}/encoder.int8.onnx?download=true /encoder.int8.onnx
ADD --checksum=sha256:0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5 ${ONNX}/decoder.int8.onnx?download=true /decoder.int8.onnx
ADD --checksum=sha256:cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98 ${ONNX}/joiner.int8.onnx?download=true /joiner.int8.onnx
ADD --checksum=sha256:d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d ${ONNX}/tokens.txt /tokens.txt
ADD --checksum=sha256:bd321b096832a3f270bd3b2a88823957920f1a5c5ada71114a26ea729d0cbe91 https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/resolve/541d1f99c6b0c3cd0b11a95167540bb8edefd82b/tokenizer.json /tokenizer.json

FROM python:3.12-slim-bookworm@sha256:44cf1793efa7c7a476bb0f2cff81443f4a072c90c1cb127e2924933daa3e8c64
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OPENBLAS_NUM_THREADS=1 HF_HUB_OFFLINE=1
WORKDIR /app
COPY requirements.txt ./
RUN python -m pip install --disable-pip-version-check --no-cache-dir --require-hashes --only-binary=:all: -r requirements.txt && mkdir -p /opt/parakeet
COPY --from=assets --chmod=0444 / /opt/parakeet/
COPY server.py test_server.py README.md ./
USER 65532:65532
RUN python -m unittest -q test_server
HEALTHCHECK --interval=60s --start-interval=3s --timeout=4s --start-period=90s CMD ["bash","-ec","exec 3<>/dev/tcp/127.0.0.1/8093; printf 'GET /health HTTP/1.0\\r\\n\\r\\n' >&3; read -r proto code rest <&3; test \"$code\" = 200"]
CMD ["python","server.py"]
