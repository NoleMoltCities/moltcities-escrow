//! Instruction handlers for the Job Escrow program
//!
//! Each instruction is implemented as a struct with TryFrom for account parsing
//! and a process() method for execution.

mod create_escrow;
mod assign_worker;
mod submit_work;
mod release;
mod dispute;
mod arbitrator;
mod reputation;
mod close;

pub use create_escrow::*;
pub use assign_worker::*;
pub use submit_work::*;
pub use release::*;
pub use dispute::*;
pub use arbitrator::*;
pub use reputation::*;
pub use close::*;

/// Instruction discriminators (single byte for efficiency)
#[repr(u8)]
pub enum Instruction {
    /// Create a new escrow
    CreateEscrow = 0,
    /// Assign a worker to the escrow
    AssignWorker = 1,
    /// Worker submits completed work
    SubmitWork = 2,
    /// Release funds to worker (platform only)
    ReleaseToWorker = 3,
    /// Poster approves work
    ApproveWork = 4,
    /// Auto-release after review window
    AutoRelease = 5,
    /// Initiate dispute
    InitiateDispute = 6,
    /// Refund to poster (platform only)
    RefundToPoster = 7,
    /// Claim expired escrow
    ClaimExpired = 8,
    /// Cancel escrow before worker assigned
    CancelEscrow = 9,
    /// Close escrow account
    CloseEscrow = 10,
    /// Initialize reputation account
    InitReputation = 11,
    /// Release with reputation update
    ReleaseWithReputation = 12,
    /// Initialize arbitrator pool
    InitArbitratorPool = 13,
    /// Register as arbitrator
    RegisterArbitrator = 14,
    /// Unregister as arbitrator
    UnregisterArbitrator = 15,
    /// Raise a dispute case
    RaiseDisputeCase = 16,
    /// Cast arbitration vote
    CastArbitrationVote = 17,
    /// Finalize dispute case
    FinalizeDisputeCase = 18,
    /// Execute dispute resolution
    ExecuteDisputeResolution = 19,
    /// Update arbitrator accuracy
    UpdateArbitratorAccuracy = 20,
    /// Claim expired arbitration
    ClaimExpiredArbitration = 21,
    /// Remove arbitrator (platform only)
    RemoveArbitrator = 22,
    /// Close dispute case
    CloseDisputeCase = 23,
    /// Close arbitrator account
    CloseArbitratorAccount = 24,
}
