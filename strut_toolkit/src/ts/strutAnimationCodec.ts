import {
    RawBinaryAnimation, RawClip, RawChannel, RawKey, RawValue, RawBezier, RawEvent,
    TargetKindName, PropertyName,
    ANIMATION_VERSION, ANIMATION_EXTENSION,
    EVENT_KIND_SOUND, EVENT_KIND_PARTICLE, EVENT_KIND_INSTRUCTION, EVENT_FIELD_SEPARATOR,
    encodeAnimation, decodeAnimation,
} from './binary/animation';
import { StringTable } from './binary/writer';
import { skeletonFingerprint } from './binary/fingerprint';
import {
    interpolationFromLive, interpolationToLive, loopModeFromLive, loopModeToLive,
    liveChannelName, dataPointFromValue, toVec3,
} from './binary/animationMapping';
import { buildModel } from './strutCodec';
import { EASING_DEFAULT, easingFunctions, isArgsEasing } from './easing';

/**
 * The live Blockbench adapter for `.strutanim` - the animation-side sibling of `strutCodec.ts`,
 * split into its own file purely for size; the same rules apply (see that file's own top
 * comment): this is the one other place touching Blockbench globals, not unit-testable the way
 * `ts/binary/*.ts` is, and correctness is covered by the export → import → export gate and the
 * Java cross-check rather than jest
 * <p>
 * Deliberately **not** wired through Blockbench's {@code AnimationCodec} API, despite
 * `docs/BINARY_CODEC_PLAN.md`'s original plan saying to attach one as the format's
 * `animation_codec`. Reading the real `AnimationCodec` surface and a shipping reference
 * implementation (AzureLib's plugin, which uses one) turned up a real problem: Blockbench's own
 * built-in "Export Animation" bar item, once a format declares `animation_codec`, calls the
 * codec's `compileFile()` and then runs the result through its own `autoStringify()` - which
 * assumes a JSON-serialisable object, not raw bytes, and would silently mangle a binary payload.
 * AzureLib's own codec has to monkeypatch that same bar item's `click` handler to route around
 * `autoStringify()` for exactly this reason - meaning "just attach an AnimationCodec" was never
 * actually a clean drop-in the way the plan assumed; it needs the same kind of surgery the
 * existing JSON path already does, for no benefit over a dedicated binary-only menu action (the
 * same shape stage 2/3 already used for the model side). Going this way also means this file
 * never touches `Animator.buildFile`/`loadFile` or their monkeypatches at all, so the existing
 * GeckoLib `.animation.json` import path (which Sandy asked to keep working after stage 6) is
 * completely unaffected by anything in this file - it doesn't share a code path
 */

/**
 * Export every animation in the current project as one `.strutanim` file, via a native save
 * dialog - `.strutanim` is `multiple_per_file` by design (see the plan's stage 5), matching this
 * plugin's existing "Export Strut Animations" JSON action, which also exports every open
 * animation as one file
 */
export function exportBinaryAnimations(): void {
    const animations: any[] = (Project as any)?.animations || [];
    const raw = buildAnimationFile(animations);
    const bytes = encodeAnimation(raw);

    // Same BinaryWriter over-allocation trap as the model exporter (stage 2) - slice to the
    // exact written length before handing the buffer to Filesystem
    const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    Filesystem.exportFile({
        resource_id: 'strut_animation',
        type: 'Strut Binary Animation',
        extensions: [ANIMATION_EXTENSION],
        name: (Project as any)?.model_identifier || 'animations',
        content: exact,
        savetype: 'binary',
    });
}

/**
 * Build a {@link RawBinaryAnimation} from a list of live `Animation` objects
 */
