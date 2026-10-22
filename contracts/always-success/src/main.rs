#![no_std]
#![no_main]

//! Always-success script: a test stand-in for token type scripts and user locks
//! in the on-chain conservation tests. Returns 0 unconditionally.

use ckb_std::{default_alloc, entry};

entry!(program_entry);
default_alloc!();

fn program_entry() -> i8 {
    0
}
