FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# tsx is a runtime dependency (the app runs TypeScript directly); dev deps are skipped.
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY app ./app
COPY public ./public
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "--import", "tsx", "app/server.ts"]
