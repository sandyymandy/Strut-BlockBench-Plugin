/**
 * The Strut Physics solvers in TypeScript: a line-for-line port of the Java {@code SpringSolver} and {@code ChainSolver}, so the plugin's preview shows what the
 * game does. No Blockbench globals here. The golden test ({@code tests/physics/golden.test.ts}) runs the same scripted inputs the Java test records into
 * {@code physics/src/test/resources/golden/solvers.json} and requires the same results
 */

export type V3 = [number, number, number];

/** The fixed step both solvers run at, in seconds */
export const STEP = 1 / 60;

// ---------------------------------------------------------------
// Spring bones
// ---------------------------------------------------------------

export interface SpringParams {
    frequency: number;
    dampingRatio: number;
    rotate: boolean;
    translate: boolean;
    tip: V3;
    length: number;
    /** Per axis {@code [min, max]} in radians, or null for no limit on that axis */
    rotationLimit: ([number, number] | null)[] | null;
    /** Model units, 0 for no limit */
    translationLimit: number;
}

export class SpringState {
    rot: V3 = [0, 0, 0];
    rotVel: V3 = [0, 0, 0];
    pos: V3 = [0, 0, 0];
    posVel: V3 = [0, 0, 0];
}

/** One step of one bone; {@code force} is in the bone's own space, blocks per second squared */
export function springStep(state: SpringState, params: SpringParams, h: number, force: V3): void {
    const omega = 2 * Math.PI * params.frequency;
    const k = omega * omega;
    const damping = 2 * params.dampingRatio * omega;
    const keep = Math.exp(-damping * h);
    const stiffen = 1 / (1 + h * h * k);

    if (params.rotate) {
        const t = params.tip;
        const lever = Math.max(1e-4, params.length);
        const torque: V3 = [
            (t[1] * force[2] - t[2] * force[1]) / lever,
            (t[2] * force[0] - t[0] * force[2]) / lever,
            (t[0] * force[1] - t[1] * force[0]) / lever,
        ];

        for (let i = 0; i < 3; i++) {
            const velocity = (state.rotVel[i] + torque[i] * h) * keep;
            const predicted = state.rot[i] + velocity * h;
            let solved = predicted * stiffen;
            const limit = params.rotationLimit === null ? null : params.rotationLimit[i];

            if (limit) solved = Math.max(limit[0], Math.min(limit[1], solved));

            state.rotVel[i] = (solved - state.rot[i]) / h;
            state.rot[i] = solved;
        }
    }

    if (params.translate) {
        for (let i = 0; i < 3; i++) {
            const velocity = (state.posVel[i] + force[i] * 16 * h) * keep;
            const predicted = state.pos[i] + velocity * h;
            let solved = predicted * stiffen;

            if (params.translationLimit > 0)
                solved = Math.max(-params.translationLimit, Math.min(params.translationLimit, solved));

            state.posVel[i] = (solved - state.pos[i]) / h;
            state.pos[i] = solved;
        }
    }
}

// ---------------------------------------------------------------
// Colliders
// ---------------------------------------------------------------

/** A shape placed in solver space. {@code axes[column][row]} is a box's orientation: its columns are its axes */
export interface Placed {
    shape: 'sphere' | 'capsule' | 'box';
    p: V3;
    q: V3;
    radius: number;
    half: V3;
    axes: number[][];
}

function pushFromPoint(x: V3, cx: number, cy: number, cz: number, reach: number): boolean {
    const dx = x[0] - cx;
    const dy = x[1] - cy;
    const dz = x[2] - cz;
    const d2 = dx * dx + dy * dy + dz * dz;

    if (d2 >= reach * reach) return false;

    const d = Math.sqrt(d2);

    if (d < 1e-9) {
        x[1] = cy + reach;

        return true;
    }

    const k = reach / d;

    x[0] = cx + dx * k;
    x[1] = cy + dy * k;
    x[2] = cz + dz * k;

    return true;
}

