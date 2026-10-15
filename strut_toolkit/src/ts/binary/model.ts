import { BinaryWriter } from './writer';
import { BinaryReader } from './reader';

/**
 * Plain records and codec functions for {@code .strutmodel}, mirroring
 * {@code com.sandymandy.strut.loading.binary.raw.RawBinaryModel} and
 * {@code BinaryModelReader}/{@code BinaryModelBaker}'s write-side counterpart field for field -
 * see {@code docs/BINARY_CODEC_PLAN.md} §4. No Blockbench globals; the adapter that builds these
 * records from live Blockbench objects lives elsewhere
 * <p>
 * Little-endian binary behind a four-byte {@code STMD} magic, laid out as a fixed-width header, a
 * string table, and then one block per element kind:
 * <pre>
 *   [HEADER 64 bytes]
 *   [STRING TABLE]      uint16-length-prefixed UTF-8, indexed everywhere else
 *   [TEXTURES]          name, pixel size, and the UV grid faces are measured against
 *   [GROUP BONES]       the rigid, Bedrock-style hierarchy; geometry hangs off bones
 *   [MESHES]            free-form; skinned ones carry per-vertex influences
 *   [CUBES]             boxes, with per-face UV rectangles or Bedrock box UVs
 *   [ARMATURES]         weighted skeletons
 * </pre>
 */

export const MODEL_MAGIC = 'STMD';
export const MODEL_EXTENSION = 'strutmodel';
/**
 * v101 adds two new fixed fields to every armature bone ({@code width}/{@code colour},
 * round-trip-fidelity-only - see {@link RawBone}'s own doc comment)
 */
export const MODEL_VERSION = 101;
/**
 * Kept at 100 rather than bumped alongside {@link MODEL_VERSION} - real shipped assets already
 * exist at v100, and nothing about v101's addition needs them re-exported; {@code readArmatures}
 * branches on {@code version} exactly once, at each bone's own {@code width}/{@code colour} read,
 * defaulting both to zero for a v100 file
 */
export const MODEL_MIN_VERSION = 100;
export const MODEL_HEADER_BYTES = 64;
/**
 * Header flag bit 0: a trailer of named extension sections follows the armature block ({@code u16} count, then per section a length-prefixed name, a
 * {@code u32} byte length and the bytes). No version bump: a reader that does not know the flag ignores the trailer. The Java mirror is
 * {@code StrutBinaryFormats.MODEL_FLAG_EXTENSIONS}
 */
export const MODEL_FLAG_EXTENSIONS = 1;
const MODEL_RESERVED_V100 = 12;

// Bit 0 of a bone's, a mesh's and a cube's flags once meant "hidden": the editor's visibility switch. It is no longer written (always 0) and no longer read,
// so a model holds geometry and what is shown is the game's business. The bit stays reserved so no other flag moves
export const MESH_FLAG_MIRROR = 2;
export const MESH_FLAG_SKINNED = 4;
/**
 * Adjacent faces blend their normals at a shared vertex instead of each rendering flat. Added
 * after the format's first six stages shipped; safe on an old reader (an unset bit reads as
 * ordinary flat shading) and on an old writer (the bit is simply never set, which is exactly what
 * "flat" already meant) - see {@code StrutBinaryFormats.MESH_FLAG_SMOOTH} on the Java side
 */
export const MESH_FLAG_SMOOTH = 8;

export const CUBE_FLAG_MIRROR = 2;
export const CUBE_FLAG_BOX_UV = 4;

export const ELEMENT_KIND_MESH = 0;
export const ELEMENT_KIND_CUBE = 1;

export const MAX_INFLUENCES = 4;

export const DEFAULT_UNITS_PER_BLOCK = 16;

export type Vec3 = [number, number, number];

export interface RawTexture {
    readonly name: string;
    readonly width: number;
    readonly height: number;
    readonly uvWidth: number;
    readonly uvHeight: number;
}

export interface RawElement {
    /** {@link ELEMENT_KIND_MESH} or {@link ELEMENT_KIND_CUBE} */
    readonly kind: number;
    readonly index: number;
}

