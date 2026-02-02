//! Arbitrator instructions
//!
//! Handles arbitrator pool management, registration, voting, and dispute resolution.

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
    state::{
        ArbitratorPool, ArbitratorEntry, DisputeCase, AccuracyClaim, JobEscrow,
        AgentReputation, EscrowStatus, Vote, DisputeResolution,
        ARBITRATORS_PER_DISPUTE, ARBITRATION_MAJORITY, MIN_ARBITRATOR_STAKE,
    },
    require, require_some,
    PLATFORM_WALLET,
};

/// Arbitration voting window: 48 hours
pub const ARBITRATION_VOTING_SECONDS: i64 = 48 * 60 * 60;

/// Transfer lamports helper
#[inline(always)]
fn transfer_lamports(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    *from.try_borrow_mut_lamports()? -= amount;
    *to.try_borrow_mut_lamports()? += amount;
    Ok(())
}

// ============== INIT ARBITRATOR POOL ==============

pub struct InitArbitratorPoolAccounts<'a> {
    pub pool: &'a AccountInfo,
    pub authority: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for InitArbitratorPoolAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [pool, authority, system_program, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !authority.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }
        require!(authority.key() == &PLATFORM_WALLET, EscrowError::NotPlatformAuthority);

        Ok(Self { pool, authority, system_program })
    }
}

pub fn process_init_arbitrator_pool(
    accounts: &[AccountInfo],
    _data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = InitArbitratorPoolAccounts::try_from(accounts)?;

    // Derive PDA
    let (expected_pda, bump) = find_program_address(&[b"arbitrator_pool_v2"], program_id);
    require!(ctx.pool.key() == &expected_pda, EscrowError::InvalidPda);

    // Create account
    let rent = Rent::get()?;
    let rent_lamports = rent.minimum_balance(ArbitratorPool::SPACE);

    let bump_ref = &[bump];
    let signer_seeds = seeds!(b"arbitrator_pool_v2", bump_ref);
    let signer = Signer::from(&signer_seeds);

    CreateAccount {
        from: ctx.authority,
        to: ctx.pool,
        lamports: rent_lamports,
        space: ArbitratorPool::SPACE as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    // Initialize
    let pool_data = &mut ctx.pool.try_borrow_mut_data()?;
    let pool = ArbitratorPool::init(pool_data)?;

    pool.authority = *ctx.authority.key();
    pool.min_stake = MIN_ARBITRATOR_STAKE;
    pool.arbitrator_count = 0;
    pool.bump = bump;

    Ok(())
}

// ============== REGISTER ARBITRATOR ==============

pub struct RegisterArbitratorAccounts<'a> {
    pub pool: &'a AccountInfo,
    pub arbitrator_account: &'a AccountInfo,
    pub agent: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for RegisterArbitratorAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [pool, arbitrator_account, agent, system_program, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !agent.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self { pool, arbitrator_account, agent, system_program })
    }
}

pub fn process_register_arbitrator(
    accounts: &[AccountInfo],
    _data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = RegisterArbitratorAccounts::try_from(accounts)?;
    let clock = Clock::get()?;

    // Verify arbitrator PDA
    let (expected_pda, bump) = find_program_address(
        &[b"arbitrator", ctx.agent.key()],
        program_id,
    );
    require!(ctx.arbitrator_account.key() == &expected_pda, EscrowError::InvalidPda);

    // Load and update pool
    let pool_data = &mut ctx.pool.try_borrow_mut_data()?;
    let pool = ArbitratorPool::load_mut(pool_data)?;

    pool.add(*ctx.agent.key())?;

    // Create arbitrator account with stake
    let rent = Rent::get()?;
    let rent_lamports = rent.minimum_balance(ArbitratorEntry::SPACE);
    let total_lamports = rent_lamports + MIN_ARBITRATOR_STAKE;

    let bump_ref = &[bump];
    let signer_seeds = seeds!(b"arbitrator", ctx.agent.key(), bump_ref);
    let signer = Signer::from(&signer_seeds);

    CreateAccount {
        from: ctx.agent,
        to: ctx.arbitrator_account,
        lamports: total_lamports,
        space: ArbitratorEntry::SPACE as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    // Initialize
    let arb_data = &mut ctx.arbitrator_account.try_borrow_mut_data()?;
    let arb = ArbitratorEntry::init(arb_data)?;

    arb.agent = *ctx.agent.key();
    arb.stake = MIN_ARBITRATOR_STAKE;
    arb.cases_voted = 0;
    arb.cases_correct = 0;
    arb.is_active = 1;
    arb.registered_at = clock.unix_timestamp;
    arb.bump = bump;

    Ok(())
}

// ============== UNREGISTER ARBITRATOR ==============

pub struct UnregisterArbitratorAccounts<'a> {
    pub pool: &'a AccountInfo,
    pub arbitrator_account: &'a AccountInfo,
    pub agent: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for UnregisterArbitratorAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [pool, arbitrator_account, agent, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !agent.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self { pool, arbitrator_account, agent })
    }
}