export function buildAnimationFile(animations: readonly any[]): RawBinaryAnimation {
    const strings = new StringTable();

    // The skeleton fingerprint has to be computed from exactly the same bone lists
    // buildModel() would write, in exactly the same order, since the Java engine independently
    // recomputes it from the baked model and rejects an animation whose fingerprint disagrees.
    // Reusing buildModel() itself (rather than re-deriving the traversal here) is what guarantees
    // that agreement - anything else risks the two falling out of step after a future change to
    // one side only
    const model = buildModel();
    const groupBoneNames = model.groupBones.map(bone => bone.name);
    const armatureBoneNames = model.armatures.map(armature => armature.bones.map(bone => bone.name));
    const fingerprint = skeletonFingerprint(groupBoneNames, armatureBoneNames);

    const clips = animations.map(animation => buildClip(animation, strings));

    return {
        version: ANIMATION_VERSION,
        flags: 0,
        skeletonFingerprint: fingerprint,
        strings: strings.entries(),
        clips,
    };
}

function buildClip(animation: any, strings: StringTable): RawClip {
    strings.intern(animation.name);

    const channels: RawChannel[] = [];

    for (const animator of Object.values(animation.animators || {}) as any[]) {
        const node = (OutlinerNode as any).uuids?.[animator.uuid];
        const targetKind = resolveTargetKind(node);

        if (targetKind === undefined)
            continue; // The effects animator, or any node this format doesn't animate

        strings.intern(node.name);

        for (const property of ['ROTATION', 'POSITION', 'SCALE'] as PropertyName[]) {
            const channelName = liveChannelName(property);
            const keyframes = ((animator.keyframes || []) as any[])
                .filter(kf => kf.channel === channelName)
                .sort((a, b) => a.time - b.time);

            if (keyframes.length === 0)
                continue;

            const keys = keyframes.map(kf => buildKey(kf, strings));
            const interpolation = keys.every(key => key.interpolation === keys[0].interpolation)
                ? keys[0].interpolation
                : null;

            channels.push({ target: node.name, targetKind, property, interpolation, keys });
        }
    }

    return {
        name: animation.name,
        duration: animation.length || 0,
        loop: loopModeFromLive(animation.loop),
        channels,
        events: buildEvents(animation.animators?.effects, strings),
    };
}

function resolveTargetKind(node: any): TargetKindName | undefined {
    if (node instanceof Group)
        return 'GROUP_BONE';

    if (node instanceof ArmatureBone)
        return 'ARMATURE_BONE';

    return undefined;
}

/**
 * Reads a keyframe's own fields directly (`.get(axis, data_point)`, `.bezier_*`), rather than
 * going through {@code Keyframe#compileBedrockKeyframe} the way the JSON export path does -
 * unlike that path, this one has no Bedrock JSON shape to conform to and no need for the
 * `"strut_bezier"` sentinel swap `monkeypatchAnimatorBuildFile` uses to smuggle bezier handles
 * through it, so a bezier-interpolation keyframe's real `interpolation` value ("bezier") is read
 * as-is
 */
function buildKey(kf: any, strings: StringTable): RawKey {
    const interpolation = interpolationFromLive(kf.interpolation);
    const value = valueFromKeyframe(kf, 0, strings);
    const hasPostSplit = interpolation !== 'BEZIER' && Array.isArray(kf.data_points) && kf.data_points.length > 1;
    const post = hasPostSplit ? valueFromKeyframe(kf, 1, strings) : null;

    const easingName: string | undefined = kf.easing;
    const easing = easingName && easingName !== EASING_DEFAULT ? easingName : null;

    if (easing !== null)
        strings.intern(easing);

    const easingArgs = easing !== null && isArgsEasing(easingName) && Array.isArray(kf.easingArgs)
        ? [...kf.easingArgs]
        : [];

    const bezier: RawBezier | null = interpolation === 'BEZIER'
        ? {
            leftTime: toVec3(kf.bezier_left_time),
            leftValue: toVec3(kf.bezier_left_value),
            rightTime: toVec3(kf.bezier_right_time),
            rightValue: toVec3(kf.bezier_right_value),
        }
        : null;

    return { time: kf.time, interpolation, value, post, easing, easingArgs, bezier };
}

