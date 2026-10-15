import { cubeFaceUvRotationSteps } from '../binary/cubeUv';
import {
    DEFAULT_UNITS_PER_BLOCK, ELEMENT_KIND_CUBE, MODEL_VERSION,
    RawBinaryModel, RawCube, RawCubeFace, RawGroupBone, Vec3,
} from '../binary/model';
import { skeletonFingerprint } from '../binary/fingerprint';
import { StringTable } from '../binary/writer';
import { Findings } from './report';


/**
 * Turns a legacy Bedrock {@code .geo.json} (format 1.12.0 / 1.21.0: {@code "minecraft:geometry"}) into the raw model {@code encodeModel} writes
 * <p>
 * Pure: no Blockbench, no file access. Cubes and bones only, which is everything the Pleasure Horizons models use; meshes, locators, armatures and skinning
 * are reported, not converted
 * <p>
 * <b>Conventions</b>, derived from reading both Java bakers ({@code BakedModelFactory.Builtin} for JSON, {@code BinaryModelBaker} for binary) rather than assumed. The JSON
 * baker negates X, and the binary baker does not (a binary model already holds authoring-space values), so the two agree when the converter writes:
 * <ul>
 * <li>bone pivot {@code (-x, y, z)}, bone rotation {@code (-x, -y, z)} degrees</li>
 * <li>cube {@code from = (-(ox + sx), oy, oz)}, {@code to = (-ox, oy + sy, oz + sz)}; the cube's rotation pivot (stored as {@code origin}) {@code (-x, y, z)};
 *     rotation {@code (-x, -y, z)} degrees; inflate unchanged (pixels)</li>
 * <li>a box {@code uv: [u, v]} is resolved to six per-face rectangles with the same layout the JSON baker uses (sizes floored); a per-face {@code uv} keeps its
 *     origin and size as a rectangle {@code (u, v) to (u + w, v + h)}; a face the JSON does not list is left out</li>
 * </ul>
 * The oracle test ({@code RealModelConverterOracleTest}) bakes the same file both ways and compares every vertex and UV, so these are checked, not trusted
 */
export interface ConvertModelOptions {
    readonly file?: string;
}

export interface ConvertedModel {
    readonly model: RawBinaryModel;
    readonly findings: Findings;
}

const FACES = ['west', 'east', 'north', 'south', 'up', 'down'] as const;
const KNOWN_BONE_KEYS = ['name', 'parent', 'pivot', 'rotation', 'cubes', 'mirror', 'inflate', 'neverRender', 'reset'];
const KNOWN_CUBE_KEYS = ['origin', 'size', 'pivot', 'rotation', 'uv', 'inflate', 'mirror'];

