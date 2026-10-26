/**
 * Cloth and flesh in the plugin: the TypeScript twin of the game's {@code ClothParams}, {@code ClothSolver} and the welding in {@code ClothInstance}. A mesh's
 * vertices are welded into particles, joined by edges that keep their length, folds that resist bending, some of them sewn to the animation, and pushed out
 * of shapes. A golden record written from the Java solver holds this port to it (see {@code golden.test.ts}). No Blockbench globals
 * <p>
 * Not ported: the swept test against blocks (a particle that moves further in one step than it is thick), which the preview's floor and test shapes do not
 * need
 */
import { V3 } from './math';
import { Placed, pushOut } from './solvers';

export interface ClothParams {
    stiffness: number;
    bend: number;
    damping: number;
    inertia: number;
    gravity: number;
    radius: number;
    pinHeight: number;
    anchor: number;
    weight: number;
    collidesWith: string[];
    friction: number;
    iterations: number;
    maxParticles: number;
    volume: number;
    softCenter: V3 | null;
    softRadius: number;
    carry: string[];
    /** Which of the bone's meshes, or -1 for every one */
    mesh: number;
    bone: string;
}

export const CLOTH_PRESET_VALUES: Record<string, Partial<ClothParams>> = {
    cloth: { stiffness: 0.9, bend: 0.15, damping: 0.6, gravity: 9.8, inertia: 0.6 },
    'cloth-silk': { stiffness: 0.8, bend: 0, damping: 0.4, gravity: 7, inertia: 0.7 },
    'cloth-stiff': { stiffness: 1, bend: 0.6, damping: 1.5, gravity: 9.8, anchor: 3, inertia: 0.5 },
};

export const FLESH_PRESET_VALUES: Record<string, Partial<ClothParams>> = {
    'flesh-soft': { anchor: 10, damping: 2.5, volume: 0.6, inertia: 0.9 },
    'flesh-firm': { anchor: 25, damping: 5, volume: 0.4, inertia: 0.8 },
    jelly: { anchor: 4, damping: 1.2, volume: 0.9, inertia: 1, gravity: 1.5 },
};

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** The values a cloth or flesh entry means, the way the game reads it: defaults of the kind, then the preset, then the entry's own keys */
export function resolveCloth(entry: Record<string, any>, flesh: boolean): ClothParams {
    const presets = flesh ? FLESH_PRESET_VALUES : CLOTH_PRESET_VALUES;
    const p: ClothParams = {
        stiffness: flesh ? 0.95 : 0.9, bend: flesh ? 0 : 0.15, damping: flesh ? 3 : 0.6, inertia: flesh ? 0.9 : 0.6, gravity: flesh ? 2 : 9.8, radius: 0.02,
        pinHeight: flesh ? 0 : 0.1, anchor: flesh ? 12 : 0, weight: 1, collidesWith: flesh ? ['other', 'players', 'mobs', 'world'] : ['body', 'world'], friction: 0.3,
        iterations: flesh ? 4 : 6, maxParticles: 600, volume: flesh ? 0.6 : 0, softCenter: null, softRadius: 0, carry: [], mesh: -1, bone: String(entry.bone ?? ''),
    };

    Object.assign(p, presets[entry.preset as string] ?? {});

    if (typeof entry.mesh === 'number') p.mesh = Math.max(-1, Math.floor(entry.mesh));
    p.stiffness = clamp01(num(entry.stiffness, p.stiffness));
    p.bend = clamp01(num(entry.bend, p.bend));
    p.damping = Math.max(0, num(entry.damping, p.damping));
    p.inertia = clamp01(num(entry.inertia, p.inertia));
    p.gravity = num(entry.gravity, p.gravity);
    p.radius = Math.max(0, num(entry.radius, p.radius));
    p.pinHeight = clamp01(num(entry.pinHeight, p.pinHeight));
    p.anchor = Math.max(0, num(entry.anchor, p.anchor));
    p.weight = clamp01(num(entry.weight, p.weight));
    p.friction = clamp01(num(entry.friction, p.friction));
    p.iterations = Math.max(1, Math.min(32, Math.floor(num(entry.iterations, p.iterations))));
    p.maxParticles = Math.max(3, Math.floor(num(entry.maxParticles, p.maxParticles)));
    p.volume = clamp01(num(entry.volume, p.volume));
    p.softRadius = Math.max(0, num(entry.softRadius, p.softRadius));

    if (Array.isArray(entry.softCenter) && entry.softCenter.length === 3) p.softCenter = entry.softCenter.map(Number) as V3;
    if (Array.isArray(entry.collidesWith)) p.collidesWith = entry.collidesWith.map(String);
    if (Array.isArray(entry.carry)) p.carry = entry.carry.map(String);

    return p;
}

