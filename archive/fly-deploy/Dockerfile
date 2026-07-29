# Servicio autónomo del agente de WhatsApp (no afecta el build Node/Vercel del repo).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# La SQLite vive en un volumen persistente, no dentro de la imagen.
ENV DATABASE_PATH=/data/agent.db
RUN mkdir -p /data

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
