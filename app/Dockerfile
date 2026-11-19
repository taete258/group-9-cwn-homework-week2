# ---- build: ติดตั้ง dependency (better-sqlite3 อาจต้อง compile ถ้าไม่มี prebuilt) ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:20-bookworm-slim
WORKDIR /app
# ฟอนต์ไทยสำหรับ PDF (pdfkit) : /usr/share/fonts/truetype/tlwg/Garuda.ttf
RUN apt-get update && apt-get install -y --no-install-recommends fonts-thai-tlwg \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/egov.db \
    TZ=Asia/Bangkok
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY views ./views
COPY public ./public
RUN mkdir -p /data
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
