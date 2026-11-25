//! Reproduce gzip size tradeoffs with synthetic text only.
use flate2::{Compression, write::GzEncoder};
use sha2::{Digest, Sha256};
use std::io::Write;
fn main() {
    let text: String = (0..7000)
        .map(|i| {
            format!(
                "## Synthetic section {i}\n\nRead-only example {}\n\n",
                hex::encode(Sha256::digest(i.to_string().as_bytes()))
            )
        })
        .collect();
    let bytes = &text.as_bytes()[..641620];
    for level in 1..=6 {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(level));
        encoder.write_all(bytes).unwrap();
        println!(
            "level={level} compressed_bytes={}",
            encoder.finish().unwrap().len()
        );
    }
}
