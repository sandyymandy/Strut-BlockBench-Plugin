import { BinaryWriter } from './writer';
import { BinaryReader } from './reader';

/**
 * Plain records and codec functions for {@code .strutanim}, mirroring
 * {@code com.sandymandy.strut.loading.binary.raw.RawBinaryAnimation} and
 * {@code BinaryAnimationReader}'s write-side counterpart field for field - see
 * {@code docs/BINARY_CODEC_PLAN.md} §4. No Blockbench globals
 * <p>
 * Little-endian binary behind a four-byte {@code STAM} magic, sharing the string-table
 * convention of {@code .strutmodel}:
 * <pre>
 *   [HEADER 32 bytes]
 *   [STRING TABLE]      uint16-length-prefixed UTF-8, indexed everywhere else
 *   [CLIPS]             each a name, a duration, a loop mode, channels and events
 * </pre>
 */

export const ANIMATION_MAGIC = 'STAM';
export const ANIMATION_EXTENSION = 'strutanim';
export const ANIMATION_VERSION = 100;
export const ANIMATION_MIN_VERSION = 100;
export const ANIMATION_HEADER_BYTES = 32;
const ANIMATION_RESERVED_V100 = 12;

/**
 * The smallest a keyframe can be: a time (4), an interpolation (1), flags (2), and three components that are each a 2-byte expression index
 * rather than a 4-byte float (6). Matches {@code StrutBinaryFormats.MIN_KEY_BYTES}; it was 19, which rejected a valid file ending in an
 * all-expression key as truncated
 */
export const MIN_KEY_BYTES = 13;

export const KEY_FLAG_HAS_POST = 0x0001;
export const KEY_FLAG_HAS_EASING = 0x0002;
export const KEY_FLAG_VALUE_EXPRESSION = 0x0004;
export const KEY_FLAG_POST_EXPRESSION = 0x0020;

export const EVENT_KIND_SOUND = 'sound';
export const EVENT_KIND_PARTICLE = 'particle';
export const EVENT_KIND_INSTRUCTION = 'instruction';

/** ASCII unit separator (U+001F) - see {@code StrutBinaryFormats#EVENT_FIELD_SEPARATOR} */
export const EVENT_FIELD_SEPARATOR = '';

export type Vec3 = [number, number, number];

export const Interpolation = {
    STEP: 0,
    LINEAR: 1,
    CATMULLROM: 2,
    BEZIER: 3,
} as const;
export type InterpolationName = keyof typeof Interpolation;
/** The sentinel a channel uses to say its keyframes do not share one mode */
export const INTERPOLATION_MIXED = 255;

export const Property = {
    ROTATION: 0,
    POSITION: 1,
    SCALE: 2,
} as const;
export type PropertyName = keyof typeof Property;

export const TargetKind = {
    GROUP_BONE: 0,
    ARMATURE_BONE: 1,
} as const;
export type TargetKindName = keyof typeof TargetKind;

export const LoopMode = {
    PLAY_ONCE: 0,
    LOOP: 1,
    HOLD_ON_LAST_FRAME: 2,
} as const;
export type LoopModeName = keyof typeof LoopMode;

export interface RawValue {
    /** Meaningless where the same-index expression is present */
    readonly literals: readonly [number, number, number];
    /** Molang source, null where that component is a literal */
    readonly expressions: readonly [string | null, string | null, string | null];
}

export interface RawBezier {
    readonly leftTime: Vec3;
    readonly leftValue: Vec3;
    readonly rightTime: Vec3;
    readonly rightValue: Vec3;
}

export interface RawKey {
    readonly time: number;
    readonly interpolation: InterpolationName;
    readonly value: RawValue;
    /** The outgoing value, where a keyframe holds a different value on each side of its own time */
    readonly post: RawValue | null;
    /** The name of the easing applied across the segment ending at this keyframe, or null */
    readonly easing: string | null;
    readonly easingArgs: readonly number[];
    /** The four handles of a bezier segment, or null for any other mode */
    readonly bezier: RawBezier | null;
}

export interface RawChannel {
    /** The name of the bone this drives, unresolved */
    readonly target: string;
    readonly targetKind: TargetKindName;
    readonly property: PropertyName;
    /** The mode shared by every keyframe, or null if they differ (the mixed sentinel) */
    readonly interpolation: InterpolationName | null;
    readonly keys: readonly RawKey[];
}

export interface RawEvent {
    readonly time: number;
    readonly kind: string;
    readonly payload: string;
    readonly authority: number;
}

export interface RawClip {
    readonly name: string;
    /** The clip's length, in seconds */
    readonly duration: number;
    readonly loop: LoopModeName;
    readonly channels: readonly RawChannel[];
    readonly events: readonly RawEvent[];
}

