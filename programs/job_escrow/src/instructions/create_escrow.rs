//! CreateEscrow instruction
//!
//! Creates a new escrow account and deposits SOL.

use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    seeds,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::{
    errors::EscrowError,
    state::{JobEscrow, EscrowStatus},
    require,
};

/// Minimum escrow amount (0.001 SOL)
pub const MIN_ESCROW_AMOUNT: u64 = 1_000_000;

/// Default escrow expiry: 30 days in seconds
pub const DEFAULT_EXPIRY_SECONDS: i64 = 30 * 24 * 60 * 60;

/// Create escrow instruction accounts
pub struct CreateEscrowAccounts<'a> {
    pub escrow: &'a AccountInfo,
    pub poster: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for CreateEscrowAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [escrow, poster, system_program, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        // Poster must be signer
        if !poster.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self {
            escrow,
            poster,
            system_program,
        })
    }
}

/// Instruction data for CreateEscrow
/// Layout: [job_id_hash: [u8; 32], amount: u64, expiry_seconds: i64 (0 = default)]
pub struct CreateEscrowData {
    pub job_id_hash: [u8; 32],
    pub amount: u64,
    pub expiry_seconds: i64,
}

impl CreateEscrowData {
    pub fn try_from_slice(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 48 {
            return Err(ProgramError::InvalidInstructionData);
        }
        
        let job_id_hash: [u8; 32] = data[0..32].try_into().unwrap();
        let amount = u64::from_le_bytes(data[32..40].try_into().unwrap());
        let expiry_seconds = i64::from_le_bytes(data[40..48].try_into().unwrap());
        
        Ok(Self {
            job_id_hash,
            amount,
            expiry_seconds,
        })
    }
}

/// Process create_escrow instruction
pub fn process_create_escrow(
    accounts: &[AccountInfo],
    data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = CreateEscrowAccounts::try_from(accounts)?;
    let args = CreateEscrowData::try_from_slice(data)?;

    // Validate amount
    require!(args.amount >= MIN_ESCROW_AMOUNT, EscrowError::AmountTooLow);

    // Get clock for timestamps
    let clock = Clock::get()?;
    
    // Calculate expiry
    let expiry = if args.expiry_seconds > 0 {
        args.expiry_seconds
    } else {
        DEFAULT_EXPIRY_SECONDS
    };
    require!(expiry > 0, EscrowError::InvalidExpiry);

    // Derive PDA and verify
    let (expected_pda, bump) = find_program_address(
        &[b"escrow", &args.job_id_hash, ctx.poster.key()],
        program_id,
    );
    
    if ctx.escrow.key() != &expected_pda {
        return Err(EscrowError::InvalidPda.into());
    }

    // Calculate rent
    let rent = Rent::get()?;
    let rent_lamports = rent.minimum_balance(JobEscrow::SPACE);
    let total_lamports = rent_lamports + args.amount;

    // Create the escrow account with PDA signer
    let bump_ref = &[bump];
    let signer_seeds = seeds!(b"escrow", &args.job_id_hash, ctx.poster.key(), bump_ref);
    let signer = Signer::from(&signer_seeds);

    CreateAccount {
        from: ctx.poster,
        to: ctx.escrow,
        lamports: total_lamports,
        space: JobEscrow::SPACE as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    // Initialize escrow data
    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::init(escrow_data)?;

    escrow.job_id_hash = args.job_id_hash;
    escrow.poster = *ctx.poster.key();
    escrow.worker = JobEscrow::DEFAULT_PUBKEY;
    escrow.amount = args.amount;
    escrow.status = EscrowStatus::Active as u8;
    escrow.created_at = clock.unix_timestamp;
    escrow.expires_at = clock.unix_timestamp + expiry;
    escrow.dispute_initiated_at = 0;
    escrow.submitted_at = 0;
    escrow.proof_hash = [0u8; 32];
    escrow.has_proof_hash = 0;
    escrow.dispute_case = JobEscrow::DEFAULT_PUBKEY;
    escrow.has_dispute_case = 0;
    escrow.bump = bump;

    Ok(())
}