export function convertGeoFile(root: unknown, options: ConvertModelOptions = {}): ConvertedModel {
    const findings = new Findings();
    const file = options.file;
    const geometries = (root as any)?.['minecraft:geometry'];

    if (!Array.isArray(geometries) || geometries.length === 0) {
        findings.add('lossy', 'no "minecraft:geometry" array (only format 1.12.0 and 1.21.0 files are read); nothing converted', { file });

        return { model: emptyModel(), findings };
    }

    if (geometries.length > 1)
        findings.add('lossy', `${geometries.length} geometries in one file; only the first is converted`, { file });

    const geometry = geometries[0];
    const description = geometry?.description ?? {};
    const strings = new StringTable();
    const identifier: string | null = typeof description.identifier === 'string' ? description.identifier : null;
    const textureWidth = numberOr(description.texture_width, 16);
    const textureHeight = numberOr(description.texture_height, 16);
    const textureName = identifier !== null ? identifier.replace(/^geometry\./, '') : 'texture';

    if (identifier !== null)
        strings.intern(identifier);

    strings.intern(textureName);

    const sourceBones: any[] = Array.isArray(geometry?.bones) ? geometry.bones : [];
    const ordered = orderBones(sourceBones, findings, file);
    const indexByName = new Map<string, number>();
    const groupBones: RawGroupBone[] = [];
    const cubes: RawCube[] = [];

    for (const bone of ordered) {
        const name: string = bone.name;
        const where = { file, bone: name };

        for (const key of Object.keys(bone)) {
            if (!KNOWN_BONE_KEYS.includes(key))
                findings.add('lossy', `bone field "${key}" is not carried over`, where);
        }

        if (bone.reset !== undefined)
            findings.add('lossy', 'bone field "reset" is not carried over', where);

        if (bone.neverRender === true)
            findings.add('lossy', 'bone field "neverRender" is not carried over: a model no longer says what is hidden; hide the bone in the game with an override', where);

        if (bone.mirror === true)
            findings.add('info', 'bone-level "mirror" is ignored, as the old JSON loader did (only a cube\'s own mirror counts)', where);

        strings.intern(name);

        const elements: { kind: number; index: number }[] = [];
        const boneCubes: any[] = Array.isArray(bone.cubes) ? bone.cubes : [];

        boneCubes.forEach((cube, i) => {
            const raw = convertCube(cube, `${name}_${i}`, bone, strings, findings, where);

            elements.push({ kind: ELEMENT_KIND_CUBE, index: cubes.length });
            cubes.push(raw);
        });

        indexByName.set(name, groupBones.length);
        groupBones.push({
            name,
            parentIndex: typeof bone.parent === 'string' && indexByName.has(bone.parent) ? indexByName.get(bone.parent)! : -1,
            pivot: mirrorX(vec3(bone.pivot)),
            rotation: negateXY(vec3(bone.rotation)),
            elements,
        });
    }

    const width = numberOr(description.visible_bounds_width, 0);
    const height = numberOr(description.visible_bounds_height, 0);
    const offset = vec3(description.visible_bounds_offset);

    return {
        model: {
            version: MODEL_VERSION,
            modelId: identifier,
            unitsPerBlock: DEFAULT_UNITS_PER_BLOCK,
            // Metadata only: the binary baker does not read it. Bedrock's X is mirrored, so the offset's X is negated
            boundsMin: [-offset[0] - width / 2, offset[1] - height / 2, offset[2] - width / 2],
            boundsMax: [-offset[0] + width / 2, offset[1] + height / 2, offset[2] + width / 2],
            strings: strings.entries(),
            textures: [{ name: textureName, width: textureWidth, height: textureHeight, uvWidth: textureWidth, uvHeight: textureHeight }],
            groupBones,
            meshes: [],
            cubes,
            armatures: [],
        },
        findings,
    };
}

/** The bone names, in the order the raw model lists them: parents before children, children in file order, so it is also a depth-first order */
export function skeletonFingerprintOf(model: RawBinaryModel): number {
    return skeletonFingerprint(model.groupBones.map(bone => bone.name), model.armatures.map(a => a.bones.map(b => b.name)));
}

function emptyModel(): RawBinaryModel {
    return {
        version: MODEL_VERSION, modelId: null, unitsPerBlock: DEFAULT_UNITS_PER_BLOCK, boundsMin: [0, 0, 0], boundsMax: [0, 0, 0],
        strings: [], textures: [], groupBones: [], meshes: [], cubes: [], armatures: [],
    };
}

/**
 * Parents first, depth-first, children in the order the file lists them. A bone naming a parent that does not exist becomes a root (reported), and a
 * duplicate name keeps the first bone (reported), since the baker addresses bones by name
 */
function orderBones(bones: any[], findings: Findings, file?: string): any[] {
    const byName = new Map<string, any>();
    const children = new Map<string, any[]>();
    const roots: any[] = [];

    for (const bone of bones) {
        if (typeof bone?.name !== 'string') {
            findings.add('lossy', 'a bone with no name is skipped', { file });

            continue;
        }

        if (byName.has(bone.name)) {
            findings.add('lossy', `a second bone named "${bone.name}"; only the first is kept`, { file, bone: bone.name });

            continue;
        }

        byName.set(bone.name, bone);
    }

    for (const bone of byName.values()) {
        const parent = typeof bone.parent === 'string' ? bone.parent : null;

        if (parent !== null && byName.has(parent) && parent !== bone.name) {
            const list = children.get(parent) ?? [];

            list.push(bone);
            children.set(parent, list);
        }
        else {
            if (parent !== null)
                findings.add('lossy', `its parent "${parent}" does not exist; it becomes a top-level bone`, { file, bone: bone.name });

            roots.push(bone);
        }
    }

    const ordered: any[] = [];
    const seen = new Set<string>();
    const visit = (bone: any): void => {
        if (seen.has(bone.name))
            return;

        seen.add(bone.name);
        ordered.push(bone);

        for (const child of children.get(bone.name) ?? [])
            visit(child);
    };

    roots.forEach(visit);

    // A cycle (a is b's parent and b is a's) leaves bones unreached; report them rather than loop
    for (const bone of byName.values()) {
        if (!seen.has(bone.name)) {
            findings.add('lossy', 'its parent chain loops back on itself; it becomes a top-level bone', { file, bone: bone.name });
            visit(bone);
        }
    }

    return ordered;
}

