import { BinaryWriter, StringTable } from '../ts/binary/writer';
import { BinaryReader, BinaryFormatError } from '../ts/binary/reader';

describe('BinaryWriter / BinaryReader round trip', () => {
  it('round-trips every primitive', () => {
    const out = new BinaryWriter(4) // deliberately tiny, to exercise growth
      .u8(255)
      .u16(65535)
      .i16(-1)
      .u32(2000000000)
      .i32(-200221733)
      .f32(1.5)
      .vec3(-1, 0, 2.25)
      .fixedString('STMD')
      .string('hello world');

    const bytes = out.toBytes();
    const reader = new BinaryReader(bytes, 'test');

    expect(reader.u8('a')).toEqual(255);
    expect(reader.u16('b')).toEqual(65535);
    expect(reader.i16('c')).toEqual(-1);
    expect(reader.u32('d')).toEqual(2000000000);
    expect(reader.i32('e')).toEqual(-200221733);
    expect(reader.f32('f')).toEqual(1.5);
    expect(reader.vec3('g')).toEqual([-1, 0, 2.25]);
    expect(reader.fixedString(4, 'h')).toEqual('STMD');
    expect(reader.string('i')).toEqual('hello world');
    expect(reader.remaining()).toEqual(0);
  });

  it('growth does not corrupt already-written bytes', () => {
    const out = new BinaryWriter(1);

    for (let i = 0; i < 500; i++) {
      out.u8(i % 256);
    }

    const bytes = out.toBytes();

    expect(bytes.length).toEqual(500);

    for (let i = 0; i < 500; i++) {
      expect(bytes[i]).toEqual(i % 256);
    }
  });

  it('zeros() reserves genuinely zero bytes across a buffer growth', () => {
    const out = new BinaryWriter(2);

    out.u8(0xFF).zeros(20).u8(0xEE);

    const bytes = out.toBytes();

    expect(bytes[0]).toEqual(0xFF);
    expect(bytes[21]).toEqual(0xEE);

    for (let i = 1; i <= 20; i++) {
      expect(bytes[i]).toEqual(0);
    }
  });

  it('toBytes() can carry a larger backing buffer than its own byteLength after growth - a trap for any caller reaching for .buffer directly', () => {
    // Regression test for exportBinaryModel's own fix: a caller that does
    // `bytes.buffer` instead of `bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset +
    // bytes.byteLength)` would silently include a grown-but-unused tail in an exported file
    const out = new BinaryWriter(1);

    out.u8(1).u8(2).u8(3);

    const bytes = out.toBytes();

    expect(bytes.byteLength).toEqual(3);
    expect(bytes.buffer.byteLength).toBeGreaterThan(3);

    const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    expect(exact.byteLength).toEqual(3);
    expect(Array.from(new Uint8Array(exact))).toEqual([1, 2, 3]);
  });

  it('vec3Array reads flat, matching what vec3 wrote sequentially', () => {
    const out = new BinaryWriter().vec3(1, 2, 3).vec3(4, 5, 6);
    const reader = new BinaryReader(out.toBytes(), 'test');

    expect(reader.vec3Array(2, 'vertices')).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a UTF-8 string with multi-byte characters round-trips by byte length, not char length', () => {
    const value = 'strut:entity/ライト';
    const out = new BinaryWriter().string(value);
    const reader = new BinaryReader(out.toBytes(), 'test');

    expect(reader.string('name')).toEqual(value);
  });

  it('a string over the uint16 length limit is rejected at write time', () => {
    const huge = 'x'.repeat(0x10000);

    expect(() => new BinaryWriter().string(huge)).toThrow(/too long/);
  });

  it('reading past the end throws, naming the file and the field', () => {
    const reader = new BinaryReader(new Uint8Array([1, 2]), 'broken.strutmodel');

    expect(() => reader.u32('bone count')).toThrow(BinaryFormatError);
    expect(() => reader.u32('bone count')).toThrow(/broken\.strutmodel/);
    expect(() => reader.u32('bone count')).toThrow(/bone count/);
  });

  it('u32 rejects a value that is not a plausible count or size', () => {
    // 0xFFFFFFFF as an unsigned 32-bit value - not a real count, and larger than a safe integer
    // boundary the format should ever legitimately need
    const out = new BinaryWriter().u32(0xFFFFFFFF);
    const reader = new BinaryReader(out.toBytes(), 'test');

    expect(() => reader.u32('count')).toThrow(/not a plausible count/);
  });

  it('plausibleCount rejects a count needing more bytes than remain', () => {
    const reader = new BinaryReader(new Uint8Array(10), 'test');

    expect(() => reader.plausibleCount(1000, 12, 'vertices')).toThrow(/truncated or the count is corrupt/);
  });

  it('plausibleCount rejects a negative count', () => {
    const reader = new BinaryReader(new Uint8Array(10), 'test');

    expect(() => reader.plausibleCount(-1, 1, 'things')).toThrow(/negative number/);
  });
});

describe('StringTable', () => {
  it('interns in first-use order and reuses an index for a repeated string', () => {
    const table = new StringTable();

    expect(table.intern('a')).toEqual(0);
    expect(table.intern('b')).toEqual(1);
    expect(table.intern('a')).toEqual(0);
    expect(table.size).toEqual(2);
  });

  it('writes entries in first-use order, readable back as the same sequence', () => {
    const table = new StringTable();

    table.intern('zebra');
    table.intern('apple');
    table.intern('zebra');
    table.intern('mango');

    const reader = new BinaryReader(table.write().toBytes(), 'test');

    expect(reader.string('0')).toEqual('zebra');
    expect(reader.string('1')).toEqual('apple');
    expect(reader.string('2')).toEqual('mango');
    expect(reader.remaining()).toEqual(0);
  });
});
