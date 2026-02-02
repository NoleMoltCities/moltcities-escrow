use anchor_lang::prelude::*;
use solana_sha256_hasher::hash as sha256_hash;

declare_id!("27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr");

/// Platform wallet for 1% fees - BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893
pub const PLATFORM_WALLET: Pubkey = pubkey!("BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893");

/// Default escrow expiry: 30 days in seconds
pub const DEFAULT_EXPIRY_SECONDS: i64 = 30 * 24 * 60 * 60;

/// Minimum timelock for refunds after dispute: 24 hours
pub const REFUND_TIMELOCK_SECONDS: i64 = 24 * 60 * 60;

/// Review window after worker submits: 24 hours
/// Poster must dispute within this window or funds auto-release
pub const REVIEW_WINDOW_SECONDS: i64 = 24 * 60 * 60;

/// Arbitration voting window: 48 hours
pub const ARBITRATION_VOTING_SECONDS: i64 = 48 * 60 * 60;

/// Number of arbitrators per dispute
pub const ARBITRATORS_PER_DISPUTE: usize = 5;

/// Majority needed to win (3 of 5)
pub const ARBITRATION_MAJORITY: usize = 3;

/// Minimum stake to become an arbitrator (0.1 SOL)
pub const MIN_ARBITRATOR_STAKE: u64 = 100_000_000;

/// Fee per vote for arbitrators (0.001 SOL)
pub const ARBITRATOR_VOTE_FEE: u64 = 1_000_000;

/// Maximum arbitrators in pool
pub const MAX_ARBITRATORS: usize = 100;

/// Minimum escrow amount (0.01 SOL) - prevents spam
pub const MIN_ESCROW_AMOUNT: u64 = 10_000_000;

/// Grace period after arbitration expiry before emergency release (48 hours)
pub const ARBITRATION_GRACE_PERIOD: i64 = 48 * 60 * 60;

#[program]
pub mod job_escrow {
    use super::*;