export interface RawBinaryAnimation {
    readonly version: number;
    readonly flags: number;
    /** A hash of the bone names the clips were authored against */
    readonly skeletonFingerprint: number;
    readonly strings: readonly string[];
    readonly clips: readonly RawClip[];
}

/** Render a fingerprint the way an exporter logs it */
export function fingerprintText(fingerprint: number): string {
    return '0x' + (fingerprint >>> 0).toString(16).padStart(8, '0');
}

// ===============================================================
// Encode
// ===============================================================

/**
 * Encode a {@link RawBinaryAnimation} into its wire bytes
 * <p>
 * As with {@link encodeModel}, the caller is responsible for {@link RawBinaryAnimation#strings}
 * already being the first-use interning order every string index in the rest of the record was
 * assigned against
 */
export function encodeAnimation(animation: RawBinaryAnimation): Uint8Array {
    const stringTable = new BinaryWriter();

    for (const value of animation.strings) {
        stringTable.string(value);
    }

    const strings = animation.strings;
    const clips = new BinaryWriter();

    for (const clip of animation.clips) {
        clips.u16(indexOf(strings, clip.name, 'clip name'))
            .f32(clip.duration)
            .u8(LoopMode[clip.loop])
            .u16(clip.channels.length)
            .u16(clip.events.length);

        for (const channel of clip.channels) {
            writeChannel(clips, channel, strings);
        }

        for (const event of clip.events) {
            writeEvent(clips, event, strings);
        }
    }

    const header = new BinaryWriter(ANIMATION_HEADER_BYTES);

    header.fixedString(ANIMATION_MAGIC)
        .u16(ANIMATION_VERSION)
        .u16(animation.flags)
        .u16(strings.length)
        .u32(stringTable.byteLength)
        .u16(animation.clips.length)
        .i32(animation.skeletonFingerprint)
        .zeros(ANIMATION_RESERVED_V100);

    if (header.byteLength !== ANIMATION_HEADER_BYTES)
        throw new Error(`wrote a ${header.byteLength}-byte animation header, expected ${ANIMATION_HEADER_BYTES}`);

    return new BinaryWriter().append(header).append(stringTable).append(clips).toBytes();
}

function writeChannel(out: BinaryWriter, channel: RawChannel, strings: readonly string[]): void {
    out.u16(indexOf(strings, channel.target, 'channel target'))
        .u8(TargetKind[channel.targetKind])
        .u8(Property[channel.property])
        .u8(channel.interpolation === null ? INTERPOLATION_MIXED : Interpolation[channel.interpolation])
        .u16(channel.keys.length);

    for (const key of channel.keys) {
        writeKey(out, key, strings);
    }
}

function writeKey(out: BinaryWriter, key: RawKey, strings: readonly string[]): void {
    out.f32(key.time).u8(Interpolation[key.interpolation]);

    let flags = 0;

    if (key.post !== null) flags |= KEY_FLAG_HAS_POST;
    if (key.easing !== null) flags |= KEY_FLAG_HAS_EASING;

    flags |= expressionFlags(key.value, KEY_FLAG_VALUE_EXPRESSION);

    if (key.post !== null)
        flags |= expressionFlags(key.post, KEY_FLAG_POST_EXPRESSION);

    out.u16(flags);

    writeValue(out, key.value, strings);

    if (key.post !== null)
        writeValue(out, key.post, strings);

    if (key.easing !== null) {
        out.u16(indexOf(strings, key.easing, 'easing name')).u8(key.easingArgs.length);

        for (const arg of key.easingArgs) {
            out.f32(arg);
        }
    }

    if (key.interpolation === 'BEZIER') {
        if (key.bezier === null)
            throw new Error('a BEZIER-interpolation keyframe must carry bezier handles');

        out.vec3(...key.bezier.leftTime).vec3(...key.bezier.leftValue)
            .vec3(...key.bezier.rightTime).vec3(...key.bezier.rightValue);
    }
}

function expressionFlags(value: RawValue, bit: number): number {
    let flags = 0;

    for (let i = 0; i < 3; i++) {
        if (value.expressions[i] !== null)
            flags |= bit << i;
    }

    return flags;
}

function writeValue(out: BinaryWriter, value: RawValue, strings: readonly string[]): void {
    for (let i = 0; i < 3; i++) {
        const expression = value.expressions[i];

        if (expression !== null) {
            out.u16(indexOf(strings, expression, `value component ${i} expression`));
        }
        else {
            out.f32(value.literals[i]);
        }
    }
}

function writeEvent(out: BinaryWriter, event: RawEvent, strings: readonly string[]): void {
    out.f32(event.time)
        .u16(indexOf(strings, event.kind, 'event kind'))
        .u16(indexOf(strings, event.payload, 'event payload'))
        .u8(event.authority);
}

