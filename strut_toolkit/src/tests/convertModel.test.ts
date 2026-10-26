import { convertGeoFile, skeletonFingerprintOf } from '../ts/convert/geoToRaw';
import { decodeModel, encodeModel } from '../ts/binary/model';

/**
 * Stage 3 of the converter (AI Info/CONVERTER_PLAN.md): legacy `.geo.json` to the raw model. The coordinate conventions are proven against the old
 * JSON baker by the Java oracle test; these tests pin the mapping itself and the ordering and error rules
 */
function geo(bones: unknown[], description: Record<string, unknown> = { identifier: 'geometry.t', texture_width: 64, texture_height: 32 }) {
    return convertGeoFile({ format_version: '1.12.0', 'minecraft:geometry': [{ description, bones }] }, { file: 't.geo.json' });
}

describe('convertGeoFile', () => {
    it('X is mirrored: bone pivot (-x, y, z), rotation (-x, -y, z); cube from and to, pivot and rotation likewise', () => {
        const { model } = geo([{
            name: 'b', pivot: [3, 4, 5], rotation: [10, 20, 30],
            cubes: [{ origin: [1, 2, 3], size: [4, 5, 6], pivot: [7, 8, 9], rotation: [11, 12, 13], uv: [0, 0] }],
        }]);
        const bone = model.groupBones[0];
        const cube = model.cubes[0];

        expect(bone.pivot).toEqual([-3, 4, 5]);
        expect(bone.rotation).toEqual([-10, -20, 30]);
        expect(cube.from).toEqual([-5, 2, 3]);
        expect(cube.to).toEqual([-1, 7, 9]);
        expect(cube.origin).toEqual([-7, 8, 9]);
        expect(cube.rotation).toEqual([-11, -12, 13]);
    });

    it('never produces negative zero', () => {
        const { model } = geo([{ name: 'b', pivot: [0, 0, 0], rotation: [0, 0, 0], cubes: [{ origin: [0, 0, 0], size: [0, 0, 0], uv: [0, 0] }] }]);

        for (const value of [...model.groupBones[0].pivot, ...model.groupBones[0].rotation, ...model.cubes[0].to, ...model.cubes[0].rotation])
            expect(Object.is(value, -0)).toBe(false);
    });

    it('a box uv becomes six rectangles in the JSON baker layout, sizes floored, down flipped', () => {
        const { model } = geo([{ name: 'b', cubes: [{ origin: [0, 0, 0], size: [4, 6, 2.9], uv: [16, 8] }] }]);
        const faces = model.cubes[0].faces;

        expect(model.cubes[0].boxUV).toBe(true);
        // sx 4, sy 6, sz 2 (floored)
        expect(faces.map(f => [f.faceId, f.u1, f.v1, f.u2, f.v2])).toEqual([
            [0, 16 + 2 + 4, 8 + 2, 16 + 2 + 4 + 2, 8 + 2 + 6],
            [1, 16, 8 + 2, 16 + 2, 8 + 2 + 6],
            [2, 16 + 2, 8 + 2, 16 + 2 + 4, 8 + 2 + 6],
            [3, 16 + 2 + 4 + 2, 8 + 2, 16 + 2 + 4 + 2 + 4, 8 + 2 + 6],
            [4, 16 + 2, 8, 16 + 2 + 4, 8 + 2],
            [5, 16 + 2 + 4, 8 + 2, 16 + 2 + 4 + 4, 8 + 2 - 2],
        ]);
    });

    it('per-face uv keeps its origin and size, omits faces the file omits, and turns degrees into rotation steps', () => {
        const { model } = geo([{ name: 'b', cubes: [{
            origin: [0, 0, 0], size: [1, 1, 1],
            uv: { north: { uv: [4, 5], uv_size: [2, -3] }, east: { uv: [1, 1], uv_size: [1, 1], uv_rotation: 270 } },
        }] }]);

        expect(model.cubes[0].boxUV).toBe(false);
        expect(model.cubes[0].faces).toEqual([
            { faceId: 1, u1: 1, v1: 1, u2: 2, v2: 2, uvRotation: 3 },
            { faceId: 2, u1: 4, v1: 5, u2: 6, v2: 2, uvRotation: 0 },
        ]);
    });

    it('bones are written parents first and depth-first in file order, whatever order the file lists them in', () => {
        const { model } = geo([
            { name: 'leaf', parent: 'child' },
            { name: 'child', parent: 'root' },
            { name: 'second' },
            { name: 'root' },
            { name: 'sibling', parent: 'root' },
        ]);

        // Roots in file order: second, root. root's children in file order: child, sibling. child's: leaf
        expect(model.groupBones.map(b => b.name)).toEqual(['second', 'root', 'child', 'leaf', 'sibling']);
        expect(model.groupBones.map(b => b.parentIndex)).toEqual([-1, -1, 1, 2, 1]);
    });

    it('problems are reported, not thrown: unknown fields, a missing parent, a duplicate name, an unknown face', () => {
        const { model, findings } = geo([
            { name: 'a', parent: 'ghost', locators: {} },
            { name: 'a' },
            { name: 'b', cubes: [{ origin: [0, 0, 0], size: [1, 1, 1], uv: { middle: { uv: [0, 0], uv_size: [1, 1] } }, color: 1 }] },
        ]);
        const text = findings.items.map(f => f.message).join('|');

        expect(model.groupBones.map(b => b.name)).toEqual(['a', 'b']);
        expect(text).toContain('"ghost" does not exist');
        expect(text).toContain('second bone named "a"');
        expect(text).toContain('locators');
        expect(text).toContain('middle');
        expect(text).toContain('color');
    });

    it('cube inflate falls back to the bone one, a cube own mirror is kept, neverRender hides the bone', () => {
        const { model } = geo([{
            name: 'b', inflate: 0.25, neverRender: true,
            cubes: [{ origin: [0, 0, 0], size: [1, 1, 1], uv: [0, 0] }, { origin: [0, 0, 0], size: [1, 1, 1], inflate: 1, mirror: true, uv: [0, 0] }],
        }]);

        expect(model.cubes.map(c => c.inflate)).toEqual([0.25, 1]);
        expect(model.cubes.map(c => c.mirror)).toEqual([false, true]);
        expect((model.groupBones[0] as any).hidden).toBeUndefined();
    });

    it('a mirrored cube with a box UV is reported (the two bakers swap its top and bottom differently), a per-face one is not', () => {
        const boxed = geo([{ name: 'b', cubes: [{ origin: [0, 0, 0], size: [1, 1, 1], mirror: true, uv: [0, 0] }] }]);
        const faced = geo([{ name: 'b', cubes: [{ origin: [0, 0, 0], size: [1, 1, 1], mirror: true, uv: { up: { uv: [0, 0], uv_size: [1, 1] } } }] }]);

        expect(boxed.findings.lossy).toBe(1);
        expect(faced.findings.lossy).toBe(0);
    });

    it('the texture, model id and fingerprint come from the description and the bone order', () => {
        const { model } = geo([{ name: 'a' }, { name: 'b', parent: 'a' }], { identifier: 'geometry.ava', texture_width: 64, texture_height: 48 });

        expect(model.modelId).toBe('geometry.ava');
        expect(model.textures[0]).toEqual({ name: 'ava', width: 64, height: 48, uvWidth: 64, uvHeight: 48 });
        expect(skeletonFingerprintOf(model)).toBe(skeletonFingerprintOf(geo([{ name: 'a' }, { name: 'b', parent: 'a' }]).model));
        expect(skeletonFingerprintOf(model)).not.toBe(skeletonFingerprintOf(geo([{ name: 'b' }, { name: 'a', parent: 'b' }]).model));
    });

    it('a file with no geometry reports that and converts nothing', () => {
        const { model, findings } = convertGeoFile({ format_version: '1.8.0', 'geometry.x': {} }, { file: 'old.geo.json' });

        expect(model.groupBones).toHaveLength(0);
        expect(findings.lossy).toBe(1);
    });

    it('the converted model encodes and decodes back to itself', () => {
        const { model } = geo([{
            name: 'b', pivot: [1, 2, 3], cubes: [{ origin: [0, 0, 0], size: [2, 2, 2], inflate: 0.1, uv: { up: { uv: [1, 1], uv_size: [2, 2], uv_rotation: 90 } } }],
        }]);
        const back = decodeModel(encodeModel(model), 'test');

        expect(back.modelId).toBe(model.modelId);
        expect(back.groupBones[0].pivot).toEqual(model.groupBones[0].pivot);
        expect(back.cubes[0].faces).toEqual(model.cubes[0].faces);
        expect(back.cubes[0].inflate).toBeCloseTo(0.1, 5);
    });
});
