/**
 * Editing collision shapes and angle limits with controls: a collider as a form (where it is, how big, how it is turned) and back to the game's JSON, fitting
 * one to a bone's geometry, the per-bone choice of how shapes are made from the model, and a spring's per-axis limits. No Blockbench globals
 */
import { AutoBone, AutoMode, ColliderSpec } from './autoColliders';
import { chainNameOf, Doc } from './edit';
import { add, length, normalize, qfromEulerDegrees, qrotate, scale, sub, V3 } from './math';

export type Shape = ColliderSpec['shape'];

/**
 * A collider as the panel edits it, in model units relative to the bone's pivot. A capsule is a centre, a length (between the centres of its round ends) and a
 * tilt: its axis is +Y turned by {@code rotation}; a box is a centre, a size and a turn; a sphere is a centre and a radius
 */
export interface ColliderForm {
    shape: Shape;
    center: V3;
    size: V3;
    radius: number;
    length: number;
    rotation: V3;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r2v = (v: V3): V3 => [r2(v[0]), r2(v[1]), r2(v[2])];

const isV3 = (v: unknown): v is V3 => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));

/** The turn (x and z tilt, degrees) that points +Y along {@code d} */
export function tiltFor(d: V3): V3 {
    const n = normalize(d);

    if (length(n) < 1e-9) return [0, 0, 0];

    return [Math.asin(Math.max(-1, Math.min(1, n[2]))) * 180 / Math.PI, 0, Math.atan2(-n[0], n[1]) * 180 / Math.PI];
}

export function formOf(entry: Record<string, any>): ColliderForm {
    const shape: Shape = entry.shape === 'capsule' || entry.shape === 'box' ? entry.shape : 'sphere';

    if (shape === 'capsule') {
        const from: V3 = isV3(entry.from) ? entry.from : [0, 4, 0];
        const to: V3 = isV3(entry.to) ? entry.to : [0, -4, 0];

        return {
            shape, center: scale(add(from, to), 0.5), size: [4, 4, 4], radius: typeof entry.radius === 'number' ? entry.radius : 2,
            length: length(sub(from, to)), rotation: tiltFor(sub(from, to)),
        };
    }

    if (shape === 'box') {
        return {
            shape, center: isV3(entry.center) ? entry.center : [0, 0, 0], size: isV3(entry.size) ? entry.size : [4, 4, 4], radius: 2, length: 8,
            rotation: isV3(entry.rotation) ? entry.rotation : [0, 0, 0],
        };
    }

    return { shape, center: isV3(entry.center) ? entry.center : [0, 0, 0], size: [4, 4, 4], radius: typeof entry.radius === 'number' ? entry.radius : 2, length: 8, rotation: [0, 0, 0] };
}

/** The game's JSON for a form, keeping the old entry's other keys (its layer) */
export function entryOf(form: ColliderForm, bone: string, old: Record<string, any> = {}): Record<string, any> {
    const layer = typeof old.layer === 'string' ? old.layer : 'body';

    if (form.shape === 'capsule') {
        const axis = scale(qrotate(qfromEulerDegrees(form.rotation), [0, 1, 0]), Math.max(0, form.length) / 2);

        return { bone, shape: 'capsule', from: r2v(add(form.center, axis)), to: r2v(sub(form.center, axis)), radius: r2(Math.max(0.05, form.radius)), layer };
    }

    if (form.shape === 'box') {
        const entry: Record<string, any> = { bone, shape: 'box', center: r2v(form.center), size: r2v(form.size.map(v => Math.max(0.05, Math.abs(v))) as V3), layer };

        if (form.rotation.some(a => Math.abs(a) > 1e-6)) entry.rotation = r2v(form.rotation);

        return entry;
    }

    return { bone, shape: 'sphere', center: r2v(form.center), radius: r2(Math.max(0.05, form.radius)), layer };
}

