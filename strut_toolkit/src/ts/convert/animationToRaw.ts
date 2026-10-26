import { easingFunctions, EASING_DEFAULT, isArgsEasing } from '../easing';
import {
    EVENT_FIELD_SEPARATOR, EVENT_KIND_INSTRUCTION, EVENT_KIND_PARTICLE, EVENT_KIND_SOUND,
    InterpolationName, LoopModeName, PropertyName, RawBinaryAnimation, RawChannel, RawClip, RawEvent, RawKey, RawValue,
    ANIMATION_VERSION,
} from '../binary/animation';
import { StringTable } from '../binary/writer';
import { Findings, Severity } from './report';

/**
 * Turns a legacy GeckoLib / Bedrock {@code .animation.json} (or {@code .scene.json}) into the raw form {@code encodeAnimation} writes
 * <p>
 * Pure: no Blockbench, no file access. What it does not decide is what an animation event means in the new system; that is the
 * {@link ConvertOptions#mapEvent} hook, which by default passes an event through unchanged (see AI Info/CONVERTER_PLAN.md section 4)
 * <p>
 * Conventions, from {@code BinaryAnimationBaker}: a {@code .strutanim} stores the authoring value. Rotation is degrees and scale is 1:1, both
 * copied. Position X is negated by the baker (a Bedrock file stores that offset already negated), so it is negated here: a literal becomes
 * {@code -x}, an expression becomes {@code -(expr)}. Rotation X and Y literals are negated too, because the old loader ({@code BakedAnimationsAdapter})
 * negated them and the binary baker does not; rotation expressions are left alone, as the old loader left them
 */
export interface LegacyEvent {
    readonly clip: string;
    readonly time: number;
    /** {@code sound}, {@code particle} or {@code instruction}, the three kinds the binary format carries */
    readonly kind: string;
    readonly payload: string;
}

/** Reports something about one event; it is attached to the clip in the findings */
export type EventReport = (severity: Severity, message: string) => void;

export type EventMapper = (event: LegacyEvent, report: EventReport) => RawEvent[];

export interface ConvertOptions {
    /** The file's name, for messages */
    readonly file?: string;
    /** From {@code skeletonFingerprint()} over the model this file belongs to; 0 when unknown (a mismatch is only a warning in game) */
    readonly skeletonFingerprint?: number;
    /** Turns one legacy event into the events to write. Default: the same event, authority 0 */
    readonly mapEvent?: EventMapper;
}

export interface ConvertedAnimation {
    readonly animation: RawBinaryAnimation;
    readonly findings: Findings;
}

const AXES = ['x', 'y', 'z'] as const;
const PROPERTIES: readonly { readonly json: string; readonly property: PropertyName }[] = [
    { json: 'rotation', property: 'ROTATION' },
    { json: 'position', property: 'POSITION' },
    { json: 'scale', property: 'SCALE' },
];

export function convertAnimationFile(root: unknown, options: ConvertOptions = {}): ConvertedAnimation {
    const findings = new Findings();
    const file = options.file;
    const strings = new StringTable();
    const clips: RawClip[] = [];

    if (typeof root !== 'object' || root === null || typeof (root as any).animations !== 'object' || (root as any).animations === null) {
        findings.add('lossy', 'no "animations" object; nothing converted', { file });

        return { animation: emptyAnimation(options), findings };
    }

    const animations = (root as any).animations as Record<string, any>;

    for (const [name, data] of Object.entries(animations)) {
        clips.push(convertClip(name, data ?? {}, strings, findings, options));
    }

    return {
        animation: {
            version: ANIMATION_VERSION,
            flags: 0,
            skeletonFingerprint: options.skeletonFingerprint ?? 0,
            strings: strings.entries(),
            clips,
        },
        findings,
    };
}

function emptyAnimation(options: ConvertOptions): RawBinaryAnimation {
    return { version: ANIMATION_VERSION, flags: 0, skeletonFingerprint: options.skeletonFingerprint ?? 0, strings: [], clips: [] };
}

