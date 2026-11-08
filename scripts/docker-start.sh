#!/bin/sh
# Starts the app inside the Docker container (Render).
# Every step prints a line first and has a time limit, so a slow or stuck step shows up clearly in the
# deploy log instead of silently using up the host's start-up time.
set -e
cd /app/server

echo "[start] applying database migrations"
timeout 300 prisma migrate deploy

echo "[start] making sure the demo accounts and building exist"
# Not fatal: the server can still run with the data already in the database.
timeout 300 tsx prisma/seed.ts || echo "[start] seeding did not finish; starting anyway"

echo "[start] starting the server on port ${PORT}"
exec tsx src/server.ts
