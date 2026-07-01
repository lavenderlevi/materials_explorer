#!/bin/bash
# Start Materials Explorer in development mode (HMR)
# Terminal 1: ./start_dev.sh backend
# Terminal 2: ./start_dev.sh frontend

MODE=${1:-"backend"}

if [ "$MODE" = "backend" ]; then
  echo "🔬 FastAPI backend on http://localhost:8000"
  uvicorn api.main:app --reload --port 8000
elif [ "$MODE" = "frontend" ]; then
  echo "⚡ Vite dev server on http://localhost:5173"
  cd frontend && npm run dev
else
  echo "Usage: $0 [backend|frontend]"
fi
