/**
 * A little-endian, growable byte sink - the TypeScript mirror of the Java {@code BinaryInput}'s
 * write-side counterpart and Python's own {@code Writer} in {@code bbmodel_to_strutmodel.py}
 * <p>
 * No Blockbench globals anywhere in this file (see {@code docs/BINARY_CODEC_PLAN.md} §4) - it is
 * exercised directly by jest, with the live Blockbench adapter built on top of it elsewhere
 */
export class BinaryWriter {
    private buffer: ArrayBuffer;
    private view: DataView;
    private length = 0;

    constructor(initialCapacity = 256) {
        this.buffer = new ArrayBuffer(Math.max(initialCapacity, 1));
        this.view = new DataView(this.buffer);
    }

    private ensureCapacity(additional: number): void {
        const required = this.length + additional;

        if (required <= this.buffer.byteLength)
            return;

        let capacity = this.buffer.byteLength * 2;

        while (capacity < required) {
            capacity *= 2;
        }

        const grown = new ArrayBuffer(capacity);

        new Uint8Array(grown).set(new Uint8Array(this.buffer, 0, this.length));
        this.buffer = grown;
        this.view = new DataView(this.buffer);
    }

    u8(value: number): this {
        this.ensureCapacity(1);
        this.view.setUint8(this.length, value & 0xFF);
        this.length += 1;

        return this;
    }

    u16(value: number): this {
        this.ensureCapacity(2);
        this.view.setUint16(this.length, value & 0xFFFF, true);
        this.length += 2;

        return this;
    }

    /**
     * A signed 16-bit value, used wherever {@code -1} means "no parent" or "no armature" -
     * written the same way {@link BinaryInput#i16} reads it, as the bit pattern of a uint16
     */
    i16(value: number): this {
        this.ensureCapacity(2);
        this.view.setInt16(this.length, value, true);
        this.length += 2;

        return this;
    }

    u32(value: number): this {
        this.ensureCapacity(4);
        this.view.setUint32(this.length, value >>> 0, true);
        this.length += 4;

        return this;
    }

    /**
     * Four raw bytes as a signed 32-bit value, for values where every bit pattern is meaningful
     * (the skeleton fingerprint) - the write-side mirror of {@code BinaryInput#bits32}
     */
    i32(value: number): this {
        this.ensureCapacity(4);
        this.view.setInt32(this.length, value, true);
        this.length += 4;

        return this;
    }

    f32(value: number): this {
        this.ensureCapacity(4);
        this.view.setFloat32(this.length, value, true);
        this.length += 4;

        return this;
    }

    vec3(x: number, y: number, z: number): this {
        return this.f32(x).f32(y).f32(z);
    }

    /**
     * A uint16-length-prefixed UTF-8 string, the shape every string-table entry takes
     */
    string(value: string): this {
        const encoded = new TextEncoder().encode(value);

        if (encoded.length > 0xFFFF)
            throw new Error(`string too long for a uint16 length prefix: ${value.slice(0, 40)}...`);

        this.u16(encoded.length);

        return this.bytes(encoded);
    }

    /**
     * A fixed-width run of raw bytes, with no length prefix - used for the four-byte magic number
     */
    fixedString(value: string): this {
        return this.bytes(new TextEncoder().encode(value));
    }

    bytes(value: Uint8Array): this {
        this.ensureCapacity(value.length);
        new Uint8Array(this.buffer, this.length, value.length).set(value);
        this.length += value.length;

        return this;
    }

    /**
     * Append another writer's bytes wholesale - how the format's per-block writers are stitched
     * into one file
     */
    append(other: BinaryWriter): this {
        return this.bytes(other.toBytes());
    }

    /**
     * Reserve {@code count} zero bytes, typically a header's reserved tail
     * <p>
     * No explicit zero-fill needed: {@code ArrayBuffer} is zero-initialized on creation, and
     * {@link ensureCapacity} only ever copies exactly {@code this.length} live bytes into a fresh
     * (zero-initialized) buffer when growing, so everything past the current length is always
     * pristine zero until something actually writes there
     */
    zeros(count: number): this {
        this.ensureCapacity(count);
        this.length += count;

        return this;
    }

    get byteLength(): number {
        return this.length;
    }

    toBytes(): Uint8Array {
        return new Uint8Array(this.buffer, 0, this.length);
    }
}

/**
 * Interns strings in first-use order, which is the order the table is written in - matching
 * Python's {@code Strings} class exactly
 * <p>
 * This is not merely an encoding detail: traversal order becomes part of the output bytes, which
 * is what makes {@code docs/BINARY_CODEC_PLAN.md} §5's round-trip gate a meaningful test rather
 * than a tautology
 */
export class StringTable {
    private readonly indices = new Map<string, number>();

    intern(value: string): number {
        const existing = this.indices.get(value);

        if (existing !== undefined)
            return existing;

        const index = this.indices.size;

        this.indices.set(value, index);

        return index;
    }

    get size(): number {
        return this.indices.size;
    }

    /**
     * The interned strings in first-use order - what a {@code RawBinaryModel}/
     * {@code RawBinaryAnimation}'s own {@code strings} field must be, since every other field's
     * string indices were assigned against exactly this order
     */
    entries(): string[] {
        return Array.from(this.indices.keys());
    }

    write(): BinaryWriter {
        const out = new BinaryWriter();

        for (const value of this.indices.keys()) {
            out.string(value);
        }

        return out;
    }
}
