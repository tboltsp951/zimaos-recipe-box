# Runtime for Recipe Box: static PWA + sync API on one port.
FROM node:20-alpine

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

WORKDIR /app

# Only the app runtime is copied in; everything else (Dockerfile, compose,
# store assets, tests) stays out of the image to keep it small.
COPY app/ /app/

# Persistence lives on a bind mount at /data provided by docker-compose.
RUN mkdir -p /data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/recipebox/info').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
