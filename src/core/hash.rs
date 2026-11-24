//! Zig's `std.hash.Wyhash` algorithm, from the official source.
//! `Bun.hash` matches it with seed 0; the crates.io `wyhash` crate does not.

const SECRET: [u64; 4] = [
    0xa0761d6478bd642f,
    0xe7037ed1a0b428db,
    0x8ebc6af09c88c6e3,
    0x589965cc75374cc3,
];

fn read<const N: usize>(data: &[u8]) -> u64 {
    let mut bytes = [0u8; 8];
    bytes[..N].copy_from_slice(&data[..N]);
    u64::from_le_bytes(bytes)
}

fn mum(a: &mut u64, b: &mut u64) {
    let product = (*a as u128) * (*b as u128);
    *a = product as u64;
    *b = (product >> 64) as u64;
}

fn mix(a: u64, b: u64) -> u64 {
    let (mut x, mut y) = (a, b);
    mum(&mut x, &mut y);
    x ^ y
}

fn round(state: &mut [u64; 3], block: &[u8]) {
    for i in 0..3 {
        let a = read::<8>(&block[8 * (2 * i)..]);
        let b = read::<8>(&block[8 * (2 * i + 1)..]);
        state[i] = mix(a ^ SECRET[i + 1], b ^ state[i]);
    }
}

fn small_key(a: &mut u64, b: &mut u64, input: &[u8]) {
    if input.len() >= 4 {
        let end = input.len() - 4;
        let quarter = (input.len() >> 3) << 2;
        *a = (read::<4>(input) << 32) | read::<4>(&input[quarter..]);
        *b = (read::<4>(&input[end..]) << 32) | read::<4>(&input[end - quarter..]);
    } else if !input.is_empty() {
        *a = ((input[0] as u64) << 16)
            | ((input[input.len() >> 1] as u64) << 8)
            | input[input.len() - 1] as u64;
        *b = 0;
    } else {
        *a = 0;
        *b = 0;
    }
}

/// Wyhash with `seed`, matching `Zig std.hash.Wyhash.hash(seed, input)`.
pub fn hash(seed: u64, input: &[u8]) -> u64 {
    let initial = seed ^ mix(seed ^ SECRET[0], SECRET[1]);
    let mut state = [initial, initial, initial];
    let mut a = 0u64;
    let mut b = 0u64;

    if input.len() <= 16 {
        small_key(&mut a, &mut b, input);
    } else {
        let mut i = 0;
        if input.len() >= 48 {
            while i + 48 < input.len() {
                round(&mut state, &input[i..i + 48]);
                i += 48;
            }
            state[0] ^= state[1] ^ state[2];
        }
        // `final1`: 16-byte blocks, leaving the last 16 bytes unread here.
        while i + 16 < input.len() {
            state[0] = mix(
                read::<8>(&input[i..]) ^ SECRET[1],
                read::<8>(&input[i + 8..]) ^ state[0],
            );
            i += 16;
        }
        // Zig reads the final 16 bytes of the whole buffer; they may overlap
        // bytes already consumed when the remainder is shorter than 16.
        a = read::<8>(&input[input.len() - 16..]);
        b = read::<8>(&input[input.len() - 8..]);
    }

    a ^= SECRET[1];
    b ^= state[0];
    mum(&mut a, &mut b);
    mix(a ^ SECRET[0] ^ input.len() as u64, b ^ SECRET[1])
}

/// Markvi ETag: quoted lowercase hex without padding.
pub fn etag(content: &str) -> String {
    format!("\"{:x}\"", hash(0, content.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Official vectors: https://github.com/ziglang/zig/blob/master/lib/std/hash/wyhash.zig
    #[test]
    fn zig_vectors() {
        let vectors: [(u64, u64, &str); 7] = [
            (0, 0x409638ee2bde459, ""),
            (1, 0xa8412d091b5fe0a9, "a"),
            (2, 0x32dd92e4b2915153, "abc"),
            (3, 0x8619124089a3a16b, "message digest"),
            (4, 0x7a43afb61d7f5f40, "abcdefghijklmnopqrstuvwxyz"),
            (
                5,
                0xff42329b90e50d58,
                "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
            ),
            (
                6,
                0xc39cab13b115aad3,
                "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
            ),
        ];
        for (seed, want, input) in vectors {
            assert_eq!(hash(seed, input.as_bytes()), want, "seed {seed}, {input:?}");
        }
    }

    // Measured with Bun 1.4.4: Bun.hash === Bun.hash.wyhash.
    #[test]
    fn bun_seed_zero() {
        assert_eq!(hash(0, b""), 0x409638ee2bde459);
        assert_eq!(hash(0, b"a"), 0x28d2053309d28531);
        assert_eq!(hash(0, b"hello"), 0xe24bbd9f93f532d);
        assert_eq!(hash(0, b"index.md"), 0x655fa7476c11cd9e);
    }

    #[test]
    fn etag_shape() {
        assert_eq!(etag("hello"), "\"e24bbd9f93f532d\"");
    }
}
