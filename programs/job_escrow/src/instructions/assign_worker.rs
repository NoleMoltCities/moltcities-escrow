//! AssignWorker instruction
//!
//! Assigns a worker to an active escrow.

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::{
    errors::EscrowError,
    state::{JobEscrow, EscrowStatus},
    require,
    PLATFORM_WALLET,
};

/// Assign worker instruction accounts
pub struct AssignWorkerAccounts<'a> {
    pub escrow: &'a AccountInfo,
    pub initiator: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for AssignWorkerAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [escrow, initiator, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        // Initiator must be signer
        if !initiator.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self { escrow, initiator })
    }
}

/// Instruction data for AssignWorker
/// Layout: [worker: Pubkey (32 bytes)]
pub struct AssignWorkerData {
    pub worker: Pubkey,
}

impl AssignWorkerData {
    pub fn try_from_slice(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 32 {
            return Err(ProgramError::InvalidInstructionData);
        }
        let worker: Pubkey = data[0..32].try_into().unwrap();
        Ok(Self { worker })
    }
}

/// Process assign_worker instruction
pub fn process_assign_worker(
    accounts: &[AccountInfo],
    data: &[u8],
    _program_id: &Pubkey,
) -> ProgramResult {
    let ctx = AssignWorkerAccounts::try_from(accounts)?;
    let args = AssignWorkerData::try_from_slice(data)?;

    // Load and validate escrow
    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;

    // Must be active
    require!(escrow.status == EscrowStatus::Active as u8, EscrowError::EscrowNotActive);

    // No worker assigned yet
    require!(!escrow.has_worker(), EscrowError::WorkerAlreadyAssigned);

    // Initiator must be poster or platform
    let initiator_key = ctx.initiator.key();
    let is_poster = initiator_key == &escrow.poster;
    let is_platform = initiator_key == &PLATFORM_WALLET;
    require!(is_poster || is_platform, EscrowError::Unauthorized);

    // Assign the worker
    escrow.worker = args.worker;

    Ok(())
}