function indexOf(strings: readonly string[], value: string, what: string): number {
    const index = strings.indexOf(value);

    if (index < 0)
        throw new Error(`encoding ${what} "${value}", which is not in the animation's own string table`);

    return index;
}

// ===============================================================
// Decode
// ===============================================================

export function decodeAnimation(bytes: Uint8Array, source: string): RawBinaryAnimation {
    return parseAnimation(new BinaryReader(bytes, source));
}

function parseAnimation(reader: BinaryReader): RawBinaryAnimation {
    const magic = reader.fixedString(4, 'magic number');

    if (magic !== ANIMATION_MAGIC)
        throw reader.fail(`opens with "${magic}" rather than "${ANIMATION_MAGIC}"; it is not a Strut binary animation`);

    const version = reader.u16('format version');

    if (version < ANIMATION_MIN_VERSION)
        throw reader.fail(`is animation format version ${version}, which this build no longer reads;`
            + ` the oldest readable version is ${ANIMATION_MIN_VERSION}. Re-export it`);

    if (version > ANIMATION_VERSION)
        throw reader.fail(`is animation format version ${version}, which is newer than this build`
            + ` understands (${ANIMATION_VERSION}). Update the plugin, or re-export the animation`
            + ` from a matching version`);

    const flags = reader.u16('header flags');
    const stringCount = reader.u16('string count');
    const stringTableSize = reader.u32('string table size');
    const clipCount = reader.u16('clip count');
    const fingerprint = reader.i32('skeleton fingerprint');

    reader.skip(ANIMATION_RESERVED_V100, 'reserved header bytes');

    if (reader.position() !== ANIMATION_HEADER_BYTES)
        throw reader.fail(`read a ${reader.position()}-byte header for version ${version}; every`
            + ` version's header is exactly ${ANIMATION_HEADER_BYTES} bytes`);

    if (stringTableSize > reader.remaining())
        throw reader.fail(`declares a ${stringTableSize}-byte string table with only`
            + ` ${reader.remaining()} bytes left after its ${ANIMATION_HEADER_BYTES}-byte header;`
            + ` the file is truncated`);

    const strings = readStringTable(reader, stringCount);

    reader.plausibleCount(clipCount, 11, 'clips');

    const clips: RawClip[] = [];

    for (let i = 0; i < clipCount; i++) {
        clips.push(readClip(reader, strings, i));
    }

    return { version, flags, skeletonFingerprint: fingerprint, strings, clips };
}

function readStringTable(reader: BinaryReader, count: number): string[] {
    reader.plausibleCount(count, 2, 'strings');

    const strings: string[] = [];

    for (let i = 0; i < count; i++) {
        strings.push(reader.string(`string ${i}`));
    }

    return strings;
}

function resolve(reader: BinaryReader, strings: readonly string[], index: number, what: string): string {
    if (index < 0 || index >= strings.length)
        throw reader.fail(`names ${what} with string index ${index}, but the string table holds`
            + ` ${strings.length} entries`);

    return strings[index];
}

function interpolationFromWire(reader: BinaryReader, wire: number, what: string): InterpolationName | null {
    if (wire === INTERPOLATION_MIXED)
        return null;

    const found = (Object.keys(Interpolation) as InterpolationName[]).find(key => Interpolation[key] === wire);

    if (found === undefined)
        throw reader.fail(`has ${what} with an unreadable value: no interpolation has wire code ${wire}`);

    return found;
}

function propertyFromWire(reader: BinaryReader, wire: number, what: string): PropertyName {
    const found = (Object.keys(Property) as PropertyName[]).find(key => Property[key] === wire);

    if (found === undefined)
        throw reader.fail(`has ${what} with an unreadable value: no property has wire code ${wire}`);

    return found;
}

function targetKindFromWire(reader: BinaryReader, wire: number, what: string): TargetKindName {
    const found = (Object.keys(TargetKind) as TargetKindName[]).find(key => TargetKind[key] === wire);

    if (found === undefined)
        throw reader.fail(`has ${what} with an unreadable value: no target kind has wire code ${wire}`);

    return found;
}

function loopModeFromWire(reader: BinaryReader, wire: number, what: string): LoopModeName {
    const found = (Object.keys(LoopMode) as LoopModeName[]).find(key => LoopMode[key] === wire);

    if (found === undefined)
        throw reader.fail(`has ${what} with an unreadable value: no loop mode has wire code ${wire}`);

    return found;
}

