import {
    RawBinaryModel, RawGroupBone, RawMesh, RawCube, RawTexture, RawElement, RawFace, RawCubeFace,
    RawArmature, RawBone, RawInfluence,
    ELEMENT_KIND_MESH, ELEMENT_KIND_CUBE, DEFAULT_UNITS_PER_BLOCK, MODEL_EXTENSION, Vec3, encodeModel, decodeModel,
} from './binary/model';
import { StringTable } from './binary/writer';
import { cubeFaceUvRotationSteps, fileFaceUv, isCubeFaceExported } from './binary/cubeUv';
import { normalizeInfluences } from './binary/skinWeights';
import { format } from './codec';
import { PROPERTY_PHYSICS } from './constants';
import { decodePhysicsSection, encodePhysicsSection, PHYSICS_SECTION } from './physics/config';
import { BONE_COLOUR_SECTION, decodeBoneColours, elementNameFor, encodeBoneColours, markerOf, storedColour } from './boneColours';

/**
 * The live Blockbench adapter: builds a {@link RawBinaryModel} from the current project
 * ({@link buildModel}/{@link exportBinaryModel}), and builds a real, editable project from a
 * decoded one ({@link buildProjectFromModel}/{@link importBinaryModel})
 * <p>
 * Deliberately thin (see {@code docs/BINARY_CODEC_PLAN.md} §4) - this file (along with its
 * animation-side sibling, `strutAnimationCodec.ts`) is the only place that touches Blockbench
 * globals (`Outliner`, `Project`, `Group`, `Cube`, `Mesh`, `Texture`, `Armature`), and is not
 * unit-testable the way `ts/binary/*.ts` is; its correctness is covered by the export → import →
 * export gate and the Java cross-check instead (§5)
 * <p>
 * Stages 2-4: geometry, model import, and now armatures/skin weights. What actually drives
 * skinning is which armature's bones carry a positive `getVertexWeight` on a mesh's vertices, not
 * `Mesh#getArmature()` - real Blockbench source shows that method as a bare
 * `this.parent instanceof Armature` check, no walk up the outliner, so it only ever answers "is
 * this mesh the Armature's own direct child" - see `findBoundArmatureUuid`'s own doc comment.
 * Weights are read and written exclusively through `ArmatureBone#getVertexWeight`/`setVertexWeight`
 * rather than by hand-rolling the `vertex_weights` map's internal key format, which is not part of
 * the public surface this file otherwise restricts itself to
 */

/** Bedrock's own face-id numbering, matching {@code CUBE_FACE_IDS} in `bbmodel_to_strutmodel.py` */
const CUBE_FACE_IDS: Record<string, number> = { west: 0, east: 1, north: 2, south: 3, up: 4, down: 5 };
const CUBE_FACE_DIRECTIONS: Record<number, string> = { 0: 'west', 1: 'east', 2: 'north', 3: 'south', 4: 'up', 5: 'down' };

class Bounds {
    private min: [number, number, number] = [Infinity, Infinity, Infinity];
    private max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    private touched = false;

    expand(x: number, y: number, z: number): void {
        this.touched = true;
        this.min[0] = Math.min(this.min[0], x); this.max[0] = Math.max(this.max[0], x);
        this.min[1] = Math.min(this.min[1], y); this.max[1] = Math.max(this.max[1], y);
        this.min[2] = Math.min(this.min[2], z); this.max[2] = Math.max(this.max[2], z);
    }

    result(): { min: Vec3; max: Vec3 } {
        if (!this.touched)
            return { min: [0, 0, 0], max: [0, 0, 0] };

        return { min: [...this.min] as Vec3, max: [...this.max] as Vec3 };
    }
}

interface BoneAccumulator {
    name: string;
    parentIndex: number;
    pivot: Vec3;
    rotation: Vec3;
    elements: RawElement[];
}

/**
 * Whether any {@code Group} exists anywhere in the outliner tree - determines whether a
 * top-level (parentless) mesh or cube is skipped (there is a real hierarchy to belong to, and it
 * chose not to) or gathered under a synthesized root bone (there is no hierarchy at all), exactly
 * matching `bbmodel_to_strutmodel.py`'s `flatten_outliner` fallback
 */
function outlinerHasGroup(nodes: any[]): boolean {
    for (const node of nodes) {
        if (node instanceof Group)
            return true;

        if (Array.isArray(node.children) && outlinerHasGroup(node.children))
            return true;
    }

    return false;
}

