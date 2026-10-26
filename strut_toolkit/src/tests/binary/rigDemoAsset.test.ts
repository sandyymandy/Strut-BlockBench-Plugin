import * as fs from 'fs';
import * as path from 'path';
import { decodeModel } from '../../ts/binary/model';
import { skeletonFingerprint } from '../../ts/binary/fingerprint';

/**
 * Reads the real, committed `rig_demo.strutmodel` - written independently by
 * `tools/make_rig_demo.py`, not by this plugin's own encoder - and checks it against the same
 * shape `SkinningTest.readsGeneratedDemoAsset` already asserts on the Java side
 * (`src/test/java/com/sandymandy/strut/loading/binary/SkinningTest.java`).
 * <p>
 * This is the cross-implementation check `docs/BINARY_CODEC_PLAN.md` §5 calls for, run in the
 * direction available without a live Blockbench session to export from: rather than exporting a
 * fixture with this stage's own (as yet unverified live) adapter and having Java read it, this
 * proves `decodeModel` correctly reads a real production file an independent implementation
 * (Python) wrote, one dependency this stage's own writer path shares with every other reader
 * <p>
 * A copy of the engine's own asset, kept in tests/fixtures: copy it again when the demo asset is regenerated
 */
const RIG_DEMO_PATH = path.resolve(__dirname, '../fixtures/rig_demo.strutmodel');

describe('decodeModel against the real rig_demo.strutmodel asset', () => {
  it('reads the asset written by tools/make_rig_demo.py, matching what SkinningTest asserts on the Java side', () => {
    const bytes = new Uint8Array(fs.readFileSync(RIG_DEMO_PATH));
    const model = decodeModel(bytes, 'rig_demo.strutmodel');

    expect(model.groupBones).toHaveLength(1);
    expect(model.groupBones[0].name).toEqual('root');

    expect(model.armatures).toHaveLength(1);
    expect(model.armatures[0].name).toEqual('rig');
    expect(model.armatures[0].bones.map(b => b.name)).toEqual(['lower', 'upper']);
    expect(model.armatures[0].bones[0].parentIndex).toEqual(-1);
    expect(model.armatures[0].bones[1].parentIndex).toEqual(0);

    expect(model.meshes).toHaveLength(1);

    const mesh = model.meshes[0];

    expect(mesh.name).toEqual('limb');
    expect(mesh.positions.length / 3).toEqual(12); // one rest position per source vertex
    expect(mesh.faces).toHaveLength(8);

    // The demo asset itself IS skinned (written directly by tools/make_rig_demo.py, not by this
    // stage's own writer, which is unskinned-only until fork phase 6 stage 4) - the bottom ring
    // belongs wholly to bone 0, the top ring wholly to bone 1, the middle ring split evenly,
    // matching SkinningTest's own description of this fixture's shape
    expect(mesh.skin).toHaveLength(12);
    expect(mesh.armatureIndex).toEqual(0);
    expect(mesh.skin[0]).toEqual([{ boneIndex: 0, weight: 1 }]);
    expect(mesh.skin[4]).toEqual([{ boneIndex: 0, weight: 0.5 }, { boneIndex: 1, weight: 0.5 }]);
    expect(mesh.skin[8]).toEqual([{ boneIndex: 1, weight: 1 }]);
  });

  it('the encoded fingerprint the demo animation asset carries matches what this model computes for its own skeleton', () => {
    // Mirrors RigDemoAnimationAssetTest.fingerprintMatchesTheDemoModel, using this file's own
    // decoder and fingerprint port instead of the Java side
    const bytes = new Uint8Array(fs.readFileSync(RIG_DEMO_PATH));
    const model = decodeModel(bytes, 'rig_demo.strutmodel');

    const groupBoneNames = model.groupBones.map(b => b.name);
    const armatureBoneNames = model.armatures.map(a => a.bones.map(b => b.name));

    expect(skeletonFingerprint(groupBoneNames, armatureBoneNames)).toEqual(-200221733); // 0xF410DBDB
  });
});
