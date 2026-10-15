        /**
 * Collision shapes made from a model's own cubes and meshes: the TypeScript twin of the game's {@code AutoColliders}. A bone with a few cubes gets a box per
 * cube; a detailed bone (more cubes than {@code maxCubes}, or any mesh) is reduced to one low-poly proxy, a capsule if long and thin, else a box. Positions are
 * relative to the bone's pivot in model units, in the bone's own unrotated frame. No Blockbench globals
 */
import { V3 } from './math';

export interface AutoBone {
    readonly name: string;
    readonly parent: string | null;
    /** The bone's pivot, model units */
    readonly origin: V3;
    /** Each cube's corners in the same space as the origin (its own rotation already applied) */
    readonly cubes: readonly (readonly V3[])[];
    /** The corners of any mesh vertices; a bone with a mesh is always simplified */
    readonly meshVertices: readonly V3[];
    readonly hidden: boolean;
}

export interface ColliderSpec {
    readonly bone: string;
    readonly shape: 'sphere' | 'capsule' | 'box';
    /** Sphere: centre. Capsule: one end. Box: centre */
    readonly a: V3;
    /** Capsule: the other end. Box: the full size */
    readonly b: V3;
    readonly radius: number;
    readonly layer: string;
    /** A box's turn on its bone, degrees (z, then y, then x); absent for none */
    readonly rotation?: V3;
}

/** How one bone gets its made shapes: by the rules, none, a box per cube however many, or one proxy */
export type AutoMode = 'auto' | 'off' | 'exact' | 'simple';

export interface AutoOptions {
    readonly maxCubes: number;
    readonly exclude: readonly string[];
    readonly layer: string;
    readonly maxShapes: number;
    /** Per bone; a mode other than auto also overrides the excludes */
    readonly modes?: Readonly<Record<string, AutoMode>>;
    /** Bones that get no made shape (those with shapes of their own) */
    readonly skip?: readonly string[];
}

export const DEFAULT_AUTO: AutoOptions = { maxCubes: 3, exclude: [], layer: 'body', maxShapes: 32 };

const BUILT_IN_EXCLUDE = ['armor*', 'custom*'];
const MIN_EXTENT = 1.0;

/** A bone name against a pattern that may start or end with {@code *} (the game's rule) */
export function matches(pattern: string, name: string): boolean {
    const p = pattern.toLowerCase();
    const n = name.toLowerCase();

    if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return n.includes(p.slice(1, -1));
    if (p.endsWith('*')) return n.startsWith(p.slice(0, -1));
    if (p.startsWith('*')) return n.endsWith(p.slice(1));

    return n === p;
}

type Box = [number, number, number, number, number, number];

const emptyBox = (): Box => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];

function grow(box: Box, points: readonly V3[], origin: V3): void {
    for (const p of points) {
        for (let a = 0; a < 3; a++) {
            const v = p[a] - origin[a];

            box[a] = Math.min(box[a], v);
            box[a + 3] = Math.max(box[a + 3], v);
        }
    }
}

export function generateAutoColliders(bones: readonly AutoBone[], options: AutoOptions = DEFAULT_AUTO): ColliderSpec[] {
    const found: { collider: ColliderSpec; volume: number }[] = [];
    const patterns = [...BUILT_IN_EXCLUDE, ...options.exclude];

    for (const bone of bones) {
        if (options.skip?.includes(bone.name)) continue;

        const mode: AutoMode = options.modes?.[bone.name] ?? 'auto';

        if (mode === 'off' || (mode === 'auto' && (bone.hidden || patterns.some(p => matches(p, bone.name))))) continue;
        if (bone.cubes.length === 0 && bone.meshVertices.length === 0) continue;

        const exact = mode === 'exact' || (mode === 'auto' && bone.cubes.length <= options.maxCubes);

        if (bone.meshVertices.length === 0 && exact) {
            for (const corners of bone.cubes) {
                const box = emptyBox();

                grow(box, corners, bone.origin);

                const size: V3 = [box[3] - box[0], box[4] - box[1], box[5] - box[2]];

                if (Math.max(...size) < MIN_EXTENT) continue;

                found.push({
                    collider: { bone: bone.name, shape: 'box', a: [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2], b: size, radius: 0, layer: options.layer },
                    volume: size[0] * size[1] * size[2],
                });
            }

            continue;
        }

        const box = emptyBox();

        for (const corners of bone.cubes) grow(box, corners, bone.origin);

        grow(box, bone.meshVertices, bone.origin);

        const size: V3 = [box[3] - box[0], box[4] - box[1], box[5] - box[2]];
        const centre: V3 = [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2];
        let longest = 0;

        for (let i = 1; i < 3; i++) if (size[i] > size[longest]) longest = i;

        const a = size[(longest + 1) % 3];
        const c = size[(longest + 2) % 3];
        const thick = Math.max(a, c);

        if (size[longest] < MIN_EXTENT) continue;

        const volume = size[0] * size[1] * size[2];

        if (size[longest] > 2.2 * thick && thick >= 0.5) {
            const radius = (a + c) / 4;
            const half = Math.max(0, size[longest] / 2 - radius);
            const from: V3 = [...centre];
            const to: V3 = [...centre];

            from[longest] = centre[longest] - half;
            to[longest] = centre[longest] + half;
            found.push({ collider: { bone: bone.name, shape: 'capsule', a: from, b: to, radius, layer: options.layer }, volume });
        }
        else {
            found.push({ collider: { bone: bone.name, shape: 'box', a: centre, b: size, radius: 0, layer: options.layer }, volume });
        }
    }

    found.sort((x, y) => y.volume - x.volume);

    return found.slice(0, options.maxShapes).map(f => f.collider);
}

/** Whether {@code shapeBone} is {@code partBone}, one of its ancestors or one of its descendants (by parent name), so a part skips the shapes it is built on */
export function isRelated(shapeBone: string, partBone: string, parents: ReadonlyMap<string, string | null>): boolean {
    const up = (from: string, to: string): boolean => {
        for (let n: string | null | undefined = from; n; n = parents.get(n)) if (n === to) return true;

        return false;
    };

    return up(shapeBone, partBone) || up(partBone, shapeBone);
}
