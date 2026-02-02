//! JobEscrow account state
//!
//! The main escrow account that holds funds for a job.

use pinocchio::{program_error::ProgramError, pubkey::Pubkey};
use core::mem::size_of;
use crate::errors::EscrowError;

/// Escrow status values
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum EscrowStatus {
    Active = 0,
    Released = 1,
    Refunded = 2,
    Expired = 3,
    Disputed = 4,
    Cancelled = 5,
    PendingReview = 6,
    InArbitration = 7,
    DisputeWorkerWins = 8,
    DisputePosterWins = 9,
    DisputeSplit = 10,
}

impl EscrowStatus {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Active),
            1 => Some(Self::Released),
            2 => Some(Self::Refunded),
            3 => Some(Self::Expired),
            4 => Some(Self::Disputed),
            5 => Some(Self::Cancelled),
            6 => Some(Self::PendingReview),
            7 => Some(Self::InArbitration),
            8 => Some(Self::DisputeWorkerWins),
            9 => Some(Self::DisputePosterWins),
            10 => Some(Self::DisputeSplit),
            _ => None,
        }
    }
}

/// Main escrow account
/// 
/// Seeds: ["escrow", job_id_hash, poster]
#[repr(C)]
pub struct JobEscrow {
    /// SHA256 hash of the job_id for PDA derivation
    pub job_id_hash: [u8; 32],
    /// The poster (job creator) who deposited funds
    pub poster: Pubkey,
    /// The assigned worker (default = Pubkey::default() when unassigned)
    pub worker: Pubkey,
    /// Amount of lamports in escrow
    pub amount: u64,
    /// Current status of the escrow
    pub status: u8,
    /// Unix timestamp when escrow was created
    pub created_at: i64,
    /// Unix timestamp when escrow expires
    pub expires_at: i64,
    /// Unix timestamp when dispute was initiated (0 = none)
    pub dispute_initiated_at: i64,
    /// Unix timestamp when work was submitted (0 = none)
    pub submitted_at: i64,
    /// Optional proof hash from worker submission (32 bytes, zeroed if none)
    pub proof_hash: [u8; 32],
    /// Has proof hash been set?
    pub has_proof_hash: u8,
    /// Associated dispute case PDA (zeroed if none)
    pub dispute_case: Pubkey,
    /// Has dispute case been set?
    pub has_dispute_case: u8,
    /// PDA bump seed
    pub bump: u8,
    /// Padding for alignment
    pub _padding: [u8; 5],
}

impl JobEscrow {
    /// Account discriminator (first 8 bytes of SHA256("account:JobEscrow"))
    pub const DISCRIMINATOR: [u8; 8] = [0x4a, 0x6f, 0x62, 0x45, 0x73, 0x63, 0x72, 0x6f]; // "JobEscro"
    
    /// Size of the account data (without discriminator)
    pub const LEN: usize = size_of::<Self>();
    
    /// Total size including 8-byte discriminator
    pub const SPACE: usize = 8 + Self::LEN;
    
    /// Default Pubkey for comparison (all zeros)
    pub const DEFAULT_PUBKEY: Pubkey = [0u8; 32];

    /// Load from account data (validates discriminator and length)
    #[inline(always)]
    pub fn load(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::SPACE {
            return Err(EscrowError::InvalidAccountData.into());
        }
        // Verify discriminator
        if data[..8] != Self::DISCRIMINATOR {
            return Err(EscrowError::AccountNotInitialized.into());
        }
        Ok(unsafe { &*(data[8..].as_ptr() as *const Self) })
    }

    /// Load mutable reference from account data
    #[inline(always)]
    pub fn load_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::SPACE {
            return Err(EscrowError::InvalidAccountData.into());
        }
        // Verify discriminator
        if data[..8] != Self::DISCRIMINATOR {
            return Err(EscrowError::AccountNotInitialized.into());
        }
        Ok(unsafe { &mut *(data[8..].as_mut_ptr() as *mut Self) })
    }

    /// Initialize account data with discriminator
    #[inline(always)]
    pub fn init(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::SPACE {
            return Err(EscrowError::InvalidAccountData.into());
        }
        // Check not already initialized
        if data[..8] == Self::DISCRIMINATOR {
            return Err(EscrowError::AccountAlreadyInitialized.into());
        }
        // Write discriminator
        data[..8].copy_from_slice(&Self::DISCRIMINATOR);
        // Zero the rest
        data[8..Self::SPACE].fill(0);
        Ok(unsafe { &mut *(data[8..].as_mut_ptr() as *mut Self) })
    }

    /// Get the escrow status as enum
    #[inline(always)]
    pub fn get_status(&self) -> Option<EscrowStatus> {
        EscrowStatus::from_u8(self.status)
    }

    /// Check if worker is assigned
    #[inline(always)]
    pub fn has_worker(&self) -> bool {
        self.worker != Self::DEFAULT_PUBKEY
    }

    /// Check if escrow is in an active state
    #[inline(always)]
    pub fn is_active(&self) -> bool {
        self.status == EscrowStatus::Active as u8
    }

    /// Check if escrow is pending review
    #[inline(always)]
    pub fn is_pending_review(&self) -> bool {
        self.status == EscrowStatus::PendingReview as u8
    }

    /// Get dispute_initiated_at as Option
    #[inline(always)]
    pub fn get_dispute_initiated_at(&self) -> Option<i64> {
        if self.dispute_initiated_at == 0 {
            None
        } else {
            Some(self.dispute_initiated_at)
        }
    }

    /// Get submitted_at as Option
    #[inline(always)]
    pub fn get_submitted_at(&self) -> Option<i64> {
        if self.submitted_at == 0 {
            None
        } else {
            Some(self.submitted_at)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::mem::size_of;

    #[test]
    fn test_escrow_size() {
        // JobEscrow is #[repr(C)], so size_of gives the actual layout
        assert_eq!(JobEscrow::LEN, size_of::<JobEscrow>());
        // Total with discriminator
        assert_eq!(JobEscrow::SPACE, 8 + size_of::<JobEscrow>());
    }
}
