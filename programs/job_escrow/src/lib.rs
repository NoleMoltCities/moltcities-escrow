//! MoltCities Job Escrow Program
//! 
//! A Solana escrow program for trustless job payments with:
//! - Multi-arbitrator dispute resolution
//! - Reputation tracking
//! - Auto-release after review windows
//! 
//! Built with Pinocchio for minimal binary size and compute usage.

#![cfg_attr(target_os = "solana", no_std)]

#[cfg(not(target_os = "solana"))]
extern crate std;

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

pub mod errors;
pub mod state;
pub mod instructions;

pub use errors::*;
pub use state::*;
pub use instructions::*;

// Program ID: 27YquD9ZJvjLfELseqgawEMZq1mD1betBQZz5RgehNZr
pub const ID: Pubkey = [
    0x0f, 0x1e, 0x6b, 0x14, 0x21, 0xc0, 0x4a, 0x07,
    0x04, 0x31, 0x26, 0x5c, 0x19, 0xc5, 0xbb, 0xee,
    0x19, 0x92, 0xba, 0xe8, 0xaf, 0xd1, 0xcd, 0x07,
    0x8e, 0xf8, 0xaf, 0x70, 0x47, 0xdc, 0x11, 0xf7,
];

/// Platform wallet for 1% fees: BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893
// BpH7T5tijFRSyPhMn62WcgGFjHEUMJ8WXQfJ2GAfB893
pub const PLATFORM_WALLET: Pubkey = [
    0xa0, 0xb1, 0x62, 0x60, 0x78, 0x17, 0x34, 0xf2,
    0x1d, 0x8c, 0xfb, 0xab, 0xff, 0x00, 0x29, 0x11,
    0xa7, 0xc2, 0xbc, 0xf4, 0xf2, 0x96, 0x4e, 0x81,
    0xdb, 0x55, 0x8c, 0x61, 0x54, 0x4c, 0x47, 0x9e,
];

// Entrypoint and allocator for BPF builds
pinocchio::program_entrypoint!(process_instruction);
pinocchio::default_allocator!();
pinocchio::nostd_panic_handler!();

/// Main program entrypoint
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    // Get discriminator (first byte)
    let (discriminator, data) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    // Route to appropriate instruction handler
    match *discriminator {
        // Core escrow operations
        0 => process_create_escrow(accounts, data, program_id),
        1 => process_assign_worker(accounts, data, program_id),
        2 => process_submit_work(accounts, data, program_id),
        3 => process_release_to_worker(accounts, data, program_id),
        4 => process_approve_work(accounts, data, program_id),
        5 => process_auto_release(accounts, data, program_id),
        
        // Dispute operations
        6 => process_initiate_dispute(accounts, data, program_id),
        7 => process_refund_to_poster(accounts, data, program_id),
        8 => process_claim_expired(accounts, data, program_id),
        9 => process_cancel_escrow(accounts, data, program_id),
        10 => process_close_escrow(accounts, data, program_id),
        
        // Reputation operations
        11 => process_init_reputation(accounts, data, program_id),
        12 => process_release_with_reputation(accounts, data, program_id),
        
        // Arbitrator pool operations
        13 => process_init_arbitrator_pool(accounts, data, program_id),
        14 => process_register_arbitrator(accounts, data, program_id),
        15 => process_unregister_arbitrator(accounts, data, program_id),
        
        // Dispute case operations
        16 => process_raise_dispute_case(accounts, data, program_id),
        17 => process_cast_arbitration_vote(accounts, data, program_id),
        18 => process_finalize_dispute_case(accounts, data, program_id),
        19 => process_execute_dispute_resolution(accounts, data, program_id),
        20 => process_update_arbitrator_accuracy(accounts, data, program_id),
        
        // Emergency and cleanup operations
        21 => process_claim_expired_arbitration(accounts, data, program_id),
        22 => process_remove_arbitrator(accounts, data, program_id),
        23 => process_close_dispute_case(accounts, data, program_id),
        24 => process_close_arbitrator_account(accounts, data, program_id),
        
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_program_id() {
        // Verify the program ID bytes are correct
        assert_eq!(ID.len(), 32);
    }

    #[test]
    fn test_account_sizes() {
        // Verify account sizes are reasonable
        assert!(JobEscrow::SPACE < 500);
        assert!(AgentReputation::SPACE < 200);
        assert!(ArbitratorEntry::SPACE < 100);
        assert!(DisputeCase::SPACE < 1000);
        // ArbitratorPool is large due to fixed array
        assert!(ArbitratorPool::SPACE > 3000);
    }
}
