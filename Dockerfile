# --- Stage 1: build the React/Vite frontend ---
FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY client/package.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# --- Stage 2: server runtime, serving the built frontend too ---
# Playwright's bundled Chromium needs glibc + its shared libs, which Alpine
# (musl) doesn't provide — Microsoft's playwright image ships Node.js plus a
# matching, pre-installed Chromium so `npm install` doesn't re-download it.
FROM mcr.microsoft.com/playwright:v1.63.0-jammy
WORKDIR /app/server
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/ ./
COPY --from=client-build /app/client/dist /app/client/dist

ENV PORT=8787
EXPOSE 8787
CMD ["node", "src/index.js"]
