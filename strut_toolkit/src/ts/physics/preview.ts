/**
 * The response the preview draws: a bone or chain put through a scripted motion (the entity walks forward, stops, and turns) with the same solvers the game
 * runs. A curve of how far the part swings and how long it takes to settle is what tuning needs; the 3D preview in game is the tool for seeing it on the model
 */
import { ChainParams, ChainState, chainStep, springStep, SpringParams, SpringState, STEP, V3 } from './solvers';

/** The entity's acceleration along its forward axis at time {@code t} seconds: speeds up for a second, coasts, then stops hard */
export function scriptedAcceleration(t: number): number {
    if (t < 1.0) return 4.0;
    if (t > 2.0 && t < 2.25) return -16.0;

    return 0.0;
}

export interface Trace {
    readonly seconds: number[];
    /** The size of the part's offset from its animated place: radians for a bone, blocks for a chain tip */
    readonly offset: number[];
    /** The largest offset seen */
    readonly peak: number;
    /** The time after the stop at which the offset stays below 5 percent of the peak, or the end of the trace */
    readonly settle: number;
}

function summarise(seconds: number[], offset: number[]): Trace {
    const peak = Math.max(...offset, 1e-12);
    let settle = seconds[seconds.length - 1];

    for (let i = offset.length - 1; i >= 0; i--) {
        if (offset[i] > 0.05 * peak) {
            settle = seconds[Math.min(i + 1, seconds.length - 1)];

            break;
        }
    }

    return { seconds, offset, peak, settle: Math.max(0, settle - 2.25) };
}

/** A spring bone under the scripted motion: the length of its rotation offset over {@code duration} seconds */
export function springResponse(params: SpringParams, inertia: number, gravity: number, duration = 5): Trace {
    const state = new SpringState();
    const seconds: number[] = [];
    const offset: number[] = [];

    for (let t = 0; t < duration; t += STEP) {
        const force: V3 = [-scriptedAcceleration(t) * inertia, -gravity, 0];

        springStep(state, params, STEP, force);
        seconds.push(t);
        offset.push(Math.hypot(...state.rot));
    }

    return summarise(seconds, offset);
}

/** A chain hanging straight down under the scripted motion, with no collision: the distance of its tip from where the animation puts it */
export function chainResponse(params: ChainParams, segments: number, segmentLength: number, duration = 5): Trace {
    const state = new ChainState(segments + 1);
    const rest: number[] = Array.from({ length: segments }, () => segmentLength);
    const seconds: number[] = [];
    const offset: number[] = [];
    let x = 0;
    let v = 0;

    const anim = (): V3[] => Array.from({ length: segments + 1 }, (_, k) => [x, 2 - k * segmentLength, 0] as V3);

    state.snapTo(anim());

    for (let t = 0; t < duration; t += STEP) {
        const before = x;

        v = Math.max(0, v + scriptedAcceleration(t) * STEP);
        x += v * STEP;

        const a = anim();

        chainStep(state, params, STEP, a, rest, [x - before, 0, 0], []);
        seconds.push(t);

        const tip = state.x[segments];
        const target = a[segments];

        offset.push(Math.hypot(tip[0] - target[0], tip[1] - target[1], tip[2] - target[2]));
    }

    return summarise(seconds, offset);
}

// ---------------------------------------------------------------
// Turning a config entry into solver parameters (mirrors PhysicsConfig's presets and defaults)
// ---------------------------------------------------------------

interface SpringDefaults { frequency: number; damping: number; gravity: number; length: number; tip: V3 }

const SPRING_BASE: SpringDefaults = { frequency: 2, damping: 0.25, gravity: 0, length: 0.15, tip: [0, -1, 0] };
const SPRING_PRESET_VALUES: Record<string, Partial<SpringDefaults>> = {
    'jiggle-soft': { frequency: 1.7, damping: 0.24 },
    'jiggle-firm': { frequency: 2.5, damping: 0.32 },
    hair: { frequency: 2.2, damping: 0.3, gravity: 9.8, length: 0.3 },
    tail: { frequency: 1.6, damping: 0.2, gravity: 9.8, length: 0.4 },
    ear: { frequency: 3.5, damping: 0.2, gravity: 4, length: 0.2, tip: [0, 1, 0] },
    'soft-bone': { frequency: 2.2, damping: 0.28 },
};
const CHAIN_BASE = { frequency: 3, damping: 0.3, inertia: 1, gravity: 9.8, radius: 0.05, maxAngle: 0, friction: 0.2 };
const CHAIN_PRESET_VALUES: Record<string, Partial<typeof CHAIN_BASE>> = {
    hair: { frequency: 3, damping: 0.3, gravity: 9.8, radius: 0.05, maxAngle: 50 },
    tail: { frequency: 1.6, damping: 0.2, gravity: 9.8, radius: 0.06, maxAngle: 70 },
    ear: { frequency: 3.5, damping: 0.2, gravity: 4, radius: 0.04, maxAngle: 40 },
};