// ---------------- welding ----------------

export interface ClothMesh {
    /** Each particle's rest position, blocks */
    rest: V3[];
    /** For each input vertex (by index), the particle it became */
    particleOfVertex: number[];
    /** Three particle indices per triangle */
    triangles: number[];
}

/**
 * Welds a mesh's vertices that sit in the same place into one particle (a seam is stitched), and triangulates its faces (a quad into two triangles, a face that
 * repeats a corner into one). The game welds corners to 1/4096 of a block; so does this
 *
 * @param positions The mesh's vertices, blocks
 * @param faces For each face, the indices of its corners in {@code positions}
 */
export function weld(positions: readonly V3[], faces: readonly (readonly number[])[]): ClothMesh {
    const key = (v: V3): string => `${Math.round(v[0] * 4096)},${Math.round(v[1] * 4096)},${Math.round(v[2] * 4096)}`;
    const byKey = new Map<string, number>();
    const rest: V3[] = [];
    const particleOfVertex = positions.map(v => {
        const k = key(v);
        let at = byKey.get(k);

        if (at === undefined) {
            at = rest.length;
            byKey.set(k, at);
            rest.push([v[0], v[1], v[2]]);
        }

        return at;
    });
    const triangles: number[] = [];

    for (const face of faces) {
        const c = face.map(i => particleOfVertex[i]);

        if (c.length < 3) continue;

        for (let i = 1; i + 1 < c.length; i++) {
            if (c[0] !== c[i] && c[i] !== c[i + 1] && c[0] !== c[i + 1]) triangles.push(c[0], c[i], c[i + 1]);
        }
    }

    return { rest, particleOfVertex, triangles };
}

// ---------------- topology and state ----------------

export class Topology {
    readonly edgeA: number[] = [];
    readonly edgeB: number[] = [];
    readonly edgeRest: number[] = [];
    readonly bendA: number[] = [];
    readonly bendB: number[] = [];
    readonly bendRest: number[] = [];
    readonly adjStart: number[];
    readonly adjOther: number[] = [];
    readonly adjRest: number[] = [];
    restVolume = 0;
    /** The connected pieces of the mesh (two pouches merged into one mesh are two): each one's particles, triangles and rest volume; volume is kept piece by piece */
    readonly pieceParticles: number[][] = [];
    readonly pieceTriangles: number[][] = [];
    readonly pieceVolume: number[] = [];

