/**
 * Test the new EscrowClient library
 */
import { EscrowClient, findEscrowPDA, sha256 } from './client';
import { Keypair } from '@solana/web3.js';
import * as fs from 'fs';

async function main() {
  console.log('Testing EscrowClient library...\n');
  
  const client = new EscrowClient(
    'process.env.HELIUS_DEVNET_RPC || "https://api.devnet.solana.com"'
  );
  
  // Load test wallets
  const poster = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync('test-poster.json', 'utf-8')))
  );
  const worker = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync('test-worker.json', 'utf-8')))
  );
  
  console.log('Poster:', poster.publicKey.toBase58());
  console.log('Worker:', worker.publicKey.toBase58());
  
  // Test 1: Create escrow using high-level API
  console.log('\n--- TEST: Create Escrow (High-Level API) ---');
  const jobId = `client-test-${Date.now()}`;
  
  try {
    const result = await client.createEscrow(poster, jobId, 0.03);
    console.log('✅ Created escrow:', result.escrow.toBase58());
    console.log('   Signature:', result.signature);
    
    // Test 2: Assign worker
    console.log('\n--- TEST: Assign Worker ---');
    const sig2 = await client.assignWorker(poster, result.escrow, worker.publicKey);
    console.log('✅ Assigned worker:', sig2);
    
    // Test 3: Submit work
    console.log('\n--- TEST: Submit Work ---');
    const sig3 = await client.submitWork(worker, result.escrow);
    console.log('✅ Submitted work:', sig3);
    
    // Test 4: Approve work
    console.log('\n--- TEST: Approve Work ---');
    const sig4 = await client.approveWork(poster, result.escrow, worker.publicKey);
    console.log('✅ Approved work:', sig4);
    
    console.log('\n=== CLIENT LIBRARY WORKING ===');
  } catch (e: any) {
    console.log('❌ Error:', e.message);
    if (e.logs) console.log('Logs:', e.logs.slice(-5));
  }
}

main().catch(console.error);
