import { InterpolationName, LoopModeName, PropertyName, RawValue } from './animation';

/**
 * The bidirectional live-Blockbench ↔ wire-format naming conventions for
 * `strutAnimationCodec.ts`, pulled out into their own dependency-free module for the same reason
 * `cubeUv.ts`/`skinWeights.ts` were in earlier stages - these are the one part of the animation
 * adapter with no live Blockbench object in them, so there's no reason to leave a naming mismatch
 * here as untestable as the parts that genuinely can't be (see `docs/BINARY_CODEC_PLAN.md` §4)
 */

export function interpolationFromLive(value: string): InterpolationName {
    switch (value) {
        case 'step': return 'STEP';
        case 'catmullrom': return 'CATMULLROM';
        case 'bezier': return 'BEZIER';
        default: return 'LINEAR';
    }
}

export function interpolationToLive(name: InterpolationName): string {
    switch (name) {
        case 'STEP': return 'step';
        case 'CATMULLROM': return 'catmullrom';
        case 'BEZIER': return 'bezier';
        case 'LINEAR': return 'linear';
    }
}

export function loopModeFromLive(loop: string): LoopModeName {
    switch (loop) {
        case 'loop': return 'LOOP';
        case 'hold': return 'HOLD_ON_LAST_FRAME';
        default: return 'PLAY_ONCE';
    }
}

export function loopModeToLive(name: LoopModeName): 'once' | 'hold' | 'loop' {
    switch (name) {
        case 'LOOP': return 'loop';
        case 'HOLD_ON_LAST_FRAME': return 'hold';
        case 'PLAY_ONCE': return 'once';
    }
}

export function liveChannelName(property: PropertyName): string {
    switch (property) {
        case 'ROTATION': return 'rotation';
        case 'POSITION': return 'position';
        case 'SCALE': return 'scale';
    }
}

/**
 * A {@link RawValue}'s per-axis literal, unless that axis carries a Molang expression instead
 * <p>
 * A literal is stringified deliberately - live-verified against a real Blockbench session that
 * {@code KeyframeDataPoint}'s `x`/`y`/`z` fields are string-typed underneath (so the same slot can
 * hold either a plain number or a Molang expression), and `addKeyframe()` does not coerce a raw
 * JS number itself: handing it one silently leaves the field at its default rather than the given
 * value. `_Keyframe#get()` does the reverse coercion automatically on read, which is why this
 * asymmetry went unnoticed until an actual import was checked against a live keyframe's own
 * internals rather than assumed from its typed signature (`KeyframeOptions.data_points: {}[]`
 * says nothing about this)
 */
export function dataPointFromValue(value: RawValue): { x: string; y: string; z: string } {
    return {
        x: value.expressions[0] ?? String(value.literals[0]),
        y: value.expressions[1] ?? String(value.literals[1]),
        z: value.expressions[2] ?? String(value.literals[2]),
    };
}

/** A live `ArrayVector3`-shaped field, defensively - `undefined`/malformed collapses to the origin */
export function toVec3(v: unknown): [number, number, number] {
    return Array.isArray(v) ? [v[0] || 0, v[1] || 0, v[2] || 0] : [0, 0, 0];
}