/**
 * Export the current project as a `.strutmodel` file, via a native save dialog
 * <p>
 * Uses {@code Filesystem.exportFile} directly (the same API a real binary-format codec like the
 * bundled FBX exporter uses) rather than {@code Blockbench.export}'s monkeypatch-routed path -
 * this is a new resource id (`strut_model`) that none of this file's own `Blockbench.export`
 * patches in `events.ts` have any special handling for, so there is nothing to gain by routing
 * through it. {@code content} is passed as the encoded bytes' own `ArrayBuffer` directly;
 * `Filesystem.writeFile` on the desktop app writes an `ArrayBuffer` to disk unmodified (confirmed
 * against real Blockbench 5.1.6 source), no base64 or string conversion needed
 */
export function exportBinaryModel(unitsPerBlock?: number): void {
    const model = buildModel(unitsPerBlock);
    const bytes = encodeModel(model);

    // bytes.buffer is BinaryWriter's own (possibly over-allocated, doubling-growth) backing
    // buffer - slicing to exactly bytes.byteLength is what keeps a half-grown buffer's unused
    // tail out of the exported file
    const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    Filesystem.exportFile({
        resource_id: 'strut_model',
        type: 'Strut Binary Model',
        extensions: [MODEL_EXTENSION],
        name: model.modelId || 'model',
        content: exact,
        savetype: 'binary',
    });
}

/**
 * Exports {@code groups} of the project as an armour slot model named {@code name}: only their geometry, with the groups above them kept empty (see
 * {@link buildModel}'s {@code selection})
 */
export function exportSlotGroups(groups: Set<any>, name: string): void {
    const model = buildModel(DEFAULT_UNITS_PER_BLOCK, groups, name);
    const bytes = encodeModel(model);
    const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    Filesystem.exportFile({
        resource_id: 'strut_model',
        type: 'Strut Binary Model',
        extensions: [MODEL_EXTENSION],
        name: name || 'armour',
        content: exact,
        savetype: 'binary',
    });
}

/**
 * Build a {@link RawBinaryModel} from the current project
 *
 * @param unitsPerBlock The authoring grid the project was built on - Minecraft's own is 16
 */