    constructor(readonly rest: readonly V3[], readonly triangles: readonly number[]) {
        const edges = new Map<string, number[]>();
        const list: number[][] = [];
        const add = (a: number, b: number, opposite: number): void => {
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            const k = `${lo}:${hi}`;
            const e = edges.get(k);

            if (!e) {
                const made = [lo, hi, opposite, -1];

                edges.set(k, made);
                list.push(made);
            }
            else if (e[3] < 0) {
                e[3] = opposite;
            }
        };

        for (let t = 0; t + 2 < triangles.length; t += 3) {
            const a = triangles[t];
            const b = triangles[t + 1];
            const c = triangles[t + 2];

            if (a === b || b === c || a === c) continue;

            add(a, b, c);
            add(b, c, a);
            add(c, a, b);
        }

        for (const e of list) {
            this.edgeA.push(e[0]);
            this.edgeB.push(e[1]);
            this.edgeRest.push(dist(rest[e[0]], rest[e[1]]));

            if (e[3] >= 0 && e[2] !== e[3] && dist(rest[e[2]], rest[e[3]]) > 1e-9) {
                this.bendA.push(e[2]);
                this.bendB.push(e[3]);
                this.bendRest.push(dist(rest[e[2]], rest[e[3]]));
            }
        }

        const n = rest.length;
        const counts = new Array<number>(n + 1).fill(0);

        for (let e = 0; e < this.edgeA.length; e++) {
            counts[this.edgeA[e] + 1]++;
            counts[this.edgeB[e] + 1]++;
        }

        for (let k = 0; k < n; k++) counts[k + 1] += counts[k];

        this.adjStart = counts;

        const fill = counts.slice(0, n);

        this.adjOther.length = this.edgeA.length * 2;
        this.adjRest.length = this.edgeA.length * 2;

        for (let e = 0; e < this.edgeA.length; e++) {
            this.adjOther[fill[this.edgeA[e]]] = this.edgeB[e];
            this.adjRest[fill[this.edgeA[e]]++] = this.edgeRest[e];
            this.adjOther[fill[this.edgeB[e]]] = this.edgeA[e];
            this.adjRest[fill[this.edgeB[e]]++] = this.edgeRest[e];
        }

        const parent = Array.from({ length: n }, (_, i) => i);
        const find = (k: number): number => {
            while (parent[k] !== k) {
                parent[k] = parent[parent[k]];
                k = parent[k];
            }

            return k;
        };

        for (let t = 0; t + 2 < triangles.length; t += 3) {
            parent[find(triangles[t])] = find(triangles[t + 1]);
            parent[find(triangles[t + 1])] = find(triangles[t + 2]);
        }

        const pieceOfRoot = new Map<number, number>();

        for (let k = 0; k < n; k++) {
            const root = find(k);
            let piece = pieceOfRoot.get(root);

            if (piece === undefined) {
                piece = this.pieceParticles.length;
                pieceOfRoot.set(root, piece);
                this.pieceParticles.push([]);
                this.pieceTriangles.push([]);
            }

            this.pieceParticles[piece].push(k);
        }

        for (let t = 0; t + 2 < triangles.length; t += 3) this.pieceTriangles[pieceOfRoot.get(find(triangles[t]))!].push(triangles[t], triangles[t + 1], triangles[t + 2]);

        this.pieceParticles.forEach((members, c) => {
            const v = Math.abs(volumeOf(rest, this.pieceTriangles[c], members).volume);

            this.pieceVolume.push(v);
            this.restVolume += v;
        });
    }
}

function dist(a: readonly number[], b: readonly number[]): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** The signed volume inside {@code triangles}, measured from the centroid, and their surface area */
export function volumeOf(x: readonly (readonly number[])[], triangles: readonly number[], particles?: readonly number[]): { volume: number; area: number } {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    const count = particles ? particles.length : x.length;

    for (let i = 0; i < count; i++) {
        const p = x[particles ? particles[i] : i];

        cx += p[0];
        cy += p[1];
        cz += p[2];
    }

    cx /= count;
    cy /= count;
    cz /= count;

    let v = 0;
    let a = 0;

    for (let t = 0; t + 2 < triangles.length; t += 3) {
        const p = x[triangles[t]];
        const q = x[triangles[t + 1]];
        const r = x[triangles[t + 2]];
        const ax = p[0] - cx; const ay = p[1] - cy; const az = p[2] - cz;
        const bx = q[0] - cx; const by = q[1] - cy; const bz = q[2] - cz;
        const dx = r[0] - cx; const dy = r[1] - cy; const dz = r[2] - cz;
        const nx = (by - ay) * (dz - az) - (bz - az) * (dy - ay);
        const ny = (bz - az) * (dx - ax) - (bx - ax) * (dz - az);
        const nz = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);

        v += (ax * (by * dz - bz * dy) + ay * (bz * dx - bx * dz) + az * (bx * dy - by * dx)) / 6;
        a += 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
    }

    return { volume: v, area: a };
}

export class ClothState {
    readonly x: V3[];
    readonly prev: V3[];
    readonly start: V3[];
    /** 0 free to 1 sewn on */
    readonly pin: number[];
    readonly touched: boolean[];
    readonly hold: (V3 | null)[];
    private readonly level: number[];
    private readonly queue: number[];
    initialised = false;

    constructor(n: number) {
        this.x = Array.from({ length: n }, () => [0, 0, 0] as V3);
        this.prev = Array.from({ length: n }, () => [0, 0, 0] as V3);
        this.start = Array.from({ length: n }, () => [0, 0, 0] as V3);
        this.pin = new Array<number>(n).fill(0);
        this.touched = new Array<boolean>(n).fill(false);
        this.hold = new Array<V3 | null>(n).fill(null);
        this.level = new Array<number>(n).fill(-1);
        this.queue = new Array<number>(n).fill(0);
    }

    snapTo(anim: readonly V3[]): void {
        for (let k = 0; k < this.x.length; k++) {
            this.x[k] = [...anim[k]] as V3;
            this.prev[k] = [...anim[k]] as V3;
        }

        this.initialised = true;
    }

