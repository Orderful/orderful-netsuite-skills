#!/usr/bin/env node
// Copyright (c) 2026 Orderful, Inc.

// Compare two rendered packing slips by DECODED PIXEL DATA.
//
//   node compare-render.mjs <before.pdf> <after.pdf>
//
// Why not just diff the files: NetSuite PDFs are not byte-deterministic — the
// same template rendered twice differs across tens of thousands of bytes — and
// PNG files carry metadata that differs per conversion. Both produce false
// "changed" verdicts. Decoding the pixel stream is the only comparison that
// means anything.
//
// Run the control first: compare two renders of the SAME template. If that does
// not come back identical, the method is broken on this machine and a pass here
// proves nothing. macOS only (uses sips).

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const [before, after] = process.argv.slice(2);
if (!before || !after) {
  console.error('usage: compare-render.mjs <before.pdf> <after.pdf>');
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'packslip-'));

function pixelDigest(pdfPath, label) {
  const png = join(work, `${label}.png`);
  execFileSync('sips', ['-s', 'format', 'png', pdfPath, '--out', png], {
    stdio: 'ignore',
  });

  const data = readFileSync(png);
  if (data.subarray(0, 8).toString('binary') !== '\x89PNG\r\n\x1a\n') {
    throw new Error(`${pdfPath} did not rasterise to a PNG`);
  }

  let offset = 8;
  let idat = Buffer.alloc(0);
  let dimensions = null;

  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString('ascii');
    const chunk = data.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      dimensions = `${chunk.readUInt32BE(0)}x${chunk.readUInt32BE(4)}`;
    } else if (type === 'IDAT') {
      idat = Buffer.concat([idat, chunk]);
    }
    offset += 12 + length;
  }

  const raw = zlib.inflateSync(idat);
  return { dimensions, digest: crypto.createHash('sha256').update(raw).digest('hex') };
}

const a = pixelDigest(before, 'before');
const b = pixelDigest(after, 'after');
const identical = a.dimensions === b.dimensions && a.digest === b.digest;

console.log(`before: ${a.dimensions}  ${a.digest.slice(0, 16)}`);
console.log(`after:  ${b.dimensions}  ${b.digest.slice(0, 16)}`);
console.log(identical ? 'PIXEL-IDENTICAL' : 'PIXELS DIFFER');

// sips only rasterises the first page, so this proves page 1 only.
process.exit(identical ? 0 : 1);