    /// Create escrow for a job - poster deposits SOL
    /// 
    /// # Arguments
    /// * `job_id` - Unique identifier for the job (max 64 chars)
    /// * `job_id_hash` - SHA256 hash of job_id (for PDA derivation)
    /// * `amount` - Amount of SOL in lamports to deposit
    /// * `expiry_seconds` - Optional custom expiry (defaults to 30 days)
    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        job_id: String,
        job_id_hash: [u8; 32],
        amount: u64,
        expiry_seconds: Option<i64>,
    ) -> Result<()> {
        require!(amount >= MIN_ESCROW_AMOUNT, EscrowError::AmountTooLow);
        require!(job_id.len() <= 64, EscrowError::JobIdTooLong);
        
        // Verify the provided hash matches the job_id
        let computed_hash = sha256_hash(job_id.as_bytes());
        require!(computed_hash.as_ref() == job_id_hash.as_ref(), EscrowError::HashMismatch);
        
        let clock = Clock::get()?;
        let expiry = expiry_seconds.unwrap_or(DEFAULT_EXPIRY_SECONDS);
        require!(expiry > 0, EscrowError::InvalidExpiry);

        let poster_key = ctx.accounts.poster.key();
        let escrow_key = ctx.accounts.escrow.key();
        let expires_at = clock.unix_timestamp + expiry;

        // Transfer SOL from poster to escrow PDA
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &poster_key,
            &escrow_key,
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.poster.to_account_info(),
                ctx.accounts.escrow.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.poster = poster_key;
        escrow.worker = Pubkey::default();
        escrow.job_id = job_id.clone();
        escrow.amount = amount;
        escrow.status = EscrowStatus::Active;
        escrow.created_at = clock.unix_timestamp;
        escrow.expires_at = expires_at;
        escrow.dispute_initiated_at = None;
        escrow.submitted_at = None;
        escrow.proof_hash = None;
        escrow.dispute_case = None;
        escrow.bump = ctx.bumps.escrow;

        emit!(EscrowCreated {
            job_id,
            poster: poster_key,
            amount,
            expires_at,
        });

        Ok(())
    }

    /// Assign a worker to the escrow (called by poster or platform)
    pub fn assign_worker(
        ctx: Context<AssignWorker>,
        worker: Pubkey,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Active, EscrowError::EscrowNotActive);
        require!(escrow.worker == Pubkey::default(), EscrowError::WorkerAlreadyAssigned);
        
        escrow.worker = worker;

        emit!(WorkerAssigned {
            job_id: escrow.job_id.clone(),
            worker,
        });

        Ok(())
    }

    /// Release funds to worker - ONLY platform authority can call this
    /// Takes 1% platform fee, sends 99% to worker
    /// Updates reputation for both parties
    pub fn release_to_worker(ctx: Context<ReleaseToWorker>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Active, EscrowError::EscrowNotActive);
        require!(escrow.worker != Pubkey::default(), EscrowError::NoWorkerAssigned);
        require!(
            escrow.worker == ctx.accounts.worker.key(),
            EscrowError::WorkerMismatch
        );

        let amount = escrow.amount;
        let platform_fee = amount / 100;
        let worker_payment = amount - platform_fee;

        escrow.status = EscrowStatus::Released;

        let escrow_info = escrow.to_account_info();
        let rent = Rent::get()?.minimum_balance(escrow_info.data_len());
        let escrow_lamports = **escrow_info.try_borrow_lamports()?;
        let available = escrow_lamports.saturating_sub(rent);
        
        require!(available >= amount, EscrowError::InsufficientFunds);

        **escrow.to_account_info().try_borrow_mut_lamports()? -= worker_payment;
        **ctx.accounts.worker.to_account_info().try_borrow_mut_lamports()? += worker_payment;

        **escrow.to_account_info().try_borrow_mut_lamports()? -= platform_fee;
        **ctx.accounts.platform.to_account_info().try_borrow_mut_lamports()? += platform_fee;

        emit!(FundsReleased {
            job_id: escrow.job_id.clone(),
            worker: ctx.accounts.worker.key(),
            worker_payment,
            platform_fee,
        });

        Ok(())
    }

    /// Initiate a dispute (by poster or platform) - starts timelock
    pub fn initiate_dispute(ctx: Context<InitiateDispute>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::Active || escrow.status == EscrowStatus::PendingReview,
            EscrowError::EscrowNotActive
        );

        escrow.status = EscrowStatus::Disputed;
        escrow.dispute_initiated_at = Some(Clock::get()?.unix_timestamp);

        emit!(DisputeInitiated {
            job_id: escrow.job_id.clone(),
            initiated_by: ctx.accounts.initiator.key(),
        });

        Ok(())
    }

    /// Refund to poster - ONLY platform authority can call, requires timelock passed
    pub fn refund_to_poster(ctx: Context<RefundToPoster>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let clock = Clock::get()?;

        require!(
            escrow.status == EscrowStatus::Disputed || escrow.status == EscrowStatus::Cancelled,
            EscrowError::RefundNotAllowed
        );

        if escrow.status == EscrowStatus::Disputed {
            let dispute_time = escrow.dispute_initiated_at.ok_or(EscrowError::NoDisputeTime)?;
            require!(
                clock.unix_timestamp >= dispute_time + REFUND_TIMELOCK_SECONDS,
                EscrowError::TimelockNotPassed
            );
        }

        let amount = escrow.amount;
        escrow.status = EscrowStatus::Refunded;

        let escrow_info = escrow.to_account_info();
        let rent = Rent::get()?.minimum_balance(escrow_info.data_len());
        let escrow_lamports = **escrow_info.try_borrow_lamports()?;
        let available = escrow_lamports.saturating_sub(rent);
        
        require!(available >= amount, EscrowError::InsufficientFunds);

        **escrow.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.poster.to_account_info().try_borrow_mut_lamports()? += amount;

        emit!(FundsRefunded {
            job_id: escrow.job_id.clone(),
            poster: ctx.accounts.poster.key(),
            amount,
        });

        Ok(())
    }

    /// Claim expired escrow - poster can reclaim after expiry
    pub fn claim_expired(ctx: Context<ClaimExpired>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let clock = Clock::get()?;

        require!(escrow.status == EscrowStatus::Active, EscrowError::EscrowNotActive);
        require!(clock.unix_timestamp >= escrow.expires_at, EscrowError::NotExpired);

        let amount = escrow.amount;
        escrow.status = EscrowStatus::Expired;

        let escrow_info = escrow.to_account_info();
        let rent = Rent::get()?.minimum_balance(escrow_info.data_len());
        let escrow_lamports = **escrow_info.try_borrow_lamports()?;
        let available = escrow_lamports.saturating_sub(rent);
        
        require!(available >= amount, EscrowError::InsufficientFunds);

        **escrow.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.poster.to_account_info().try_borrow_mut_lamports()? += amount;

        emit!(EscrowExpired {
            job_id: escrow.job_id.clone(),
            poster: ctx.accounts.poster.key(),
            amount,
        });

        Ok(())
    }

    /// Cancel escrow before worker assigned
    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Active, EscrowError::EscrowNotActive);
        require!(escrow.worker == Pubkey::default(), EscrowError::WorkerAlreadyAssigned);

        let amount = escrow.amount;
        escrow.status = EscrowStatus::Cancelled;

        let escrow_info = escrow.to_account_info();
        let rent = Rent::get()?.minimum_balance(escrow_info.data_len());
        let escrow_lamports = **escrow_info.try_borrow_lamports()?;
        let available = escrow_lamports.saturating_sub(rent);
        
        require!(available >= amount, EscrowError::InsufficientFunds);

        **escrow.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.poster.to_account_info().try_borrow_mut_lamports()? += amount;

        emit!(EscrowCancelled {
            job_id: escrow.job_id.clone(),
            poster: ctx.accounts.poster.key(),
            amount,
        });

        Ok(())
    }

    /// Close escrow account and reclaim rent
    pub fn close_escrow(ctx: Context<CloseEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::Released ||
            escrow.status == EscrowStatus::Refunded ||
            escrow.status == EscrowStatus::Expired ||
            escrow.status == EscrowStatus::Cancelled,
            EscrowError::CannotClose
        );

        emit!(EscrowClosed {
            job_id: escrow.job_id.clone(),
        });

        Ok(())
    }

    // ============== PHASE 1: CLIENT-MUST-ACT FLOW ==============

    /// Worker submits completed work - starts 24h review window
    pub fn submit_work(
        ctx: Context<SubmitWork>,
        proof_hash: Option<[u8; 32]>,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let clock = Clock::get()?;

        require!(escrow.status == EscrowStatus::Active, EscrowError::EscrowNotActive);
        require!(escrow.worker != Pubkey::default(), EscrowError::NoWorkerAssigned);
        require!(
            escrow.worker == ctx.accounts.worker.key(),
            EscrowError::WorkerMismatch
        );

        escrow.status = EscrowStatus::PendingReview;
        escrow.submitted_at = Some(clock.unix_timestamp);
        escrow.proof_hash = proof_hash;

        emit!(WorkSubmitted {
            job_id: escrow.job_id.clone(),
            worker: ctx.accounts.worker.key(),
            proof_hash,
            review_deadline: clock.unix_timestamp + REVIEW_WINDOW_SECONDS,
        });

        Ok(())
    }

    /// Poster approves submitted work - releases funds immediately
    pub fn approve_work(ctx: Context<ApproveWork>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;

        require!(
            escrow.status == EscrowStatus::PendingReview,
            EscrowError::NotPendingReview
        );

        let amount = escrow.amount;
        let platform_fee = amount / 100;
        let worker_payment = amount - platform_fee;

        escrow.status = EscrowStatus::Released;

        let escrow_info = escrow.to_account_info();
        let rent = Rent::get()?.minimum_balance(escrow_info.data_len());
        let escrow_lamports = **escrow_info.try_borrow_lamports()?;
        let available = escrow_lamports.saturating_sub(rent);
        
        require!(available >= amount, EscrowError::InsufficientFunds);

        **escrow.to_account_info().try_borrow_mut_lamports()? -= worker_payment;
        **ctx.accounts.worker.to_account_info().try_borrow_mut_lamports()? += worker_payment;

        **escrow.to_account_info().try_borrow_mut_lamports()? -= platform_fee;
        **ctx.accounts.platform.to_account_info().try_borrow_mut_lamports()? += platform_fee;

        emit!(WorkApproved {
            job_id: escrow.job_id.clone(),
            worker: ctx.accounts.worker.key(),
            worker_payment,
            platform_fee,
            approved_by: ctx.accounts.poster.key(),
        });

        Ok(())
    }

    /// Auto-release funds after review window expires
    pub fn auto_release(ctx: Context<AutoRelease>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let clock = Clock::get()?;

        require!(
            escrow.status == EscrowStatus::PendingReview,
            EscrowError::NotPendingReview
        );

        let submitted_at = escrow.submitted_at.ok_or(EscrowError::NoSubmissionTime)?;
        require!(
            clock.unix_timestamp >= submitted_at + REVIEW_WINDOW_SECONDS,
            EscrowError::ReviewWindowNotExpired
        );

        let amount = escrow.amount;
        let platform_fee = amount / 100;
        let worker_payment = amount - platform_fee;

        escrow.status = EscrowStatus::Released;

        let escrow_info = escrow.to_account_info();
        let rent = Rent::get()?.minimum_balance(escrow_info.data_len());
        let escrow_lamports = **escrow_info.try_borrow_lamports()?;
        let available = escrow_lamports.saturating_sub(rent);
        
        require!(available >= amount, EscrowError::InsufficientFunds);

        **escrow.to_account_info().try_borrow_mut_lamports()? -= worker_payment;
        **ctx.accounts.worker.to_account_info().try_borrow_mut_lamports()? += worker_payment;

        **escrow.to_account_info().try_borrow_mut_lamports()? -= platform_fee;
        **ctx.accounts.platform.to_account_info().try_borrow_mut_lamports()? += platform_fee;

        emit!(WorkAutoReleased {
            job_id: escrow.job_id.clone(),
            worker: ctx.accounts.worker.key(),
            worker_payment,
            platform_fee,
            triggered_by: ctx.accounts.cranker.key(),
        });

        Ok(())
    }

    // ============== PHASE 2: REPUTATION SYSTEM ==============

    /// Initialize a reputation account for an agent
    pub fn init_reputation(ctx: Context<InitReputation>) -> Result<()> {
        let reputation = &mut ctx.accounts.reputation;
        let clock = Clock::get()?;

        reputation.agent = ctx.accounts.agent.key();
        reputation.jobs_completed = 0;
        reputation.jobs_posted = 0;
        reputation.total_earned = 0;
        reputation.total_spent = 0;
        reputation.disputes_won = 0;
        reputation.disputes_lost = 0;
        reputation.reputation_score = 0;
        reputation.created_at = clock.unix_timestamp;
        reputation.bump = ctx.bumps.reputation;

        emit!(ReputationInitialized {
            agent: ctx.accounts.agent.key(),
        });

        Ok(())
    }

    /// Release funds with reputation update (preferred over raw release_to_worker)
    pub fn release_with_reputation(ctx: Context<ReleaseWithReputation>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Active || escrow.status == EscrowStatus::PendingReview, 
            EscrowError::EscrowNotActive);
        require!(escrow.worker != Pubkey::default(), EscrowError::NoWorkerAssigned);
        require!(
            escrow.worker == ctx.accounts.worker.key(),
            EscrowError::WorkerMismatch
        );

        let amount = escrow.amount;
        let platform_fee = amount / 100;
        let worker_payment = amount - platform_fee;

        escrow.status = EscrowStatus::Released;

        // Update worker reputation
        let worker_rep = &mut ctx.accounts.worker_reputation;
        worker_rep.jobs_completed += 1;
        worker_rep.total_earned += worker_payment;
        worker_rep.reputation_score = calculate_reputation_score(worker_rep);

        // Update poster reputation
        let poster_rep = &mut ctx.accounts.poster_reputation;
        poster_rep.jobs_posted += 1;
        poster_rep.total_spent += amount;
        poster_rep.reputation_score = calculate_reputation_score(poster_rep);

        let escrow_info = escrow.to_account_info();
        let rent = Rent::get()?.minimum_balance(escrow_info.data_len());
        let escrow_lamports = **escrow_info.try_borrow_lamports()?;
        let available = escrow_lamports.saturating_sub(rent);
        
        require!(available >= amount, EscrowError::InsufficientFunds);

        **escrow.to_account_info().try_borrow_mut_lamports()? -= worker_payment;
        **ctx.accounts.worker.to_account_info().try_borrow_mut_lamports()? += worker_payment;

        **escrow.to_account_info().try_borrow_mut_lamports()? -= platform_fee;
        **ctx.accounts.platform.to_account_info().try_borrow_mut_lamports()? += platform_fee;

        emit!(FundsReleasedWithReputation {
            job_id: escrow.job_id.clone(),
            worker: ctx.accounts.worker.key(),
            worker_payment,
            platform_fee,
            worker_new_score: worker_rep.reputation_score,
            poster_new_score: poster_rep.reputation_score,
        });

        Ok(())
    }

    // ============== PHASE 3: MULTI-ARBITRATOR DISPUTES ==============

    /// Initialize the arbitrator pool (platform only, one-time)
    pub fn init_arbitrator_pool(ctx: Context<InitArbitratorPool>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.arbitrators = Vec::new();
        pool.min_stake = MIN_ARBITRATOR_STAKE;
        pool.bump = ctx.bumps.pool;

        emit!(ArbitratorPoolInitialized {
            authority: ctx.accounts.authority.key(),
        });

        Ok(())
    }

    /// Register as an arbitrator (requires stake)
    pub fn register_arbitrator(ctx: Context<RegisterArbitrator>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let arbitrator = &mut ctx.accounts.arbitrator_account;
        let agent_key = ctx.accounts.agent.key();

        require!(pool.arbitrators.len() < MAX_ARBITRATORS, EscrowError::ArbitratorPoolFull);
        require!(!pool.arbitrators.contains(&agent_key), EscrowError::AlreadyArbitrator);

        // Transfer stake from agent to arbitrator account
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &agent_key,
            &arbitrator.key(),
            MIN_ARBITRATOR_STAKE,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.agent.to_account_info(),
                arbitrator.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        arbitrator.agent = agent_key;
        arbitrator.stake = MIN_ARBITRATOR_STAKE;
        arbitrator.cases_voted = 0;
        arbitrator.cases_correct = 0;
        arbitrator.is_active = true;
        arbitrator.registered_at = Clock::get()?.unix_timestamp;
        arbitrator.bump = ctx.bumps.arbitrator_account;

        pool.arbitrators.push(agent_key);

        emit!(ArbitratorRegistered {
            agent: agent_key,
            stake: MIN_ARBITRATOR_STAKE,
        });

        Ok(())
    }

    /// Unregister as arbitrator and reclaim stake
    pub fn unregister_arbitrator(ctx: Context<UnregisterArbitrator>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let arbitrator = &mut ctx.accounts.arbitrator_account;
        let agent_key = ctx.accounts.agent.key();

        require!(arbitrator.is_active, EscrowError::ArbitratorNotActive);
        
        // Remove from pool
        if let Some(pos) = pool.arbitrators.iter().position(|x| *x == agent_key) {
            pool.arbitrators.remove(pos);
        }

        arbitrator.is_active = false;

        // Return stake
        let stake = arbitrator.stake;
        **arbitrator.to_account_info().try_borrow_mut_lamports()? -= stake;
        **ctx.accounts.agent.to_account_info().try_borrow_mut_lamports()? += stake;

        emit!(ArbitratorUnregistered {
            agent: agent_key,
            stake_returned: stake,
        });

        Ok(())
    }

    /// Raise a dispute case - selects 5 random arbitrators
    pub fn raise_dispute_case(ctx: Context<RaiseDisputeCase>, reason: String) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let dispute_case = &mut ctx.accounts.dispute_case;
        let pool = &ctx.accounts.pool;
        let clock = Clock::get()?;

        require!(
            escrow.status == EscrowStatus::Active || escrow.status == EscrowStatus::PendingReview,
            EscrowError::EscrowNotActive
        );
        require!(reason.len() <= 500, EscrowError::ReasonTooLong);
        require!(pool.arbitrators.len() >= ARBITRATORS_PER_DISPUTE, EscrowError::NotEnoughArbitrators);

        // Select 5 arbitrators with improved randomness (H-1 fix)
        // Seed includes: escrow key, slot, initiator, timestamp, amount
        // This makes gaming arbitrator selection significantly harder
        let escrow_bytes = escrow.key().to_bytes();
        let initiator_bytes = ctx.accounts.initiator.key().to_bytes();
        let slot_bytes = clock.slot.to_le_bytes();
        let ts_bytes = clock.unix_timestamp.to_le_bytes();
        let amt_bytes = escrow.amount.to_le_bytes();
        
        // Combine multiple entropy sources
        let mut seed_data = [0u8; 32];
        for i in 0..8 { seed_data[i] = escrow_bytes[i] ^ initiator_bytes[i]; }
        for i in 0..8 { seed_data[8 + i] = slot_bytes[i] ^ escrow_bytes[16 + i]; }
        for i in 0..8 { seed_data[16 + i] = ts_bytes[i] ^ initiator_bytes[16 + i]; }
        for i in 0..8 { seed_data[24 + i] = amt_bytes[i] ^ escrow_bytes[24 + i]; }
        
        let seed_hash = sha256_hash(&seed_data);
        let seed = u64::from_le_bytes(seed_hash.as_ref()[0..8].try_into().unwrap());
        
        let mut selected: Vec<Pubkey> = Vec::with_capacity(ARBITRATORS_PER_DISPUTE);
        let mut used_indices: Vec<usize> = Vec::new();
        
        for i in 0..ARBITRATORS_PER_DISPUTE {
            let mut idx = ((seed.wrapping_add(i as u64).wrapping_mul(31337).wrapping_add(
                u64::from_le_bytes(seed_hash.as_ref()[8..16].try_into().unwrap())
            )) as usize) % pool.arbitrators.len();
            while used_indices.contains(&idx) {
                idx = (idx + 1) % pool.arbitrators.len();
            }
            used_indices.push(idx);
            selected.push(pool.arbitrators[idx]);
        }

        escrow.status = EscrowStatus::InArbitration;
        escrow.dispute_case = Some(dispute_case.key());

        dispute_case.escrow = escrow.key();
        dispute_case.raised_by = ctx.accounts.initiator.key();
        dispute_case.reason = reason.clone();
        dispute_case.arbitrators = [selected[0], selected[1], selected[2], selected[3], selected[4]];
        dispute_case.votes = [None, None, None, None, None];
        dispute_case.voting_deadline = clock.unix_timestamp + ARBITRATION_VOTING_SECONDS;
        dispute_case.resolution = None;
        dispute_case.created_at = clock.unix_timestamp;
        dispute_case.bump = ctx.bumps.dispute_case;

        emit!(DisputeCaseRaised {
            escrow: escrow.key(),
            raised_by: ctx.accounts.initiator.key(),
            arbitrators: dispute_case.arbitrators,
            voting_deadline: dispute_case.voting_deadline,
            reason,
        });

        Ok(())
    }

    /// Cast a vote on a dispute case
    pub fn cast_arbitration_vote(ctx: Context<CastArbitrationVote>, vote: Vote) -> Result<()> {
        let dispute_case = &mut ctx.accounts.dispute_case;
        let arbitrator_account = &mut ctx.accounts.arbitrator_account;
        let voter_key = ctx.accounts.voter.key();
        let clock = Clock::get()?;

        require!(dispute_case.resolution.is_none(), EscrowError::DisputeAlreadyResolved);
        require!(clock.unix_timestamp < dispute_case.voting_deadline, EscrowError::VotingDeadlinePassed);

        // Find voter's position in arbitrators array
        let position = dispute_case.arbitrators.iter()
            .position(|&arb| arb == voter_key)
            .ok_or(EscrowError::NotSelectedArbitrator)?;

        require!(dispute_case.votes[position].is_none(), EscrowError::AlreadyVoted);

        dispute_case.votes[position] = Some(vote);
        arbitrator_account.cases_voted += 1;

        emit!(ArbitrationVoteCast {
            dispute_case: dispute_case.key(),
            arbitrator: voter_key,
            vote,
        });

        Ok(())
    }

    /// Finalize dispute after voting (anyone can call after deadline or when majority reached)
    pub fn finalize_dispute_case(ctx: Context<FinalizeDisputeCase>) -> Result<()> {
        let dispute_case = &mut ctx.accounts.dispute_case;
        let escrow = &mut ctx.accounts.escrow;
        let clock = Clock::get()?;

        require!(dispute_case.resolution.is_none(), EscrowError::DisputeAlreadyResolved);

        // Count votes
        let mut for_worker = 0u8;
        let mut for_poster = 0u8;
        for vote in dispute_case.votes.iter() {
            match vote {
                Some(Vote::ForWorker) => for_worker += 1,
                Some(Vote::ForPoster) => for_poster += 1,
                None => {}
            }
        }

        let total_votes = for_worker + for_poster;
        let has_majority = for_worker >= ARBITRATION_MAJORITY as u8 || for_poster >= ARBITRATION_MAJORITY as u8;
        let deadline_passed = clock.unix_timestamp >= dispute_case.voting_deadline;

        require!(has_majority || deadline_passed, EscrowError::VotingNotComplete);

        // Determine resolution
        let resolution = if for_worker > for_poster {
            DisputeResolution::WorkerWins
        } else if for_poster > for_worker {
            DisputeResolution::PosterWins
        } else {
            DisputeResolution::Split
        };

        dispute_case.resolution = Some(resolution);

        // Update escrow status based on resolution
        escrow.status = match resolution {
            DisputeResolution::WorkerWins => EscrowStatus::DisputeWorkerWins,
            DisputeResolution::PosterWins => EscrowStatus::DisputePosterWins,
            DisputeResolution::Split => EscrowStatus::DisputeSplit,
        };

        emit!(DisputeCaseFinalized {
            dispute_case: dispute_case.key(),
            resolution,
            votes_for_worker: for_worker,
            votes_for_poster: for_poster,
        });

        Ok(())
    }

    /// Execute dispute resolution - transfer funds based on outcome
    /// Also updates reputation for winner/loser
    pub fn execute_dispute_resolution(ctx: Context<ExecuteDisputeResolution>) -> Result<()> {
        let dispute_case = &ctx.accounts.dispute_case;
        let escrow = &mut ctx.accounts.escrow;

        let resolution = dispute_case.resolution.ok_or(EscrowError::DisputeNotResolved)?;
        
        require!(
            escrow.status == EscrowStatus::DisputeWorkerWins ||
            escrow.status == EscrowStatus::DisputePosterWins ||
            escrow.status == EscrowStatus::DisputeSplit,
            EscrowError::InvalidStatusForExecution
        );

        let amount = escrow.amount;
        let escrow_info = escrow.to_account_info();
        let rent = Rent::get()?.minimum_balance(escrow_info.data_len());
        let escrow_lamports = **escrow_info.try_borrow_lamports()?;
        let available = escrow_lamports.saturating_sub(rent);
        require!(available >= amount, EscrowError::InsufficientFunds);

        // Update reputation based on resolution
        let worker_rep = &mut ctx.accounts.worker_reputation;
        let poster_rep = &mut ctx.accounts.poster_reputation;

        match resolution {
            DisputeResolution::WorkerWins => {
                let platform_fee = amount / 100;
                let worker_payment = amount - platform_fee;
                
                **escrow.to_account_info().try_borrow_mut_lamports()? -= worker_payment;
                **ctx.accounts.worker.to_account_info().try_borrow_mut_lamports()? += worker_payment;
                
                **escrow.to_account_info().try_borrow_mut_lamports()? -= platform_fee;
                **ctx.accounts.platform.to_account_info().try_borrow_mut_lamports()? += platform_fee;

                // Worker won the dispute
                worker_rep.disputes_won += 1;
                poster_rep.disputes_lost += 1;

                escrow.status = EscrowStatus::Released;
            }
            DisputeResolution::PosterWins => {
                **escrow.to_account_info().try_borrow_mut_lamports()? -= amount;
                **ctx.accounts.poster.to_account_info().try_borrow_mut_lamports()? += amount;

                // Poster won the dispute
                poster_rep.disputes_won += 1;
                worker_rep.disputes_lost += 1;

                escrow.status = EscrowStatus::Refunded;
            }
            DisputeResolution::Split => {
                // Symmetric fee: take 1% from total, THEN split remainder equally
                let platform_fee = amount / 100;
                let remaining = amount - platform_fee;
                let worker_half = remaining / 2;
                let poster_half = remaining - worker_half; // Handles odd amounts

                **escrow.to_account_info().try_borrow_mut_lamports()? -= worker_half;
                **ctx.accounts.worker.to_account_info().try_borrow_mut_lamports()? += worker_half;

                **escrow.to_account_info().try_borrow_mut_lamports()? -= poster_half;
                **ctx.accounts.poster.to_account_info().try_borrow_mut_lamports()? += poster_half;

                **escrow.to_account_info().try_borrow_mut_lamports()? -= platform_fee;
                **ctx.accounts.platform.to_account_info().try_borrow_mut_lamports()? += platform_fee;

                // Split = no clear winner, no reputation change for disputes

                escrow.status = EscrowStatus::Released;
            }
        }

        // Recalculate reputation scores
        worker_rep.reputation_score = calculate_reputation_score(worker_rep);
        poster_rep.reputation_score = calculate_reputation_score(poster_rep);

        emit!(DisputeResolutionExecuted {
            escrow: escrow.key(),
            resolution,
            amount,
            worker_new_score: worker_rep.reputation_score,
            poster_new_score: poster_rep.reputation_score,
        });

        Ok(())
    }

    /// Update arbitrator accuracy after dispute resolution (C-1 fix)
    /// Creates AccuracyClaim PDA to prevent duplicate calls
    pub fn update_arbitrator_accuracy(ctx: Context<UpdateArbitratorAccuracy>) -> Result<()> {
        let dispute_case = &ctx.accounts.dispute_case;
        let arbitrator = &mut ctx.accounts.arbitrator_account;
        let accuracy_claim = &mut ctx.accounts.accuracy_claim;
        let arbitrator_key = arbitrator.agent;

        let resolution = dispute_case.resolution.ok_or(EscrowError::DisputeNotResolved)?;

        // Find this arbitrator's vote
        let position = dispute_case.arbitrators.iter()
            .position(|&arb| arb == arbitrator_key)
            .ok_or(EscrowError::NotSelectedArbitrator)?;

        let vote = dispute_case.votes[position].ok_or(EscrowError::ArbitratorDidNotVote)?;

        // AccuracyClaim PDA being created proves this is the first call
        // If called again, the PDA init will fail with "already initialized"
        accuracy_claim.dispute_case = dispute_case.key();
        accuracy_claim.arbitrator = arbitrator_key;
        accuracy_claim.claimed_at = Clock::get()?.unix_timestamp;
        accuracy_claim.bump = ctx.bumps.accuracy_claim;

        // Determine if vote matched the resolution
        let voted_correctly = match (vote, resolution) {
            (Vote::ForWorker, DisputeResolution::WorkerWins) => true,
            (Vote::ForPoster, DisputeResolution::PosterWins) => true,
            // Split case: neither side "won", so we consider both votes as correct
            (_, DisputeResolution::Split) => true,
            _ => false,
        };

        if voted_correctly {
            arbitrator.cases_correct += 1;
        }

        emit!(ArbitratorAccuracyUpdated {
            arbitrator: arbitrator_key,
            dispute_case: dispute_case.key(),
            voted_correctly,
            cases_correct: arbitrator.cases_correct,
            cases_voted: arbitrator.cases_voted,
        });

        Ok(())
    }

    /// Emergency release for expired arbitrations (H-2 fix)
    /// If arbitration extends past escrow expiry + grace period, poster can reclaim funds
    pub fn claim_expired_arbitration(ctx: Context<ClaimExpiredArbitration>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let clock = Clock::get()?;

        require!(
            escrow.status == EscrowStatus::InArbitration,
            EscrowError::NotInArbitration
        );
        
        // Must be past expiry + grace period
        let emergency_deadline = escrow.expires_at + ARBITRATION_GRACE_PERIOD;
        require!(
            clock.unix_timestamp >= emergency_deadline,
            EscrowError::ArbitrationGracePeriodNotPassed
        );

        let amount = escrow.amount;
        let escrow_info = escrow.to_account_info();
        let rent = Rent::get()?.minimum_balance(escrow_info.data_len());
        let escrow_lamports = **escrow_info.try_borrow_lamports()?;
        let available = escrow_lamports.saturating_sub(rent);

        require!(available >= amount, EscrowError::InsufficientFunds);

        // Return funds to poster (no fee for emergency release)
        **escrow.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.poster.to_account_info().try_borrow_mut_lamports()? += amount;

        escrow.status = EscrowStatus::Refunded;

        emit!(ExpiredArbitrationClaimed {
            job_id: escrow.job_id.clone(),
            poster: ctx.accounts.poster.key(),
            amount,
        });

        Ok(())
    }

    /// Remove an arbitrator from the pool (platform authority only)
    /// Returns their stake - use for bad actors
    pub fn remove_arbitrator(ctx: Context<RemoveArbitrator>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let arbitrator = &mut ctx.accounts.arbitrator_account;
        let agent_key = arbitrator.agent;

        require!(arbitrator.is_active, EscrowError::ArbitratorNotActive);
        
        // Remove from pool
        if let Some(pos) = pool.arbitrators.iter().position(|x| *x == agent_key) {
            pool.arbitrators.remove(pos);
        }

        arbitrator.is_active = false;

        // Return stake to the arbitrator
        let stake = arbitrator.stake;
        **arbitrator.to_account_info().try_borrow_mut_lamports()? -= stake;
        **ctx.accounts.arbitrator_agent.to_account_info().try_borrow_mut_lamports()? += stake;

        emit!(ArbitratorRemoved {
            agent: agent_key,
            removed_by: ctx.accounts.authority.key(),
            stake_returned: stake,
        });

        Ok(())
    }

    /// Close a dispute case after execution - returns rent to initiator
    pub fn close_dispute_case(ctx: Context<CloseDisputeCase>) -> Result<()> {
        let dispute_case = &ctx.accounts.dispute_case;
        let escrow = &ctx.accounts.escrow;

        // Ensure dispute has been resolved and executed
        require!(dispute_case.resolution.is_some(), EscrowError::DisputeNotResolved);
        require!(
            escrow.status == EscrowStatus::Released ||
            escrow.status == EscrowStatus::Refunded,
            EscrowError::DisputeNotExecuted
        );

        emit!(DisputeCaseClosed {
            dispute_case: dispute_case.key(),
            escrow: escrow.key(),
            rent_returned_to: ctx.accounts.initiator.key(),
        });

        Ok(())
    }

    /// Close an inactive arbitrator account - returns rent to agent
    pub fn close_arbitrator_account(ctx: Context<CloseArbitratorAccount>) -> Result<()> {
        let arbitrator = &ctx.accounts.arbitrator_account;
        let pool = &ctx.accounts.pool;

        // Ensure arbitrator is not active (already unregistered from pool)
        require!(!arbitrator.is_active, EscrowError::ArbitratorStillActive);
        
        // Double-check they're not in the pool
        require!(
            !pool.arbitrators.contains(&arbitrator.agent),
            EscrowError::ArbitratorStillInPool
        );

        emit!(ArbitratorAccountClosed {
            agent: arbitrator.agent,
            rent_returned: ctx.accounts.arbitrator_account.to_account_info().lamports(),
        });

        Ok(())
    }
}