const CHAIN_TIP: Record<string, number> = { hair: 0.15, tail: 0.2, ear: 0.1 };

const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** The solver parameters of one entry of {@code bones}: the preset first, then the explicit keys, exactly as the game reads them */
export interface ResolvedSpring {
    params: SpringParams;
    inertia: number;
    gravity: number;
    weight: number;
    /** Blocks */
    radius: number;
    squish: number;
    collidesWith: string[];
}

export function resolveSpring(entry: Record<string, any>): ResolvedSpring {
    const d = { ...SPRING_BASE, ...(SPRING_PRESET_VALUES[entry.preset] ?? {}) };
    const limit = entry.limit && typeof entry.limit === 'object' ? entry.limit : null;

    return {
        params: {
            frequency: Math.max(1e-3, num(entry.frequency, d.frequency)),
            dampingRatio: Math.max(0, num(entry.damping, d.damping)),
            rotate: entry.rotate !== false,
            translate: typeof entry.translate === 'boolean' ? entry.translate : entry.preset === 'soft-bone',
            tip: Array.isArray(entry.tip) && entry.tip.length === 3 ? (entry.tip as V3) : d.tip,
            length: Math.max(1e-3, num(entry.length, d.length)),
            rotationLimit: limit ? ['x', 'y', 'z'].map(a => (Array.isArray(limit[a]) ? [limit[a][0] * Math.PI / 180, limit[a][1] * Math.PI / 180] as [number, number] : null)) : null,
            translationLimit: Math.max(0, num(entry.maxTranslate, entry.preset === 'soft-bone' ? 1.5 : 0)),
        },
        inertia: Math.max(0, Math.min(1, num(entry.inertia, 1))),
        gravity: num(entry.gravity, d.gravity),
        weight: Math.max(0, Math.min(1, num(entry.weight, 1))),
        radius: Math.max(0, num(entry.radius, 0.1)),
        squish: Math.max(0, Math.min(1, num(entry.squish, entry.preset === 'soft-bone' ? 0.3 : 0))),
        collidesWith: Array.isArray(entry.collidesWith) ? entry.collidesWith.map(String) : entry.preset === 'soft-bone' ? ['other', 'players', 'mobs', 'body'] : [],
    };
}

/** The solver parameters of one entry of {@code chains} */
export interface ResolvedChain {
    params: ChainParams;
    segments: number;
    /** Blocks */
    tipLength: number;
    weight: number;
    collidesWith: string[];
}

export function resolveChain(entry: Record<string, any>): ResolvedChain {
    const d = { ...CHAIN_BASE, ...(CHAIN_PRESET_VALUES[entry.preset] ?? {}) };

    return {
        params: {
            frequency: Math.max(1e-3, num(entry.frequency, d.frequency)),
            dampingRatio: Math.max(0, num(entry.damping, d.damping)),
            inertia: Math.max(0, Math.min(1, num(entry.inertia, d.inertia))),
            gravity: num(entry.gravity, d.gravity),
            radius: Math.max(0, num(entry.radius, d.radius)),
            maxAngle: Math.max(0, num(entry.maxAngle, d.maxAngle)) * Math.PI / 180,
            friction: Math.max(0, Math.min(1, num(entry.friction, d.friction))),
        },
        segments: Array.isArray(entry.bones) ? Math.max(1, entry.bones.length) : 1,
        tipLength: Math.max(1e-3, num(entry.tipLength, CHAIN_TIP[entry.preset] ?? 0.15)),
        weight: Math.max(0, Math.min(1, num(entry.weight, 1))),
        collidesWith: Array.isArray(entry.collidesWith) ? entry.collidesWith.map(String) : ['body', 'world'],
    };
}

export interface NamedTrace { readonly name: string; readonly kind: 'bone' | 'chain'; readonly trace: Trace }

/** The scripted response of everything a physics document configures */
export function respond(document: Record<string, any>): NamedTrace[] {
    const traces: NamedTrace[] = [];

    for (const [name, entry] of Object.entries(document.bones ?? {})) {
        const r = resolveSpring((entry ?? {}) as Record<string, any>);

        traces.push({ name, kind: 'bone', trace: springResponse(r.params, r.inertia, r.gravity) });
    }

    for (const [name, entry] of Object.entries(document.chains ?? {})) {
        const r = resolveChain((entry ?? {}) as Record<string, any>);

        traces.push({ name, kind: 'chain', trace: chainResponse(r.params, r.segments, 0.3) });
    }

    return traces;
}
