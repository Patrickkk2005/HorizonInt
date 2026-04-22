FROM python:3.12-slim

WORKDIR /app

COPY scripts/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY scripts/ ./scripts/

# Static files bundled in image (not written to by scripts)
RUN mkdir -p /app/static
COPY docs/data/romania.geojson /app/static/romania.geojson

RUN mkdir -p /data

ENV OUTPUT_DIR=/data

CMD ["python3", "scripts/server.py"]