function convertCube(cube: any, name: string, bone: any, strings: StringTable, findings: Findings, where: { file?: string; bone?: string }): RawCube {
    for (const key of Object.keys(cube ?? {})) {
        if (!KNOWN_CUBE_KEYS.includes(key))
            findings.add('lossy', `cube field "${key}" is not carried over`, where);
    }

    strings.intern(name);

    const origin = vec3(cube?.origin);
    const size = vec3(cube?.size);
    const boxUV = Array.isArray(cube?.uv);

    // The two bakers disagree here: the JSON one leaves a mirrored box-UV cube's top and bottom faces alone, the binary one swaps them for every mirrored
    // cube (found by the oracle test). Pleasure Horizons has none; a per-face UV mirrored cube agrees in both
    if (boxUV && cube?.mirror === true)
        findings.add('lossy', 'a mirrored cube with a box UV: the binary format draws its top and bottom faces swapped; give it per-face UVs in Blockbench', where);

    return {
        name,
        textureIndex: 0,
        origin: mirrorX(vec3(cube?.pivot)),
        rotation: negateXY(vec3(cube?.rotation)),
        from: [negated(origin[0] + size[0]), origin[1], origin[2]],
        to: [negated(origin[0]), origin[1] + size[1], origin[2] + size[2]],
        inflate: numberOr(cube?.inflate, numberOr(bone?.inflate, 0)),
        mirror: cube?.mirror === true,
        boxUV,
        faces: boxUV ? boxFaces(cube.uv, size) : perFaceFaces(cube?.uv, findings, where),
    };
}

/** The six rectangles of a Bedrock box UV, with the layout and the floored sizes the JSON baker uses */
function boxFaces(uv: number[], size: Vec3): RawCubeFace[] {
    const [u, v] = [numberOr(uv[0], 0), numberOr(uv[1], 0)];
    const [sx, sy, sz] = [Math.floor(size[0]), Math.floor(size[1]), Math.floor(size[2])];
    const rects: Record<string, [number, number, number, number]> = {
        west: [u + sz + sx, v + sz, sz, sy],
        east: [u, v + sz, sz, sy],
        north: [u + sz, v + sz, sx, sy],
        south: [u + sz + sx + sz, v + sz, sx, sy],
        up: [u + sz, v, sx, sz],
        down: [u + sz + sx, v + sz, sx, -sz],
    };

    return FACES.map((direction, faceId) => {
        const [u1, v1, w, h] = rects[direction];

        return { faceId, u1, v1, u2: u1 + w, v2: v1 + h, uvRotation: 0 };
    });
}

function perFaceFaces(uv: unknown, findings: Findings, where: { file?: string; bone?: string }): RawCubeFace[] {
    if (uv === undefined || uv === null || typeof uv !== 'object')
        return [];

    const faces: RawCubeFace[] = [];

    for (const direction of Object.keys(uv as object)) {
        if (!(FACES as readonly string[]).includes(direction))
            findings.add('lossy', `UV face "${direction}" is not one of west, east, north, south, up, down; skipped`, where);
    }

    FACES.forEach((direction, faceId) => {
        const face = (uv as any)[direction];

        if (face === undefined || face === null)
            return;

        const origin: number[] = Array.isArray(face.uv) ? face.uv : [0, 0];
        const extent: number[] = Array.isArray(face.uv_size) ? face.uv_size : [0, 0];
        const u1 = numberOr(origin[0], 0);
        const v1 = numberOr(origin[1], 0);

        faces.push({
            faceId,
            u1,
            v1,
            u2: u1 + numberOr(extent[0], 0),
            v2: v1 + numberOr(extent[1], 0),
            uvRotation: cubeFaceUvRotationSteps(numberOr(face.uv_rotation, 0)),
        });
    });

    return faces;
}

function numberOr(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function vec3(value: unknown): Vec3 {
    if (!Array.isArray(value))
        return [0, 0, 0];

    return [numberOr(value[0], 0), numberOr(value[1], 0), numberOr(value[2], 0)];
}

function negated(value: number): number {
    return value === 0 ? 0 : -value;
}

function mirrorX(value: Vec3): Vec3 {
    return [negated(value[0]), value[1], value[2]];
}

function negateXY(value: Vec3): Vec3 {
    return [negated(value[0]), negated(value[1]), value[2]];
}