export function buildModel(unitsPerBlock: number = DEFAULT_UNITS_PER_BLOCK, selection?: Set<any>, modelIdOverride?: string): RawBinaryModel {
    const strings = new StringTable();

    // By convention the model's own identifier is interned first, so it lands at string index 0 -
    // see RawBinaryModel#modelId's own doc comment on the Java side
    const modelId: string = modelIdOverride || (Project as any).model_identifier || (Project as any).name || 'model';

    strings.intern(modelId);

    const projectTextures: any[] = (Project as any).textures || [];
    const textures: RawTexture[] = [];
    const textureIndexByUuid = new Map<string, number>();

    for (const texture of projectTextures) {
        textureIndexByUuid.set(texture.uuid, textures.length);
        strings.intern(texture.name);
        textures.push({
            name: texture.name,
            width: texture.width,
            height: texture.height,
            uvWidth: texture.uv_width,
            uvHeight: texture.uv_height,
        });
    }

    if (textures.length === 0) {
        strings.intern('missing');
        textures.push({ name: 'missing', width: 16, height: 16, uvWidth: 16, uvHeight: 16 });
    }

    const outlinerRoot: any[] = (Outliner as any).root || [];
    const hasAnyGroup = outlinerHasGroup(outlinerRoot);

    const bones: BoneAccumulator[] = [];
    // the marker colour of each bone, as stored (see boneColours.ts), in the order of the bones
    const boneColours: number[] = [];
    const meshes: RawMesh[] = [];
    const cubes: RawCube[] = [];
    const bounds = new Bounds();
    const warnings: string[] = [];

    // Armatures are registered as they're encountered in the outliner walk (so a warning fires
    // for one outside any group exactly like a top-level mesh/cube), but their skin data can only
    // be resolved once every armature in the project has a known index and bone list - a mesh can
    // reference an armature by uuid regardless of where either sits in the outliner. So this pass
    // only records the live node plus its owning group bone; buildArmatures() below does the rest
    const armatureNodes: { node: any; ownerIndex: number }[] = [];
    // Parallel to `meshes` - the live Mesh object and the vertex-key order addMesh() built
    // `positions` from, needed to resolve skin weights per vertex after all armatures are known
    const meshLiveRecords: { live: any; vkeys: string[] }[] = [];

    if (!hasAnyGroup) {
        strings.intern('root');
        bones.push({ name: 'root', parentIndex: -1, pivot: [0, 0, 0], rotation: [0, 0, 0], elements: [] });
        boneColours.push(0);
    }

    function textureIndexOf(uuid: string | undefined): number | undefined {
        return uuid === undefined ? undefined : textureIndexByUuid.get(uuid);
    }

    function addMesh(mesh: any, ownerIndex: number): void {
        const meshIndex = meshes.length;

        bones[ownerIndex].elements.push({ kind: ELEMENT_KIND_MESH, index: meshIndex });
        strings.intern(mesh.name);

        const origin: Vec3 = [mesh.origin[0], mesh.origin[1], mesh.origin[2]];
        const vkeys = Object.keys(mesh.vertices);
        const vertexIndexByKey = new Map<string, number>();
        const positions: number[] = [];

        vkeys.forEach((vkey, i) => {
            vertexIndexByKey.set(vkey, i);

            const [x, y, z] = mesh.vertices[vkey];

            positions.push(x, y, z);
            bounds.expand(x + origin[0], y + origin[1], z + origin[2]);
        });

        const faceKeys = Object.keys(mesh.faces).filter(fkey => mesh.faces[fkey].vertices.length >= 3);

        let textureIndex = 0;
        let foundTexture = false;

        const faces: RawFace[] = faceKeys.map(fkey => {
            const face = mesh.faces[fkey];
            // getSortedVertices() is the same winding-correction Blockbench's own getSaveCopy()
            // and Bedrock compilers use, rather than trusting the face's raw authoring-order array
            const sorted: string[] = typeof face.getSortedVertices === 'function' ? face.getSortedVertices() : face.vertices;

            if (!foundTexture) {
                const texture = typeof face.getTexture === 'function' ? face.getTexture() : null;
                const index = texture ? textureIndexOf(texture.uuid) : undefined;

                if (index !== undefined) {
                    textureIndex = index;
                    foundTexture = true;
                }
            }

            const vertices = sorted.map((vkey: string) => vertexIndexByKey.get(vkey) as number);
            const uvs: number[] = [];

            for (const vkey of sorted) {
                const uv = face.uv[vkey] || [0, 0];

                uvs.push(uv[0], uv[1]);
            }

            return { vertices, uvs };
        });

        meshes.push({
            name: mesh.name,
            textureIndex,
            origin,
            rotation: (mesh.rotation ? [mesh.rotation[0], mesh.rotation[1], mesh.rotation[2]] : [0, 0, 0]) as Vec3,
            // Mesh carries no mirror-like property in Blockbench 5.1.6 (confirmed against real
            // source) - only Cube's mirror_uv has a live field to read, so this is always false
            mirror: false,
            // Placeholder - buildArmatures() fills this in for meshes with a live armature, once
            // every armature in the project is known
            armatureIndex: -1,
            positions,
            faces,
            skin: [],
            smooth: mesh.shading === 'smooth',
        });

        meshLiveRecords.push({ live: mesh, vkeys });
    }

    function addCube(cube: any, ownerIndex: number): void {
        const cubeIndex = cubes.length;

        bones[ownerIndex].elements.push({ kind: ELEMENT_KIND_CUBE, index: cubeIndex });
        strings.intern(cube.name);

        const from: Vec3 = [cube.from[0], cube.from[1], cube.from[2]];
        const to: Vec3 = [cube.to[0], cube.to[1], cube.to[2]];

        bounds.expand(from[0], from[1], from[2]);
        bounds.expand(to[0], to[1], to[2]);

        let textureIndex = 0;
        let foundTexture = false;
        const faces: RawCubeFace[] = [];

        for (const direction of Object.keys(cube.faces)) {
            const faceId = CUBE_FACE_IDS[direction];

            if (faceId === undefined)
                continue;

            const face = cube.faces[direction];

            // Live-verified: a rig with five of a cube's six faces blanked still exported all six,
            // each with a real UV rectangle, because a blanked face carries `texture: null` while
            // `enabled` stays at its default `true` - see isCubeFaceExported's own doc comment for
            // why `texture === null` is the signal, and why the strict null check matters
            if (!isCubeFaceExported(face))
                continue;

            if (!foundTexture) {
                const texture = typeof face.getTexture === 'function' ? face.getTexture() : null;
                const index = texture ? textureIndexOf(texture.uuid) : undefined;

                if (index !== undefined) {
                    textureIndex = index;
                    foundTexture = true;
                }
            }

            const [u1, v1, u2, v2] = fileFaceUv(direction, face.uv);

            faces.push({ faceId, u1, v1, u2, v2, uvRotation: cubeFaceUvRotationSteps(face.rotation) });
        }

        cubes.push({
            name: cube.name,
            textureIndex,
            origin: [cube.origin[0], cube.origin[1], cube.origin[2]],
            rotation: [cube.rotation[0], cube.rotation[1], cube.rotation[2]],
            from,
            to,
            inflate: cube.inflate || 0,
            // Blockbench's "mirror UV" is already in the faces' rectangles: the east and west faces swap their regions and every face's u range is flipped (u1 above
            // u2), whether the cube is in box UV or in per-face UV mode. Sending the flag as well made the baker flip them again (it swaps the east and west faces'
            // corners and takes the opposite end of each u range, which is what a Bedrock geometry file's mirror means), so a mirrored cube showed the wrong part of the
            // texture. The flag stays in the format for the geometry converter, whose faces are not flipped
            mirror: false,
            boxUV: cube.box_uv === true,
            faces,
        });
    }

    // With a selection (an armour slot model), only the geometry inside the selected groups is exported, and every group that is above one of them is kept
    // empty: the worn model is posed on its wearer by bone name, so the chain of bones above the piece has to be there, with the same pivots, to carry the
    // wearer's pose down to it. Groups beside the piece and armatures are left out
    function groupHasSelection(group: any): boolean {
        if (selection!.has(group))
            return true;

        return Array.isArray(group.children) && group.children.some((child: any) => child instanceof Group && groupHasSelection(child));
    }

    function visit(node: any, parentIndex: number, inSelection: boolean = false): void {
        if (selection !== undefined) {
            if (node instanceof Group) {
                const selected = inSelection || selection.has(node);

                if (!selected && !groupHasSelection(node))
                    return;

                inSelection = selected;
            }
            else if (node instanceof Armature || !inSelection) {
                return;
            }
        }

        if (node instanceof Armature) {
            const owner = hasAnyGroup ? parentIndex : 0;

            if (owner < 0) {
                warnings.push(`"${node.name}" is not under any group; skipped`);

                return;
            }

            armatureNodes.push({ node, ownerIndex: owner });

            // Armature is a transparent container as far as geometry ownership goes: a mesh
            // nested under it still attaches to the enclosing group bone, exactly as if the
            // armature were not there. Its own children who are ArmatureBones fall through
            // every instanceof check below and are silently skipped here - they're walked
            // separately, from the live Armature object itself, in buildArmatures()
            for (const child of node.children) {
                visit(child, owner);
            }

            return;
        }

        if (node instanceof Group) {
            const index = bones.length;

            strings.intern(node.name);
            bones.push({
                name: node.name,
                parentIndex,
                pivot: [node.origin[0], node.origin[1], node.origin[2]],
                rotation: [node.rotation[0], node.rotation[1], node.rotation[2]],
                elements: [],
            });
            boneColours.push(storedColour(node.color));

            for (const child of node.children) {
                visit(child, index, inSelection);
            }

            return;
        }

        if (node instanceof Mesh || node instanceof Cube) {
            const owner = hasAnyGroup ? parentIndex : 0;

            if (owner < 0) {
                warnings.push(`"${node.name}" is not under any group; skipped`);

                return;
            }

            if (node instanceof Mesh) {
                addMesh(node, owner);
            }
            else {
                addCube(node, owner);
            }
        }

        // NullObject, Locator and anything else: not this stage's job
    }

    for (const node of outlinerRoot) {
        visit(node, -1);
    }

    const armatures = buildArmatures(armatureNodes, meshLiveRecords, meshes, strings);

    for (const warning of warnings) {
        console.warn(`[Strut] ${warning}`);
    }

    const { min, max } = bounds.result();
    const physics = selection !== undefined ? null : encodePhysicsSection(String((Project as any)[PROPERTY_PHYSICS] ?? ''));
    const colours = encodeBoneColours(boneColours);
    const sections = new Map<string, Uint8Array>();

    if (physics !== null)
        sections.set(PHYSICS_SECTION, physics);

    if (colours !== null)
        sections.set(BONE_COLOUR_SECTION, colours);

    return {
        ...(sections.size > 0 ? { extensions: sections } : {}),
        version: 100,
        modelId,
        unitsPerBlock,
        boundsMin: min,
        boundsMax: max,
        strings: strings.entries(),
        textures,
        groupBones: bones.map((bone): RawGroupBone => ({
            name: bone.name,
            parentIndex: bone.parentIndex,
            pivot: bone.pivot,
            rotation: bone.rotation,
            elements: bone.elements,
        })),
        meshes,
        cubes,
        armatures,
    };
}

