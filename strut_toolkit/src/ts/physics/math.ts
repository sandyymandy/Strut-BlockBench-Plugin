/** Small vector and quaternion helpers for the physics rig. Plain arrays so nothing here needs Blockbench or three.js; quaternions are {@code [x, y, z, w]} */

export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: V3): number => Math.sqrt(dot(a, a));

export function normalize(a: V3): V3 {
    const l = length(a);

    return l < 1e-12 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}

export const QI: Q4 = [0, 0, 0, 1];

export function qmul(a: Q4, b: Q4): Q4 {
    return [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
}

/** The inverse of a unit quaternion */
export const qinv = (q: Q4): Q4 => [-q[0], -q[1], -q[2], q[3]];

export function qnormalize(q: Q4): Q4 {
    const l = Math.hypot(q[0], q[1], q[2], q[3]);

    return l < 1e-12 ? [0, 0, 0, 1] : [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Turns {@code v} by {@code q} */
export function qrotate(q: Q4, v: V3): V3 {
    const u: V3 = [q[0], q[1], q[2]];
    const t = scale(cross(u, v), 2);

    return add(add(v, scale(t, q[3])), cross(u, t));
}

/** The rotation that turns unit vector {@code a} onto unit vector {@code b} by the shortest way */
export function qrotationTo(a: V3, b: V3): Q4 {
    const d = dot(a, b);

    if (d > 0.999999) return [0, 0, 0, 1];

    if (d < -0.999999) {
        // opposite: a half turn about any axis perpendicular to a
        let axis = cross([1, 0, 0], a);

        if (length(axis) < 1e-6) axis = cross([0, 1, 0], a);

        axis = normalize(axis);

        return [axis[0], axis[1], axis[2], 0];
    }

    const c = cross(a, b);

    return qnormalize([c[0], c[1], c[2], 1 + d]);
}

/** The rotation of {@code rotationVector.length} radians about the vector's direction (exact, not the small-angle approximation) */
export function qfromRotationVector(r: V3): Q4 {
    const angle = length(r);

    if (angle < 1e-12) return [0, 0, 0, 1];

    const s = Math.sin(angle / 2) / angle;

    return [r[0] * s, r[1] * s, r[2] * s, Math.cos(angle / 2)];
}

export function qslerp(a: Q4, b: Q4, t: number): Q4 {
    let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    let bb: Q4 = b;

    if (cos < 0) {
        cos = -cos;
        bb = [-b[0], -b[1], -b[2], -b[3]];
    }

    if (cos > 0.9995)
        return qnormalize([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);

    const angle = Math.acos(cos);
    const sin = Math.sin(angle);
    const wa = Math.sin((1 - t) * angle) / sin;
    const wb = Math.sin(t * angle) / sin;

    return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}

/** A turn given in degrees about x, y and z, applied z first, then y, then x: the same as JOML's {@code rotationZYX}, which the game uses */
export function qfromEulerDegrees(r: V3): Q4 {
    const half = (d: number): number => d * Math.PI / 360;
    const qx: Q4 = [Math.sin(half(r[0])), 0, 0, Math.cos(half(r[0]))];
    const qy: Q4 = [0, Math.sin(half(r[1])), 0, Math.cos(half(r[1]))];
    const qz: Q4 = [0, 0, Math.sin(half(r[2])), Math.cos(half(r[2]))];

    return qmul(qz, qmul(qy, qx));
}

/** A rotation of {@code radians} about +Y */
export const qaxisY = (radians: number): Q4 => [0, Math.sin(radians / 2), 0, Math.cos(radians / 2)];
