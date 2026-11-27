FROM python:3.12-slim-bookworm@sha256:44cf1793efa7c7a476bb0f2cff81443f4a072c90c1cb127e2924933daa3e8c64
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY whatsapp/requirements.txt .
RUN pip install --no-cache-dir --only-binary=:all: -r requirements.txt
COPY common/media.py whatsapp/adapter.py whatsapp/playback.py ./
USER 65534:65534
EXPOSE 8092
CMD ["python", "adapter.py"]
