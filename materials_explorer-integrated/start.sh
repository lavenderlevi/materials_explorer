#!/bin/bash
# Start Materials Explorer (production mode)
# Requires: cd frontend && npm install && npm run build  (first time only)

set -e
echo "🔬 Starting Materials Explorer..."

if [ ! -d "api/static/dist" ]; then
  echo "⚠️  React build not found. Building now..."
  cd frontend
  npm install
  npm run build
  cd ..
fi

echo "🚀 FastAPI on http://localhost:8000"
echo "📖 API docs: http://localhost:8000/api/docs"
uvicorn api.main:app --host 0.0.0.0 --port 8000