/**
 * Register every armature the outliner walk found, in encounter order, and resolve skin weights
 * for every mesh bound to one. Mutates {@code meshes} in place to fill in the
 * {@code armatureIndex}/{@code skin} placeholders {@link addMesh} left behind
 * <p>
 * Binding is detected by probing every armature's own bones for a positive
 * {@code getVertexWeight} on this mesh, not by {@code Mesh#getArmature()} - real Blockbench source
 * (`bb5_mesh.src`) shows that method is {@code this.parent instanceof Armature ? this.parent :
 * undefined}, a bare immediate-parent check with no walk up the outliner, unlike
 * {@code ArmatureBone#getArmature()}'s own version of the same idea, which does walk up. That
 * makes it too strict for this plugin's own model: a mesh weight-painted through Blockbench's
 * native tool keeps working (and keeps rendering correctly in Blockbench's own viewport) however
 * far it sits from the Armature node in the outliner, entirely through `vertex_weights` on the
 * bones themselves - nothing about that requires the mesh to be the Armature's own direct child.
 * A mesh should be free to sit as an ordinary child anywhere in the group hierarchy, exactly like
 * an unskinned one, while still carrying skin capability - probing the actual weight data is what
 * makes that true regardless of nesting, matching how the mesh is bound in every other sense
 */
