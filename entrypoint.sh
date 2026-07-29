#!/bin/sh

# Generate self-signed certificate if they don't exist
if [ ! -f "/app/cert.pem" ] || [ ! -f "/app/key.pem" ]; then
    echo "[TLS] No certificates found. Generating self-signed certificates..."
    openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
        -keyout /app/key.pem -out /app/cert.pem \
        -subj "/CN=spool"
    echo "[TLS] Self-signed certificates generated successfully."
fi

# Start the application
exec node server.js
