# 🔬 One breath, byte by byte

*A tiny tour of what WatchAir actually writes to the SD card. This is the whole format — there is
no other magic.*

Here are the first 78 bytes of a recording: the 30-byte header, then 8 samples (320 ms of a slow
inhale).

```
00000000  57 41 49 52 03 3f 2b 9c 14 7a 6d 4e 21 9b 08 5c  |WAIR.?+..zmN!..\|
00000010  7d 1e 4a 6f 30 19 00 a6 40 7f 98 01 00 00 00 00  |}.Jo0...@.......|
00000020  00 00 00 00 28 00 00 00 0b 00 50 00 00 00 16 00  |....(.....P.....|
00000030  78 00 00 00 21 00 a0 00 00 00 2c 00 c8 00 00 00  |x...!.....,.....|
00000040  37 00 f0 00 00 00 42 00 18 01 00 00 4c 00        |7.....B.....L.|
```

## The header — 30 bytes, written once

```
57 41 49 52                          magic       "WAIR"
03                                   version     3
3f 2b 9c 14 … 5c 7d 1e 4a 6f 30      uuid        3f2b9c14-7a6d-4e21-9b08-5c7d1e4a6f30
19                                   hz          25
00 a6 40 7f 98 01 00 00              started     1754481600000 → 2025-08-06 12:00:00 UTC
```

That last field is the whole point. It is **milliseconds, not seconds** — truncating would leave up
to 999 ms of skew between the origin the header claims and the origin the samples are stamped
against. It names the recording, it fills `started_at` in Postgres, and the server never replaces it
with a `datetime.now()`. The file is the authority.

## The records — 6 bytes each, forever

```
        t_ms (u32 LE)   p_centiPa (i16 LE)
        ─────────────   ──────────────────
  #0    00 00 00 00  →      0 ms      00 00  →     0    ·  0.00 Pa
  #1    28 00 00 00  →     40 ms      0b 00  →    11    ·  0.11 Pa
  #2    50 00 00 00  →     80 ms      16 00  →    22    ·  0.22 Pa
  #3    78 00 00 00  →    120 ms      21 00  →    33    ·  0.33 Pa
  #4    a0 00 00 00  →    160 ms      2c 00  →    44    ·  0.44 Pa
  #5    c8 00 00 00  →    200 ms      37 00  →    55    ·  0.55 Pa
  #6    f0 00 00 00  →    240 ms      42 00  →    66    ·  0.66 Pa
  #7    18 01 00 00  →    280 ms      4c 00  →    76    ·  0.76 Pa
```

Forty milliseconds apart, exactly, because the sampler schedules from its previous wake-up instead
of from "now". Pressure is `int16` centipascals: 0.01 Pa of resolution across ±327 Pa, comfortably
more range than a breath through a cannula ever produces.

## Three things that fall out of this for free

**A power cut is visible, not invisible.** Nothing marks the outage. Sample *n* says `t_ms = 92_040`
and sample *n+1* says `t_ms = 431_600`, and the chart draws a break in the line rather than a
straight segment politely interpolating over six missing minutes.

**A truncated tail is a one-liner.** A file killed mid-flush ends in garbage, so the server simply
refuses to look at it: `n = (len − 30) // 6`. The ESP32 also truncates before resuming — belt and
braces, because the server rule has to cover files the board never got to clean up.

**Nothing re-encodes it.** These exact bytes sit on the SD card, travel in the HTTP body, and land
in Supabase Storage. The browser is the first thing that ever turns them back into numbers.

## The receipts

12 hours at 25 Hz is 1,080,000 samples.

|  | as JSON | as this |
|:--|--:|--:|
| on the card | ~40 MB | **6.5 MB** |
| in the hot path | a serializer | a `memcpy` |
| to parse | a tokenizer | `offset += 6` |

And the write buffer is 85 records — because 85 × 6 = 510 bytes, which is as close to one 512-byte
card block as you can get without going over. 🎯