pub fn process_unregister_arbitrator(
    accounts: &[AccountInfo],
    _data: &[u8],
    _program_id: &Pubkey,
) -> ProgramResult {
    let ctx = UnregisterArbitratorAccounts::try_from(accounts)?;

    // Load pool and remove
    let pool_data = &mut ctx.pool.try_borrow_mut_data()?;
    let pool = ArbitratorPool::load_mut(pool_data)?;
    pool.remove(ctx.agent.key())?;

    // Load arbitrator
    let arb_data = &mut ctx.arbitrator_account.try_borrow_mut_data()?;
    let arb = ArbitratorEntry::load_mut(arb_data)?;

    require!(arb.is_active(), EscrowError::ArbitratorNotActive);
    require!(&arb.agent == ctx.agent.key(), EscrowError::Unauthorized);

    arb.is_active = 0;

    // Return stake
    transfer_lamports(ctx.arbitrator_account, ctx.agent, arb.stake)?;

    Ok(())
}

// ============== RAISE DISPUTE CASE ==============

pub struct RaiseDisputeCaseAccounts<'a> {
    pub escrow: &'a AccountInfo,
    pub dispute_case: &'a AccountInfo,
    pub pool: &'a AccountInfo,
    pub initiator: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for RaiseDisputeCaseAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [escrow, dispute_case, pool, initiator, system_program, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !initiator.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self { escrow, dispute_case, pool, initiator, system_program })
    }
}

/// Instruction data for RaiseDisputeCase
pub struct RaiseDisputeCaseData<'a> {
    pub reason: &'a str,
}

impl<'a> RaiseDisputeCaseData<'a> {
    pub fn try_from_slice(data: &'a [u8]) -> Result<Self, ProgramError> {
        if data.len() < 2 {
            return Err(ProgramError::InvalidInstructionData);
        }
        let len = u16::from_le_bytes([data[0], data[1]]) as usize;
        if data.len() < 2 + len {
            return Err(ProgramError::InvalidInstructionData);
        }
        let reason = core::str::from_utf8(&data[2..2+len])
            .map_err(|_| ProgramError::InvalidInstructionData)?;
        Ok(Self { reason })
    }
}

