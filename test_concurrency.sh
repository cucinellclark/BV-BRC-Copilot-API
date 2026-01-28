#!/bin/bash
echo "Testing concurrent requests to Python utilities service..."
echo "Sending 20 concurrent requests..."
echo ""

start_time=$(date +%s)

for i in {1..20}; do
  curl -s -X POST http://localhost:5000/count_tokens \
    -H "Content-Type: application/json" \
    -d "{\"text_list\": [\"test query number $i\"]}" \
    -w "\nRequest $i - Time: %{time_total}s\n" &
done

wait

end_time=$(date +%s)
elapsed=$((end_time - start_time))

echo ""
echo "=========================================="
echo "All 20 requests completed in: ${elapsed} seconds"
echo "=========================================="
echo ""
echo "With single-threaded Flask, this would take 20-40 seconds"
echo "With Gunicorn + gevent, should take 2-5 seconds"