function valueFromKeyframe(kf: any, dataPoint: number, strings: StringTable): RawValue {
    const literals: [number, number, number] = [0, 0, 0];
    const expressions: [string | null, string | null, string | null] = [null, null, null];

    (['x', 'y', 'z'] as const).forEach((axis, i) => {
        const raw = kf.get(axis, dataPoint);

        if (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(easingFunctions, raw)) {
            // An easing name is never a Molang expression. A project imported from older data can carry one in a data point's
            // x/y/z, and exporting it as an expression would make the game drop the whole clip. Written as 0 instead
            console.warn(`Strut export: keyframe at ${kf.time}s has the easing name "${raw}" as its ${axis} value; exporting 0`);
            literals[i] = 0;
        }
        else if (typeof raw === 'string') {
            expressions[i] = raw;
            strings.intern(raw);
        }
        else {
            literals[i] = Number(raw) || 0;
        }
    });

    return { literals, expressions };
}

/**
 * Sound/particle/instruction events all live on one {@code EffectAnimator}'s flat `.keyframes`
 * array, discriminated by `.channel` (`'sound'`/`'particle'`/`'timeline'`) - confirmed against a
 * real, shipping reference `AnimationCodec` implementation (AzureLib's plugin), since neither
 * `blockbench-types` nor this codebase's own existing JSON import path make that flat-array shape
 * explicit. A particle event's `effect`/`locator`/`script` triple flattens into one
 * {@link EVENT_FIELD_SEPARATOR}-joined payload string, matching {@code StrutBinaryFormats}'
 * own javadoc; a sound event's payload is just its identifier; an instruction (Blockbench's own
 * `'timeline'` channel) event's payload is its script text
 */
function buildEvents(effects: any, strings: StringTable): RawEvent[] {
    if (!effects || !Array.isArray(effects.keyframes))
        return [];

    const events: RawEvent[] = [];
    const sorted = [...effects.keyframes].sort((a: any, b: any) => a.time - b.time);

    for (const kf of sorted) {
        const dataPoints: any[] = Array.isArray(kf.data_points) ? kf.data_points : [];

        if (kf.channel === 'sound') {
            for (const point of dataPoints) {
                const effect = typeof point === 'string' ? point : point?.effect;

                if (effect)
                    events.push(makeEvent(kf.time, EVENT_KIND_SOUND, effect, strings));
            }
        }
        else if (kf.channel === 'particle') {
            for (const point of dataPoints) {
                const effect = point?.effect;

                if (!effect)
                    continue;

                const payload = [effect, point?.locator || '', point?.script || ''].join(EVENT_FIELD_SEPARATOR);

                events.push(makeEvent(kf.time, EVENT_KIND_PARTICLE, payload, strings));
            }
        }
        else if (kf.channel === 'timeline') {
            const script = dataPoints[0]?.script;

            if (script)
                events.push(makeEvent(kf.time, EVENT_KIND_INSTRUCTION, script, strings));
        }
    }

    return events;
}

function makeEvent(time: number, kind: string, payload: string, strings: StringTable): RawEvent {
    strings.intern(kind);
    strings.intern(payload);

    // No authored equivalent exists anywhere in Blockbench's UI - the Java side parses and drops
    // this field today regardless (see RawBinaryAnimation's own doc comment), reserved for engine
    // phase 5's typed events
    return { time, kind, payload, authority: 0 };
}

// ===============================================================
// Import
// ===============================================================

/**
 * Import a `.strutanim` file, via a native file picker, into the current project
 * <p>
 * Unlike model import, this does not open a new project - an animation only makes sense against
 * an existing rig, exactly like the existing GeckoLib `.animation.json` import already assumes
 */
export function importBinaryAnimations(): void {
    (Blockbench as any).import({
        resource_id: 'strut_animation',
        type: 'Strut Binary Animation',
        extensions: [ANIMATION_EXTENSION],
        readtype: 'binary',
    }, (files: any[]) => {
        const file = files[0];

        if (!file)
            return;

        const bytes = new Uint8Array(file.content as ArrayBuffer);
        const raw = decodeAnimation(bytes, file.name || 'imported.strutanim');

        buildAnimationsFromFile(raw, file.path);
    });
}

