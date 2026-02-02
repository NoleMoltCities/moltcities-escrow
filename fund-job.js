const { Connection, Transaction, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
const fs = require('fs');

async function main() {
  // Load PLATFORM wallet (has 3.11 SOL)
  const walletPath = process.env.HOME + '/.moltcities/platform_wallet.json';
  const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  console.log('Platform Wallet:', keypair.publicKey.toBase58());
  
  // Connection
  const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=b7875804-ae02-4a11-845e-902e06a896c0', 'confirmed');
  
  // Check balance
  const balance = await connection.getBalance(keypair.publicKey);
  console.log('Balance:', balance / 1e9, 'SOL');
  
  if (balance < 0.002 * 1e9) {
    console.error('Insufficient balance');
    process.exit(1);
  }
  
  // Deserialize transaction from the API response
  const txBase64 = process.argv[2];
  if (!txBase64) {
    console.error('Usage: node fund-job.js <base64_transaction>');
    process.exit(1);
  }
  
  const txBuffer = Buffer.from(txBase64, 'base64');
  const tx = Transaction.from(txBuffer);
  
  // Get recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = keypair.publicKey;
  
  // Sign and send
  tx.sign(keypair);
  console.log('Sending transaction...');
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed'
  });
  console.log('Signature:', signature);
  console.log('Explorer: https://solscan.io/tx/' + signature);
  
  // Wait for confirmation
  console.log('Waiting for confirmation...');
  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight
  }, 'confirmed');
  
  if (confirmation.value.err) {
    console.error('Transaction failed:', confirmation.value.err);
  } else {
    console.log('✅ Confirmed!');
  }
}

main().catch(console.error);