function convertClip(name: string, data: any, strings: StringTable, findings: Findings, options: ConvertOptions): RawClip {
    const where = { file: options.file, clip: name };
    const channels: RawChannel[] = [];
    let lastTime = 0;

    strings.intern(name);

    for (const [bone, boneData] of Object.entries((data.bones ?? {}) as Record<string, any>)) {
        for (const { json, property } of PROPERTIES) {
            if (boneData?.[json] === undefined)
                continue;

            const channel = convertChannel(bone, property, boneData[json], strings, findings, { ...where, bone });

            if (channel === null)
                continue;

            channels.push(channel);

            for (const key of channel.keys)
                lastTime = Math.max(lastTime, key.time);
        }

        for (const other of Object.keys(boneData ?? {})) {
            if (!PROPERTIES.some(p => p.json === other))
                findings.add('lossy', `bone data "${other}" is not carried over (only rotation, position and scale are)`, { ...where, bone });
        }
    }

    const events = convertEvents(name, data, strings, findings, options);

    for (const event of events)
        lastTime = Math.max(lastTime, event.time);

    for (const other of Object.keys(data)) {
        if (!['bones', 'loop', 'animation_length', 'sound_effects', 'particle_effects', 'timeline', 'override_previous_animation'].includes(other))
            findings.add('lossy', `clip data "${other}" is not carried over`, where);
    }

    const length = typeof data.animation_length === 'number' ? data.animation_length : lastTime;

    return { name, duration: length, loop: loopModeOf(data.loop), channels, events };
}

function loopModeOf(loop: unknown): LoopModeName {
    if (loop === true)
        return 'LOOP';

    if (loop === 'hold_on_last_frame')
        return 'HOLD_ON_LAST_FRAME';

    return 'PLAY_ONCE';
}

// ---------------------------------------------------------------------------------------------
// Bone channels
// ---------------------------------------------------------------------------------------------

interface Where {
    readonly file?: string;
    readonly clip?: string;
    readonly bone?: string;
}

function convertChannel(bone: string, property: PropertyName, data: unknown, strings: StringTable, findings: Findings,
                        where: Where): RawChannel | null {
    strings.intern(bone);

    const keys: RawKey[] = [];

    if (isConstant(data)) {
        const vector = (data as any)?.vector !== undefined ? (data as any).vector : data;
        const value = valueOf(vector, property, strings, findings, where, 'at time 0');

        if (value === null)
            return null;

        keys.push(makeKey(0, value, null, null, [], 'LINEAR'));
    }
    else if (typeof data === 'object' && data !== null) {
        const times = new Map<number, RawKey>();

        for (const [timeText, entry] of Object.entries(data as Record<string, any>)) {
            const time = Number(timeText);

            if (!Number.isFinite(time)) {
                findings.add('lossy', `"${timeText}" is not a time; that entry is skipped`, where);

                continue;
            }

            const key = convertKey(time, entry, property, strings, findings, where);

            if (key === null)
                continue;

            if (times.has(time))
                findings.add('lossy', `two keyframes at ${time}s; the later one wins`, where);

            times.set(time, key);
        }

        keys.push(...[...times.values()].sort((a, b) => a.time - b.time));
    }
    else {
        findings.add('lossy', `${property.toLowerCase()} has an unreadable value; the channel is skipped`, where);

        return null;
    }

    if (keys.length === 0)
        return null;

    const interpolations = new Set(keys.map(key => key.interpolation));

    return {
        target: bone,
        targetKind: 'GROUP_BONE',
        property,
        interpolation: interpolations.size === 1 ? keys[0].interpolation : null,
        keys,
    };
}

/**
 * A channel is constant when it is a bare vector or number, or an object carrying {@code vector} and no time keys. That last form is
 * what older files use: {@code "position": {"vector": [0, 0, 0]}}
 */
function isConstant(data: unknown): boolean {
    if (Array.isArray(data) || typeof data === 'number' || typeof data === 'string')
        return true;

    if (typeof data !== 'object' || data === null)
        return false;

    const keys = Object.keys(data);

    return keys.length > 0 && keys.every(key => !Number.isFinite(Number(key)));
}

function convertKey(time: number, entry: any, property: PropertyName, strings: StringTable, findings: Findings, where: Where): RawKey | null {
    const at = `at ${time}s`;

    if (Array.isArray(entry) || typeof entry === 'number' || typeof entry === 'string') {
        const value = valueOf(entry, property, strings, findings, where, at);

        return value === null ? null : makeKey(time, value, null, null, [], 'LINEAR');
    }

    if (typeof entry !== 'object' || entry === null) {
        findings.add('lossy', `keyframe ${at} is unreadable; skipped`, where);

        return null;
    }

    // pre and post are either a vector or {"vector": [...]} (the real files use the second)
    const pre = entry.pre !== undefined ? valueOf(unwrapVector(entry.pre), property, strings, findings, where, at) : null;
    const post = entry.post !== undefined ? valueOf(unwrapVector(entry.post), property, strings, findings, where, at) : null;
    const plain = entry.vector !== undefined ? valueOf(entry.vector, property, strings, findings, where, at) : null;
    const value = pre ?? plain ?? post;

    if (value === null) {
        findings.add('lossy', `keyframe ${at} has no value; skipped`, where);

        return null;
    }

    for (const other of Object.keys(entry)) {
        if (!['vector', 'pre', 'post', 'easing', 'easingArgs', 'lerp_mode'].includes(other))
            findings.add('lossy', `keyframe field "${other}" ${at} is not carried over`, where);
    }

    const easingName = typeof entry.easing === 'string' ? entry.easing : null;
    let easing: string | null = null;

    if (easingName !== null && easingName !== EASING_DEFAULT) {
        if (Object.prototype.hasOwnProperty.call(easingFunctions, easingName)) {
            easing = easingName;
            strings.intern(easingName);
        }
        else {
            findings.add('lossy', `unknown easing "${easingName}" ${at}; treated as linear`, where);
        }
    }

    const easingArgs = easing !== null && isArgsEasing(easing as any) && Array.isArray(entry.easingArgs)
        ? entry.easingArgs.filter((n: unknown) => typeof n === 'number') as number[]
        : [];
    const interpolation: InterpolationName = entry.lerp_mode === 'catmullrom' ? 'CATMULLROM' : 'LINEAR';

    return makeKey(time, value, pre !== null && post !== null ? post : null, easing, easingArgs, interpolation);
}