// ============== HELPER FUNCTIONS ==============

fn calculate_reputation_score(rep: &AgentReputation) -> i64 {
    let base = (rep.jobs_completed as i64) * 10;
    let dispute_bonus = (rep.disputes_won as i64) * 5;
    let dispute_penalty = (rep.disputes_lost as i64) * 10;
    base + dispute_bonus - dispute_penalty
}

// ============== ACCOUNTS ==============

#[derive(Accounts)]
#[instruction(job_id: String, job_id_hash: [u8; 32])]
pub struct CreateEscrow<'info> {
    #[account(
        init,
        payer = poster,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [b"escrow", job_id_hash.as_ref(), poster.key().as_ref()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub poster: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AssignWorker<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(
        constraint = initiator.key() == escrow.poster || initiator.key() == PLATFORM_WALLET 
            @ EscrowError::Unauthorized
    )]
    pub initiator: Signer<'info>,
}

#[derive(Accounts)]
pub struct ReleaseToWorker<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(address = PLATFORM_WALLET @ EscrowError::NotPlatformAuthority)]
    pub platform_authority: Signer<'info>,
    /// CHECK: Worker receives payment
    #[account(mut)]
    pub worker: AccountInfo<'info>,
    /// CHECK: Platform wallet receives 1% fee
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct InitiateDispute<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(
        constraint = initiator.key() == escrow.poster || initiator.key() == PLATFORM_WALLET 
            @ EscrowError::Unauthorized
    )]
    pub initiator: Signer<'info>,
}

