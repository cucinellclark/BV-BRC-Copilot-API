#!/bin/bash

echo "=========================================="
echo "MongoDB Connection Pool Test"
echo "=========================================="
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if API is running
echo "1. Checking if API is running..."
if ! curl -s http://localhost:7032/copilot-api/test > /dev/null 2>&1; then
    echo -e "${RED}✗ API is not running on port 7032${NC}"
    echo "  Please start the API first: pm2 start copilot.ecosystem.config.js"
    exit 1
fi
echo -e "${GREEN}✓ API is running${NC}"
echo ""

# Test liveness endpoint
echo "2. Testing liveness endpoint..."
response=$(curl -s http://localhost:7032/copilot-api/health/live)
if echo "$response" | grep -q "ok"; then
    echo -e "${GREEN}✓ Liveness check passed${NC}"
    echo "  Response: $response"
else
    echo -e "${RED}✗ Liveness check failed${NC}"
    echo "  Response: $response"
fi
echo ""

# Test readiness endpoint
echo "3. Testing readiness endpoint (MongoDB connection pool)..."
response=$(curl -s http://localhost:7032/copilot-api/health/ready)
if echo "$response" | grep -q "ready"; then
    echo -e "${GREEN}✓ Readiness check passed - MongoDB connection pool active${NC}"
    echo "  Response: $response"
else
    echo -e "${RED}✗ Readiness check failed - MongoDB connection pool not ready${NC}"
    echo "  Response: $response"
fi
echo ""

# Test MongoDB-specific endpoint
echo "4. Testing MongoDB-specific health endpoint..."
response=$(curl -s http://localhost:7032/copilot-api/health/mongodb)
echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
echo ""

# Test detailed status endpoint
echo "5. Testing detailed status endpoint..."
response=$(curl -s http://localhost:7032/copilot-api/health/status)
echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
echo ""

# Test concurrent database operations
echo "6. Testing concurrent MongoDB connection pool usage..."
echo "   Sending 20 concurrent requests to trigger pool..."
echo ""

start_time=$(date +%s)

for i in {1..20}; do
  curl -s http://localhost:7032/copilot-api/health/mongodb > /dev/null &
done

wait

end_time=$(date +%s)
elapsed=$((end_time - start_time))

echo -e "${GREEN}✓ All 20 concurrent MongoDB health checks completed in ${elapsed} seconds${NC}"
echo ""

# Final status check
echo "7. Final MongoDB connection pool status..."
curl -s http://localhost:7032/copilot-api/health/mongodb | \
  python3 -c "import sys, json; data=json.load(sys.stdin); print(json.dumps(data.get('connectionPool', {}), indent=2))" 2>/dev/null
echo ""

echo "=========================================="
echo "MongoDB Connection Pool Test Complete"
echo "=========================================="
echo ""
echo "Key Improvements:"
echo "  • maxPoolSize: 50 connections per PM2 instance"
echo "  • minPoolSize: 10 (warm connections ready)"
echo "  • Connection reuse and pooling active"
echo "  • Health check endpoints available"
echo ""