pub fn process_raise_dispute_case(
    accounts: &[AccountInfo],
    data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = RaiseDisputeCaseAccounts::try_from(accounts)?;
    let args = RaiseDisputeCaseData::try_from_slice(data)?;
    let clock = Clock::get()?;

    require!(args.reason.len() <= DisputeCase::MAX_REASON_LEN, EscrowError::ReasonTooLong);

    // Load escrow
    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;

    require!(
        escrow.status == EscrowStatus::Active as u8 || escrow.status == EscrowStatus::PendingReview as u8,
        EscrowError::EscrowNotActive
    );

    // Initiator must be poster or worker
    let initiator_key = ctx.initiator.key();
    require!(
        initiator_key == &escrow.poster || initiator_key == &escrow.worker,
        EscrowError::Unauthorized
    );

    // Load pool and check we have enough arbitrators
    let pool_data = ctx.pool.try_borrow_data()?;
    let pool = ArbitratorPool::load(&pool_data)?;
    require!(pool.arbitrator_count as usize >= ARBITRATORS_PER_DISPUTE, EscrowError::NotEnoughArbitrators);

    // Verify dispute case PDA
    let (expected_pda, bump) = find_program_address(
        &[b"dispute", ctx.escrow.key()],
        program_id,
    );
    require!(ctx.dispute_case.key() == &expected_pda, EscrowError::InvalidPda);

    // Select 5 random arbitrators using improved randomness
    let escrow_key = ctx.escrow.key();
    let initiator_bytes = ctx.initiator.key();
    let slot_bytes = clock.slot.to_le_bytes();
    let ts_bytes = clock.unix_timestamp.to_le_bytes();
    let amt_bytes = escrow.amount.to_le_bytes();

    // Combine entropy sources
    let mut seed_data = [0u8; 32];
    for i in 0..8 { seed_data[i] = escrow_key[i] ^ initiator_bytes[i]; }
    for i in 0..8 { seed_data[8 + i] = slot_bytes[i] ^ escrow_key[16 + i]; }
    for i in 0..8 { seed_data[16 + i] = ts_bytes[i] ^ initiator_bytes[16 + i]; }
    for i in 0..8 { seed_data[24 + i] = amt_bytes[i] ^ escrow_key[24 + i]; }

    // Simple hash-like mixing
    let seed = u64::from_le_bytes(seed_data[0..8].try_into().unwrap());

    let mut selected: [Pubkey; ARBITRATORS_PER_DISPUTE] = [[0u8; 32]; ARBITRATORS_PER_DISPUTE];
    let mut used_indices: [usize; ARBITRATORS_PER_DISPUTE] = [usize::MAX; ARBITRATORS_PER_DISPUTE];

    for i in 0..ARBITRATORS_PER_DISPUTE {
        let mut idx = ((seed.wrapping_add(i as u64).wrapping_mul(31337)) as usize) 
            % pool.arbitrator_count as usize;
        
        // Linear probe to avoid duplicates
        while used_indices.contains(&idx) {
            idx = (idx + 1) % pool.arbitrator_count as usize;
        }
        used_indices[i] = idx;
        selected[i] = pool.arbitrators[idx];
    }

    // Drop pool borrow before creating account
    drop(pool_data);

    // Create dispute case account
    let rent = Rent::get()?;
    let rent_lamports = rent.minimum_balance(DisputeCase::SPACE);

    let bump_ref = &[bump];
    let signer_seeds = seeds!(b"dispute", ctx.escrow.key(), bump_ref);
    let signer = Signer::from(&signer_seeds);

    CreateAccount {
        from: ctx.initiator,
        to: ctx.dispute_case,
        lamports: rent_lamports,
        space: DisputeCase::SPACE as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    // Initialize dispute case
    let dispute_data = &mut ctx.dispute_case.try_borrow_mut_data()?;
    let dispute = DisputeCase::init(dispute_data)?;

    dispute.escrow = *ctx.escrow.key();
    dispute.raised_by = *ctx.initiator.key();
    dispute.arbitrators = selected;
    dispute.votes = [Vote::None as u8; ARBITRATORS_PER_DISPUTE];
    dispute.voting_deadline = clock.unix_timestamp + ARBITRATION_VOTING_SECONDS;
    dispute.resolution = DisputeResolution::Pending as u8;
    dispute.created_at = clock.unix_timestamp;
    dispute.bump = bump;
    dispute.set_reason(args.reason)?;

    // Update escrow status
    escrow.status = EscrowStatus::InArbitration as u8;
    escrow.dispute_case = *ctx.dispute_case.key();
    escrow.has_dispute_case = 1;

    Ok(())
}

// ============== CAST ARBITRATION VOTE ==============

pub struct CastArbitrationVoteAccounts<'a> {
    pub dispute_case: &'a AccountInfo,
    pub arbitrator_account: &'a AccountInfo,
    pub voter: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for CastArbitrationVoteAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [dispute_case, arbitrator_account, voter, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !voter.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self { dispute_case, arbitrator_account, voter })
    }
}

/// Instruction data for CastArbitrationVote
pub struct CastArbitrationVoteData {
    pub vote: Vote,
}

impl CastArbitrationVoteData {
    pub fn try_from_slice(data: &[u8]) -> Result<Self, ProgramError> {
        if data.is_empty() {
            return Err(ProgramError::InvalidInstructionData);
        }
        let vote = Vote::from_u8(data[0]).ok_or(ProgramError::InvalidInstructionData)?;
        Ok(Self { vote })
    }
}

