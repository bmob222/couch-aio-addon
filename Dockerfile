FROM node:20-alpine
WORKDIR /app
COPY . .
ENV PORT=7700
EXPOSE 7700
CMD ["node", "lib/server.js"]