export interface RawGroupBone {
    readonly name: string;
    /** -1 for a root */
    readonly parentIndex: number;
    readonly pivot: Vec3;
    readonly rotation: Vec3;
    readonly elements: readonly RawElement[];
}

export interface RawInfluence {
    readonly boneIndex: number;
    readonly weight: number;
}

export interface RawFace {
    /** Indices into the owning mesh's vertex array, one per corner */
    readonly vertices: readonly number[];
    /** Two floats per corner, measured against the texture's UV grid */
    readonly uvs: readonly number[];
}

export interface RawMesh {
    readonly name: string;
    readonly textureIndex: number;
    readonly origin: Vec3;
    readonly rotation: Vec3;
    readonly mirror: boolean;
    /** -1 if unskinned */
    readonly armatureIndex: number;
    /** Three floats per vertex, relative to {@link origin} */
    readonly positions: readonly number[];
    readonly faces: readonly RawFace[];
    /** One entry per vertex, or empty if the mesh is not skinned */
    readonly skin: readonly (readonly RawInfluence[])[];
    /** Whether adjacent faces blend their normals at a shared vertex, rather than each rendering flat */
    readonly smooth: boolean;
}

export interface RawCubeFace {
    /** 0 to 5 */
    readonly faceId: number;
    readonly u1: number;
    readonly v1: number;
    readonly u2: number;
    readonly v2: number;
    /** In 90-degree steps */
    readonly uvRotation: number;
}

export interface RawCube {
    readonly name: string;
    readonly textureIndex: number;
    readonly origin: Vec3;
    readonly rotation: Vec3;
    readonly from: Vec3;
    readonly to: Vec3;
    readonly inflate: number;
    readonly mirror: boolean;
    /** Whether {@link faces} holds Bedrock box UVs rather than per-face rectangles */
    readonly boxUV: boolean;
    readonly faces: readonly RawCubeFace[];
}

export interface RawBone {
    readonly name: string;
    /** -1 for a root */
    readonly parentIndex: number;
    /** This bone's origin, in model units */
    readonly head: Vec3;
    readonly rotation: Vec3;
    /** This bone's length along its own axis, used to place its tail */
    readonly length: number;
    /**
     * This bone's display thickness in Blockbench's own editor - round-trip fidelity only, like
     * {@link length}; nothing in the game engine's own rendering reads it. Added in v101
     */
    readonly width: number;
    /**
     * This bone's display colour, one of Blockbench's own fixed marker colour indices -
     * round-trip fidelity only, same as {@link width}. Added in v101
     */
    readonly colour: number;
}

export interface RawArmature {
    readonly name: string;
    readonly origin: Vec3;
    /** -1 if this armature is a root, otherwise the group bone it hangs off */
    readonly parentGroupBone: number;
    readonly bones: readonly RawBone[];
}

export interface RawBinaryModel {
    readonly version: number;
    /** The identifier the file gives itself, informational only */
    readonly modelId: string | null;
    /** The authoring grid, used by the bake to normalise to Minecraft's 16 */
    readonly unitsPerBlock: number;
    readonly boundsMin: Vec3;
    readonly boundsMax: Vec3;
    readonly strings: readonly string[];
    readonly textures: readonly RawTexture[];
    readonly groupBones: readonly RawGroupBone[];
    readonly meshes: readonly RawMesh[];
    readonly cubes: readonly RawCube[];
    readonly armatures: readonly RawArmature[];
    /** Extension sections by name (for example {@code strut_physics:physics}); absent or empty when the model has none */
    readonly extensions?: ReadonlyMap<string, Uint8Array>;
}

// ===============================================================
// Encode
// ===============================================================

/**
 * Encode a {@link RawBinaryModel} into its wire bytes
 * <p>
 * The caller is responsible for {@link RawBinaryModel#strings} being exactly the first-use
 * interning order every other field's string indices were assigned against - see
 * {@link StringTable}, which the adapter builds this record's indices from before calling here
 */
