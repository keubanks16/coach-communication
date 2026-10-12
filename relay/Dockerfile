FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json server.mjs ./
ENV PORT=8080 HOST=0.0.0.0 DATABASE_PATH=/data/coach.sqlite
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