/** A form of {@code shape} that wraps the bone's own geometry (or a small one at its pivot when it has none) */
export function fitForm(shape: Shape, bone: AutoBone | undefined): ColliderForm {
    const points: V3[] = [];

    if (bone) {
        for (const cube of bone.cubes) points.push(...cube);

        points.push(...bone.meshVertices);
    }

    if (!bone || points.length === 0) return { shape, center: [0, 0, 0], size: [4, 4, 4], radius: 2, length: 4, rotation: [0, 0, 0] };

    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];

    for (const p of points) {
        for (let a = 0; a < 3; a++) {
            lo[a] = Math.min(lo[a], p[a] - bone.origin[a]);
            hi[a] = Math.max(hi[a], p[a] - bone.origin[a]);
        }
    }

    const size: V3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const center: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];

    if (shape === 'box') return { shape, center: r2v(center), size: r2v(size), radius: 2, length: 4, rotation: [0, 0, 0] };

    if (shape === 'sphere') return { shape, center: r2v(center), size, radius: r2(Math.max(size[0], size[1], size[2]) / 2), length: 4, rotation: [0, 0, 0] };

    let longest = 0;

    for (let a = 1; a < 3; a++) if (size[a] > size[longest]) longest = a;

    const radius = (size[(longest + 1) % 3] + size[(longest + 2) % 3]) / 4;
    const dir: V3 = [longest === 0 ? 1 : 0, longest === 1 ? 1 : 0, longest === 2 ? 1 : 0];

    return { shape, center: r2v(center), size, radius: r2(radius), length: r2(Math.max(0, size[longest] - 2 * radius)), rotation: r2v(tiltFor(dir)) };
}

/** The colliders authored on {@code bone}, with their places in the document's list */
export function collidersOn(doc: Doc, bone: string): { index: number; form: ColliderForm }[] {
    const out: { index: number; form: ColliderForm }[] = [];

    (Array.isArray(doc.colliders) ? doc.colliders : []).forEach((c: any, index: number) => {
        if (c && c.bone === bone) out.push({ index, form: formOf(c) });
    });

    return out;
}

export function addColliderForm(doc: Doc, bone: string, form: ColliderForm): { doc: Doc; index: number } {
    const colliders = [...(Array.isArray(doc.colliders) ? doc.colliders : []), entryOf(form, bone)];

    return { doc: { ...doc, colliders }, index: colliders.length - 1 };
}

export function updateColliderAt(doc: Doc, index: number, form: ColliderForm): Doc {
    const colliders = [...(doc.colliders ?? [])];
    const old = colliders[index];

    if (!old) return doc;

    colliders[index] = entryOf(form, old.bone, old);

    return { ...doc, colliders };
}

export function removeColliderAt(doc: Doc, index: number): Doc {
    return { ...doc, colliders: (doc.colliders ?? []).filter((_: unknown, i: number) => i !== index) };
}

// ---------------- how shapes are made from the model, per bone ----------------

export function autoModeOf(doc: Doc, bone: string): AutoMode {
    const a = doc.autoColliders;
    const mode = typeof a === 'object' && a !== null && typeof a.bones === 'object' && a.bones !== null ? a.bones[bone] : undefined;

    return mode === 'off' || mode === 'exact' || mode === 'simple' ? mode : 'auto';
}

/** Tags a bone: its made shapes follow the rules, are left out, are a box per cube, or are one proxy. The model-wide on/off is kept */
export function setAutoMode(doc: Doc, bone: string, mode: AutoMode): Doc {
    const a = doc.autoColliders;
    const base: Record<string, any> = typeof a === 'object' && a !== null ? { ...a } : typeof a === 'boolean' ? { enabled: a } : {};
    const bones: Record<string, string> = { ...(typeof base.bones === 'object' && base.bones !== null ? base.bones : {}) };

    if (mode === 'auto') delete bones[bone];
    else bones[bone] = mode;

    if (Object.keys(bones).length > 0) base.bones = bones;
    else delete base.bones;

    const next: Doc = { ...doc };

    if (Object.keys(base).length === 0) delete next.autoColliders;
    else next.autoColliders = base;

    return next;
}

