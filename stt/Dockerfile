# syntax=docker/dockerfile:1.7
ARG WHISPER_IMAGE=ghcr.io/ggml-org/whisper.cpp@sha256:a02c5bcd922e6d3c3372b23ab84f87a64756efb7cd547372f8033e91fdfbe822
FROM scratch AS model
ADD --checksum=sha256:394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2 https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin?download=true /whisper.bin

FROM ${WHISPER_IMAGE}
COPY --from=model --chmod=0444 /whisper.bin /opt/whisper-large-v3-turbo-q5_0.bin
ADD --checksum=sha256:b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d --chmod=0444 https://raw.githubusercontent.com/openai/whisper/6e3be77e1a105e59086e3e21ff5f609fd6fa89a5/LICENSE /opt/whisper-model-LICENSE.txt
USER 65532:65532
ENV HOME=/tmp XDG_CACHE_HOME=/tmp
HEALTHCHECK --interval=15s --timeout=4s --start-period=90s CMD ["curl", "--silent", "--fail", "--max-time", "3", "http://127.0.0.1:8093/health"]
ENTRYPOINT ["whisper-server"]
CMD ["--model", "/opt/whisper-large-v3-turbo-q5_0.bin", "--host", "0.0.0.0", "--port", "8093", "--inference-path", "/v1/audio/transcriptions", "--language", "de", "--threads", "4", "--beam-size", "3", "--no-timestamps"]
