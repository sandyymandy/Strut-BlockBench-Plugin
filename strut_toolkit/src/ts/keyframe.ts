import groupBy from 'lodash/groupBy';
import mapValues from 'lodash/mapValues';
import {addMonkeypatch, Monkeypatches} from './utils';
import {STRUT_MODEL_ID} from './constants';
import {
    EASING_DEFAULT,
    easingFunctions, type EasingKey,
    EasingProperties,
    GeckolibKeyframe,
    getEasingArgDefault, isArgsEasing,
    reverseEasing
} from './easing';

// `Keyframe` is the runtime global the plugin patches (see types/blockbench-types.d.ts) -
// blockbench-types 5.1 only ambient-declares the underscore-prefixed `_Keyframe` type/class,
// not the `Keyframe` value Blockbench itself exposes via `Object.assign(window, {Keyframe, ...})`

/**
 * `easing` and `easingArgs` were, until fork phase 5 stage 3, ad-hoc fields whose persistence
 * across undo/redo and project load depended entirely on {@link keyframeGetUndoCopy} and
 * {@link keyframeExtend} manually copying them - fragile, and the reason a GeckoLib-project
 * converter needs a real round-trip test rather than an assumption (see
 * {@code docs/PLUGIN_PORT_PLAN.md} §4). Registering them as real {@code Property}s makes
 * Blockbench's own (delegated-to) {@code Keyframe.prototype.extend}/{@code getUndoCopy} - which
 * already iterate every registered property - merge and copy them structurally, the same way any
 * other keyframe field survives. The `condition` keeps `reset()`/`merge()`/`copy()` a no-op for
 * every non-Strut (Bedrock) keyframe, exactly matching this file's existing `Format.id` guards.
 * Kept alongside those guards rather than replacing them - the guards drive the actual easing
 * *calculation*, which is unrelated to how the two fields persist
 */
let keyframeProperties: Property[];

export function loadKeyframeOverrides() {
    addMonkeypatch(Keyframe, "prototype", "getLerp", keyframeGetLerp);
    addMonkeypatch(Keyframe, "prototype", "compileBedrockKeyframe", keyframeCompileBedrock);
    addMonkeypatch(Keyframe, "prototype", "getUndoCopy", keyframeGetUndoCopy);
    addMonkeypatch(Keyframe, "prototype", "extend", keyframeExtend);

    addMonkeypatch(BarItems.reverse_keyframes, null, "click", onReverseKeyframes);

    keyframeProperties = [
        new Property(Keyframe, "string", "easing", {
            condition: {formats: [STRUT_MODEL_ID]},
        }),
        new Property(Keyframe, "array", "easingArgs", {
            condition: {formats: [STRUT_MODEL_ID]},
        }),
    ];
}

export function unloadKeyframeOverrides() {
    //No-op for now since monkeypatches are unloaded automatically

    for (const property of keyframeProperties) {
        property.delete();
    }
}

interface GeckolibKeyframeOptions extends KeyframeOptions {
    easing: EasingKey
    easingArgs: number[] | null | undefined
}

// This subclass isn't strictly needed at runtime but was required to appease the compiler due to our monkeypatch
export class GeckolibBoneAnimator extends BoneAnimator {
    public addKeyframe(data: GeckolibKeyframeOptions, uuid?: string): _Keyframe {
        const keyframe = super.addKeyframe(data, uuid);
        if (data.bezier_left_time)
            keyframe.bezier_left_time = data.bezier_left_time;
        if (data.bezier_right_time)
            keyframe.bezier_right_time = data.bezier_right_time;
        if (data.bezier_right_value)
            keyframe.bezier_right_value = data.bezier_right_value;
        if (data.bezier_left_value)
            keyframe.bezier_left_value = data.bezier_left_value;
        return keyframe;
    }
}

function lerp(start: number, stop: number, amt: number) {
    return amt * (stop - start) + start;
}

// eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
function keyframeGetLerp(other, axis, amount, allow_expression) {
    const easing = other.easing || EASING_DEFAULT;
    if (Format.id !== STRUT_MODEL_ID) {
        return Monkeypatches.get(Keyframe).getLerp.apply(this, arguments);
    }
    let easingFunc = easingFunctions[easing];
    if (isArgsEasing(easing)) {
        const arg1 = Array.isArray(other.easingArgs) && other.easingArgs.length > 0
            ? other.easingArgs[0]
            : getEasingArgDefault(other);
        // console.log(`keyframeGetLerp arg1: ${arg1}`);
        easingFunc = easingFunc.bind(null, arg1);
    }
    const easedAmount = easingFunc(amount);
    const start = this.data_points.length == 1 ? this.calc(axis) : this.calc(axis, 1);
    const stop = other.calc(axis);
    const result = lerp(start, stop, easedAmount);
    // console.log('keyframeGetLerp easing:', easing, 'arguments:', arguments, 'start:', start, 'stop:', stop, 'amount:', amount, 'easedAmount:', easedAmount, 'result:', result);
    if (Number.isNaN(result)) {
        throw new Error('batman');
    }
    return result;
}

