/**
 * The physics description a model carries: JSON text, the same text the game's {@code PhysicsConfig} reads from the {@code strut_physics:physics} extension
 * section of a {@code .strutmodel} or from a sidecar file. This file checks it (mirroring the Java parser's keys, so a typo is found in the editor and not in
 * the game log) and turns it into the section payload. No Blockbench globals
 */

/** The extension section the game looks for */
export const PHYSICS_SECTION = 'strut_physics:physics';

export const SPRING_PRESETS = ['jiggle-soft', 'jiggle-firm', 'hair', 'tail', 'ear', 'soft-bone'] as const;
export const CHAIN_PRESETS = ['hair', 'tail', 'ear'] as const;
export const CLOTH_PRESETS = ['cloth', 'cloth-silk', 'cloth-stiff'] as const;
export const FLESH_PRESETS = ['flesh-soft', 'flesh-firm', 'jelly'] as const;

const TOP_KEYS = ['defaults', 'bones', 'version', 'chains', 'cloth', 'flesh', 'colliders', 'autoColliders', 'ragdoll'];
const BONE_KEYS = ['preset', 'frequency', 'damping', 'inertia', 'gravity', 'rotate', 'translate', 'tip', 'length', 'limit', 'maxTranslate', 'translateScale',
    'weight', 'collidesWith', 'radius', 'squish', 'collideBones', 'ignoreBones'];
const CHAIN_KEYS = ['bones', 'preset', 'frequency', 'damping', 'inertia', 'gravity', 'radius', 'maxAngle', 'tipLength', 'weight', 'friction', 'collidesWith', 'collideBones', 'ignoreBones'];
const CLOTH_KEYS = ['bone', 'mesh', 'preset', 'stiffness', 'bend', 'damping', 'inertia', 'gravity', 'radius', 'pinHeight', 'anchor', 'weight', 'friction', 'iterations',
    'maxParticles', 'volume', 'softCenter', 'softRadius', 'carry', 'collidesWith', 'collideBones', 'ignoreBones'];
const SHAPES = ['sphere', 'capsule', 'box'];

export interface PhysicsCheck {
    /** The parsed document, or null when the text is not a JSON object */
    readonly document: Record<string, any> | null;
    readonly warnings: readonly string[];
    readonly bones: number;
    readonly chains: number;
    readonly cloth: number;
    readonly colliders: number;
    /** Whether the document has a ragdoll skeleton */
    readonly ragdoll: boolean;
}