#[derive(Accounts)]
pub struct RefundToPoster<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(address = PLATFORM_WALLET @ EscrowError::NotPlatformAuthority)]
    pub platform_authority: Signer<'info>,
    /// CHECK: Poster receives refund
    #[account(mut, address = escrow.poster @ EscrowError::PosterMismatch)]
    pub poster: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ClaimExpired<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, address = escrow.poster @ EscrowError::PosterMismatch)]
    pub poster: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, address = escrow.poster @ EscrowError::PosterMismatch)]
    pub poster: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseEscrow<'info> {
    #[account(
        mut,
        close = poster,
        constraint = poster.key() == escrow.poster @ EscrowError::PosterMismatch
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub poster: Signer<'info>,
}

// ============== PHASE 1 ACCOUNTS ==============

#[derive(Accounts)]
pub struct SubmitWork<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(address = escrow.worker @ EscrowError::WorkerMismatch)]
    pub worker: Signer<'info>,
}

#[derive(Accounts)]
pub struct ApproveWork<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(address = escrow.poster @ EscrowError::PosterMismatch)]
    pub poster: Signer<'info>,
    /// CHECK: Worker receives payment
    #[account(mut, address = escrow.worker @ EscrowError::WorkerMismatch)]
    pub worker: AccountInfo<'info>,
    /// CHECK: Platform wallet receives 1% fee
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct AutoRelease<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    pub cranker: Signer<'info>,
    /// CHECK: Worker receives payment
    #[account(mut, address = escrow.worker @ EscrowError::WorkerMismatch)]
    pub worker: AccountInfo<'info>,
    /// CHECK: Platform wallet receives 1% fee
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform: AccountInfo<'info>,
}

