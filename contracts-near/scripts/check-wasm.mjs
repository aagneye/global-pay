// Checks that contract wasm files use only what the NEAR runtime accepts: WebAssembly MVP
// plus sign-extension ops. Refuses multi-value, reference types (including the padded
// call_indirect table index), bulk memory, non-trapping float-to-int, SIMD and tail calls.
//
//   node scripts/check-wasm.mjs res/settlement.wasm res/test_usdc.wasm

import { readFileSync } from 'node:fs';

function check(file) {
  const bytes = readFileSync(file);
  const problems = new Set();
  let pos = 0;
  let signExt = 0;

  const byte = () => bytes[pos++];
  const u32 = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = byte();
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) return result;
    }
  };
  const sleb = () => {
    // Only skipped, never used.
    while (byte() & 0x80);
  };
  const skip = (n) => {
    pos += n;
  };
  const constExpr = () => {
    for (;;) {
      const op = byte();
      if (op === 0x0b) return;
      if (op === 0x41 || op === 0x42) sleb();
      else if (op === 0x23) u32();
      else if (op === 0x43) skip(4);
      else if (op === 0x44) skip(8);
      else {
        problems.add(`const expr opcode 0x${op.toString(16)}`);
        return;
      }
    }
  };

  const VALTYPES = new Set([0x7f, 0x7e, 0x7d, 0x7c]);
  const blockType = () => {
    const b = bytes[pos];
    if (b === 0x40 || VALTYPES.has(b)) return skip(1);
    problems.add('multi-value block type');
    sleb();
  };

  const code = (end) => {
    while (pos < end) {
      const op = byte();
      if (op <= 0x01 || op === 0x05 || op === 0x0b || op === 0x0f || op === 0x1a || op === 0x1b) continue;
      if (op >= 0x02 && op <= 0x04) blockType();
      else if (op === 0x0c || op === 0x0d || op === 0x10) u32();
      else if (op === 0x0e) {
        const n = u32();
        for (let i = 0; i <= n; i++) u32();
      } else if (op === 0x11) {
        u32();
        if (byte() !== 0x00) problems.add('call_indirect with a non-MVP table index (reference types)');
      } else if (op === 0x12 || op === 0x13) {
        problems.add('tail calls');
        u32();
      } else if (op === 0x1c) {
        problems.add('typed select (reference types)');
        const n = u32();
        skip(n);
      } else if (op >= 0x20 && op <= 0x24) u32();
      else if (op === 0x25 || op === 0x26) {
        problems.add('table.get/set (reference types)');
        u32();
      } else if (op >= 0x28 && op <= 0x3e) {
        u32();
        u32();
      } else if (op === 0x3f || op === 0x40) skip(1);
      else if (op === 0x41 || op === 0x42) sleb();
      else if (op === 0x43) skip(4);
      else if (op === 0x44) skip(8);
      else if (op >= 0x45 && op <= 0xbf) continue;
      else if (op >= 0xc0 && op <= 0xc4) signExt++;
      else if (op >= 0xd0 && op <= 0xd2) {
        problems.add('ref.* (reference types)');
        if (op === 0xd0) skip(1);
        if (op === 0xd2) u32();
      } else if (op === 0xfc) {
        const sub = u32();
        if (sub <= 7) problems.add('non-trapping float-to-int');
        else problems.add(`bulk memory / table op 0xfc ${sub}`);
        if (sub === 8 || sub === 12 || sub === 14) {
          u32();
          u32();
        } else if (sub === 10) skip(2);
        else if (sub === 11) skip(1);
        else if (sub > 7) u32();
      } else {
        problems.add(`opcode 0x${op.toString(16)} (SIMD or unknown)`);
        return;
      }
    }
  };

  if (bytes.readUInt32LE(0) !== 0x6d736100 || bytes.readUInt32LE(4) !== 1) throw new Error(`${file}: not a wasm module`);
  pos = 8;
  while (pos < bytes.length) {
    const id = byte();
    const size = u32();
    const end = pos + size;
    if (id === 1) {
      const n = u32();
      for (let i = 0; i < n; i++) {
        byte(); // 0x60
        skip(u32()); // parameter types
        const results = u32();
        if (results > 1) problems.add('function type with several results (multi-value)');
        skip(results);
      }
      pos = end;
    } else if (id === 4) {
      if (u32() > 1) problems.add('several tables (reference types)');
      pos = end;
    } else if (id === 9) {
      const n = u32();
      for (let i = 0; i < n; i++) {
        const flags = u32();
        if (flags !== 0) {
          problems.add(`element segment flags ${flags} (bulk memory / reference types)`);
          break;
        }
        constExpr();
        const count = u32();
        for (let j = 0; j < count; j++) u32();
      }
      pos = end;
    } else if (id === 10) {
      const n = u32();
      for (let i = 0; i < n; i++) {
        const bodySize = u32();
        const bodyEnd = pos + bodySize;
        const groups = u32();
        for (let g = 0; g < groups; g++) {
          u32();
          skip(1);
        }
        code(bodyEnd);
        pos = bodyEnd;
      }
    } else if (id === 11) {
      const n = u32();
      for (let i = 0; i < n; i++) {
        const flags = u32();
        if (flags !== 0) {
          problems.add(`passive data segment (bulk memory)`);
          break;
        }
        constExpr();
        skip(u32());
      }
      pos = end;
    } else if (id === 12) {
      problems.add('data count section (bulk memory)');
      pos = end;
    } else {
      pos = end;
    }
  }
  return { problems: [...problems], signExt, size: bytes.length };
}

let failed = false;
for (const file of process.argv.slice(2)) {
  const { problems, signExt, size } = check(file);
  if (problems.length) {
    failed = true;
    console.log(`FAIL ${file} (${size} bytes): ${problems.join('; ')}`);
  } else {
    console.log(`ok   ${file} (${size} bytes): MVP${signExt ? ` + ${signExt} sign-ext ops` : ''}`);
  }
}
process.exit(failed ? 1 : 0);
