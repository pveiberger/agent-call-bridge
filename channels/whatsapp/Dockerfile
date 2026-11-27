FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY whatsapp/requirements.txt .
RUN pip install --no-cache-dir --only-binary=:all: -r requirements.txt
COPY common/media.py whatsapp/adapter.py whatsapp/playback.py ./
USER 65534:65534
EXPOSE 8092
CMD ["python", "adapter.py"]
