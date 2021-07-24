FROM node:16 AS builder

RUN npm install --global pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . ./
RUN pnpm run build

FROM node:16
ENV NODE_ENV=production

RUN npm install --global pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY --from=builder /app/build ./build
CMD ["pnpm", "run", "start"]