function unwrapVector(value: any): unknown {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && value.vector !== undefined ? value.vector : value;
}

function makeKey(time: number, value: RawValue, post: RawValue | null, easing: string | null, easingArgs: number[],
                 interpolation: InterpolationName): RawKey {
    return { time, interpolation, value, post, easing, easingArgs, bezier: null };
}

/**
 * One vector, three components. A number is a literal; a string that reads as a number is a literal; an easing name is data that was
 * never a value (0, reported); anything else is a Molang expression. Position X is negated, see the file comment
 */
function valueOf(raw: unknown, property: PropertyName, strings: StringTable, findings: Findings, where: Where, at: string): RawValue | null {
    let components: unknown[];

    if (Array.isArray(raw))
        components = raw.length === 3 ? raw : [raw[0], raw[1], raw[2]];
    else if (typeof raw === 'number' || typeof raw === 'string')
        components = [raw, raw, raw];
    else {
        findings.add('lossy', `a ${property.toLowerCase()} value ${at} is unreadable; skipped`, where);

        return null;
    }

    if (Array.isArray(raw) && raw.length !== 3)
        findings.add('lossy', `a ${property.toLowerCase()} value ${at} has ${raw.length} components, expected 3; missing ones are 0`, where);

    const literals: [number, number, number] = [0, 0, 0];
    const expressions: [string | null, string | null, string | null] = [null, null, null];

    AXES.forEach((axis, i) => {
        const component = components[i];
        // The old loader negates a rotation's X and Y (literals only) and the renderer negates a position's X; a .strutanim stores the authoring value,
        // so the literal is negated here for both. A Molang expression is never negated for rotation (the old loader did not), and is for position X
        const negate = (property === 'POSITION' && i === 0) || (property === 'ROTATION' && i < 2);
        const negateExpression = property === 'POSITION' && i === 0;

        if (typeof component === 'number') {
            literals[i] = negate ? negated(component) : component;
        }
        else if (typeof component === 'string') {
            const text = component.trim();
            const pasted = /^(-?\d+(?:\.\d+)?)\s*\+\s*(ease[A-Za-z]*)$/.exec(text);
            const stray = text.replace(/`/g, '');

            if (text !== '' && Number.isFinite(Number(text))) {
                literals[i] = negate ? negated(Number(text)) : Number(text);
            }
            else if (pasted !== null) {
                // An easing name pasted after a number ("12.45+easeInOutSine"): the old loader could not read it and dropped the whole clip
                findings.add('lossy', `the value "${text}" ${at} has an easing name pasted after the number; the number ${pasted[1]} is used for ${axis}`, where);
                literals[i] = negate ? negated(Number(pasted[1])) : Number(pasted[1]);
            }
            else if (text === '.') {
                findings.add('changed', `the value "." ${at} is not a number; written as 0 for ${axis}`, where);
            }
            else if (stray !== text && stray !== '' && Number.isFinite(Number(stray))) {
                findings.add('changed', `the value "${text}" ${at} has a stray character; read as ${Number(stray)} for ${axis}`, where);
                literals[i] = negate ? negated(Number(stray)) : Number(stray);
            }
            else if (Object.prototype.hasOwnProperty.call(easingFunctions, text)) {
                findings.add('lossy', `the easing name "${text}" was used as the ${axis} value ${at}; written as 0`, where);
            }
            else if (text === '') {
                literals[i] = 0;
            }
            else if (/\bNaN\b/i.test(text) || isEasingResidue(text)) {
                // "NaN-(linear)": an easing name that was negated or added to as if it were a number. It was never an expression
                findings.add('lossy', `the value "${text}" ${at} is damaged (an easing name or NaN where a value was); written as 0 for ${axis}`, where);
            }
            else {
                const written = placeholdersAsVariables(text, findings, where, at);

                expressions[i] = negateExpression ? `-(${written})` : written;
                strings.intern(expressions[i] as string);
            }
        }
        else if (component === undefined || component === null) {
            literals[i] = 0;
        }
        else {
            findings.add('lossy', `the ${axis} value ${at} is not a number or an expression; written as 0`, where);
        }
    });

    return { literals, expressions };
}

/** A name with no prefix and no brackets: a Blockbench variable placeholder such as SIZE */
const BARE_NAME = /(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)(?![\w.(])/g;
const KNOWN_NAMES = new Set(['pi', 'e', 'true', 'false']);

/** Whether what is left of a value once its signs and brackets are taken off is only an easing name */
function isEasingResidue(text: string): boolean {
    const bare = text.replace(/[-+\s()]/g, '');

    return bare !== '' && Object.prototype.hasOwnProperty.call(easingFunctions, bare);
}

/**
 * Blockbench lets a project define placeholders (SIZE) that an animation uses by name, but Molang only knows {@code variable.size}: written as that, the value is
 * 0 until the game sets it. The game does the same for a name it finds, so this only makes the file say what it means, and reports each placeholder once
 */
function placeholdersAsVariables(text: string, findings: Findings, where: Where, at: string): string {
    const seen = new Set<string>();
    const written = text.replace(BARE_NAME, (match, name: string) => {
        const lower = name.toLowerCase();

        if (KNOWN_NAMES.has(lower))
            return match;

        if (!seen.has(lower)) {
            seen.add(lower);
            findings.add('info', `the placeholder "${name}" ${at} is written as variable.${lower}: it is 0 in the game until something sets variable.${lower}`, where);
        }

        return `variable.${lower}`;
    });

    return written;
}

function negated(value: number): number {
    return value === 0 ? 0 : -value;
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

function convertEvents(clip: string, data: any, strings: StringTable, findings: Findings, options: ConvertOptions): RawEvent[] {
    const legacy: LegacyEvent[] = [];
    const where = { file: options.file, clip };

    collect(data.sound_effects, (time, point) => {
        const effect = point?.effect;

        if (typeof effect === 'string' && effect !== '')
            legacy.push({ clip, time, kind: EVENT_KIND_SOUND, payload: effect });
    }, findings, where);

    collect(data.particle_effects, (time, point) => {
        const effect = point?.effect;

        if (typeof effect === 'string' && effect !== '') {
            const payload = [effect, point?.locator || '', point?.pre_effect_script || point?.script || ''].join(EVENT_FIELD_SEPARATOR);

            legacy.push({ clip, time, kind: EVENT_KIND_PARTICLE, payload });
        }
    }, findings, where);

    if (data.timeline !== undefined && data.timeline !== null && typeof data.timeline === 'object') {
        for (const [timeText, script] of Object.entries(data.timeline as Record<string, unknown>)) {
            const time = Number(timeText);
            const text = Array.isArray(script) ? script.join('\n') : script;

            if (Number.isFinite(time) && typeof text === 'string' && text.trim() !== '')
                legacy.push({ clip, time, kind: EVENT_KIND_INSTRUCTION, payload: text });
        }
    }

    const map: EventMapper = options.mapEvent ?? ((event: LegacyEvent): RawEvent[] => [{
        time: event.time, kind: event.kind, payload: event.payload, authority: 0,
    }]);
    const events: RawEvent[] = [];

    for (const event of legacy) {
        for (const mapped of map(event, (severity, message) => findings.add(severity, `at ${event.time}s: ${message}`, where))) {
            strings.intern(mapped.kind);
            strings.intern(mapped.payload);
            events.push(mapped);
        }
    }

    // Stable: events at one time keep the order they were collected in
    return events.map((event, index) => ({ event, index }))
        .sort((a, b) => a.event.time - b.event.time || a.index - b.index)
        .map(entry => entry.event);
}

/** {@code { "0.5": {..} }} or {@code { "0.5": [{..}, {..}] }}: calls {@code each} once per point */
function collect(table: unknown, each: (time: number, point: any) => void, findings: Findings, where: Where): void {
    if (table === undefined || table === null)
        return;

    if (typeof table !== 'object') {
        findings.add('lossy', 'an event table is not an object; skipped', where);

        return;
    }

    for (const [timeText, entry] of Object.entries(table as Record<string, unknown>)) {
        const time = Number(timeText);

        if (!Number.isFinite(time)) {
            findings.add('lossy', `"${timeText}" is not a time; that event is skipped`, where);

            continue;
        }

        for (const point of Array.isArray(entry) ? entry : [entry])
            each(time, point);
    }
}