/**
 * Delegates to Blockbench's own {@code compileBedrockKeyframe} and post-processes the result with
 * {@code easing}/{@code easingArgs}, rather than reimplementing the method body the way this
 * function used to (see {@code docs/PLUGIN_PORT_PLAN.md} §2 and §5 stage 4)
 * <p>
 * The old reimplementation predated BB5's {@code flipArray} helper, which applies
 * {@code invertMolang} to a mirror-animated bone's position/rotation array - so it silently
 * dropped mirror animating for every Strut keyframe. Delegating first means that fix (and any
 * future change to the original method) is absorbed automatically, the same way the other three
 * patches in this file already delegate
 * <p>
 * The original's return shape splits on whether a keyframe has a pre/post split: an object
 * ({@code {pre, post[, lerp_mode]}}, a catmullrom keyframe's own shape, or a {@link oneLiner} for
 * any other split) has somewhere to attach easing metadata directly; a single-data-point
 * keyframe's bare vector/value from {@code getArray()} does not, so this plugin has always wrapped
 * that case in {@code {vector: ...}} instead - preserved here rather than returning the delegate's
 * raw bare value, since the Java loader's wire format expects every Strut keyframe to carry this
 * shape regardless of whether an easing is actually set
 */
function keyframeCompileBedrock() {
    if (Format.id !== STRUT_MODEL_ID || !this.transform) {
        return Monkeypatches.get(Keyframe).compileBedrockKeyframe.apply(this, arguments);
    }

    const {easing, easingArgs} = this;

    if (this.interpolation == "strut_bezier") {
        // A sentinel this plugin's own export path sets (see events.ts,
        // monkeypatchAnimatorBuildFile) to carry a keyframe's raw bezier handles through
        // compilation - BB core has no native concept of this mode, so there is nothing to
        // delegate to for it, unlike every other interpolation below
        return {
            vector: this.getArray(),
            easing: "bezier",
            left: this.bezier_left_value,
            left_time: this.bezier_left_time,
            right: this.bezier_right_value,
            right_time: this.bezier_right_time,
        };
    }

    const original = Monkeypatches.get(Keyframe).compileBedrockKeyframe.apply(this, arguments);

    const result = (original !== null && typeof original === 'object' && !Array.isArray(original))
        ? original
        : {vector: original};

    result.easing = easing;
    if (isArgsEasing(easing)) result.easingArgs = easingArgs;

    return result;
}

function keyframeGetUndoCopy() {
    const {easing, easingArgs} = this;
    const result = Monkeypatches.get(Keyframe).getUndoCopy.apply(this, arguments);
    if (Format.id === STRUT_MODEL_ID) {
        Object.assign(result, {easing});
        if (isArgsEasing(easing)) result.easingArgs = easingArgs;
    }
//   console.log('keyframeGetUndoCopy arguments:', arguments, 'this:', this, 'result:', result);
    return result;
}

function keyframeExtend(dataIn) {
    const data = Object.assign({}, dataIn);
//   console.log('keyframeExtend 1 arguments:', arguments);
    if (Format.id === STRUT_MODEL_ID) {
        if (typeof data.values === 'object') {
            if (data.values.easing !== undefined) {
                Merge.string(this, data.values, 'easing');
            }
            if (Array.isArray(data.values.easingArgs)) {
                this.easingArgs = data.values.easingArgs;
            }
            if (!Array.isArray(data.values) && Array.isArray(data.values.vector)) {
                // Convert data to format expected by KeyframeExtendOriginal
                data.values = data.values.vector;
            }
        } else {
            if (data.easing !== undefined) {
                Merge.string(this, data, 'easing');
            }
            if (Array.isArray(data.easingArgs)) {
                this.easingArgs = data.easingArgs;
            }
        }
    }
    const result = Monkeypatches.get(Keyframe).extend.apply(this, arguments);
//   console.log('keyframeExtend 2 arguments:', arguments, 'this:', this, 'result:', result);
    return result;
}

function onReverseKeyframes() {
    Monkeypatches.get(BarItems.reverse_keyframes).click.apply(this, arguments);
    // console.log('@@@ onReverseKeyframes selected:', Timeline.selected);
    // There's not really an easy way to merge our undo operation with the original one so we'll make a new one instead
    Undo.initEdit({keyframes: Timeline.selected})
    const kfByAnimator = groupBy(Timeline.selected, kf => kf.animator.uuid);
    const kfByAnimatorAndChannel = mapValues(
        kfByAnimator,
        keyframesForAnimator => groupBy(keyframesForAnimator, kf => kf.channel)
    );
    Object.keys(kfByAnimatorAndChannel).forEach(animatorUuid => {
        const animatorChannelGroups = kfByAnimatorAndChannel[animatorUuid];
        Object.keys(animatorChannelGroups).forEach(channel => {
            const channelKeyframes = animatorChannelGroups[channel];
            // Ensure keyframes are in temporal order. Not sure if this is already the case, but it couldn't hurt
            channelKeyframes.sort((kfA, kfB) => kfA.time - kfB.time);
            // Reverse easing direction
            const easingData: EasingProperties[] = channelKeyframes.map((kf: GeckolibKeyframe) => ({
                easing: reverseEasing(kf.easing),
                easingArgs: kf.easingArgs
            }));
            // console.log('@@@ onReverseKeyframes PRE animator:', animatorUuid, 'channel:', channel, 'channelKeyframes:', channelKeyframes, 'easingData:', easingData);
            // Shift easing data to the right by one keyframe
            channelKeyframes.forEach((kf: GeckolibKeyframe, i: number) => {
                if (i == 0) {
                    kf.easing = undefined;
                    kf.easingArgs = undefined;
                    return;
                }
                const newEasingData = easingData[i - 1];
                kf.easing = newEasingData.easing;
                kf.easingArgs = newEasingData.easingArgs;
            });
            // console.log('@@@ onReverseKeyframes POST animator:', animatorUuid, 'channel:', channel, 'channelKeyframes:', channelKeyframes);
        });
    });
    // console.log('@@@ kfByAnimator:', kfByAnimator, "\nkfByAnimatorAndChannel:", kfByAnimatorAndChannel);
    Undo.finishEdit('Reverse keyframe easing')
    updateKeyframeSelection();
    Animator.preview();
}