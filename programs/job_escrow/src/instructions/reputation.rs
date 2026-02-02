//! Reputation instructions
//!
//! Handles reputation account initialization.

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
    state::AgentReputation,
    require,
};

// ============== INIT REPUTATION ==============

pub struct InitReputationAccounts<'a> {
    pub reputation: &'a AccountInfo,
    pub agent: &'a AccountInfo,
    pub payer: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for InitReputationAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [reputation, agent, payer, system_program, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !payer.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self { reputation, agent, payer, system_program })
    }
}

/// Process init_reputation instruction
pub fn process_init_reputation(
    accounts: &[AccountInfo],
    _data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = InitReputationAccounts::try_from(accounts)?;
    let clock = Clock::get()?;

    // Verify PDA
    let (expected_pda, bump) = find_program_address(
        &[b"reputation", ctx.agent.key()],
        program_id,
    );
    require!(ctx.reputation.key() == &expected_pda, EscrowError::InvalidPda);

    // Create account
    let rent = Rent::get()?;
    let rent_lamports = rent.minimum_balance(AgentReputation::SPACE);

    let bump_ref = &[bump];
    let signer_seeds = seeds!(b"reputation", ctx.agent.key(), bump_ref);
    let signer = Signer::from(&signer_seeds);

    CreateAccount {
        from: ctx.payer,
        to: ctx.reputation,
        lamports: rent_lamports,
        space: AgentReputation::SPACE as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    // Initialize
    let rep_data = &mut ctx.reputation.try_borrow_mut_data()?;
    let rep = AgentReputation::init(rep_data)?;

    rep.agent = *ctx.agent.key();
    rep.jobs_completed = 0;
    rep.jobs_posted = 0;
    rep.total_earned = 0;
    rep.total_spent = 0;
    rep.disputes_won = 0;
    rep.disputes_lost = 0;
    rep.reputation_score = 0;
    rep.created_at = clock.unix_timestamp;
    rep.bump = bump;

    Ok(())
}
