FROM python:3.12-slim-bookworm@sha256:44cf1793efa7c7a476bb0f2cff81443f4a072c90c1cb127e2924933daa3e8c64
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY telegram/requirements.txt ./
RUN python -m pip install --disable-pip-version-check --no-cache-dir -r requirements.txt \
    && mkdir /session && chown 1000:1000 /session
COPY common/media.py ./
COPY telegram/adapter.py telegram/send_link.py ./
RUN python -c "import adapter"
USER 1000:1000
ENTRYPOINT ["python", "adapter.py"]
CMD ["run"]