function pushFromBox(s: Placed, x: V3, r: number): boolean {
    const d: V3 = [x[0] - s.p[0], x[1] - s.p[1], x[2] - s.p[2]];
    const local: V3 = [0, 0, 0];

    for (let axis = 0; axis < 3; axis++)
        local[axis] = d[0] * s.axes[axis][0] + d[1] * s.axes[axis][1] + d[2] * s.axes[axis][2];

    const near: V3 = [0, 0, 0];
    let dist2 = 0;

    for (let i = 0; i < 3; i++) {
        near[i] = Math.max(-s.half[i], Math.min(s.half[i], local[i]));

        const e = local[i] - near[i];

        dist2 += e * e;
    }

    const out: V3 = [0, 0, 0];

    if (dist2 > 1e-18) {
        const dd = Math.sqrt(dist2);

        if (dd >= r) return false;

        for (let i = 0; i < 3; i++) out[i] = near[i] + (local[i] - near[i]) / dd * r;
    }
    else {
        let best = 0;
        let gap = Number.MAX_VALUE;

        for (let i = 0; i < 3; i++) {
            const g = s.half[i] - Math.abs(local[i]);

            if (g < gap) {
                gap = g;
                best = i;
            }
        }

        out[0] = local[0];
        out[1] = local[1];
        out[2] = local[2];
        out[best] = Math.sign(local[best] === 0 ? 1 : local[best]) * (s.half[best] + r);
    }

    for (let axis = 0; axis < 3; axis++)
        x[axis] = s.p[axis] + out[0] * s.axes[0][axis] + out[1] * s.axes[1][axis] + out[2] * s.axes[2][axis];

    return true;
}

/** If a ball of {@code r} at {@code x} is inside the shape, moves it to the nearest place it just touches and returns true */
export function pushOut(s: Placed, x: V3, r: number): boolean {
    switch (s.shape) {
        case 'sphere':
            return pushFromPoint(x, s.p[0], s.p[1], s.p[2], s.radius + r);
        case 'capsule': {
            const ab: V3 = [s.q[0] - s.p[0], s.q[1] - s.p[1], s.q[2] - s.p[2]];
            const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
            let t = len2 < 1e-12 ? 0 : ((x[0] - s.p[0]) * ab[0] + (x[1] - s.p[1]) * ab[1] + (x[2] - s.p[2]) * ab[2]) / len2;

            t = Math.max(0, Math.min(1, t));

            return pushFromPoint(x, s.p[0] + ab[0] * t, s.p[1] + ab[1] * t, s.p[2] + ab[2] * t, s.radius + r);
        }
        default:
            return pushFromBox(s, x, r);
    }
}

// ---------------------------------------------------------------
// Chains
// ---------------------------------------------------------------

export const CHAIN_ITERATIONS = 4;

export interface ChainParams {
    frequency: number;
    dampingRatio: number;
    inertia: number;
    gravity: number;
    radius: number;
    /** Radians, 0 for no limit */
    maxAngle: number;
    friction: number;
}

export class ChainState {
    readonly x: V3[];
    readonly prev: V3[];
    readonly pin: (V3 | null)[];
    readonly touched: boolean[];
    initialised = false;

    constructor(particles: number) {
        this.x = Array.from({ length: particles }, () => [0, 0, 0] as V3);
        this.prev = Array.from({ length: particles }, () => [0, 0, 0] as V3);
        this.pin = Array.from({ length: particles }, () => null);
        this.touched = Array.from({ length: particles }, () => false);
    }

    snapTo(anim: V3[]): void {
        for (let k = 0; k < this.x.length; k++) {
            this.x[k] = [...anim[k]];
            this.prev[k] = [...anim[k]];
        }

        this.initialised = true;
    }
}

function applyPins(st: ChainState): void {
    for (let k = 0; k < st.x.length; k++) {
        const pin = st.pin[k];

        if (pin) {
            st.x[k] = [...pin];
            st.prev[k] = [...pin];
        }
    }
}

function keepLengthFromParent(st: ChainState, i: number, rest: number): void {
    const a = st.x[i];
    const b = st.x[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (len < 1e-12) return;

    const k = rest / len;

    b[0] = a[0] + dx * k;
    b[1] = a[1] + dy * k;
    b[2] = a[2] + dz * k;
}

function keepLength(st: ChainState, i: number, rest: number): void {
    const a = st.x[i];
    const b = st.x[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (len < 1e-12) return;

    const k = (len - rest) / len;
    const share = i === 0 ? 1.0 : 0.5;

    b[0] -= dx * k * share;
    b[1] -= dy * k * share;
    b[2] -= dz * k * share;

    if (i > 0) {
        a[0] += dx * k * share;
        a[1] += dy * k * share;
        a[2] += dz * k * share;
    }
}

function limitBend(st: ChainState, i: number, rest: number, anim: V3[], maxAngle: number): void {
    let sx = st.x[i + 1][0] - st.x[i][0];
    let sy = st.x[i + 1][1] - st.x[i][1];
    let sz = st.x[i + 1][2] - st.x[i][2];
    let ax = anim[i + 1][0] - anim[i][0];
    let ay = anim[i + 1][1] - anim[i][1];
    let az = anim[i + 1][2] - anim[i][2];
    const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
    const al = Math.sqrt(ax * ax + ay * ay + az * az);

    if (sl < 1e-12 || al < 1e-12) return;

    sx /= sl; sy /= sl; sz /= sl;
    ax /= al; ay /= al; az /= al;

    const dot = Math.max(-1, Math.min(1, sx * ax + sy * ay + sz * az));
    const angle = Math.acos(dot);

    if (angle <= maxAngle) return;

    let perpX = sx - ax * dot;
    let perpY = sy - ay * dot;
    let perpZ = sz - az * dot;
    let pl = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ);

    if (pl < 1e-12) {
        perpX = Math.abs(ax) < 0.9 ? 1 : 0;
        perpY = Math.abs(ax) < 0.9 ? 0 : 1;
        perpZ = 0;

        const d2 = perpX * ax + perpY * ay + perpZ * az;

        perpX -= ax * d2;
        perpY -= ay * d2;
        perpZ -= az * d2;
        pl = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ);
    }

    perpX /= pl; perpY /= pl; perpZ /= pl;

    const c = Math.cos(maxAngle);
    const s = Math.sin(maxAngle);

    st.x[i + 1][0] = st.x[i][0] + (ax * c + perpX * s) * rest;
    st.x[i + 1][1] = st.x[i][1] + (ay * c + perpY * s) * rest;
    st.x[i + 1][2] = st.x[i][2] + (az * c + perpZ * s) * rest;
}