    /** Sets {@link pin} from the mesh and the params: the part outside the soft zone sewn on (blending in), and the top {@code pinHeight} of the mesh sewn on */
    setPins(rest: readonly V3[], p: ClothParams): void {
        this.pin.fill(0);

        if (p.softRadius > 0) {
            const c = p.softCenter ?? [0, 0, 0];

            for (let k = 0; k < rest.length; k++) {
                const t = Math.min(1, Math.hypot(rest[k][0] - c[0], rest[k][1] - c[1], rest[k][2] - c[2]) / p.softRadius);

                this.pin[k] = t * t * (3 - 2 * t);
            }
        }

        if (p.pinHeight > 0) {
            let minY = Infinity;
            let maxY = -Infinity;

            for (const r of rest) {
                minY = Math.min(minY, r[1]);
                maxY = Math.max(maxY, r[1]);
            }

            const threshold = maxY - p.pinHeight * (maxY - minY);

            for (let k = 0; k < rest.length; k++) if (rest[k][1] >= threshold - 1e-6) this.pin[k] = 1;
        }
    }

    // internal scratch for the strain pass
    scratch(): { level: number[]; queue: number[] } {
        return { level: this.level, queue: this.queue };
    }
}

// ---------------- the step ----------------

export function clothStep(topo: Topology, st: ClothState, p: ClothParams, h: number, anim: readonly V3[], entityDelta: V3, colliders: readonly Placed[]): void {
    const n = st.x.length;
    const keep = Math.exp(-p.damping * h);
    const carry = 1 - p.inertia;
    const pull = 1 - Math.exp(-p.anchor * h);

    st.touched.fill(false);

    for (let k = 0; k < n; k++) st.start[k] = [...st.x[k]] as V3;

    for (let k = 0; k < n; k++) {
        if (st.pin[k] >= 0.999 || st.hold[k] !== null) continue;

        for (let a = 0; a < 3; a++) {
            const v = (st.x[k][a] - st.prev[k][a]) * keep;
            const move = entityDelta[a] * carry;

            st.prev[k][a] = st.x[k][a] + move;
            st.x[k][a] += v + move;
        }

        st.x[k][1] -= p.gravity * h * h;

        if (pull > 0) for (let a = 0; a < 3; a++) st.x[k][a] += (anim[k][a] - st.x[k][a]) * pull;
    }

    applyPins(st, anim);

    const stiffness = p.stiffness;
    const bend = p.bend * 0.5;

    for (let it = 0; it < p.iterations; it++) {
        for (let e = 0; e < topo.edgeA.length; e++) relax(st, topo.edgeA[e], topo.edgeB[e], topo.edgeRest[e], stiffness);

        if (bend > 0) for (let b = 0; b < topo.bendA.length; b++) relax(st, topo.bendA[b], topo.bendB[b], topo.bendRest[b], bend);

        applyPins(st, anim);

        if (colliders.length > 0) {
            for (let k = 0; k < n; k++) {
                if (st.pin[k] >= 0.999) continue;

                for (const shape of colliders) st.touched[k] = pushOut(shape, st.x[k], p.radius) || st.touched[k];
            }
        }
    }

    limitStrain(topo, st, 0.02 + (1 - stiffness) * 0.5);

    if (p.volume > 0 && topo.restVolume > 1e-9) restoreVolume(topo, st, p.volume);

    if (colliders.length > 0) {
        const mid: V3 = [0, 0, 0];

        for (let e = 0; e < topo.edgeA.length; e++) {
            const a = topo.edgeA[e];
            const b = topo.edgeB[e];

            for (let axis = 0; axis < 3; axis++) mid[axis] = (st.x[a][axis] + st.x[b][axis]) * 0.5;

            const m: V3 = [mid[0], mid[1], mid[2]];
            let moved = false;

            for (const shape of colliders) moved = pushOut(shape, mid, p.radius) || moved;

            if (moved) {
                for (let axis = 0; axis < 3; axis++) {
                    const d = mid[axis] - m[axis];

                    if (st.pin[a] < 0.999) st.x[a][axis] += d;
                    if (st.pin[b] < 0.999) st.x[b][axis] += d;
                }

                st.touched[a] = true;
                st.touched[b] = true;
            }
        }

        for (let k = 0; k < n; k++) {
            if (st.pin[k] >= 0.999) continue;

            for (const shape of colliders) st.touched[k] = pushOut(shape, st.x[k], p.radius) || st.touched[k];
        }
    }

    applyPins(st, anim);

    if (p.friction > 0) {
        for (let k = 0; k < n; k++) {
            if (!st.touched[k]) continue;

            for (let a = 0; a < 3; a++) st.prev[k][a] = st.x[k][a] - (st.x[k][a] - st.prev[k][a]) * (1 - p.friction);
        }
    }
}