function buildArmatures(
    armatureNodes: { node: any; ownerIndex: number }[],
    meshLiveRecords: { live: any; vkeys: string[] }[],
    meshes: RawMesh[],
    strings: StringTable,
): RawArmature[] {
    const armatureIndexByUuid = new Map<string, number>();
    const boneIndexByUuidPerArmature = new Map<string, Map<string, number>>();
    const liveBonesByUuid = new Map<string, any[]>();

    const armatures: RawArmature[] = armatureNodes.map(({ node, ownerIndex }, armatureIndex) => {
        armatureIndexByUuid.set(node.uuid, armatureIndex);
        strings.intern(node.name);

        const liveBones: any[] = typeof node.getAllBones === 'function' ? node.getAllBones() : [];
        const boneIndexByUuid = new Map<string, number>();

        liveBones.forEach((bone, i) => boneIndexByUuid.set(bone.uuid, i));
        boneIndexByUuidPerArmature.set(node.uuid, boneIndexByUuid);
        liveBonesByUuid.set(node.uuid, liveBones);

        const bones: RawBone[] = liveBones.map((bone): RawBone => {
            strings.intern(bone.name);

            const parent = bone.parent;
            const parentIndex = parent instanceof ArmatureBone ? boneIndexByUuid.get(parent.uuid) ?? -1 : -1;

            return {
                name: bone.name,
                parentIndex,
                head: [bone.origin[0], bone.origin[1], bone.origin[2]],
                rotation: [bone.rotation[0], bone.rotation[1], bone.rotation[2]],
                length: bone.length || 0,
                width: bone.width || 0,
                colour: bone.color || 0,
            };
        });

        return {
            name: node.name,
            origin: [node.origin[0], node.origin[1], node.origin[2]],
            parentGroupBone: ownerIndex,
            bones,
        };
    });

    meshLiveRecords.forEach(({ live, vkeys }, meshIndex) => {
        const armatureUuid = findBoundArmatureUuid(live, vkeys, armatureNodes, liveBonesByUuid);

        if (armatureUuid === undefined)
            return;

        const armatureIndex = armatureIndexByUuid.get(armatureUuid) as number;
        const boneIndexByUuid = boneIndexByUuidPerArmature.get(armatureUuid) as Map<string, number>;
        const liveBones = liveBonesByUuid.get(armatureUuid) as any[];

        (meshes[meshIndex] as any).armatureIndex = armatureIndex;
        (meshes[meshIndex] as any).skin = buildSkinForVertices(live, vkeys, liveBones, boneIndexByUuid);
    });

    return armatures;
}

/**
 * The armature (if any) actually carrying weight on this mesh's vertices - see {@link buildArmatures}'s
 * own doc comment for why this asks the weight data directly rather than trusting
 * {@code Mesh#getArmature()}'s stricter immediate-parent notion
 * <p>
 * {@code Mesh#getArmature()} is tried first regardless, as a cheap common-case shortcut (a mesh
 * authored as the Armature's own direct child, which {@code getVertexWeight} would answer the same
 * way anyway, just slower) - the fallback below is what makes a mesh sitting anywhere else in the
 * group hierarchy work too. Stops at the first armature with any positive weight on this mesh,
 * since one mesh skinned to two different armatures at once is not a shape this format supports
 */