export function encodeModel(model: RawBinaryModel): Uint8Array {
    const stringTable = new BinaryWriter();

    for (const value of model.strings) {
        stringTable.string(value);
    }

    const textures = new BinaryWriter();

    for (const texture of model.textures) {
        textures.u16(indexOf(model.strings, texture.name, 'texture name'))
            .u16(texture.width).u16(texture.height)
            .u16(texture.uvWidth).u16(texture.uvHeight);
    }

    const groupBones = new BinaryWriter();

    for (const bone of model.groupBones) {
        groupBones.u16(indexOf(model.strings, bone.name, 'bone name'))
            .i16(bone.parentIndex)
            .vec3(...bone.pivot).vec3(...bone.rotation)
            .u8(0)
            .u16(bone.elements.length);

        for (const element of bone.elements) {
            groupBones.u8(element.kind).u16(element.index);
        }
    }

    const meshes = new BinaryWriter();

    for (const mesh of model.meshes) {
        const skinned = mesh.skin.length > 0;
        let flags = 0;

        if (mesh.mirror) flags |= MESH_FLAG_MIRROR;
        if (skinned) flags |= MESH_FLAG_SKINNED;
        if (mesh.smooth) flags |= MESH_FLAG_SMOOTH;

        meshes.u16(indexOf(model.strings, mesh.name, 'mesh name'))
            .u16(mesh.textureIndex)
            .vec3(...mesh.origin).vec3(...mesh.rotation)
            .u8(flags)
            .i16(skinned ? mesh.armatureIndex : -1)
            .u32(mesh.positions.length / 3)
            .u32(mesh.faces.length);

        for (let i = 0; i < mesh.positions.length; i += 3) {
            meshes.vec3(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
        }

        for (const face of mesh.faces) {
            meshes.u8(face.vertices.length);

            for (let c = 0; c < face.vertices.length; c++) {
                meshes.u32(face.vertices[c]).f32(face.uvs[c * 2]).f32(face.uvs[c * 2 + 1]);
            }
        }

        if (skinned) {
            for (const influences of mesh.skin) {
                meshes.u8(influences.length);

                for (const influence of influences) {
                    meshes.u16(influence.boneIndex).f32(influence.weight);
                }
            }
        }
    }

    const cubes = new BinaryWriter();

    for (const cube of model.cubes) {
        let flags = 0;

        if (cube.mirror) flags |= CUBE_FLAG_MIRROR;
        if (cube.boxUV) flags |= CUBE_FLAG_BOX_UV;

        cubes.u16(indexOf(model.strings, cube.name, 'cube name'))
            .u16(cube.textureIndex)
            .vec3(...cube.origin).vec3(...cube.rotation)
            .vec3(...cube.from).vec3(...cube.to)
            .f32(cube.inflate)
            .u8(flags)
            .u8(cube.faces.length);

        for (const face of cube.faces) {
            cubes.u8(face.faceId)
                .f32(face.u1).f32(face.v1).f32(face.u2).f32(face.v2)
                .u8(face.uvRotation);
        }
    }

    const armatures = new BinaryWriter();

    for (const armature of model.armatures) {
        armatures.u16(indexOf(model.strings, armature.name, 'armature name'))
            .vec3(...armature.origin)
            .i16(armature.parentGroupBone)
            .u8(0)
            .u16(armature.bones.length);

        for (const bone of armature.bones) {
            armatures.u16(indexOf(model.strings, bone.name, 'armature bone name'))
                .i16(bone.parentIndex)
                .vec3(...bone.head).vec3(...bone.rotation)
                .f32(bone.length)
                .f32(bone.width)
                .u8(bone.colour)
                .u8(0);
        }
    }

    const extensions = new BinaryWriter();
    const extensionCount = model.extensions?.size ?? 0;

    if (extensionCount > 0) {
        extensions.u16(extensionCount);

        for (const [name, payload] of model.extensions!) {
            extensions.string(name).u32(payload.length).bytes(payload);
        }
    }

    const header = new BinaryWriter(MODEL_HEADER_BYTES);

    header.fixedString(MODEL_MAGIC)
        .u16(MODEL_VERSION)
        .u16(extensionCount > 0 ? MODEL_FLAG_EXTENSIONS : 0)
        .u16(model.strings.length)
        .u16(model.textures.length)
        .u16(model.groupBones.length)
        .u16(model.meshes.length)
        .u16(model.cubes.length)
        .u16(model.armatures.length)
        .u32(stringTable.byteLength)
        .f32(model.unitsPerBlock)
        .vec3(...model.boundsMin).vec3(...model.boundsMax)
        .zeros(MODEL_RESERVED_V100);

    if (header.byteLength !== MODEL_HEADER_BYTES)
        throw new Error(`wrote a ${header.byteLength}-byte model header, expected ${MODEL_HEADER_BYTES}`);

    return new BinaryWriter()
        .append(header).append(stringTable).append(textures)
        .append(groupBones).append(meshes).append(cubes).append(armatures).append(extensions)
        .toBytes();
}

function indexOf(strings: readonly string[], value: string, what: string): number {
    const index = strings.indexOf(value);

    if (index < 0)
        throw new Error(`encoding ${what} "${value}", which is not in the model's own string table`);

    return index;
}

// ===============================================================
// Decode
// ===============================================================

export function decodeModel(bytes: Uint8Array, source: string): RawBinaryModel {
    const reader = new BinaryReader(bytes, source);

    return parseModel(reader);
}

function parseModel(reader: BinaryReader): RawBinaryModel {
    const magic = reader.fixedString(4, 'magic number');

    if (magic !== MODEL_MAGIC)
        throw reader.fail(`does not begin with ${MODEL_MAGIC} (found "${magic}"); it is not a Strut binary model`);

    const version = reader.u16('format version');

    if (version < MODEL_MIN_VERSION)
        throw reader.fail(`is model format version ${version}, which this build no longer reads; the`
            + ` oldest readable version is ${MODEL_MIN_VERSION}. Re-export it`);

    if (version > MODEL_VERSION)
        throw reader.fail(`is model format version ${version}, which is newer than this build`
            + ` understands (${MODEL_VERSION}). Update the plugin, or re-export the model from a`
            + ` matching version`);

    const headerFlags = reader.u16('header flags');

    const stringCount = reader.u16('string count');
    const textureCount = reader.u16('texture count');
    const groupBoneCount = reader.u16('group bone count');
    const meshCount = reader.u16('mesh count');
    const cubeCount = reader.u16('cube count');
    const armatureCount = reader.u16('armature count');
    const stringTableSize = reader.u32('string table size');
    const unitsPerBlock = reader.f32('units per block');
    const boundsMin = reader.vec3('bounds minimum');
    const boundsMax = reader.vec3('bounds maximum');

    reader.skip(MODEL_RESERVED_V100, 'reserved header bytes');

    if (reader.position() !== MODEL_HEADER_BYTES)
        throw reader.fail(`read a ${reader.position()}-byte header for version ${version}; every`
            + ` version's header is exactly ${MODEL_HEADER_BYTES} bytes`);

    if (stringTableSize > reader.remaining())
        throw reader.fail(`declares a ${stringTableSize}-byte string table with only`
            + ` ${reader.remaining()} bytes left after its ${MODEL_HEADER_BYTES}-byte header; the`
            + ` file is truncated`);

    if (unitsPerBlock <= 0 || !Number.isFinite(unitsPerBlock))
        throw reader.fail(`declares ${unitsPerBlock} units per block; the authoring grid must be a`
            + ` positive, finite number`);

    const strings = readStringTable(reader, stringCount);
    const textures = readTextures(reader, textureCount, strings);
    const groupBones = readGroupBones(reader, groupBoneCount, strings, meshCount, cubeCount);
    const meshes = readMeshes(reader, meshCount, strings, textureCount, armatureCount);
    const cubes = readCubes(reader, cubeCount, strings, textureCount);
    const armatures = readArmatures(reader, armatureCount, strings, groupBoneCount, version);
    const extensions = (headerFlags & MODEL_FLAG_EXTENSIONS) !== 0 ? readExtensions(reader) : undefined;

    return {
        version,
        modelId: strings.length > 0 ? strings[0] : null,
        unitsPerBlock,
        boundsMin,
        boundsMax,
        strings,
        textures, groupBones, meshes, cubes, armatures,
        ...(extensions !== undefined ? { extensions } : {}),
    };
}

function readExtensions(reader: BinaryReader): Map<string, Uint8Array> {
    const count = reader.plausibleCount(reader.u16('extension count'), 6, 'extension sections');
    const sections = new Map<string, Uint8Array>();

    for (let i = 0; i < count; i++) {
        const name = reader.string(`extension ${i} name`);
        const length = reader.u32(`extension "${name}" length`);

        if (length > reader.remaining())
            throw reader.fail(`declares a ${length}-byte extension "${name}" with only ${reader.remaining()} bytes left; the file is truncated`);

        if (sections.has(name))
            throw reader.fail(`has two extension sections named "${name}"`);

        sections.set(name, reader.raw(length, `extension "${name}"`));
    }

    return sections;
}

function readStringTable(reader: BinaryReader, count: number): string[] {
    reader.plausibleCount(count, 2, 'strings');

    const strings: string[] = [];

    for (let i = 0; i < count; i++) {
        strings.push(reader.string(`string ${i}`));
    }

    return strings;
}

function resolve(reader: BinaryReader, strings: readonly string[], index: number, what: string): string {
    if (index < 0 || index >= strings.length)
        throw reader.fail(`names ${what} with string index ${index}, but the string table holds`
            + ` ${strings.length} entries`);

    return strings[index];
}

function checkIndex(reader: BinaryReader, index: number, count: number, what: string, block: string): number {
    if (index < 0 || index >= count)
        throw reader.fail(`has ${what} referencing ${block} ${index} of ${count}`);

    return index;
}

function checkParent(reader: BinaryReader, index: number, count: number, what: string): number {
    if (index < -1 || index >= count)
        throw reader.fail(`has ${what} naming parent ${index}, which is neither -1 nor one of the`
            + ` ${count} entries in its own block`);

    return index;
}

function readTextures(reader: BinaryReader, count: number, strings: readonly string[]): RawTexture[] {
    reader.plausibleCount(count, 10, 'textures');

    const textures: RawTexture[] = [];

    for (let i = 0; i < count; i++) {
        const name = resolve(reader, strings, reader.u16(`texture ${i} name`), `texture ${i}`);

        textures.push({
            name,
            width: reader.u16(`texture ${i} width`),
            height: reader.u16(`texture ${i} height`),
            uvWidth: reader.u16(`texture ${i} uv width`),
            uvHeight: reader.u16(`texture ${i} uv height`),
        });
    }

    return textures;
}

function readGroupBones(reader: BinaryReader, count: number, strings: readonly string[],
                         meshCount: number, cubeCount: number): RawGroupBone[] {
    reader.plausibleCount(count, 31, 'group bones');

    const bones: RawGroupBone[] = [];

    for (let i = 0; i < count; i++) {
        const name = resolve(reader, strings, reader.u16(`bone ${i} name`), `bone ${i}`);
        const parentIndex = checkParent(reader, reader.i16(`bone "${name}" parent`), count, `bone "${name}"`);
        const pivot = reader.vec3(`bone "${name}" pivot`);
        const rotation = reader.vec3(`bone "${name}" rotation`);
        reader.u8(`bone "${name}" flags`);

        const elementCount = reader.plausibleCount(reader.u16(`bone "${name}" element count`), 3, 'elements');
        const elements: RawElement[] = [];

        for (let e = 0; e < elementCount; e++) {
            const kind = reader.u8(`element kind of bone "${name}"`);
            const index = reader.u16(`element index of bone "${name}"`);

            switch (kind) {
                case ELEMENT_KIND_MESH: checkIndex(reader, index, meshCount, `bone "${name}"`, 'mesh'); break;
                case ELEMENT_KIND_CUBE: checkIndex(reader, index, cubeCount, `bone "${name}"`, 'cube'); break;
                default: throw reader.fail(`has bone "${name}" holding an element of kind ${kind};`
                    + ` the only kinds are ${ELEMENT_KIND_MESH} (mesh) and ${ELEMENT_KIND_CUBE} (cube)`);
            }

            elements.push({ kind, index });
        }

        bones.push({ name, parentIndex, pivot, rotation, elements });
    }

    return bones;
}

function readFaces(reader: BinaryReader, faceCount: number, vertexCount: number, where: string): RawFace[] {
    const faces: RawFace[] = [];

    for (let f = 0; f < faceCount; f++) {
        const corners = reader.plausibleCount(reader.u8(`${where} face ${f} corner count`), 12, 'face corners');

        if (corners < 3)
            throw reader.fail(`has ${where} face ${f} with ${corners} corner(s); a face needs at least three`);

        const vertices: number[] = [];
        const uvs: number[] = [];

        for (let c = 0; c < corners; c++) {
            vertices.push(checkIndex(reader, reader.u32(`${where} face ${f} corner vertex index`),
                vertexCount, `${where} face ${f}`, 'vertex'));
            uvs.push(reader.f32(`${where} face ${f} corner u`), reader.f32(`${where} face ${f} corner v`));
        }

        faces.push({ vertices, uvs });
    }

    return faces;
}

function readSkin(reader: BinaryReader, vertexCount: number, where: string): RawInfluence[][] {
    const skin: RawInfluence[][] = [];

    for (let v = 0; v < vertexCount; v++) {
        const influenceCount = reader.plausibleCount(reader.u8(`${where} vertex ${v} influence count`), 6,
            `influences of ${where} vertex ${v}`);

        if (influenceCount > MAX_INFLUENCES)
            throw reader.fail(`has ${where} vertex ${v} carrying ${influenceCount} influences; the`
                + ` format allows at most ${MAX_INFLUENCES}, so the exporter did not cap them`);

        const influences: RawInfluence[] = [];

        for (let k = 0; k < influenceCount; k++) {
            influences.push({ boneIndex: reader.u16(`${where} influence bone`), weight: reader.f32(`${where} influence weight`) });
        }

        skin.push(influences);
    }

    return skin;
}

function readMeshes(reader: BinaryReader, count: number, strings: readonly string[],
                     textureCount: number, armatureCount: number): RawMesh[] {
    reader.plausibleCount(count, 39, 'meshes');

    const meshes: RawMesh[] = [];

    for (let i = 0; i < count; i++) {
        const name = resolve(reader, strings, reader.u16(`mesh ${i} name`), `mesh ${i}`);
        const where = `mesh "${name}"`;
        const textureIndex = checkIndex(reader, reader.u16(`${where} texture`), textureCount, where, 'texture');
        const origin = reader.vec3(`${where} origin`);
        const rotation = reader.vec3(`${where} rotation`);
        const flags = reader.u8(`${where} flags`);
        const rawArmatureIndex = reader.i16(`${where} armature`);
        const skinned = (flags & MESH_FLAG_SKINNED) !== 0;

        if (skinned) {
            checkIndex(reader, rawArmatureIndex, armatureCount, where, 'armature');
        }
        else if (rawArmatureIndex !== -1) {
            throw reader.fail(`has ${where} naming armature ${rawArmatureIndex} without being`
                + ` flagged as skinned; an unskinned mesh must name armature -1`);
        }

        const vertexCount = reader.plausibleCount(reader.u32(`${where} vertex count`), 12, `vertices of ${where}`);
        const faceCount = reader.plausibleCount(reader.u32(`${where} face count`), 1, `faces of ${where}`);
        const positions = reader.vec3Array(vertexCount, `${where} vertex`);
        const faces = readFaces(reader, faceCount, vertexCount, where);
        const skin = skinned ? readSkin(reader, vertexCount, where) : [];

        meshes.push({
            name, textureIndex, origin, rotation,
            mirror: (flags & MESH_FLAG_MIRROR) !== 0,
            armatureIndex: skinned ? rawArmatureIndex : -1,
            positions, faces, skin,
            smooth: (flags & MESH_FLAG_SMOOTH) !== 0,
        });
    }

    return meshes;
}

function readCubes(reader: BinaryReader, count: number, strings: readonly string[], textureCount: number): RawCube[] {
    reader.plausibleCount(count, 58, 'cubes');

    const cubes: RawCube[] = [];

    for (let i = 0; i < count; i++) {
        const name = resolve(reader, strings, reader.u16(`cube ${i} name`), `cube ${i}`);
        const where = `cube "${name}"`;
        const textureIndex = checkIndex(reader, reader.u16(`${where} texture`), textureCount, where, 'texture');
        const origin = reader.vec3(`${where} origin`);
        const rotation = reader.vec3(`${where} rotation`);
        const from = reader.vec3(`${where} from`);
        const to = reader.vec3(`${where} to`);
        const inflate = reader.f32(`${where} inflate`);
        const flags = reader.u8(`${where} flags`);

        const faceCount = reader.plausibleCount(reader.u8(`${where} face count`), 18, `faces of ${where}`);

        if (faceCount > 6)
            throw reader.fail(`has ${where} declaring ${faceCount} faces; a box has six`);

        const faces: RawCubeFace[] = [];

        for (let f = 0; f < faceCount; f++) {
            const faceId = reader.u8(`${where} face id`);

            if (faceId > 5)
                throw reader.fail(`has ${where} naming face ${faceId}; a box has six faces, numbered 0 to 5`);

            faces.push({
                faceId,
                u1: reader.f32(`${where} face u1`), v1: reader.f32(`${where} face v1`),
                u2: reader.f32(`${where} face u2`), v2: reader.f32(`${where} face v2`),
                uvRotation: reader.u8(`${where} face uv rotation`),
            });
        }

        cubes.push({
            name, textureIndex, origin, rotation, from, to, inflate,
            mirror: (flags & CUBE_FLAG_MIRROR) !== 0,
            boxUV: (flags & CUBE_FLAG_BOX_UV) !== 0,
            faces,
        });
    }

    return cubes;
}

/**
 * {@code version} gates only one thing: a v100 file's armature bone record has no
 * {@code width}/{@code colour} fields at all (added in v101 - see {@link MODEL_VERSION}'s own doc
 * comment), so those bytes simply aren't there to read on one. Defaulted to zero rather than made
 * optional - both are round-trip-fidelity-only fields nothing in the game engine's own rendering
 * reads, so a v100 asset loading with "no custom width/colour" is exactly as correct as it already
 * was before v101 existed
 */
function readArmatures(reader: BinaryReader, count: number, strings: readonly string[],
                        groupBoneCount: number, version: number): RawArmature[] {
    if (count === 0)
        return [];

    reader.plausibleCount(count, 19, 'armatures');

    const armatures: RawArmature[] = [];

    for (let i = 0; i < count; i++) {
        const name = resolve(reader, strings, reader.u16(`armature ${i} name`), `armature ${i}`);
        const where = `armature "${name}"`;
        const origin = reader.vec3(`${where} origin`);
        const parentGroupBone = checkParent(reader, reader.i16(`${where} parent bone`), groupBoneCount, where);

        reader.u8(`${where} flags`);

        const boneCount = reader.plausibleCount(reader.u16(`${where} bone count`), 33, `bones of ${where}`);
        const bones: RawBone[] = [];

        for (let b = 0; b < boneCount; b++) {
            const boneName = resolve(reader, strings, reader.u16(`${where} bone name`), `${where} bone ${b}`);
            const parentIndex = checkParent(reader, reader.i16(`${where} bone "${boneName}" parent`), boneCount,
                `${where} bone "${boneName}"`);
            const head = reader.vec3(`${where} bone "${boneName}" head`);
            const rotation = reader.vec3(`${where} bone "${boneName}" rotation`);
            const length = reader.f32(`${where} bone "${boneName}" length`);
            const width = version >= 101 ? reader.f32(`${where} bone "${boneName}" width`) : 0;
            const colour = version >= 101 ? reader.u8(`${where} bone "${boneName}" colour`) : 0;
            reader.u8(`${where} bone "${boneName}" flags`);

            bones.push({ name: boneName, parentIndex, head, rotation, length, width, colour });
        }

        armatures.push({ name, origin, parentGroupBone, bones });
    }

    return armatures;
}
