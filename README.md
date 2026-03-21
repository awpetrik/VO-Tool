# VoiceForge

## Backend
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

## Frontend
cd frontend
npm install
npm run dev

## Notes: use SVG icons instead of emoji
- Whisper first run will download model weights (~140MB for base)
- Recommended: Python 3.10+, use venv
- For Apple Silicon: torch installs via pip normally, MPS acceleration supported