function readClip(reader: BinaryReader, strings: readonly string[], index: number): RawClip {
    const name = resolve(reader, strings, reader.u16(`clip ${index} name`), `clip ${index}`);
    const where = `clip "${name}"`;
    const duration = reader.f32(`${where} duration`);
    const loop = loopModeFromWire(reader, reader.u8(`${where} loop mode`), `${where} loop mode`);

    const channelCount = reader.plausibleCount(reader.u16(`${where} channel count`), 7, `channels of ${where}`);
    const eventCount = reader.u16(`${where} event count`);

    const channels: RawChannel[] = [];

    for (let c = 0; c < channelCount; c++) {
        channels.push(readChannel(reader, strings, name, c));
    }

    reader.plausibleCount(eventCount, 9, `events of ${where}`);

    const events: RawEvent[] = [];

    for (let e = 0; e < eventCount; e++) {
        events.push(readEvent(reader, strings, name));
    }

    return { name, duration, loop, channels, events };
}

function readChannel(reader: BinaryReader, strings: readonly string[], clip: string, index: number): RawChannel {
    const where = `channel ${index} of clip "${clip}"`;
    const target = resolve(reader, strings, reader.u16(`${where} target`), where);
    const targetKind = targetKindFromWire(reader, reader.u8(`${where} target kind`), `${where} target kind`);
    const property = propertyFromWire(reader, reader.u8(`${where} property`), `${where} property`);
    const interpolation = interpolationFromWire(reader, reader.u8(`${where} interpolation`), `${where} interpolation`);

    const keyCount = reader.plausibleCount(reader.u16(`${where} keyframe count`), MIN_KEY_BYTES, `keyframes of ${where}`);
    const keys: RawKey[] = [];

    for (let k = 0; k < keyCount; k++) {
        keys.push(readKey(reader, strings, where, k, interpolation));
    }

    return { target, targetKind, property, interpolation, keys };
}

function readKey(reader: BinaryReader, strings: readonly string[], channel: string, index: number,
                  channelInterpolation: InterpolationName | null): RawKey {
    const where = `keyframe ${index} of ${channel}`;
    const time = reader.f32(`${where} time`);
    const interpolation = interpolationFromWire(reader, reader.u8(`${where} interpolation`), `${where} interpolation`);

    if (interpolation === null)
        throw reader.fail(`has ${where} declaring the mixed-interpolation sentinel, which is only`
            + ` meaningful on a channel; a keyframe has exactly one mode`);

    if (channelInterpolation !== null && channelInterpolation !== interpolation)
        throw reader.fail(`has ${where} using ${interpolation} interpolation, but its channel declares`
            + ` ${channelInterpolation} for every keyframe; a channel whose keyframes differ must`
            + ` declare the mixed sentinel (${INTERPOLATION_MIXED})`);

    const flags = reader.u16(`${where} flags`);
    const value = readValue(reader, strings, `${where} value`, flags, KEY_FLAG_VALUE_EXPRESSION);
    const post = (flags & KEY_FLAG_HAS_POST) !== 0
        ? readValue(reader, strings, `${where} outgoing value`, flags, KEY_FLAG_POST_EXPRESSION)
        : null;

    let easing: string | null = null;
    let easingArgs: number[] = [];

    if ((flags & KEY_FLAG_HAS_EASING) !== 0) {
        easing = resolve(reader, strings, reader.u16(`${where} easing name`), `${where} easing`);

        const argCount = reader.plausibleCount(reader.u8(`${where} easing argument count`), 4,
            `easing arguments of ${where}`);

        easingArgs = [];

        for (let i = 0; i < argCount; i++) {
            easingArgs.push(reader.f32(`${where} easing argument ${i}`));
        }
    }

    const bezier: RawBezier | null = interpolation === 'BEZIER'
        ? {
            leftTime: reader.vec3(`${where} left handle time`),
            leftValue: reader.vec3(`${where} left handle value`),
            rightTime: reader.vec3(`${where} right handle time`),
            rightValue: reader.vec3(`${where} right handle value`),
        }
        : null;

    return { time, interpolation, value, post, easing, easingArgs, bezier };
}

function readValue(reader: BinaryReader, strings: readonly string[], where: string, flags: number,
                    expressionBit: number): RawValue {
    const literals: [number, number, number] = [0, 0, 0];
    const expressions: [string | null, string | null, string | null] = [null, null, null];

    for (let i = 0; i < 3; i++) {
        if ((flags & (expressionBit << i)) !== 0) {
            expressions[i] = resolve(reader, strings, reader.u16(`${where} component ${i} expression`), `${where} component ${i}`);
        }
        else {
            literals[i] = reader.f32(`${where} component ${i}`);
        }
    }

    return { literals, expressions };
}

function readEvent(reader: BinaryReader, strings: readonly string[], clip: string): RawEvent {
    const where = `an event of clip "${clip}"`;
    const time = reader.f32(`${where} time`);
    const kind = resolve(reader, strings, reader.u16(`${where} kind`), where);
    const payload = resolve(reader, strings, reader.u16(`${where} payload`), where);

    return { time, kind, payload, authority: reader.u8(`${where} authority`) };
}
