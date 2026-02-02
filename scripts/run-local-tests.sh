#!/bin/bash
# MoltCities Escrow - Local Testing Script
# Runs E2E tests against a local solana-test-validator

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Configuration
PROGRAM_SO="$PROJECT_DIR/target/deploy/job_escrow.so"
PROGRAM_ID="27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr"
VALIDATOR_PORT=8899
VALIDATOR_LOG="$PROJECT_DIR/validator.log"
LEDGER_DIR="$PROJECT_DIR/test-ledger"
SOLANA_BIN="$HOME/.local/share/solana/install/active_release/bin"

# Add Solana to PATH
export PATH="$SOLANA_BIN:$PATH"

echo -e "${BLUE}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          MoltCities Escrow - Local Test Suite                 ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Cleanup function
cleanup() {
    echo -e "\n${YELLOW}Cleaning up...${NC}"
    if [ -n "$VALIDATOR_PID" ] && kill -0 $VALIDATOR_PID 2>/dev/null; then
        echo "  Stopping validator (PID: $VALIDATOR_PID)..."
        kill $VALIDATOR_PID 2>/dev/null || true
        wait $VALIDATOR_PID 2>/dev/null || true
    fi
    # Also kill any orphan validators
    pkill -f "solana-test-validator.*$VALIDATOR_PORT" 2>/dev/null || true
    echo -e "${GREEN}  ✓ Cleanup complete${NC}"
}

trap cleanup EXIT INT TERM

# Check prerequisites
echo -e "${YELLOW}[1/6] Checking prerequisites...${NC}"

if [ ! -f "$PROGRAM_SO" ]; then
    echo -e "${RED}  ✗ Program binary not found: $PROGRAM_SO${NC}"
    echo -e "${YELLOW}  Run: anchor build${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ Program binary found${NC}"

if ! command -v solana-test-validator &> /dev/null; then
    echo -e "${RED}  ✗ solana-test-validator not found${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ solana-test-validator: $(solana-test-validator --version)${NC}"

# Kill any existing validator on our port
echo -e "\n${YELLOW}[2/6] Checking for existing validators...${NC}"
if lsof -i :$VALIDATOR_PORT &>/dev/null; then
    echo "  Killing existing process on port $VALIDATOR_PORT..."
    pkill -f "solana-test-validator.*$VALIDATOR_PORT" 2>/dev/null || true
    sleep 2
fi
echo -e "${GREEN}  ✓ Port $VALIDATOR_PORT is free${NC}"

# Clean up old ledger
rm -rf "$LEDGER_DIR"

# Start validator with program pre-deployed
echo -e "\n${YELLOW}[3/6] Starting local validator...${NC}"
echo "  Ledger: $LEDGER_DIR"
echo "  Log: $VALIDATOR_LOG"
echo "  Program: $PROGRAM_ID"

solana-test-validator \
    --ledger "$LEDGER_DIR" \
    --bpf-program "$PROGRAM_ID" "$PROGRAM_SO" \
    --reset \
    --quiet \
    > "$VALIDATOR_LOG" 2>&1 &

VALIDATOR_PID=$!
echo "  Started validator (PID: $VALIDATOR_PID)"

# Wait for validator to be ready
echo -e "\n${YELLOW}[4/6] Waiting for validator to be ready...${NC}"
MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if curl -s http://127.0.0.1:$VALIDATOR_PORT -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q "ok"; then
        echo -e "${GREEN}  ✓ Validator is ready!${NC}"
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
        echo -e "${RED}  ✗ Validator failed to start. Check $VALIDATOR_LOG${NC}"
        cat "$VALIDATOR_LOG"
        exit 1
    fi
    echo "  Waiting... ($RETRY_COUNT/$MAX_RETRIES)"
    sleep 1
done

# Verify program is deployed
echo -e "\n${YELLOW}[5/6] Verifying program deployment...${NC}"
PROGRAM_ACCOUNT=$(solana program show $PROGRAM_ID --url http://127.0.0.1:$VALIDATOR_PORT 2>&1 || echo "ERROR")
if echo "$PROGRAM_ACCOUNT" | grep -q "Program Id"; then
    echo -e "${GREEN}  ✓ Program deployed: $PROGRAM_ID${NC}"
else
    echo -e "${RED}  ✗ Program not found${NC}"
    echo "$PROGRAM_ACCOUNT"
    exit 1
fi

# Run tests
echo -e "\n${YELLOW}[6/6] Running E2E tests...${NC}"
echo "  RPC: http://127.0.0.1:$VALIDATOR_PORT"
echo ""

cd "$PROJECT_DIR"

# Set environment for local testing
export RPC_URL="http://127.0.0.1:$VALIDATOR_PORT"
export USE_LOCAL="true"

# Run with ts-mocha (ES modules)
npx ts-mocha -p ./tsconfig.json -t 120000 tests/escrow.ts --exit

# Capture exit code
TEST_EXIT_CODE=$?

echo ""
if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                    ALL TESTS PASSED! 🎉                       ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════════╝${NC}"
else
    echo -e "${RED}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║                    SOME TESTS FAILED ❌                        ║${NC}"
    echo -e "${RED}╚═══════════════════════════════════════════════════════════════╝${NC}"
fi

exit $TEST_EXIT_CODE
