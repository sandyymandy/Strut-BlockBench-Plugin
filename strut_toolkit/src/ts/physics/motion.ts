/** The scripted movements the model is put through in the preview, and the line drawings of colliders. Pure maths; no Blockbench globals */
import { add, cross, normalize, qfromEulerDegrees, qmul, qrotate, scale, V3 } from './math';
import { BoneFrame } from './rig';
import { ColliderSpec } from './autoColliders';

export type MotionKind = 'idle' | 'walk' | 'run' | 'turn' | 'spin' | 'jump';

export const MOTIONS: { id: MotionKind; label: string }[] = [
    { id: 'idle', label: 'Stand still' },
    { id: 'walk', label: 'Walk back and forth' },
    { id: 'run', label: 'Run and stop' },
    { id: 'turn', label: 'Turn side to side' },
    { id: 'spin', label: 'Spin' },
    { id: 'jump', label: 'Jump' },
];

export interface Motion { readonly pos: V3; readonly yaw: number }

/** Where the model is at {@code t} seconds, blocks and radians */
export function motionAt(kind: MotionKind, t: number): Motion {
    switch (kind) {
        case 'walk':
            // back and forth along z with a slow turn at each end: a triangle-ish wave keeps a steady speed between the ends
            return { pos: [0, 0, 1.4 * Math.sin(t * 1.3)], yaw: 0 };
        case 'run': {
            // a 4 second cycle: speed up for 1.5 s, coast for 1, stop hard, stand, then back to the start
            const c = t % 4;
            const d = c < 1.5 ? 1.6 * c * c : c < 2.5 ? 3.6 + 4.8 * (c - 1.5) : 8.4;
            const back = c > 3 ? (c - 3) * 8.4 : 0;

            return { pos: [0, 0, (d - back) * 0.4], yaw: 0 };
        }
        case 'turn':
            return { pos: [0, 0, 0], yaw: 0.9 * Math.sin(t * 2.4) };
        case 'spin':
            return { pos: [0, 0, 0], yaw: t * 3.2 };
        case 'jump':
            return { pos: [0, Math.max(0, 0.9 * Math.sin(t * 5)), 0], yaw: 0 };
        default:
            return { pos: [0, 0, 0], yaw: 0 };
    }
}

// ---------------- collider drawings ----------------

export type Segment = readonly [V3, V3];

function ring(centre: V3, u: V3, v: V3, r: number, n = 16): Segment[] {
    const out: Segment[] = [];
    const point = (i: number): V3 => add(centre, add(scale(u, Math.cos(i / n * 2 * Math.PI) * r), scale(v, Math.sin(i / n * 2 * Math.PI) * r)));

    for (let i = 0; i < n; i++) out.push([point(i), point(i + 1)]);

    return out;
}

/** The lines that outline a collider on its bone, in world blocks */
export function colliderLines(spec: ColliderSpec, frame: BoneFrame): Segment[] {
    const at = (local: V3): V3 => add(frame.origin, qrotate(frame.orientation, scale(local, 1 / 16)));
    const axis = (i: number): V3 => qrotate(frame.orientation, [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0]);
    const lines: Segment[] = [];

    if (spec.shape === 'box') {
        const turn = spec.rotation ? qmul(frame.orientation, qfromEulerDegrees(spec.rotation)) : frame.orientation;
        const axis = (i: number): V3 => qrotate(turn, [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0]);
        const c = at(spec.a);
        const h = [spec.b[0] / 32, spec.b[1] / 32, spec.b[2] / 32];
        const corner = (sx: number, sy: number, sz: number): V3 => add(c, add(add(scale(axis(0), sx * h[0]), scale(axis(1), sy * h[1])), scale(axis(2), sz * h[2])));

        for (const [a, b] of [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7]]) {
            const p = (i: number): V3 => corner(i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1);

            lines.push([p(a), p(b)]);
        }

        return lines;
    }

    const r = spec.radius / 16;

    if (spec.shape === 'sphere') {
        const c = at(spec.a);

        return [...ring(c, axis(0), axis(1), r), ...ring(c, axis(1), axis(2), r), ...ring(c, axis(0), axis(2), r)];
    }

    const a = at(spec.a);
    const b = at(spec.b);
    const dir = normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const u = normalize(cross(dir, Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    const w = cross(dir, u);

    lines.push(...ring(a, u, w, r), ...ring(b, u, w, r));

    for (const s of [u, w, scale(u, -1), scale(w, -1)]) lines.push([add(a, scale(s, r)), add(b, scale(s, r))]);

    return lines;
}

// ---------------- angle limits ----------------

/** The arc a spring bone's lever tip can sweep about one of its own axes between two angles (degrees), from the bone's pivot, in world blocks */
export function limitArc(frame: BoneFrame, lever: V3, axis: 0 | 1 | 2, minDeg: number, maxDeg: number, steps = 20): Segment[] {
    const out: Segment[] = [];
    const point = (deg: number): V3 => {
        const r: V3 = [0, 0, 0];

        r[axis] = deg;

        return add(frame.origin, qrotate(frame.orientation, qrotate(qfromEulerDegrees(r), lever)));
    };

    for (let i = 0; i < steps; i++) {
        const a = minDeg + (maxDeg - minDeg) * i / steps;
        const b = minDeg + (maxDeg - minDeg) * (i + 1) / steps;

        out.push([point(a), point(b)]);
    }

    out.push([frame.origin, point(minDeg)], [frame.origin, point(maxDeg)]);

    return out;
}

/** The cone a chain segment may swing within: {@code maxAngle} degrees about the direction from {@code a} to {@code b}, as a ring and four spokes */
export function limitCone(a: V3, b: V3, maxDeg: number, n = 20): Segment[] {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as V3;
    const len = Math.hypot(d[0], d[1], d[2]);

    if (len < 1e-9 || maxDeg <= 0) return [];

    const dir = normalize(d);
    const u = normalize(cross(dir, Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    const w = cross(dir, u);
    const angle = Math.min(maxDeg, 179) * Math.PI / 180;
    const centre = add(a, scale(dir, Math.cos(angle) * len));
    const r = Math.sin(angle) * len;
    const out: Segment[] = ring(centre, u, w, r, n);

    for (const s of [u, w, scale(u, -1), scale(w, -1)]) out.push([a, add(centre, scale(s, r))]);

    return out;
}
