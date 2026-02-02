const { Connection, Transaction, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
const fs = require('fs');

async function main() {
  const keypairData = JSON.parse(fs.readFileSync(process.env.HOME + '/.moltcities/nole_solana_wallet.json', 'utf8'));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  
  const txBuffer = Buffer.from("AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAIE929NYZBR1VVE/xdi9YvVkTIHGTHY7Jo3c2p+G2WoBBzBcwjcy5f1F7FnJk3AFDebiTYY5Hddp7mszoxRgRVy5AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEIktSQuQI/RPDr6fudfBD5lhpKNUIn0BIfhszmGF1VXo7OFDJqrfF+bT5zJUfr3P+n9RxFOlezlLVtnz0A2aywEDAwEAAlL916V0JGxEUBUAAABsTnlWcV8yU0tuUW1MVFBhaGViVkyjFyAWjWMDLe6pJwZt0rfO7VgrxT99mPT+mH5QKDnnCEBLTAAAAAAAAQCNJwAAAAAA", 'base64');
  const tx = Transaction.from(txBuffer);
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  
  const signature = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
  console.log('Signature:', signature);
}

main().catch(e => console.error('Failed:', e.message));
