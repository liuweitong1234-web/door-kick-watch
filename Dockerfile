# Door Kick Watch - production image.
#   docker build -t door-kick-watch .
#   docker run -p 8080:8080 --env-file .env -v dkw-data:/data door-kick-watch
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py serve.py ./
COPY static ./static

# Run as an unprivileged user. /data holds the SQLite database: mount a persistent volume there.
RUN useradd --create-home --uid 10001 app && mkdir -p /data && chown app:app /data
USER app
VOLUME ["/data"]

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT', '8080'), timeout=4)"

CMD ["python", "serve.py"]
