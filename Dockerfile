# Microsoft's official Playwright image already includes Node, Chromium, and every
# system library Chromium needs (libnss3, libgtk, libgbm, etc.) — built as root during
# Docker's image build stage, which sidesteps the "su: Authentication failure" problem
# that happens on Render's standard (non-Docker) Node build environment.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "admin-server.js"]
