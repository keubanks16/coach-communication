FROM node:24-bookworm-slim
WORKDIR /app
COPY relay/package.json relay/package-lock.json ./relay/
RUN cd relay && npm ci --omit=dev
COPY relay/server.mjs relay/web-push.mjs ./relay/
COPY web ./web
ENV PORT=8080 HOST=0.0.0.0 DATABASE_PATH=/data/coach.sqlite VAPID_KEY_PATH=/data/vapid.json
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "relay/server.mjs"]
