FROM apache/hop:2.17.0

# Copy your project files
COPY . /app

# Fix permissions using modern Docker syntax (works better on macOS)
COPY --chmod=0755 run_vault.sh /app/run_vault.sh
COPY --chmod=0755 render-hop-environment.sh /app/render-hop-environment.sh
COPY --chmod=0755 generate-hop-config.sh /app/generate-hop-config.sh

WORKDIR /app

ENTRYPOINT ["/app/run_vault.sh"]
