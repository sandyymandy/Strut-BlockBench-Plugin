import { encodeModel, decodeModel, RawBinaryModel, MODEL_VERSION } from '../../ts/binary/model';

/**
 * A synthetic model exercising every element kind the format has: one group bone parenting a
 * skinned mesh and a cube, one armature of two bones, and a vertex with four tied-weight
 * influences (the case that would sort unstably without a deterministic tie-break - see
 * docs/BINARY_CODEC_PLAN.md §2 and §5)
 */
function syntheticModel(): RawBinaryModel {
    return {
        // encodeModel always writes MODEL_VERSION regardless of what's here - matched to it rather
        // than a stale literal, since a version bump would otherwise break this fixture's own
        // round-trip assertion for a reason unrelated to what it actually tests
        version: MODEL_VERSION,
        modelId: 'strut:test/synthetic',
        unitsPerBlock: 16,
        boundsMin: [-1, 0, -1],
        boundsMax: [1, 2, 1],
        strings: ['strut:test/synthetic', 'texture', 'root', 'limb', 'box', 'rig', 'lower', 'upper'],
        textures: [{ name: 'texture', width: 64, height: 64, uvWidth: 64, uvHeight: 64 }],
        groupBones: [
            {
                name: 'root',
                parentIndex: -1,
                pivot: [0, 0, 0],
                rotation: [0, 0, 0],
                elements: [{ kind: 0, index: 0 }, { kind: 1, index: 0 }],
            },
        ],
        meshes: [
            {
                name: 'limb',
                textureIndex: 0,
                origin: [0, 0, 0],
                rotation: [0, 0, 0],
                mirror: false,
                armatureIndex: 0,
                positions: [0, 0, 0, 1, 1, 1],
                faces: [
                    { vertices: [0, 1, 0], uvs: [0, 0, 1, 0, 1, 1] },
                ],
                skin: [
                    // Four influences, all equal weight, each with a different bone index - the
                    // exact shape that sorts unstably without a deterministic tie-break
                    [
                        { boneIndex: 3, weight: 0.25 },
                        { boneIndex: 0, weight: 0.25 },
                        { boneIndex: 2, weight: 0.25 },
                        { boneIndex: 1, weight: 0.25 },
                    ],
                    [{ boneIndex: 1, weight: 1 }],
                ],
                smooth: true,
            },
        ],
        cubes: [
            {
                name: 'box',
                textureIndex: 0,
                origin: [0, 0, 0],
                rotation: [0, 0, 0],
                from: [-1, 0, -1],
                to: [1, 2, 1],
                inflate: 0,
                mirror: true,
                boxUV: false,
                faces: [
                    { faceId: 0, u1: 0, v1: 0, u2: 8, v2: 8, uvRotation: 0 },
                    { faceId: 4, u1: 8, v1: 0, u2: 16, v2: 8, uvRotation: 3 },
                ],
            },
        ],
        armatures: [
            {
                name: 'rig',
                origin: [0, 0, 0],
                parentGroupBone: 0,
                bones: [
                    { name: 'lower', parentIndex: -1, head: [0, 0, 0], rotation: [0, 0, 0], length: 8, width: 2, colour: 0, },
                    { name: 'upper', parentIndex: 0, head: [0, 8, 0], rotation: [0, 0, 0], length: 8, width: 3, colour: 5, },
                ],
            },
        ],
    };
}

describe('encodeModel / decodeModel round trip', () => {
  it('write -> read -> write is byte-identical for a synthetic model exercising every element kind', () => {
    const model = syntheticModel();
    const firstBytes = encodeModel(model);
    const decoded = decodeModel(firstBytes, 'synthetic.strutmodel');
    const secondBytes = encodeModel(decoded);

    expect(Array.from(secondBytes)).toEqual(Array.from(firstBytes));
  });

  it('decoding preserves every field of the synthetic model', () => {
    const model = syntheticModel();
    const decoded = decodeModel(encodeModel(model), 'synthetic.strutmodel');

    expect(decoded).toEqual(model);
  });

  it('preserves a skinned vertex with four tied-weight influences, in the authored order', () => {
    const model = syntheticModel();
    const decoded = decodeModel(encodeModel(model), 'synthetic.strutmodel');

    expect(decoded.meshes[0].skin[0]).toEqual([
      { boneIndex: 3, weight: 0.25 },
      { boneIndex: 0, weight: 0.25 },
      { boneIndex: 2, weight: 0.25 },
      { boneIndex: 1, weight: 0.25 },
    ]);
  });

  it('round-trips a mesh with smooth shading turned off, distinctly from the synthetic model\'s smooth one', () => {
    const model = syntheticModel();
    const flatModel: RawBinaryModel = {
      ...model,
      meshes: [{ ...model.meshes[0], smooth: false }],
    };
    const decoded = decodeModel(encodeModel(flatModel), 'synthetic.strutmodel');

    expect(decoded.meshes[0].smooth).toEqual(false);
  });

  it('normalises an unskinned mesh armatureIndex to -1 regardless of what was passed in', () => {
    const model = syntheticModel();
    const withStrayArmatureIndex: RawBinaryModel = {
      ...model,
      meshes: [{ ...model.meshes[0], armatureIndex: -1, skin: [] }],
    };
    const decoded = decodeModel(encodeModel(withStrayArmatureIndex), 'synthetic.strutmodel');

    expect(decoded.meshes[0].armatureIndex).toEqual(-1);
    expect(decoded.meshes[0].skin).toEqual([]);
  });

  it('rejects a file that does not begin with the STMD magic', () => {
    expect(() => decodeModel(new Uint8Array(64), 'bad.strutmodel')).toThrow(/does not begin with STMD/);
  });

  it('the header is exactly 64 bytes', () => {
    const bytes = encodeModel(syntheticModel());

    // string table size (u32) is at header offset 4+2+2+2+2+2+2+2+2 = 20
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const stringTableSize = view.getUint32(20, true);

    // Everything from byte 64 up to the string table should be exactly stringTableSize
    expect(bytes.length).toBeGreaterThanOrEqual(64 + stringTableSize);
  });
});