// ============== PHASE 2 ACCOUNTS ==============

#[derive(Accounts)]
pub struct InitReputation<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + AgentReputation::INIT_SPACE,
        seeds = [b"reputation", agent.key().as_ref()],
        bump
    )]
    pub reputation: Account<'info, AgentReputation>,
    /// CHECK: Agent whose reputation is being initialized
    pub agent: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseWithReputation<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(address = PLATFORM_WALLET @ EscrowError::NotPlatformAuthority)]
    pub platform_authority: Signer<'info>,
    /// CHECK: Worker receives payment
    #[account(mut, address = escrow.worker @ EscrowError::WorkerMismatch)]
    pub worker: AccountInfo<'info>,
    /// CHECK: Platform wallet receives 1% fee
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"reputation", escrow.worker.as_ref()],
        bump = worker_reputation.bump
    )]
    pub worker_reputation: Account<'info, AgentReputation>,
    #[account(
        mut,
        seeds = [b"reputation", escrow.poster.as_ref()],
        bump = poster_reputation.bump
    )]
    pub poster_reputation: Account<'info, AgentReputation>,
}

// ============== PHASE 3 ACCOUNTS ==============

#[derive(Accounts)]
pub struct InitArbitratorPool<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ArbitratorPool::INIT_SPACE,
        seeds = [b"arbitrator_pool"],
        bump
    )]
    pub pool: Account<'info, ArbitratorPool>,
    #[account(mut, address = PLATFORM_WALLET @ EscrowError::NotPlatformAuthority)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterArbitrator<'info> {
    #[account(
        mut,
        seeds = [b"arbitrator_pool"],
        bump = pool.bump
    )]
    pub pool: Account<'info, ArbitratorPool>,
    #[account(
        init,
        payer = agent,
        space = 8 + Arbitrator::INIT_SPACE,
        seeds = [b"arbitrator", agent.key().as_ref()],
        bump
    )]
    pub arbitrator_account: Account<'info, Arbitrator>,
    #[account(mut)]
    pub agent: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnregisterArbitrator<'info> {
    #[account(
        mut,
        seeds = [b"arbitrator_pool"],
        bump = pool.bump
    )]
    pub pool: Account<'info, ArbitratorPool>,
    #[account(
        mut,
        seeds = [b"arbitrator", agent.key().as_ref()],
        bump = arbitrator_account.bump,
        constraint = arbitrator_account.agent == agent.key() @ EscrowError::Unauthorized
    )]
    pub arbitrator_account: Account<'info, Arbitrator>,
    #[account(mut)]
    pub agent: Signer<'info>,
}