function buildAnimationsFromFile(raw: RawBinaryAnimation, path?: string): void {
    const created: any[] = [];

    for (const clip of raw.clips) {
        const animation = new (Animation as unknown as typeof _Animation)({
            name: clip.name,
            path,
            loop: loopModeToLive(clip.loop),
            length: clip.duration,
        }).add();

        addChannelsToAnimation(animation, clip);
        buildEffectsFromEvents(animation, clip.events);

        animation.calculateSnappingFromKeyframes();
        created.push(animation);
    }

    if (created.length > 0 && Animator.open)
        created[0].select();
}

function addChannelsToAnimation(animation: any, clip: RawClip): void {
    const animatorsByTarget = new Map<string, any>();

    for (const channel of clip.channels) {
        const targetKey = `${channel.targetKind}:${channel.target}`;
        let animator = animatorsByTarget.get(targetKey);

        if (animator === undefined) {
            const node = resolveTargetNode(channel.targetKind, channel.target);

            if (!node) {
                console.warn(`[Strut] animation "${clip.name}" references ${channel.targetKind.toLowerCase()}`
                    + ` "${channel.target}", which does not exist in this project; its keyframes were skipped`);
                animator = null;
            }
            else {
                animator = typeof animation.getBoneAnimator === 'function' ? animation.getBoneAnimator(node) : null;
            }

            animatorsByTarget.set(targetKey, animator);
        }

        if (!animator)
            continue;

        const channelName = liveChannelName(channel.property);

        for (const key of channel.keys) {
            animator.addKeyframe(keyframeOptionsFromRawKey(key, channelName));
        }
    }
}

function resolveTargetNode(targetKind: TargetKindName, name: string): any {
    if (targetKind === 'GROUP_BONE')
        return ((Group as any).all || []).find((group: any) => group.name === name);

    return ((ArmatureBone as any).all || []).find((bone: any) => bone.name === name);
}

function keyframeOptionsFromRawKey(key: RawKey, channel: string): any {
    const dataPoints = [dataPointFromValue(key.value)];

    if (key.post !== null)
        dataPoints.push(dataPointFromValue(key.post));

    const options: any = {
        channel,
        time: key.time,
        interpolation: interpolationToLive(key.interpolation),
        data_points: dataPoints,
    };

    if (key.easing !== null) {
        options.easing = key.easing;

        if (key.easingArgs.length > 0)
            options.easingArgs = [...key.easingArgs];
    }

    if (key.interpolation === 'BEZIER' && key.bezier !== null) {
        options.bezier_left_time = [...key.bezier.leftTime];
        options.bezier_left_value = [...key.bezier.leftValue];
        options.bezier_right_time = [...key.bezier.rightTime];
        options.bezier_right_value = [...key.bezier.rightValue];
    }

    return options;
}

function buildEffectsFromEvents(animation: any, events: readonly RawEvent[]): void {
    if (events.length === 0)
        return;

    if (!animation.animators.effects)
        animation.animators.effects = new (EffectAnimator as any)(animation);

    const effects = animation.animators.effects;

    for (const event of events) {
        if (event.kind === EVENT_KIND_SOUND) {
            effects.addKeyframe({ channel: 'sound', time: event.time, data_points: [{ effect: event.payload }] });
        }
        else if (event.kind === EVENT_KIND_PARTICLE) {
            const [effect, locator, script] = event.payload.split(EVENT_FIELD_SEPARATOR);
            const point: any = { effect: effect || '' };

            if (locator) point.locator = locator;
            if (script) point.script = script;

            effects.addKeyframe({ channel: 'particle', time: event.time, data_points: [point] });
        }
        else if (event.kind === EVENT_KIND_INSTRUCTION) {
            effects.addKeyframe({ channel: 'timeline', time: event.time, data_points: [{ script: event.payload }] });
        }
        else {
            console.warn(`[Strut] event of unrecognised kind "${event.kind}" skipped on import`);
        }
    }
}
