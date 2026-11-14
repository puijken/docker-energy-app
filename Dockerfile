FROM python:3.15-slim
LABEL maintainer="puijken"
LABEL description="Read-only home energy web app (PWA): live flow and today's figures from TimescaleDB views"
LABEL org.opencontainers.image.source="https://github.com/puijken/docker-energy-app"

WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

RUN useradd --create-home --uid 1000 app
COPY --chown=app:app app.py /app/
COPY --chown=app:app static /app/static
USER app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080

EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
    CMD python3 -c "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT','8080'), timeout=4).status == 200 else 1)"

CMD ["python3", "/app/app.py"]
