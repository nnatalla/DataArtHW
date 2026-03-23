# W katalogu projektu (obok Dockerfile):
cat > entrypoint.sh << 'EOF'
#!/bin/sh
set -e

chown -R appuser:appgroup /app/data /app/uploads 2>/dev/null || true

exec su-exec appuser node dist/server.js
EOF

chmod +x entrypoint.sh