pub fn process_cast_arbitration_vote(
    accounts: &[AccountInfo],
    data: &[u8],
    _program_id: &Pubkey,
) -> ProgramResult {
    let ctx = CastArbitrationVoteAccounts::try_from(accounts)?;
    let args = CastArbitrationVoteData::try_from_slice(data)?;
    let clock = Clock::get()?;

    // Validate vote is ForWorker or ForPoster (not None)
    require!(args.vote != Vote::None, EscrowError::AlreadyVoted);

    // Load arbitrator
    let arb_data = &mut ctx.arbitrator_account.try_borrow_mut_data()?;
    let arb = ArbitratorEntry::load_mut(arb_data)?;

    require!(arb.is_active(), EscrowError::ArbitratorNotActive);
    require!(&arb.agent == ctx.voter.key(), EscrowError::Unauthorized);

    // Load dispute case
    let dispute_data = &mut ctx.dispute_case.try_borrow_mut_data()?;
    let dispute = DisputeCase::load_mut(dispute_data)?;

    require!(!dispute.is_resolved(), EscrowError::DisputeAlreadyResolved);
    require!(clock.unix_timestamp < dispute.voting_deadline, EscrowError::VotingDeadlinePassed);

    // Find voter's position
    let position = require_some!(
        dispute.find_arbitrator_position(ctx.voter.key()),
        EscrowError::NotSelectedArbitrator
    );

    // Check not already voted
    require!(dispute.votes[position] == Vote::None as u8, EscrowError::AlreadyVoted);

    // Cast vote
    dispute.set_vote(position, args.vote);
    arb.cases_voted += 1;

    Ok(())
}

// ============== FINALIZE DISPUTE CASE ==============

pub struct FinalizeDisputeCaseAccounts<'a> {
    pub dispute_case: &'a AccountInfo,
    pub escrow: &'a AccountInfo,
    pub finalizer: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for FinalizeDisputeCaseAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [dispute_case, escrow, finalizer, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !finalizer.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self { dispute_case, escrow, finalizer })
    }
}

pub fn process_finalize_dispute_case(
    accounts: &[AccountInfo],
    _data: &[u8],
    _program_id: &Pubkey,
) -> ProgramResult {
    let ctx = FinalizeDisputeCaseAccounts::try_from(accounts)?;
    let clock = Clock::get()?;

    // Load dispute case
    let dispute_data = &mut ctx.dispute_case.try_borrow_mut_data()?;
    let dispute = DisputeCase::load_mut(dispute_data)?;

    require!(!dispute.is_resolved(), EscrowError::DisputeAlreadyResolved);

    // Count votes
    let (for_worker, for_poster) = dispute.count_votes();
    let has_majority = for_worker >= ARBITRATION_MAJORITY || for_poster >= ARBITRATION_MAJORITY;
    let deadline_passed = clock.unix_timestamp >= dispute.voting_deadline;

    require!(has_majority || deadline_passed, EscrowError::VotingNotComplete);

    // Determine resolution
    let resolution = if for_worker > for_poster {
        DisputeResolution::WorkerWins
    } else if for_poster > for_worker {
        DisputeResolution::PosterWins
    } else {
        DisputeResolution::Split
    };

    dispute.resolution = resolution as u8;

    // Load and update escrow
    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;

    require!(&escrow.dispute_case == ctx.dispute_case.key(), EscrowError::EscrowMismatch);

    escrow.status = match resolution {
        DisputeResolution::WorkerWins => EscrowStatus::DisputeWorkerWins as u8,
        DisputeResolution::PosterWins => EscrowStatus::DisputePosterWins as u8,
        DisputeResolution::Split => EscrowStatus::DisputeSplit as u8,
        _ => unreachable!(),
    };

    Ok(())
}

// ============== EXECUTE DISPUTE RESOLUTION ==============

pub struct ExecuteDisputeResolutionAccounts<'a> {
    pub dispute_case: &'a AccountInfo,
    pub escrow: &'a AccountInfo,
    pub worker: &'a AccountInfo,
    pub poster: &'a AccountInfo,
    pub platform: &'a AccountInfo,
    pub worker_reputation: &'a AccountInfo,
    pub poster_reputation: &'a AccountInfo,
    pub executor: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for ExecuteDisputeResolutionAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [dispute_case, escrow, worker, poster, platform, worker_reputation, poster_reputation, executor, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !executor.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        require!(platform.key() == &PLATFORM_WALLET, EscrowError::NotPlatformAuthority);

        Ok(Self { dispute_case, escrow, worker, poster, platform, worker_reputation, poster_reputation, executor })
    }
}