function applyPins(st: ClothState, anim: readonly V3[]): void {
    for (let k = 0; k < st.x.length; k++) {
        const hold = st.hold[k];

        if (hold) {
            st.x[k] = [...hold] as V3;
            st.prev[k] = [...hold] as V3;

            continue;
        }

        const pin = st.pin[k];

        if (pin <= 0) continue;

        if (pin >= 0.999) {
            st.x[k] = [...anim[k]] as V3;
            st.prev[k] = [...anim[k]] as V3;
        }
        else {
            for (let a = 0; a < 3; a++) st.x[k][a] += (anim[k][a] - st.x[k][a]) * pin;
        }
    }
}

function relax(st: ClothState, a: number, b: number, rest: number, strength: number): void {
    const wa = st.hold[a] !== null ? 0 : 1 - st.pin[a];
    const wb = st.hold[b] !== null ? 0 : 1 - st.pin[b];
    const wsum = wa + wb;

    if (wsum < 1e-6) return;

    const pa = st.x[a];
    const pb = st.x[b];
    const dx = pb[0] - pa[0];
    const dy = pb[1] - pa[1];
    const dz = pb[2] - pa[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (len < 1e-12) return;

    const c = (len - rest) / len * strength / wsum;

    pa[0] += dx * c * wa; pa[1] += dy * c * wa; pa[2] += dz * c * wa;
    pb[0] -= dx * c * wb; pb[1] -= dy * c * wb; pb[2] -= dz * c * wb;
}

function limitStrain(topo: Topology, st: ClothState, maxStretch: number): void {
    const { level, queue } = st.scratch();
    const n = st.x.length;
    let head = 0;
    let tail = 0;

    for (let k = 0; k < n; k++) {
        const fixed = st.pin[k] >= 0.999 || st.hold[k] !== null;

        level[k] = fixed ? 0 : -1;

        if (fixed) queue[tail++] = k;
    }

    if (tail === 0) return;

    const grow = 1 + maxStretch;

    while (head < tail) {
        const u = queue[head++];

        for (let i = topo.adjStart[u]; i < topo.adjStart[u + 1]; i++) {
            const v = topo.adjOther[i];

            if (level[v] === 0 || (level[v] > 0 && level[v] <= level[u])) continue;

            if (level[v] < 0) {
                level[v] = level[u] + 1;
                queue[tail++] = v;
            }

            const dx = st.x[v][0] - st.x[u][0];
            const dy = st.x[v][1] - st.x[u][1];
            const dz = st.x[v][2] - st.x[u][2];
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const limit = topo.adjRest[i] * grow;

            if (len <= limit || len < 1e-12) continue;

            const k = limit / len;

            st.x[v][0] = st.x[u][0] + dx * k;
            st.x[v][1] = st.x[u][1] + dy * k;
            st.x[v][2] = st.x[u][2] + dz * k;
        }
    }
}

function restoreVolume(topo: Topology, st: ClothState, strength: number): void {
    topo.pieceVolume.forEach((rest, piece) => {
        if (rest > 1e-9) restorePieceVolume(topo, st, piece, strength);
    });
}

/** One connected piece keeps its own volume, pushed out from its own middle: a merged mesh of two parts is two bodies, not one */
function restorePieceVolume(topo: Topology, st: ClothState, piece: number, strength: number): void {
    const members = topo.pieceParticles[piece];
    const { volume, area } = volumeOf(st.x, topo.pieceTriangles[piece], members);

    if (area < 1e-9) return;

    const push = Math.max(-0.04, Math.min(0.04, (topo.pieceVolume[piece] - Math.abs(volume)) / area * strength));
    let cx = 0;
    let cy = 0;
    let cz = 0;

    for (const k of members) {
        cx += st.x[k][0];
        cy += st.x[k][1];
        cz += st.x[k][2];
    }

    cx /= members.length;
    cy /= members.length;
    cz /= members.length;

    for (const k of members) {
        if (st.pin[k] >= 0.999 || st.hold[k] !== null) continue;

        const dx = st.x[k][0] - cx;
        const dy = st.x[k][1] - cy;
        const dz = st.x[k][2] - cz;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (len < 1e-9) continue;

        const s = push * (1 - st.pin[k]) / len;

        st.x[k][0] += dx * s;
        st.x[k][1] += dy * s;
        st.x[k][2] += dz * s;
    }
}

/** The largest relative difference between an edge's length and its rest length, for tests */
export function worstEdgeError(topo: Topology, st: ClothState): number {
    let worst = 0;

    for (let e = 0; e < topo.edgeA.length; e++) {
        if (topo.edgeRest[e] < 1e-9) continue;

        worst = Math.max(worst, Math.abs(dist(st.x[topo.edgeA[e]], st.x[topo.edgeB[e]]) - topo.edgeRest[e]) / topo.edgeRest[e]);
    }

    return worst;
}

// ---------------- a carried piece ----------------

/** A rotation matrix, row major */
export type M3 = [number, number, number, number, number, number, number, number, number];

const det3 = (m: M3): number => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

function inverseTranspose(m: M3): M3 | null {
    const d = det3(m);

    if (Math.abs(d) < 1e-14) return null;

    // the inverse transpose is the cofactor matrix over the determinant
    return [
        (m[4] * m[8] - m[5] * m[7]) / d, -(m[3] * m[8] - m[5] * m[6]) / d, (m[3] * m[7] - m[4] * m[6]) / d,
        -(m[1] * m[8] - m[2] * m[7]) / d, (m[0] * m[8] - m[2] * m[6]) / d, -(m[0] * m[7] - m[1] * m[6]) / d,
        (m[1] * m[5] - m[2] * m[4]) / d, -(m[0] * m[5] - m[2] * m[3]) / d, (m[0] * m[4] - m[1] * m[3]) / d,
    ];
}

/**
 * The rigid motion that best takes the points {@code from} to the points {@code to}: their two centres and the rotation (the polar factor of their spread,
 * found by averaging the matrix with its inverse transpose until it settles). What a carried mesh (a tip on a pouch) moves by, as one piece
 */
export function rigidFit(from: readonly V3[], to: readonly V3[]): { centreFrom: V3; centreTo: V3; rotation: M3 } {
    const m = from.length;
    const ra: V3 = [0, 0, 0];
    const rc: V3 = [0, 0, 0];

    for (let k = 0; k < m; k++) {
        for (let a = 0; a < 3; a++) {
            ra[a] += from[k][a] / m;
            rc[a] += to[k][a] / m;
        }
    }

    // the spread: sum over points of (to - centre) (from - centre)^T, row i column j
    const s: M3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];

    for (let k = 0; k < m; k++) {
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s[i * 3 + j] += (to[k][i] - rc[i]) * (from[k][j] - ra[j]);
    }

    let r: M3 = [...s] as M3;

    if (Math.abs(det3(r)) > 1e-14) {
        for (let i = 0; i < 12; i++) {
            const next = inverseTranspose(r);

            if (!next) break;

            r = r.map((v, idx) => (v + next[idx]) * 0.5) as M3;
        }
    }
    else {
        r = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    }

    return { centreFrom: ra, centreTo: rc, rotation: r };
}

export function applyRotation(r: M3, v: V3): V3 {
    return [r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[3] * v[0] + r[4] * v[1] + r[5] * v[2], r[6] * v[0] + r[7] * v[1] + r[8] * v[2]];
}

/**
 * The particles around a mesh whose movement it follows: those within the mesh's own size (and a little more) of its middle, at least the six nearest. As in
 * the game, so a carried piece moves the same here
 */
export function fitParticles(rest: readonly V3[], meshVertices: readonly V3[]): number[] {
    if (meshVertices.length === 0) return [];

    const c: V3 = [0, 0, 0];

    for (const v of meshVertices) for (let a = 0; a < 3; a++) c[a] += v[a] / meshVertices.length;

    let reach = 0;

    for (const v of meshVertices) reach = Math.max(reach, dist(v, c));

    const byDistance = rest.map((r, k) => ({ k, d: dist(r, c) })).sort((a, b) => a.d - b.d);
    let count = 0;

    while (count < byDistance.length && (count < 6 || byDistance[count].d <= reach + 0.04)) count++;

    return byDistance.slice(0, count).map(e => e.k);
}