#[derive(Accounts)]
pub struct RaiseDisputeCase<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(
        init,
        payer = initiator,
        space = 8 + DisputeCase::INIT_SPACE,
        seeds = [b"dispute", escrow.key().as_ref()],
        bump
    )]
    pub dispute_case: Account<'info, DisputeCase>,
    #[account(
        seeds = [b"arbitrator_pool"],
        bump = pool.bump
    )]
    pub pool: Account<'info, ArbitratorPool>,
    #[account(
        mut,
        constraint = initiator.key() == escrow.poster || initiator.key() == escrow.worker 
            @ EscrowError::Unauthorized
    )]
    pub initiator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CastArbitrationVote<'info> {
    #[account(mut)]
    pub dispute_case: Account<'info, DisputeCase>,
    #[account(
        mut,
        seeds = [b"arbitrator", voter.key().as_ref()],
        bump = arbitrator_account.bump,
        constraint = arbitrator_account.agent == voter.key() @ EscrowError::Unauthorized,
        constraint = arbitrator_account.is_active @ EscrowError::ArbitratorNotActive
    )]
    pub arbitrator_account: Account<'info, Arbitrator>,
    pub voter: Signer<'info>,
}

#[derive(Accounts)]
pub struct FinalizeDisputeCase<'info> {
    #[account(mut)]
    pub dispute_case: Account<'info, DisputeCase>,
    #[account(
        mut,
        constraint = escrow.key() == dispute_case.escrow @ EscrowError::EscrowMismatch
    )]
    pub escrow: Account<'info, Escrow>,
    /// Anyone can finalize after deadline or majority
    pub finalizer: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteDisputeResolution<'info> {
    #[account(
        constraint = dispute_case.escrow == escrow.key() @ EscrowError::EscrowMismatch
    )]
    pub dispute_case: Account<'info, DisputeCase>,
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: Worker may receive funds
    #[account(mut, address = escrow.worker @ EscrowError::WorkerMismatch)]
    pub worker: AccountInfo<'info>,
    /// CHECK: Poster may receive refund
    #[account(mut, address = escrow.poster @ EscrowError::PosterMismatch)]
    pub poster: AccountInfo<'info>,
    /// CHECK: Platform wallet receives fee
    #[account(mut, address = PLATFORM_WALLET)]
    pub platform: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [b"reputation", escrow.worker.as_ref()],
        bump = worker_reputation.bump
    )]
    pub worker_reputation: Account<'info, AgentReputation>,
    #[account(
        mut,
        seeds = [b"reputation", escrow.poster.as_ref()],
        bump = poster_reputation.bump
    )]
    pub poster_reputation: Account<'info, AgentReputation>,
    /// Anyone can execute after finalization
    pub executor: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateArbitratorAccuracy<'info> {
    #[account(
        constraint = dispute_case.resolution.is_some() @ EscrowError::DisputeNotResolved
    )]
    pub dispute_case: Account<'info, DisputeCase>,
    #[account(
        mut,
        seeds = [b"arbitrator", arbitrator_account.agent.as_ref()],
        bump = arbitrator_account.bump
    )]
    pub arbitrator_account: Account<'info, Arbitrator>,
    /// AccuracyClaim PDA - prevents duplicate accuracy claims (C-1 fix)
    #[account(
        init,
        payer = caller,
        space = 8 + AccuracyClaim::INIT_SPACE,
        seeds = [b"accuracy_claim", dispute_case.key().as_ref(), arbitrator_account.agent.as_ref()],
        bump
    )]
    pub accuracy_claim: Account<'info, AccuracyClaim>,
    /// Caller pays for AccuracyClaim PDA rent
    #[account(mut)]
    pub caller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimExpiredArbitration<'info> {
    #[account(
        mut,
        constraint = escrow.poster == poster.key() @ EscrowError::PosterMismatch
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut)]
    pub poster: Signer<'info>,
}

