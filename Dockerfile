FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY engine.js core.js server.js ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
