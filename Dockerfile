FROM mcr.microsoft.com/playwright:v1.48.2-jammy
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY runner.js ./
ENV NODE_ENV=production
CMD ["node", "runner.js"]