function isObject(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function vec3(value: unknown): boolean {
    return Array.isArray(value) && value.length === 3 && value.every(n => typeof n === 'number' && Number.isFinite(n));
}

/**
 * Checks {@code text}. Never throws: everything wrong is a warning, and the game applies the same rule (a bad key is skipped, never fatal). {@code boneNames}
 * (when given) lets a bone or collider naming something the model lacks be reported
 */
export function checkPhysics(text: string, boneNames?: readonly string[]): PhysicsCheck {
    const warnings: string[] = [];
    let document: Record<string, any>;

    try {
        const parsed = JSON.parse(text);

        if (!isObject(parsed))
            return { document: null, warnings: ['the physics text must be a JSON object'], bones: 0, chains: 0, cloth: 0, colliders: 0, ragdoll: false };

        document = parsed;
    }
    catch (error) {
        return { document: null, warnings: [`not valid JSON (${(error as Error).message})`], bones: 0, chains: 0, cloth: 0, colliders: 0, ragdoll: false };
    }

    for (const key of Object.keys(document)) {
        if (!TOP_KEYS.includes(key)) warnings.push(`unknown top-level key "${key}"`);
    }

    const known = (name: string, where: string): void => {
        if (boneNames && !boneNames.includes(name)) warnings.push(`${where} names bone "${name}", which the model does not have`);
    };
    const bones = isObject(document.bones) ? document.bones : {};
    const chains = isObject(document.chains) ? document.chains : {};
    const cloth = isObject(document.cloth) ? document.cloth : {};
    const flesh = isObject(document.flesh) ? document.flesh : {};
    const colliders = Array.isArray(document.colliders) ? document.colliders : [];

    if (document.bones !== undefined && !isObject(document.bones)) warnings.push('"bones" must be an object of bone name to settings');
    if (document.chains !== undefined && !isObject(document.chains)) warnings.push('"chains" must be an object of chain name to settings');
    if (document.cloth !== undefined && !isObject(document.cloth)) warnings.push('"cloth" must be an object of cloth name to settings');
    if (document.flesh !== undefined && !isObject(document.flesh)) warnings.push('"flesh" must be an object of flesh name to settings');
    if (document.colliders !== undefined && !Array.isArray(document.colliders)) warnings.push('"colliders" must be a list');

    for (const [name, value] of Object.entries(bones)) {
        const where = `bone "${name}"`;

        known(name, where);

        if (!isObject(value)) {
            warnings.push(`${where} must be an object`);

            continue;
        }

        for (const key of Object.keys(value)) {
            if (!BONE_KEYS.includes(key)) warnings.push(`${where}: unknown key "${key}"`);
        }

        if (value.preset !== undefined && !(SPRING_PRESETS as readonly string[]).includes(value.preset))
            warnings.push(`${where}: unknown preset "${value.preset}" (known: ${SPRING_PRESETS.join(', ')})`);

        if (value.frequency !== undefined && !(typeof value.frequency === 'number' && value.frequency > 0))
            warnings.push(`${where}: "frequency" must be above 0`);

        if (value.length !== undefined && !(typeof value.length === 'number' && value.length > 0))
            warnings.push(`${where}: "length" must be above 0`);

        if (value.tip !== undefined && !vec3(value.tip)) warnings.push(`${where}: "tip" must be [x, y, z]`);
    }

    for (const [name, value] of Object.entries(chains)) {
        const where = `chain "${name}"`;

        if (!isObject(value)) {
            warnings.push(`${where} must be an object`);

            continue;
        }

        if (!Array.isArray(value.bones) || value.bones.length < 1) {
            warnings.push(`${where}: needs a "bones" list of at least one bone`);
        }
        else {
            value.bones.forEach((b: unknown) => known(String(b), where));
        }

        for (const key of Object.keys(value)) {
            if (!CHAIN_KEYS.includes(key)) warnings.push(`${where}: unknown key "${key}"`);
        }

        if (value.preset !== undefined && !(CHAIN_PRESETS as readonly string[]).includes(value.preset))
            warnings.push(`${where}: unknown chain preset "${value.preset}" (known: ${CHAIN_PRESETS.join(', ')})`);
    }

    const soft: [string, any, string, readonly string[]][] = [
        ...Object.entries(cloth).map(([name, value]) => [name, value, 'cloth', CLOTH_PRESETS] as [string, any, string, readonly string[]]),
        ...Object.entries(flesh).map(([name, value]) => [name, value, 'flesh', FLESH_PRESETS] as [string, any, string, readonly string[]]),
    ];

    for (const [name, value, kind, presets] of soft) {
        const where = `${kind} "${name}"`;

        if (!isObject(value)) {
            warnings.push(`${where} must be an object`);

            continue;
        }

        if (typeof value.bone !== 'string') warnings.push(`${where}: needs a "bone" whose mesh is the cloth`);
        else known(value.bone, where);

        for (const key of Object.keys(value)) {
            if (!CLOTH_KEYS.includes(key)) warnings.push(`${where}: unknown key "${key}"`);
        }

        if (value.preset !== undefined && !presets.includes(value.preset))
            warnings.push(`${where}: unknown ${kind} preset "${value.preset}" (known: ${presets.join(', ')})`);
    }

    colliders.forEach((c, i) => {
        const where = `collider #${i}`;

        if (!isObject(c) || typeof c.bone !== 'string' || !SHAPES.includes(c.shape)) {
            warnings.push(`${where}: needs "bone" and a "shape" of ${SHAPES.join(', ')}`);

            return;
        }

        known(c.bone, where);

        const needs = c.shape === 'sphere' ? ['center'] : c.shape === 'capsule' ? ['from', 'to'] : ['center', 'size'];

        for (const key of needs) {
            if (!vec3(c[key])) warnings.push(`${where}: "${key}" must be [x, y, z]`);
        }

        if (c.shape !== 'box' && !(typeof c.radius === 'number' && c.radius > 0)) warnings.push(`${where}: "radius" must be above 0`);
    });

    return {
        document,
        warnings,
        bones: Object.keys(bones).length,
        chains: Object.keys(chains).length,
        cloth: Object.keys(cloth).length + Object.keys(flesh).length,
        colliders: colliders.length,
        ragdoll: isObject(document.ragdoll),
    };
}

/**
 * The section payload for {@code text}: its JSON, compacted, as UTF-8. Returns null for text that is not a JSON object, or for a document that configures
 * nothing (no section is better than an empty one)
 */
export function encodePhysicsSection(text: string): Uint8Array | null {
    const check = checkPhysics(text);

    if (check.document === null || (check.bones === 0 && check.chains === 0 && check.cloth === 0 && check.colliders === 0 && !check.ragdoll)) return null;

    return new TextEncoder().encode(JSON.stringify(check.document));
}

/** The text of a physics section payload */
export function decodePhysicsSection(bytes: Uint8Array): string {
    return new TextDecoder('utf-8').decode(bytes);
}

/** A starting document for a bone list: every bone a soft spring, ready to edit */
export function starterPhysics(boneNames: readonly string[]): string {
    const bones: Record<string, unknown> = {};

    for (const name of boneNames) bones[name] = { preset: 'jiggle-soft' };

    return JSON.stringify({ bones }, null, 2);
}