#[derive(Accounts)]
pub struct RemoveArbitrator<'info> {
    #[account(
        mut,
        seeds = [b"arbitrator_pool"],
        bump = pool.bump
    )]
    pub pool: Account<'info, ArbitratorPool>,
    #[account(
        mut,
        seeds = [b"arbitrator", arbitrator_account.agent.as_ref()],
        bump = arbitrator_account.bump
    )]
    pub arbitrator_account: Account<'info, Arbitrator>,
    /// The arbitrator's wallet - receives stake back
    /// CHECK: Verified by arbitrator_account.agent constraint
    #[account(
        mut,
        constraint = arbitrator_agent.key() == arbitrator_account.agent @ EscrowError::Unauthorized
    )]
    pub arbitrator_agent: AccountInfo<'info>,
    /// Platform authority - only they can remove arbitrators
    #[account(
        constraint = authority.key() == PLATFORM_WALLET @ EscrowError::NotPlatformAuthority
    )]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseDisputeCase<'info> {
    #[account(
        mut,
        close = initiator,
        seeds = [b"dispute", escrow.key().as_ref()],
        bump = dispute_case.bump,
        constraint = dispute_case.raised_by == initiator.key() @ EscrowError::Unauthorized
    )]
    pub dispute_case: Account<'info, DisputeCase>,
    #[account(
        constraint = escrow.key() == dispute_case.escrow @ EscrowError::EscrowMismatch
    )]
    pub escrow: Account<'info, Escrow>,
    /// Rent returned to the original dispute initiator
    #[account(mut)]
    pub initiator: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseArbitratorAccount<'info> {
    #[account(
        seeds = [b"arbitrator_pool"],
        bump = pool.bump
    )]
    pub pool: Account<'info, ArbitratorPool>,
    #[account(
        mut,
        close = agent,
        seeds = [b"arbitrator", agent.key().as_ref()],
        bump = arbitrator_account.bump,
        constraint = arbitrator_account.agent == agent.key() @ EscrowError::Unauthorized
    )]
    pub arbitrator_account: Account<'info, Arbitrator>,
    /// Rent returned to the arbitrator agent
    #[account(mut)]
    pub agent: Signer<'info>,
}

