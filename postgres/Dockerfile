FROM postgres:17

# COPY init scripts into the image so sed -i inside the container
# does not bleed through to the host bind mount.
COPY db-init/ /docker-entrypoint-initdb.d/

# Make the dir writable so sed -i can create its temp file at runtime
RUN chmod -R 777 /docker-entrypoint-initdb.d/
