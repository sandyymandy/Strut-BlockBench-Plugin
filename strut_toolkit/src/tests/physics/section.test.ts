import { decodeModel, encodeModel, RawBinaryModel } from '../../ts/binary/model';
import { checkPhysics, decodePhysicsSection, encodePhysicsSection, PHYSICS_SECTION, starterPhysics } from '../../ts/physics/config';

const bare: RawBinaryModel = {
    version: 101,
    modelId: 'dummy',
    unitsPerBlock: 16,
    boundsMin: [0, 0, 0],
    boundsMax: [1, 1, 1],
    strings: ['dummy', 'root'],
    textures: [],
    groupBones: [{ name: 'root', parentIndex: -1, pivot: [0, 0, 0], rotation: [0, 0, 0], elements: [] }],
    meshes: [],
    cubes: [],
    armatures: [],
};

const PHYSICS = JSON.stringify({ bones: { root: { preset: 'jiggle-soft', squish: 0.3 } }, colliders: [{ bone: 'root', shape: 'sphere', center: [0, 1, 0], radius: 2 }] });

describe('extension sections in a model file', () => {
    test('a model with no extension is byte-identical to before, and has none when read', () => {
        const bytes = encodeModel(bare);

        expect(bytes[6] | (bytes[7] << 8)).toBe(0);
        expect(decodeModel(bytes, 'bare').extensions).toBeUndefined();
    });

    test('a physics section round-trips through encode and decode, and sets header flag bit 0', () => {
        const payload = encodePhysicsSection(PHYSICS)!;
        const bytes = encodeModel({ ...bare, extensions: new Map([[PHYSICS_SECTION, payload]]) });

        expect(bytes[6] & 1).toBe(1);

        const back = decodeModel(bytes, 'with physics');

        expect([...back.extensions!.keys()]).toEqual([PHYSICS_SECTION]);
        expect(JSON.parse(decodePhysicsSection(back.extensions!.get(PHYSICS_SECTION)!))).toEqual(JSON.parse(PHYSICS));
        expect(back.groupBones[0].name).toBe('root');
    });

    test('a truncated section is reported, not read past', () => {
        const bytes = encodeModel({ ...bare, extensions: new Map([[PHYSICS_SECTION, encodePhysicsSection(PHYSICS)!]]) });

        expect(() => decodeModel(bytes.slice(0, bytes.length - 5), 'cut')).toThrow(/truncated/);
    });
});

describe('checking physics text', () => {
    test('a good document has no warnings and is counted', () => {
        const check = checkPhysics(PHYSICS, ['root']);

        expect(check.warnings).toEqual([]);
        expect([check.bones, check.chains, check.colliders]).toEqual([1, 0, 1]);
    });

    test('typos are found the way the game finds them, and never thrown', () => {
        const check = checkPhysics(JSON.stringify({
            bogus: 1,
            bones: { root: { preset: 'jiggly', frequenzy: 2 }, ghost: {} },
            chains: { hair: { bones: [] } },
            colliders: [{ bone: 'root', shape: 'cone' }],
        }), ['root']);
        const all = check.warnings.join('\n');

        expect(all).toMatch(/unknown top-level key "bogus"/);
        expect(all).toMatch(/unknown preset "jiggly"/);
        expect(all).toMatch(/unknown key "frequenzy"/);
        expect(all).toMatch(/bone "ghost", which the model does not have/);
        expect(all).toMatch(/needs a "bones" list/);
        expect(all).toMatch(/needs "bone" and a "shape"/);
        expect(checkPhysics('not json').document).toBeNull();
        expect(checkPhysics('[]').warnings[0]).toMatch(/must be a JSON object/);
    });

    test('cloth and a ragdoll alone are enough to write a section, and cloth keys are checked', () => {
        const cloth = { cloth: { skirt: { bone: 'skirt', preset: 'cloth', pinHeight: 0.1 } } };

        expect(checkPhysics(JSON.stringify(cloth), ['skirt']).warnings).toEqual([]);
        expect(checkPhysics(JSON.stringify(cloth), ['skirt']).cloth).toBe(1);
        expect(encodePhysicsSection(JSON.stringify(cloth))).not.toBeNull();
        expect(encodePhysicsSection(JSON.stringify({ ragdoll: { bones: ['a', 'b'] } }))).not.toBeNull();

        const all = checkPhysics(JSON.stringify({ cloth: { a: { preset: 'silk', wobble: 1 }, b: { bone: 'nope' }, c: 5 } }), ['skirt']).warnings.join('\n');

        expect(all).toMatch(/cloth "a": needs a "bone"/);
        expect(all).toMatch(/cloth "a": unknown key "wobble"/);
        expect(all).toMatch(/unknown cloth preset "silk"/);
        expect(all).toMatch(/cloth "b" names bone "nope"/);
        expect(all).toMatch(/cloth "c" must be an object/);
    });

    test('flesh is checked like cloth, with its own presets', () => {
        const ok = { flesh: { belly: { bone: 'belly', preset: 'jelly', volume: 0.5, softCenter: [0, 1, 0], softRadius: 0.2 } } };

        expect(checkPhysics(JSON.stringify(ok), ['belly']).warnings).toEqual([]);
        expect(encodePhysicsSection(JSON.stringify(ok))).not.toBeNull();

        const all = checkPhysics(JSON.stringify({ flesh: { a: { bone: 'belly', preset: 'cloth' } } }), ['belly']).warnings.join('\n');

        expect(all).toMatch(/unknown flesh preset "cloth"/);
    });

    test('an empty document writes no section, and the starter lists every bone', () => {
        expect(encodePhysicsSection('{}')).toBeNull();
        expect(encodePhysicsSection('nope')).toBeNull();
        expect(Object.keys(JSON.parse(starterPhysics(['a', 'b'])).bones)).toEqual(['a', 'b']);
    });
});