function findBoundArmatureUuid(live: any, vkeys: string[], armatureNodes: { node: any; ownerIndex: number }[],
                                liveBonesByUuid: Map<string, any[]>): string | undefined {
    const direct = typeof live.getArmature === 'function' ? live.getArmature() : undefined;

    if (direct)
        return direct.uuid;

    for (const { node } of armatureNodes) {
        const liveBones = liveBonesByUuid.get(node.uuid) ?? [];
        const isBound = liveBones.some(bone => vkeys.some(vkey => bone.getVertexWeight(live, vkey) > 0));

        if (isBound)
            return node.uuid;
    }

    return undefined;
}

/**
 * One entry per vertex: every armature bone with a positive weight on it, run through
 * {@link normalizeInfluences} to cap, tie-break and renormalise
 */
function buildSkinForVertices(mesh: any, vkeys: string[], liveBones: any[],
                               boneIndexByUuid: Map<string, number>): RawInfluence[][] {
    return vkeys.map(vkey => {
        const raw: RawInfluence[] = [];

        for (const bone of liveBones) {
            const weight = bone.getVertexWeight(mesh, vkey);

            if (weight > 0) {
                raw.push({ boneIndex: boneIndexByUuid.get(bone.uuid) as number, weight });
            }
        }

        return normalizeInfluences(raw);
    });
}

// ===============================================================
// Import
// ===============================================================

/**
 * A stand-in image for an imported texture the format carries no pixel data for - a magenta/black
 * checkerboard at the texture's own real pixel dimensions (per §0's decision: "textures as named
 * placeholders the user re-links"), rather than faking the metadata and leaving a 0x0 image that
 * would silently disagree with the `RawTexture`'s own declared width/height
 */
function placeholderTextureDataUrl(width: number, height: number): string {
    const canvas = document.createElement('canvas');

    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);

    const context = canvas.getContext('2d');

    if (context) {
        const cell = Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / 8));

        for (let y = 0; y < canvas.height; y += cell) {
            for (let x = 0; x < canvas.width; x += cell) {
                context.fillStyle = ((x / cell) + (y / cell)) % 2 === 0 ? '#ff00ff' : '#000000';
                context.fillRect(x, y, cell, cell);
            }
        }
    }

    return canvas.toDataURL('image/png');
}

/**
 * Build a real, editable project from a decoded {@link RawBinaryModel}
 * <p>
 * Follows the same `new X(data).addTo(parent).init()` construction pattern Blockbench's own
 * Bedrock `.geo.json` format parser uses (confirmed against real 5.1.6 source,
 * `js/formats/bedrock/bedrock.js`) - `addTo` before `init()`, since `init()`'s own root-parented
 * default only fires when `this.parent` is not already set
 */
