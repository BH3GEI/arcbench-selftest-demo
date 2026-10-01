# Zero-dependency todo app used to demo the self-test channel.
# Build needs no network once the base image is cached.
FROM node:24-bookworm-slim
WORKDIR /app
COPY server.js .
EXPOSE 3000
CMD ["node", "server.js"]
