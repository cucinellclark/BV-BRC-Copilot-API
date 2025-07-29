#!/usr/bin/env python3
"""
Startup script that preloads vector databases before starting the Flask server.
"""

import sys
import os
import logging
from pathlib import Path

# Add the utilities directory to the Python path
utilities_dir = Path(__file__).parent
sys.path.insert(0, str(utilities_dir))

from vector_preloader import preload_databases, get_preloader
from server import app

def main():
    """Main startup function."""
    # Set up logging
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    logger = logging.getLogger(__name__)
    
    logger.info("Starting BV-BRC Copilot Utilities with vector database preloading...")
    
    # Preload vector databases
    logger.info("Preloading vector databases...")
    preload_results = preload_databases()
    
    # Log preload results
    logger.info("Preload results:")
    for db_name, result in preload_results.items():
        if result.get('status') == 'success':
            logger.info(f"  ✓ {db_name}: {result}")
        else:
            logger.warning(f"  ✗ {db_name}: {result}")
    
    # Get final status
    preloader = get_preloader()
    status = preloader.get_preload_status()
    logger.info(f"Final preload status: {status}")
    
    # Start the Flask server
    logger.info("Starting Flask server...")
    app.run(host='0.0.0.0', port=5000)

if __name__ == "__main__":
    main() 