export function buildProjectFromModel(model: RawBinaryModel): void {
    setupProject(format);

    // buildModel() reads Project.model_identifier first (falling back to Project.name) for
    // RawBinaryModel#modelId, which is written as string index 0 - the very first byte of the
    // string table. Without setting this back on import, a fresh ModelProject's own default
    // model_identifier would make a re-export produce a different modelId than the one just
    // decoded, breaking §5's round-trip byte-identity on the very first field
    if (model.modelId)
        (Project as any).model_identifier = model.modelId;

    const physicsSection = model.extensions?.get(PHYSICS_SECTION);

    (Project as any)[PROPERTY_PHYSICS] = physicsSection ? decodePhysicsSection(physicsSection) : '';

    // Texture.load() (called internally by fromDataURL) reads a canvas-generated data URL's real
    // pixel dimensions into texture.width/height - this happens through the browser's own Image
    // decode, which is not necessarily synchronous. Unverified without a live session: whether
    // width/height are reliably populated by the time a re-export reads them immediately after.
    // Explicitly set uv_width/uv_height beforehand regardless, since those come from the decoded
    // model directly rather than depending on image decode timing
    const liveTextures: any[] = model.textures.map(texture => {
        const live = new (Texture as any)({ name: texture.name });

        live.uv_width = texture.uvWidth;
        live.uv_height = texture.uvHeight;
        live.fromDataURL(placeholderTextureDataUrl(texture.width, texture.height));
        live.add(false);

        return live;
    });

    function textureFor(index: number): any {
        return liveTextures[index] ?? false;
    }

    // A plain loop, not .map() - each bone's parent must already exist in liveGroups by the time
    // it is read, and groupBones is guaranteed parent-before-child (§2), but a .map() callback
    // cannot see its own not-yet-returned array while it runs, so building this with .map() would
    // read `liveGroups[bone.parentIndex]` from an array that does not exist yet for every
    // non-root bone
    const liveGroups: any[] = [];
    const colourSection = model.extensions?.get(BONE_COLOUR_SECTION);
    const boneColours = colourSection ? decodeBoneColours(colourSection, model.groupBones.length) : [];

    for (const [boneIndex, bone] of model.groupBones.entries()) {
        const parent = bone.parentIndex >= 0 ? liveGroups[bone.parentIndex] : undefined;
        const marker = markerOf(boneColours[boneIndex] ?? 0);
        const group = new (Group as any)({
            name: bone.name,
            ...(marker !== undefined ? { color: marker } : {}),
            origin: bone.pivot,
            rotation: bone.rotation,
                    });

        if (marker !== undefined)
            group.color = marker;

        group.addTo(parent);
        group.init();

        liveGroups.push(group);
    }

    // Built before meshes/cubes so a skinned mesh's live `armature` field (a uuid string - see
    // this file's own top comment) and its influences' bone objects both already exist by the
    // time addMeshToProject() needs them, regardless of where in groupBones that mesh sits
    const liveArmatures: any[] = [];
    const liveArmatureBones: any[][] = [];

    for (const armature of model.armatures) {
        const parent = armature.parentGroupBone >= 0 ? liveGroups[armature.parentGroupBone] : undefined;
        const liveArmature = new (Armature as any)({ name: armature.name, origin: armature.origin });

        liveArmature.addTo(parent);
        liveArmature.init();
        liveArmatures.push(liveArmature);

        // A plain loop for the same reason as liveGroups above - a bone's parent (another bone
        // of this same armature, or the armature itself for a root) must already exist
        const bones: any[] = [];

        for (const bone of armature.bones) {
            const boneParent = bone.parentIndex >= 0 ? bones[bone.parentIndex] : liveArmature;
            const liveBone = new (ArmatureBone as any)({
                name: bone.name,
                origin: bone.head,
                rotation: bone.rotation,
                length: bone.length,
                width: bone.width,
                color: bone.colour,
                            });

            liveBone.addTo(boneParent);
            liveBone.init();
            bones.push(liveBone);
        }

        liveArmatureBones.push(bones);
    }

    model.groupBones.forEach((bone, index) => {
        const group = liveGroups[index];

        for (const element of bone.elements) {
            if (element.kind === ELEMENT_KIND_MESH) {
                const mesh = model.meshes[element.index];

                // Mesh#getArmature() (real Blockbench source, see buildArmatures' own doc comment)
                // only ever recognises a mesh as skinned when it is the Armature's own direct
                // outliner child - so a skinned mesh reimports there instead of under its owning
                // group whenever that's still positionally correct (the armature's own
                // parentGroupBone already is this same group), letting Blockbench's own weight-paint
                // tool and viewport deformation preview work on it again. Re-exporting a mesh parented
                // this way reproduces the identical RawBinaryModel either way - visit()'s own Armature
                // handling already treats it as a transparent container, attaching a mesh nested
                // inside one to the armature's enclosing group exactly like this mesh's own
                // groupBones[index].elements entry already says, so this never invents a new shape
                // the export side wouldn't already recognise.
                //
                // When the two disagree (the mesh was skinned to an armature that lives somewhere
                // else in the hierarchy - exactly the case buildArmatures' own weight-probing fallback
                // exists to support), reparenting to the armature would silently move the mesh to a
                // different part of the tree and change what a re-export produces. Left under its own
                // group instead: the binary data - and so the game - is unaffected either way, but
                // Blockbench's own UI still won't recognise the skin relationship for a mesh sitting
                // this far from its armature, a real, disclosed limitation of Blockbench's own
                // getArmature(), not something reparenting alone can paper over
                const armature = mesh.armatureIndex >= 0 ? model.armatures[mesh.armatureIndex] : undefined;
                const parent = armature && armature.parentGroupBone === index
                    ? liveArmatures[mesh.armatureIndex]
                    : group;

                addMeshToProject(mesh, parent, textureFor, liveArmatures, liveArmatureBones, group.name);
            }
            else if (element.kind === ELEMENT_KIND_CUBE) {
                addCubeToProject(model.cubes[element.index], group, textureFor);
            }
        }
    });
}

