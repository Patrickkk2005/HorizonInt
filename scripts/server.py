#!/usr/bin/env python3
"""
HorizonInt — Self-hosted API server (stdlib only, no pip).
Serves data files with CORS and triggers pipeline scripts on demand.

Routes:
  GET  /data/<file>.json   → serve public/data/<file>
  POST /run/feeds          → fetch_feeds.py
  POST /run/gdelt          → fetch_gdelt.py
  POST /run/gdacs          → fetch_gdacs.py
  POST /run/briefing       → generate_briefing.py

Start: python3 server.py
Task Scheduler entry: wsl -e bash -c "cd ~/horizonint && python3 scripts/server.py"
"""

import http.server
import json
import logging
import os
import subprocess
import sys
from pathlib import Path

# ── Load secrets from config.py (gitignored, lives on mini PC only) ──────────
try:
    sys.path.insert(0, str(Path(__file__).parent))
    import config as _cfg
    for _attr, _env in [
        ('ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'),
        ('OPENAI_API_KEY',    'OPENAI_API_KEY'),
        ('OUTPUT_DIR',        'OUTPUT_DIR'),
    ]:
        if hasattr(_cfg, _attr):
            os.environ[_env] = getattr(_cfg, _attr)
except ImportError:
    pass  # fall back to env vars already set in the shell

# ── Settings ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

SCRIPTS_DIR = Path(__file__).parent
DATA_DIR    = Path(os.environ.get('OUTPUT_DIR', 'public/data'))
PORT        = int(os.environ.get('PORT', 8787))

SCRIPTS = {
    'feeds':    SCRIPTS_DIR / 'fetch_feeds.py',
    'gdelt':    SCRIPTS_DIR / 'fetch_gdelt.py',
    'gdacs':    SCRIPTS_DIR / 'fetch_gdacs.py',
    'briefing': SCRIPTS_DIR / 'generate_briefing.py',
}

CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
}

ALLOWED_SUFFIXES = {'.json', '.geojson'}

# ── Handler ───────────────────────────────────────────────────────────────────
class Handler(http.server.BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        log.info(fmt, *args)

    # ── helpers ───────────────────────────────────────────────────────────────
    def _send(self, code, body, content_type='application/json'):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        for k, v in CORS.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj))

    # ── CORS preflight ────────────────────────────────────────────────────────
    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.end_headers()

    # ── GET /data/<file> ──────────────────────────────────────────────────────
    def do_GET(self):
        path = self.path.split('?')[0]

        if not path.startswith('/data/'):
            self._json(404, {'error': 'not found'})
            return

        fname = path[len('/data/'):]

        # Reject path traversal and non-data extensions
        if '..' in fname or Path(fname).suffix not in ALLOWED_SUFFIXES:
            self._json(403, {'error': 'forbidden'})
            return

        fpath = DATA_DIR / fname
        if not fpath.exists():
            self._json(404, {'error': 'file not found'})
            return

        self._send(200, fpath.read_bytes())

    # ── POST /run/<script> ────────────────────────────────────────────────────
    def do_POST(self):
        path = self.path.split('?')[0]

        if not path.startswith('/run/'):
            self._json(404, {'error': 'not found'})
            return

        key = path[len('/run/'):]
        if key not in SCRIPTS:
            self._json(404, {'error': f'unknown script: {key}'})
            return

        script = SCRIPTS[key]
        log.info('Running %s', script.name)
        try:
            result = subprocess.run(
                [sys.executable, str(script)],
                capture_output=True,
                text=True,
                timeout=300,
                env=os.environ.copy(),
            )
            self._json(
                200 if result.returncode == 0 else 500,
                {
                    'ok':         result.returncode == 0,
                    'returncode': result.returncode,
                    'stdout':     result.stdout[-3000:],
                    'stderr':     result.stderr[-3000:],
                },
            )
        except subprocess.TimeoutExpired:
            self._json(504, {'error': 'script timed out after 300s'})


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == '__main__':
    log.info('Data directory : %s', DATA_DIR.resolve())
    log.info('Scripts        : %s', ', '.join(SCRIPTS))
    log.info('Listening on   : http://0.0.0.0:%d', PORT)
    with http.server.HTTPServer(('0.0.0.0', PORT), Handler) as srv:
        srv.serve_forever()