/** The model-wide switch: null follows the rule (made when something collides with the body), false never. Per-bone tags are kept */
export function setAutoEnabled(doc: Doc, enabled: boolean | null): Doc {
    const a = doc.autoColliders;
    const base: Record<string, any> = typeof a === 'object' && a !== null ? { ...a } : {};

    if (enabled === null) delete base.enabled;
    else base.enabled = enabled;

    const next: Doc = { ...doc };

    if (Object.keys(base).length === 0) delete next.autoColliders;
    else if (Object.keys(base).length === 1 && 'enabled' in base) next.autoColliders = base.enabled;
    else next.autoColliders = base;

    return next;
}

// ---------------- a spring's limits ----------------

export type Limits = { x: [number, number] | null; y: [number, number] | null; z: [number, number] | null };

/** A spring bone's limits in degrees per axis, null for a free axis */
export function springLimits(doc: Doc, bone: string): Limits {
    const limit = doc.bones?.[bone]?.limit;
    const axis = (k: 'x' | 'y' | 'z'): [number, number] | null => {
        const v = limit?.[k];

        return Array.isArray(v) && v.length === 2 && v.every((n: unknown) => typeof n === 'number') ? [v[0], v[1]] : null;
    };

    return { x: axis('x'), y: axis('y'), z: axis('z') };
}

export function setSpringLimits(doc: Doc, bone: string, limits: Limits): Doc {
    if (!doc.bones?.[bone]) return doc;

    const entry = { ...doc.bones[bone] };
    const out: Record<string, [number, number]> = {};

    for (const k of ['x', 'y', 'z'] as const) {
        const v = limits[k];

        if (v) out[k] = [Math.round(Math.min(v[0], v[1])), Math.round(Math.max(v[0], v[1]))];
    }

    if (Object.keys(out).length > 0) entry.limit = out;
    else delete entry.limit;

    return { ...doc, bones: { ...doc.bones, [bone]: entry } };
}

// ---------------- which of its own bones a part collides with ----------------

export interface BoneFilter {
    /** The only bones felt, when not empty */
    only: string[];
    /** Bones never felt */
    ignore: string[];
}

/** Where the part holding {@code bone} is written: a spring bone's entry or its chain's */
function partEntry(doc: Doc, bone: string): { group: 'bones' | 'chains'; name: string } | null {
    if (doc.bones?.[bone]) return { group: 'bones', name: bone };

    const chain = chainNameOf(doc, bone);

    return chain !== null ? { group: 'chains', name: chain } : null;
}

export function boneFilterOf(doc: Doc, bone: string): BoneFilter {
    const at = partEntry(doc, bone);
    const e = at ? doc[at.group][at.name] : {};
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

    return { only: list(e.collideBones), ignore: list(e.ignoreBones) };
}

export function setBoneFilter(doc: Doc, bone: string, filter: BoneFilter): Doc {
    const at = partEntry(doc, bone);

    if (!at) return doc;

    const entry = { ...doc[at.group][at.name] };

    if (filter.only.length) entry.collideBones = [...filter.only];
    else delete entry.collideBones;

    if (filter.ignore.length) entry.ignoreBones = [...filter.ignore];
    else delete entry.ignoreBones;

    return { ...doc, [at.group]: { ...doc[at.group], [at.name]: entry } };
}

/**
 * Ticks or unticks one bone in the part's list. With an allow list ({@code onlyTicked}) the ticked bones are the list; otherwise the unticked ones are the
 * deny list
 */
export function tickBone(filter: BoneFilter, bone: string, ticked: boolean, onlyTicked: boolean): BoneFilter {
    if (onlyTicked) {
        const only = filter.only.filter(b => b !== bone);

        return { only: ticked ? [...only, bone] : only, ignore: [] };
    }

    const ignore = filter.ignore.filter(b => b !== bone);

    return { only: [], ignore: ticked ? ignore : [...ignore, bone] };
}

/** Switches between an allow list and a deny list keeping which bones are ticked */
export function switchFilterMode(filter: BoneFilter, candidates: readonly string[], onlyTicked: boolean): BoneFilter {
    const ticked = candidates.filter(b => (filter.only.length ? filter.only.includes(b) : !filter.ignore.includes(b)));

    return onlyTicked ? { only: ticked, ignore: [] } : { only: [], ignore: candidates.filter(b => !ticked.includes(b)) };
}