function addMeshToProject(mesh: RawMesh, parent: any, textureFor: (index: number) => any,
                           liveArmatures: any[], liveArmatureBones: any[][], boneName: string): void {
    const vertexKeys: string[] = [];
    const vertices: Record<string, [number, number, number]> = {};

    for (let i = 0; i < mesh.positions.length; i += 3) {
        const key = `v${i / 3}`;

        vertexKeys.push(key);
        vertices[key] = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
    }

    const texture = textureFor(mesh.textureIndex);
    const faces: Record<string, any> = {};

    mesh.faces.forEach((face, faceIndex) => {
        const uv: Record<string, [number, number]> = {};
        const faceVertexKeys = face.vertices.map(vi => vertexKeys[vi]);

        faceVertexKeys.forEach((key, corner) => {
            uv[key] = [face.uvs[corner * 2], face.uvs[corner * 2 + 1]];
        });

        faces[`f${faceIndex}`] = { vertices: faceVertexKeys, uv, texture };
    });

    const armature = mesh.armatureIndex >= 0 ? liveArmatures[mesh.armatureIndex] : undefined;

    const live = new (Mesh as any)({
        // named after its bone, without the numbers that end the bone's name: elements may share a name
        name: elementNameFor(boneName),
        origin: mesh.origin,
        rotation: mesh.rotation,
        shading: mesh.smooth ? 'smooth' : 'flat',
        vertices,
        faces,
        ...(armature ? { armature: armature.uuid } : {}),
    });

    live.addTo(parent);
    live.init();

    if (armature) {
        const bones = liveArmatureBones[mesh.armatureIndex];

        mesh.skin.forEach((influences, vertexIndex) => {
            const vkey = vertexKeys[vertexIndex];

            for (const influence of influences) {
                const bone = bones[influence.boneIndex];

                if (bone)
                    bone.setVertexWeight(live, vkey, influence.weight);
            }
        });
    }
}

function addCubeToProject(cube: RawCube, parent: any, textureFor: (index: number) => any): void {
    const texture = textureFor(cube.textureIndex);
    const faces: Record<string, any> = {};

    // A face the exporter dropped was blank in the project it came from (see addCube's own note on
    // `texture === null`), so it has to come back blank rather than as an ordinary defaulted face,
    // or a round trip quietly re-adds every face its author had deliberately removed
    for (const direction of Object.values(CUBE_FACE_DIRECTIONS)) {
        faces[direction] = { texture: null };
    }

    for (const face of cube.faces) {
        const direction = CUBE_FACE_DIRECTIONS[face.faceId];

        if (direction === undefined)
            continue;

        faces[direction] = {
            uv: fileFaceUv(direction, [face.u1, face.v1, face.u2, face.v2]),
            rotation: face.uvRotation * 90,
            texture,
        };
    }

    const live = new (Cube as any)({
        // named after its bone, without the numbers that end the bone's name: elements may share a name
        name: elementNameFor(parent.name),
        origin: cube.origin,
        rotation: cube.rotation,
        from: cube.from,
        to: cube.to,
        inflate: cube.inflate,
        mirror_uv: cube.mirror,
        box_uv: cube.boxUV,
        faces,
    });

    live.addTo(parent);
    live.init();
}

/**
 * Import a `.strutmodel` file, via a native file picker, into a new project
 * <p>
 * Uses {@code Blockbench.import} with `readtype: 'binary'` specifically - the generic drag-and-
 * drop/open-file dispatcher (`loadModelFile` in Blockbench's own `io.js`, confirmed against real
 * source) only recognises `'image'`, `'text'` and `'json'` content, and reading a binary
 * `.strutmodel` as text would UTF-8-decode arbitrary bytes and silently corrupt it. A dedicated
 * "Import" menu action reading as a real `ArrayBuffer` sidesteps that entirely, at the cost of not
 * (yet) being reachable by double-clicking the file from the OS - a follow-up, not a correctness
 * gap in what this does import
 */
export function importBinaryModel(): void {
    (Blockbench as any).import({
        resource_id: 'strut_model',
        type: 'Strut Binary Model',
        extensions: [MODEL_EXTENSION],
        readtype: 'binary',
    }, (files: any[]) => {
        const file = files[0];

        if (!file)
            return;

        const bytes = new Uint8Array(file.content as ArrayBuffer);
        const model = decodeModel(bytes, file.name || 'imported.strutmodel');

        buildProjectFromModel(model);
    });
}
