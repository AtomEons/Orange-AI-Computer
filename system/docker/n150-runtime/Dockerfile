FROM node:22-bookworm-slim

WORKDIR /orange5

ENV NODE_ENV=production
ENV ORANGE5_ORANGELLM_HOST=0.0.0.0
ENV ORANGE5_ORANGELLM_PORT=1337
ENV ORANGE5_SMART_SKINNY_HOST=127.0.0.1
ENV ORANGE5_SMART_SKINNY_PORT=8797
ENV ORANGE5_OLLAMA_BASE_URL=http://host.docker.internal:11434
ENV ORANGE5_CODEXA_OLLAMA_URL=http://CODEXA.local:11434
ENV ORANGE5_CODEXA_HEAVY_MODEL=qwen2.5-coder:32b

COPY . /orange5
COPY docker/n150-runtime/entrypoint.sh /usr/local/bin/orange5-entrypoint.sh
RUN chmod +x /usr/local/bin/orange5-entrypoint.sh

EXPOSE 1337

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:1337/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/orange5-entrypoint.sh"]