pub fn process_execute_dispute_resolution(
    accounts: &[AccountInfo],
    _data: &[u8],
    _program_id: &Pubkey,
) -> ProgramResult {
    let ctx = ExecuteDisputeResolutionAccounts::try_from(accounts)?;

    // Load dispute case
    let dispute_data = ctx.dispute_case.try_borrow_data()?;
    let dispute = DisputeCase::load(&dispute_data)?;

    let resolution = require_some!(
        DisputeResolution::from_u8(dispute.resolution),
        EscrowError::DisputeNotResolved
    );
    require!(resolution != DisputeResolution::Pending, EscrowError::DisputeNotResolved);

    // Drop dispute borrow
    drop(dispute_data);

    // Load escrow
    let escrow_data = &mut ctx.escrow.try_borrow_mut_data()?;
    let escrow = JobEscrow::load_mut(escrow_data)?;

    require!(
        escrow.status == EscrowStatus::DisputeWorkerWins as u8 ||
        escrow.status == EscrowStatus::DisputePosterWins as u8 ||
        escrow.status == EscrowStatus::DisputeSplit as u8,
        EscrowError::InvalidStatusForExecution
    );

    require!(ctx.worker.key() == &escrow.worker, EscrowError::WorkerMismatch);
    require!(ctx.poster.key() == &escrow.poster, EscrowError::PosterMismatch);

    let amount = escrow.amount;

    // Load reputations
    let worker_rep_data = &mut ctx.worker_reputation.try_borrow_mut_data()?;
    let worker_rep = AgentReputation::load_mut(worker_rep_data)?;

    let poster_rep_data = &mut ctx.poster_reputation.try_borrow_mut_data()?;
    let poster_rep = AgentReputation::load_mut(poster_rep_data)?;

    match resolution {
        DisputeResolution::WorkerWins => {
            let platform_fee = amount / 100;
            let worker_payment = amount - platform_fee;

            transfer_lamports(ctx.escrow, ctx.worker, worker_payment)?;
            transfer_lamports(ctx.escrow, ctx.platform, platform_fee)?;

            worker_rep.disputes_won += 1;
            poster_rep.disputes_lost += 1;

            escrow.status = EscrowStatus::Released as u8;
        }
        DisputeResolution::PosterWins => {
            transfer_lamports(ctx.escrow, ctx.poster, amount)?;

            poster_rep.disputes_won += 1;
            worker_rep.disputes_lost += 1;

            escrow.status = EscrowStatus::Refunded as u8;
        }
        DisputeResolution::Split => {
            let platform_fee = amount / 100;
            let remaining = amount - platform_fee;
            let worker_half = remaining / 2;
            let poster_half = remaining - worker_half;

            transfer_lamports(ctx.escrow, ctx.worker, worker_half)?;
            transfer_lamports(ctx.escrow, ctx.poster, poster_half)?;
            transfer_lamports(ctx.escrow, ctx.platform, platform_fee)?;

            escrow.status = EscrowStatus::Released as u8;
        }
        _ => {}
    }

    worker_rep.update_score();
    poster_rep.update_score();

    Ok(())
}

// ============== UPDATE ARBITRATOR ACCURACY ==============

pub struct UpdateArbitratorAccuracyAccounts<'a> {
    pub dispute_case: &'a AccountInfo,
    pub arbitrator_account: &'a AccountInfo,
    pub accuracy_claim: &'a AccountInfo,
    pub caller: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for UpdateArbitratorAccuracyAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [dispute_case, arbitrator_account, accuracy_claim, caller, system_program, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !caller.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self { dispute_case, arbitrator_account, accuracy_claim, caller, system_program })
    }
}

