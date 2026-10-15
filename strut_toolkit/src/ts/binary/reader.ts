/**
 * A bounds-checked, little-endian read cursor over a complete file held in memory - the
 * TypeScript mirror of the Java {@code BinaryInput}
 * <p>
 * Errors by field name the same way {@code BinaryInput} does, so a truncated or corrupt file
 * names the file and the field rather than throwing a bare {@code RangeError}. No Blockbench
 * globals anywhere in this file (see {@code docs/BINARY_CODEC_PLAN.md} §4)
 */
export class BinaryFormatError extends Error {}

export class BinaryReader {
    private readonly bytes: Uint8Array;
    private readonly view: DataView;
    private readonly source: string;
    private cursor = 0;

    constructor(bytes: Uint8Array, source: string) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.source = source;
    }

    /** The number of bytes consumed so far */
    position(): number {
        return this.cursor;
    }

    /** The number of bytes left unread */
    remaining(): number {
        return this.bytes.length - this.cursor;
    }

    /**
     * Construct an exception naming this file and the problem with it
     *
     * @param problem The complaint, phrased to follow the file's name (e.g. `"is truncated"`)
     */
    fail(problem: string): BinaryFormatError {
        return new BinaryFormatError(`"${this.source}" ${problem}`);
    }

    private require(count: number, what: string): void {
        if (count < 0)
            throw this.fail(`asked for ${count} bytes reading ${what}`);

        if (this.remaining() < count)
            throw this.fail(`is truncated: reading ${what} at byte ${this.cursor} needs `
                + `${count} byte(s), but only ${this.remaining()} remain`);
    }

    /** Skip a run of bytes, typically a header's reserved tail */
    skip(count: number, what: string): void {
        this.require(count, what);
        this.cursor += count;
    }

    /** A run of raw bytes (a copy, so it outlives the file buffer), such as an extension section's payload */
    raw(count: number, what: string): Uint8Array {
        this.require(count, what);

        const value = this.bytes.slice(this.cursor, this.cursor + count);

        this.cursor += count;

        return value;
    }

    u8(what: string): number {
        this.require(1, what);

        const value = this.view.getUint8(this.cursor);

        this.cursor += 1;

        return value;
    }

    u16(what: string): number {
        this.require(2, what);

        const value = this.view.getUint16(this.cursor, true);

        this.cursor += 2;

        return value;
    }

    /** A signed 16-bit value, used wherever `-1` means "no parent" or "no armature" */
    i16(what: string): number {
        this.require(2, what);

        const value = this.view.getInt16(this.cursor, true);

        this.cursor += 2;

        return value;
    }

    /**
     * An unsigned 32-bit value, rejected if it exceeds what a JS number can hold exactly as an
     * integer - the mirror of Java's own rejection at {@code Integer.MAX_VALUE}, since nothing in
     * either format legitimately reaches billions of anything, and a value that large is a
     * corrupt count rather than a real one
     */
    u32(what: string): number {
        this.require(4, what);

        const value = this.view.getUint32(this.cursor, true);

        this.cursor += 4;

        if (value > 0x7FFFFFFF)
            throw this.fail(`declares ${what} as ${value}, which is not a plausible count or size`);

        return value;
    }

    /** Four raw bytes as a signed 32-bit value, for values where every bit pattern is meaningful */
    i32(what: string): number {
        this.require(4, what);

        const value = this.view.getInt32(this.cursor, true);

        this.cursor += 4;

        return value;
    }

    f32(what: string): number {
        this.require(4, what);

        const value = this.view.getFloat32(this.cursor, true);

        this.cursor += 4;

        return value;
    }

    vec3(what: string): [number, number, number] {
        return [this.f32(`${what} x`), this.f32(`${what} y`), this.f32(`${what} z`)];
    }

    /**
     * Read `count` consecutive vectors into a flat number array - flat rather than an array of
     * vectors, matching {@code BinaryInput#vec3Array}, since a mesh's vertex block is the largest
     * thing in any model file
     */
    vec3Array(count: number, what: string): number[] {
        this.require(count * 12, what);

        const values = new Array<number>(count * 3);

        for (let i = 0; i < values.length; i++) {
            values[i] = this.f32(what);
        }

        return values;
    }

    /** A fixed-width run of bytes as a string, used for the magic number */
    fixedString(length: number, what: string): string {
        this.require(length, what);

        const value = new TextDecoder('utf-8').decode(this.bytes.subarray(this.cursor, this.cursor + length));

        this.cursor += length;

        return value;
    }

    /** A uint16-length-prefixed UTF-8 string, the shape every string-table entry takes */
    string(what: string): string {
        const length = this.u16(`${what} length`);

        this.require(length, what);

        const value = new TextDecoder('utf-8').decode(this.bytes.subarray(this.cursor, this.cursor + length));

        this.cursor += length;

        return value;
    }

    /**
     * Reject a count that could not possibly be satisfied by the bytes that remain, checked
     * before the array it sizes is allocated - the mirror of {@code BinaryInput#plausibleCount}
     *
     * @param count The count just read
     * @param minimumBytesEach The smallest a single record of this kind can be
     * @param what What is being counted, for the error message
     */
    plausibleCount(count: number, minimumBytesEach: number, what: string): number {
        if (count < 0)
            throw this.fail(`declares a negative number of ${what} (${count})`);

        if (count * minimumBytesEach > this.remaining())
            throw this.fail(`declares ${count} ${what} needing at least `
                + `${count * minimumBytesEach} bytes, but only ${this.remaining()} remain after `
                + `byte ${this.cursor}; the file is truncated or the count is corrupt`);

        return count;
    }
}
