#!/bin/bash

DIR=$(realpath "$(dirname "${BASH_SOURCE[0]}")")

# Navigate to project directory
cd $DIR

# Activate the virtual environment (copilot_utils_env in utilities directory)
venv=$(realpath $DIR/copilot_utils_env)
source $venv/bin/activate

## Start the Flask server
#python3 server.py
gunicorn -w 4 -k gevent \
  --worker-connections 100 \
  --timeout 120 \
  --bind 0.0.0.0:5000 \
  --access-logfile access.log \
  --error-logfile error.log \
  --log-level info \
  server:app
