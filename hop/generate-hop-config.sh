#!/bin/bash
set -e

cat > /app/project-config.json <<EOF
{
  "projectName": "dv-latest",
  "projectHome": "$PROJECT_HOME"
}
EOF
