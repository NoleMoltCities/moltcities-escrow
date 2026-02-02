//! SubmitWork instruction
//!
//! Worker submits completed work, starting the review window.

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::{
    errors::EscrowError,
    state::{JobEscrow, EscrowStatus},
    require,
    ID,
};

/// Review window after worker submits: 24 hours
pub const REVIEW_WINDOW_SECONDS: i64 = 24 * 60 * 60;

/// Submit work instruction accounts
pub struct SubmitWorkAccounts<'a> {
    pub escrow: &'a AccountInfo,
    pub worker: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for SubmitWorkAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [escrow, worker, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !worker.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self { escrow, worker })
    }
}

/// Instruction data for SubmitWork
/// Layout: [has_proof: u8, proof_hash: [u8; 32] (optional)]
pub struct SubmitWorkData {
    pub proof_hash: Option<[u8; 32]>,
}

impl SubmitWorkData {
    pub fn try_from_slice(data: &[u8]) -> Result<Self, ProgramError> {
        if data.is_empty() {
            return Ok(Self { proof_hash: None });
        }
        
        let has_proof = data[0];
        if has_proof == 0 {
            return Ok(Self { proof_hash: None });
        }
        
        if data.len() < 33 {
            return Err(ProgramError::InvalidInstructionData);
        }
        
        let proof_hash: [u8; 32] = data[1..33].try_into().unwrap();
        Ok(Self { proof_hash: Some(proof_hash) })
    }
}

/// Process submit_work instruction
pub fn process_submit_work(
    accounts: &[AccountInfo],
    data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = SubmitWorkAccounts::try_from(accounts)?;
    let args = SubmitWorkData::try_from_slice(data)?;

    let clock = Clock::get()?;

    // SECURITY FIX C-01: Verify escrow account is owned by this program
    if *ctx.escrow.owner() != ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Load and validate escrow
    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;

    // SECURITY FIX C-02: Verify escrow PDA derivation
    let (expected_pda, expected_bump) = find_program_address(
        &[b"escrow", &escrow.job_id_hash, &escrow.poster],
        program_id,
    );
    require!(ctx.escrow.key() == &expected_pda, EscrowError::InvalidPda);
    require!(escrow.bump == expected_bump, EscrowError::InvalidPda);

    // Must be active
    require!(escrow.status == EscrowStatus::Active as u8, EscrowError::EscrowNotActive);

    // Must have worker assigned
    require!(escrow.has_worker(), EscrowError::NoWorkerAssigned);

    // Worker must match
    require!(ctx.worker.key() == &escrow.worker, EscrowError::WorkerMismatch);

    // Update status and timestamps
    escrow.status = EscrowStatus::PendingReview as u8;
    escrow.submitted_at = clock.unix_timestamp;

    // Set proof hash if provided
    if let Some(hash) = args.proof_hash {
        escrow.proof_hash = hash;
        escrow.has_proof_hash = 1;
    }

    Ok(())
}
