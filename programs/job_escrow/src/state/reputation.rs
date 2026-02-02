//! AgentReputation account state
//!
//! Tracks an agent's job completion and dispute history.

use pinocchio::{program_error::ProgramError, pubkey::Pubkey};
use core::mem::size_of;
use crate::errors::EscrowError;

/// Agent reputation tracking account
///
/// Seeds: ["reputation", agent]
#[repr(C)]
pub struct AgentReputation {
    /// The agent this reputation belongs to
    pub agent: Pubkey,
    /// Number of jobs completed as worker
    pub jobs_completed: u64,
    /// Number of jobs posted as poster
    pub jobs_posted: u64,
    /// Total lamports earned as worker
    pub total_earned: u64,
    /// Total lamports spent as poster
    pub total_spent: u64,
    /// Number of disputes won
    pub disputes_won: u64,
    /// Number of disputes lost
    pub disputes_lost: u64,
    /// Calculated reputation score (can be negative)
    pub reputation_score: i64,
    /// Unix timestamp when reputation was initialized
    pub created_at: i64,
    /// PDA bump seed
    pub bump: u8,
    /// Padding for alignment
    pub _padding: [u8; 7],
}

impl AgentReputation {
    /// Account discriminator (first 8 bytes)
    pub const DISCRIMINATOR: [u8; 8] = [0x41, 0x67, 0x65, 0x6e, 0x74, 0x52, 0x65, 0x70]; // "AgentRep"
    
    /// Size of the account data (without discriminator)
    pub const LEN: usize = size_of::<Self>();
    
    /// Total size including 8-byte discriminator
    pub const SPACE: usize = 8 + Self::LEN;

    /// Load from account data
    #[inline(always)]
    pub fn load(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::SPACE {
            return Err(EscrowError::InvalidAccountData.into());
        }
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
        if data[..8] == Self::DISCRIMINATOR {
            return Err(EscrowError::AccountAlreadyInitialized.into());
        }
        data[..8].copy_from_slice(&Self::DISCRIMINATOR);
        data[8..Self::SPACE].fill(0);
        Ok(unsafe { &mut *(data[8..].as_mut_ptr() as *mut Self) })
    }

    /// Calculate reputation score based on activity
    /// Formula: (jobs_completed * 10) + (disputes_won * 5) - (disputes_lost * 10)
    /// SECURITY FIX H-05: Use saturating arithmetic to prevent overflow
    #[inline(always)]
    pub fn calculate_score(&self) -> i64 {
        // Use saturating_mul to prevent overflow
        let base = (self.jobs_completed as i64).saturating_mul(10);
        let dispute_bonus = (self.disputes_won as i64).saturating_mul(5);
        let dispute_penalty = (self.disputes_lost as i64).saturating_mul(10);
        
        // Use saturating arithmetic for the final calculation
        base.saturating_add(dispute_bonus).saturating_sub(dispute_penalty)
    }

    /// Update the reputation score field
    #[inline(always)]
    pub fn update_score(&mut self) {
        self.reputation_score = self.calculate_score();
    }
}
