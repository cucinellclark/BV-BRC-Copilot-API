#!/bin/bash

DIR=$(realpath "$(dirname "${BASH_SOURCE[0]}")")

# Navigate to project directory
cd $DIR

# Activate the virtual environment
# We assume it is installed in the same directory as the copilot checkout

#venv=$(realpath $DIR/../../venv)
venv="/home/ac.cucinell/bvbrc-dev/Copilot/BV-BRC-Copilot-API/utilities/copilot_utils_env"
source $venv/bin/activate

## Start the Flask server
#python3 server.py
gunicorn --bind 0.0.0.0:5000 server:app