pub fn process_update_arbitrator_accuracy(
    accounts: &[AccountInfo],
    _data: &[u8],
    program_id: &Pubkey,
) -> ProgramResult {
    let ctx = UpdateArbitratorAccuracyAccounts::try_from(accounts)?;
    let clock = Clock::get()?;

    // Load dispute case
    let dispute_data = ctx.dispute_case.try_borrow_data()?;
    let dispute = DisputeCase::load(&dispute_data)?;

    let resolution = require_some!(
        DisputeResolution::from_u8(dispute.resolution),
        EscrowError::DisputeNotResolved
    );
    require!(resolution != DisputeResolution::Pending, EscrowError::DisputeNotResolved);

    // Load arbitrator
    let arb_data = &mut ctx.arbitrator_account.try_borrow_mut_data()?;
    let arb = ArbitratorEntry::load_mut(arb_data)?;

    // Find this arbitrator's position and vote
    let position = require_some!(
        dispute.find_arbitrator_position(&arb.agent),
        EscrowError::NotSelectedArbitrator
    );

    let vote = require_some!(
        Vote::from_u8(dispute.votes[position]),
        EscrowError::ArbitratorDidNotVote
    );
    require!(vote != Vote::None, EscrowError::ArbitratorDidNotVote);

    // Drop dispute borrow
    let arb_agent = arb.agent;
    drop(dispute_data);

    // Verify and create accuracy claim PDA
    let (expected_pda, bump) = find_program_address(
        &[b"accuracy_claim", ctx.dispute_case.key(), &arb_agent],
        program_id,
    );
    require!(ctx.accuracy_claim.key() == &expected_pda, EscrowError::InvalidPda);

    // Create accuracy claim account (prevents duplicate claims)
    let rent = Rent::get()?;
    let rent_lamports = rent.minimum_balance(AccuracyClaim::SPACE);

    let bump_ref = &[bump];
    let signer_seeds = seeds!(b"accuracy_claim", ctx.dispute_case.key(), &arb_agent, bump_ref);
    let signer = Signer::from(&signer_seeds);

    CreateAccount {
        from: ctx.caller,
        to: ctx.accuracy_claim,
        lamports: rent_lamports,
        space: AccuracyClaim::SPACE as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    // Initialize accuracy claim
    let claim_data = &mut ctx.accuracy_claim.try_borrow_mut_data()?;
    let claim = AccuracyClaim::init(claim_data)?;

    claim.dispute_case = *ctx.dispute_case.key();
    claim.arbitrator = arb_agent;
    claim.claimed_at = clock.unix_timestamp;
    claim.bump = bump;

    // Determine if vote was correct
    let voted_correctly = match (vote, resolution) {
        (Vote::ForWorker, DisputeResolution::WorkerWins) => true,
        (Vote::ForPoster, DisputeResolution::PosterWins) => true,
        (_, DisputeResolution::Split) => true, // Split = both considered correct
        _ => false,
    };

    if voted_correctly {
        arb.cases_correct += 1;
    }

    Ok(())
}

// ============== REMOVE ARBITRATOR ==============

pub struct RemoveArbitratorAccounts<'a> {
    pub pool: &'a AccountInfo,
    pub arbitrator_account: &'a AccountInfo,
    pub arbitrator_agent: &'a AccountInfo,
    pub authority: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for RemoveArbitratorAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [pool, arbitrator_account, arbitrator_agent, authority, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        if !authority.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        require!(authority.key() == &PLATFORM_WALLET, EscrowError::NotPlatformAuthority);

        Ok(Self { pool, arbitrator_account, arbitrator_agent, authority })
    }
}

pub fn process_remove_arbitrator(
    accounts: &[AccountInfo],
    _data: &[u8],
    _program_id: &Pubkey,
) -> ProgramResult {
    let ctx = RemoveArbitratorAccounts::try_from(accounts)?;

    // Load arbitrator
    let arb_data = &mut ctx.arbitrator_account.try_borrow_mut_data()?;
    let arb = ArbitratorEntry::load_mut(arb_data)?;

    require!(arb.is_active(), EscrowError::ArbitratorNotActive);
    require!(&arb.agent == ctx.arbitrator_agent.key(), EscrowError::Unauthorized);

    // Load pool and remove
    let pool_data = &mut ctx.pool.try_borrow_mut_data()?;
    let pool = ArbitratorPool::load_mut(pool_data)?;
    pool.remove(&arb.agent)?;

    arb.is_active = 0;

    // Return stake
    transfer_lamports(ctx.arbitrator_account, ctx.arbitrator_agent, arb.stake)?;

    Ok(())
}