// ============== STATE ==============

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub poster: Pubkey,
    pub worker: Pubkey,
    #[max_len(64)]
    pub job_id: String,
    pub amount: u64,
    pub status: EscrowStatus,
    pub created_at: i64,
    pub expires_at: i64,
    pub dispute_initiated_at: Option<i64>,
    pub submitted_at: Option<i64>,
    pub proof_hash: Option<[u8; 32]>,
    pub dispute_case: Option<Pubkey>,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AgentReputation {
    pub agent: Pubkey,
    pub jobs_completed: u64,
    pub jobs_posted: u64,
    pub total_earned: u64,
    pub total_spent: u64,
    pub disputes_won: u64,
    pub disputes_lost: u64,
    pub reputation_score: i64,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ArbitratorPool {
    pub authority: Pubkey,
    #[max_len(100)]
    pub arbitrators: Vec<Pubkey>,
    pub min_stake: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Arbitrator {
    pub agent: Pubkey,
    pub stake: u64,
    pub cases_voted: u64,
    pub cases_correct: u64,
    pub is_active: bool,
    pub registered_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct DisputeCase {
    pub escrow: Pubkey,
    pub raised_by: Pubkey,
    #[max_len(500)]
    pub reason: String,
    pub arbitrators: [Pubkey; 5],
    pub votes: [Option<Vote>; 5],
    pub voting_deadline: i64,
    pub resolution: Option<DisputeResolution>,
    pub created_at: i64,
    pub bump: u8,
}

/// Tracks accuracy claims to prevent duplicate calls (C-1 fix)
#[account]
#[derive(InitSpace)]
pub struct AccuracyClaim {
    pub dispute_case: Pubkey,
    pub arbitrator: Pubkey,
    pub claimed_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowStatus {
    Active,
    Released,
    Refunded,
    Expired,
    Disputed,
    Cancelled,
    PendingReview,
    InArbitration,
    DisputeWorkerWins,
    DisputePosterWins,
    DisputeSplit,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Vote {
    ForWorker,
    ForPoster,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum DisputeResolution {
    WorkerWins,
    PosterWins,
    Split,
}

// ============== EVENTS ==============

#[event]
pub struct EscrowCreated {
    pub job_id: String,
    pub poster: Pubkey,
    pub amount: u64,
    pub expires_at: i64,
}

#[event]
pub struct WorkerAssigned {
    pub job_id: String,
    pub worker: Pubkey,
}

#[event]
pub struct FundsReleased {
    pub job_id: String,
    pub worker: Pubkey,
    pub worker_payment: u64,
    pub platform_fee: u64,
}

#[event]
pub struct FundsRefunded {
    pub job_id: String,
    pub poster: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EscrowExpired {
    pub job_id: String,
    pub poster: Pubkey,
    pub amount: u64,
}

#[event]
pub struct DisputeInitiated {
    pub job_id: String,
    pub initiated_by: Pubkey,
}

#[event]
pub struct EscrowCancelled {
    pub job_id: String,
    pub poster: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EscrowClosed {
    pub job_id: String,
}

#[event]
pub struct WorkSubmitted {
    pub job_id: String,
    pub worker: Pubkey,
    pub proof_hash: Option<[u8; 32]>,
    pub review_deadline: i64,
}

#[event]
pub struct WorkApproved {
    pub job_id: String,
    pub worker: Pubkey,
    pub worker_payment: u64,
    pub platform_fee: u64,
    pub approved_by: Pubkey,
}

#[event]
pub struct WorkAutoReleased {
    pub job_id: String,
    pub worker: Pubkey,
    pub worker_payment: u64,
    pub platform_fee: u64,
    pub triggered_by: Pubkey,
}

#[event]
pub struct ReputationInitialized {
    pub agent: Pubkey,
}

#[event]
pub struct FundsReleasedWithReputation {
    pub job_id: String,
    pub worker: Pubkey,
    pub worker_payment: u64,
    pub platform_fee: u64,
    pub worker_new_score: i64,
    pub poster_new_score: i64,
}

#[event]
pub struct ArbitratorPoolInitialized {
    pub authority: Pubkey,
}

#[event]
pub struct ArbitratorRegistered {
    pub agent: Pubkey,
    pub stake: u64,
}

#[event]
pub struct ArbitratorUnregistered {
    pub agent: Pubkey,
    pub stake_returned: u64,
}

#[event]
pub struct DisputeCaseRaised {
    pub escrow: Pubkey,
    pub raised_by: Pubkey,
    pub arbitrators: [Pubkey; 5],
    pub voting_deadline: i64,
    pub reason: String,
}

#[event]
pub struct ArbitrationVoteCast {
    pub dispute_case: Pubkey,
    pub arbitrator: Pubkey,
    pub vote: Vote,
}

#[event]
pub struct DisputeCaseFinalized {
    pub dispute_case: Pubkey,
    pub resolution: DisputeResolution,
    pub votes_for_worker: u8,
    pub votes_for_poster: u8,
}

#[event]
pub struct DisputeResolutionExecuted {
    pub escrow: Pubkey,
    pub resolution: DisputeResolution,
    pub amount: u64,
    pub worker_new_score: i64,
    pub poster_new_score: i64,
}

#[event]
pub struct ArbitratorAccuracyUpdated {
    pub arbitrator: Pubkey,
    pub dispute_case: Pubkey,
    pub voted_correctly: bool,
    pub cases_correct: u64,
    pub cases_voted: u64,
}

#[event]
pub struct DisputeCaseClosed {
    pub dispute_case: Pubkey,
    pub escrow: Pubkey,
    pub rent_returned_to: Pubkey,
}

#[event]
pub struct ArbitratorAccountClosed {
    pub agent: Pubkey,
    pub rent_returned: u64,
}

#[event]
pub struct ExpiredArbitrationClaimed {
    pub job_id: String,
    pub poster: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ArbitratorRemoved {
    pub agent: Pubkey,
    pub removed_by: Pubkey,
    pub stake_returned: u64,
}

// ============== ERRORS ==============

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than 0")]
    InvalidAmount,
    #[msg("Job ID too long (max 64 chars)")]
    JobIdTooLong,
    #[msg("Invalid expiry duration")]
    InvalidExpiry,
    #[msg("Escrow is not active")]
    EscrowNotActive,
    #[msg("Worker already assigned to this escrow")]
    WorkerAlreadyAssigned,
    #[msg("No worker assigned to this escrow")]
    NoWorkerAssigned,
    #[msg("Worker address does not match escrow")]
    WorkerMismatch,
    #[msg("Poster address does not match escrow")]
    PosterMismatch,
    #[msg("Only platform authority can perform this action")]
    NotPlatformAuthority,
    #[msg("Unauthorized to perform this action")]
    Unauthorized,
    #[msg("Refund not allowed in current state")]
    RefundNotAllowed,
    #[msg("Dispute timelock has not passed (24h required)")]
    TimelockNotPassed,
    #[msg("No dispute timestamp recorded")]
    NoDisputeTime,
    #[msg("Escrow has not expired yet")]
    NotExpired,
    #[msg("Cannot close escrow in current state")]
    CannotClose,
    #[msg("Insufficient funds in escrow")]
    InsufficientFunds,
    #[msg("Escrow is not in pending review state")]
    NotPendingReview,
    #[msg("No submission timestamp recorded")]
    NoSubmissionTime,
    #[msg("Review window has not expired yet (24h required)")]
    ReviewWindowNotExpired,
    // Phase 3 errors
    #[msg("Arbitrator pool is full (max 100)")]
    ArbitratorPoolFull,
    #[msg("Already registered as arbitrator")]
    AlreadyArbitrator,
    #[msg("Arbitrator is not active")]
    ArbitratorNotActive,
    #[msg("Not enough arbitrators in pool (need 5)")]
    NotEnoughArbitrators,
    #[msg("Reason too long (max 500 chars)")]
    ReasonTooLong,
    #[msg("Not selected as arbitrator for this case")]
    NotSelectedArbitrator,
    #[msg("Already voted on this dispute")]
    AlreadyVoted,
    #[msg("Dispute already resolved")]
    DisputeAlreadyResolved,
    #[msg("Voting deadline has passed")]
    VotingDeadlinePassed,
    #[msg("Voting not complete (no majority and deadline not passed)")]
    VotingNotComplete,
    #[msg("Dispute not yet resolved")]
    DisputeNotResolved,
    #[msg("Escrow mismatch")]
    EscrowMismatch,
    #[msg("Invalid status for execution")]
    InvalidStatusForExecution,
    #[msg("Job ID hash does not match provided job ID")]
    HashMismatch,
    #[msg("Arbitrator did not vote on this dispute")]
    ArbitratorDidNotVote,
    #[msg("Dispute has not been executed yet")]
    DisputeNotExecuted,
    #[msg("Arbitrator is still active - unregister first")]
    ArbitratorStillActive,
    #[msg("Arbitrator is still in the pool")]
    ArbitratorStillInPool,
    #[msg("Amount too low (minimum 0.01 SOL)")]
    AmountTooLow,
    #[msg("Escrow is not in arbitration")]
    NotInArbitration,
    #[msg("Arbitration grace period has not passed (48h after expiry)")]
    ArbitrationGracePeriodNotPassed,
}