/**
 * One step of a chain: {@code anim} is where the animation puts each particle (world), {@code rest} each segment's length, {@code entityDelta} how far the
 * entity moved this step, {@code colliders} the shapes to push out of
 */
export function chainStep(st: ChainState, p: ChainParams, h: number, anim: V3[], rest: number[], entityDelta: V3, colliders: Placed[]): void {
    const n = st.x.length;
    const omega = 2 * Math.PI * p.frequency;
    const keep = Math.exp(-2 * p.dampingRatio * omega * h);
    const stiffen = 1.0 / (1.0 + h * h * omega * omega);
    const carry = 1.0 - p.inertia;

    st.touched.fill(false);

    for (let k = 1; k < n; k++) {
        for (let a = 0; a < 3; a++) {
            const v = (st.x[k][a] - st.prev[k][a]) * keep;
            const move = entityDelta[a] * carry;

            st.prev[k][a] = st.x[k][a] + move;
            st.x[k][a] += v + move;
        }

        st.x[k][1] -= p.gravity * h * h;
    }

    st.x[0] = [...anim[0]];
    st.prev[0] = [...anim[0]];
    applyPins(st);

    for (let k = 1; k < n; k++) {
        for (let a = 0; a < 3; a++)
            st.x[k][a] = anim[k][a] + (st.x[k][a] - anim[k][a]) * stiffen;
    }

    const tmp: V3 = [0, 0, 0];

    for (let it = 0; it < CHAIN_ITERATIONS; it++) {
        for (let i = 0; i < n - 1; i++) {
            keepLength(st, i, rest[i]);

            if (p.maxAngle > 0) limitBend(st, i, rest[i], anim, p.maxAngle);
        }

        applyPins(st);

        for (let k = 1; k < n; k++) {
            for (const shape of colliders)
                st.touched[k] = pushOut(shape, st.x[k], p.radius) || st.touched[k];
        }

        for (let i = 0; i < n - 1; i++) {
            for (let a = 0; a < 3; a++) tmp[a] = (st.x[i][a] + st.x[i + 1][a]) * 0.5;

            const m0 = tmp[0];
            const m1 = tmp[1];
            const m2 = tmp[2];
            let moved = false;

            for (const shape of colliders)
                moved = pushOut(shape, tmp, p.radius) || moved;

            if (moved) {
                st.touched[i] = (i > 0) || st.touched[i];
                st.touched[i + 1] = true;

                const d: V3 = [tmp[0] - m0, tmp[1] - m1, tmp[2] - m2];

                for (let a = 0; a < 3; a++) {
                    if (i === 0) {
                        st.x[1][a] += d[a] * 2;
                    }
                    else {
                        st.x[i][a] += d[a];
                        st.x[i + 1][a] += d[a];
                    }
                }
            }
        }
    }

    for (let i = 0; i < n - 1; i++) {
        keepLengthFromParent(st, i, rest[i]);

        if (p.maxAngle > 0) limitBend(st, i, rest[i], anim, p.maxAngle);
    }

    for (let k = 1; k < n; k++) {
        for (const shape of colliders)
            st.touched[k] = pushOut(shape, st.x[k], p.radius) || st.touched[k];
    }

    applyPins(st);

    if (p.friction > 0) {
        for (let k = 1; k < n; k++) {
            if (!st.touched[k]) continue;

            for (let a = 0; a < 3; a++)
                st.prev[k][a] = st.x[k][a] - (st.x[k][a] - st.prev[k][a]) * (1.0 - p.friction);
        }
    }
}
