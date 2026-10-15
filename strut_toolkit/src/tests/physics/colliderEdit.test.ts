import { checkPhysics } from '../../ts/physics/config';
import {
    addColliderForm, autoModeOf, boneFilterOf, collidersOn, setBoneFilter, switchFilterMode, tickBone, entryOf, fitForm, formOf, removeColliderAt, setAutoEnabled, setAutoMode, setSpringLimits, springLimits, tiltFor,
    updateColliderAt,
} from '../../ts/physics/colliderEdit';
import { generateAutoColliders } from '../../ts/physics/autoColliders';
import { length, qfromEulerDegrees, qrotate, QI, sub, V3 } from '../../ts/physics/math';
import { limitArc, limitCone } from '../../ts/physics/motion';
import { PhysicsRig } from '../../ts/physics/rig';

const cube = (min: V3, max: V3): V3[] => {
    const c: V3[] = [];

    for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) c.push([x, y, z]);

    return c;
};

describe('editing a collider as a form', () => {
    test('a tilt points +Y along any direction', () => {
        for (const d of [[1, 0, 0], [0, 0, 1], [0, -1, 0], [0.3, 0.5, -0.8]] as V3[]) {
            const n = Math.hypot(...d);
            const back = qrotate(qfromEulerDegrees(tiltFor(d)), [0, 1, 0]);

            expect(length(sub(back, [d[0] / n, d[1] / n, d[2] / n]))).toBeLessThan(1e-9);
        }
    });

    test('every shape round-trips through the form and back to the same JSON', () => {
        const entries = [
            { bone: 'a', shape: 'sphere', center: [1, 2, 3], radius: 2.5, layer: 'body' },
            { bone: 'a', shape: 'box', center: [0, 1, 0], size: [2, 3, 4], rotation: [10, 20, 30], layer: 'limb' },
            { bone: 'a', shape: 'capsule', from: [0, 4, 0], to: [2, -2, 1], radius: 1.5, layer: 'body' },
        ];

        for (const e of entries) {
            const back = entryOf(formOf(e), 'a', e);

            expect(back.shape).toBe(e.shape);
            expect(back.layer).toBe(e.layer);

            for (const key of ['center', 'size', 'rotation', 'from', 'to']) {
                if ((e as any)[key]) (e as any)[key].forEach((v: number, i: number) => expect(back[key][i]).toBeCloseTo(v, 1));
            }
        }
    });

    test('an unturned box writes no rotation, and the JSON the forms write is what the game reads', () => {
        const box = entryOf({ shape: 'box', center: [0, 0, 0], size: [2, 2, 2], radius: 0, length: 0, rotation: [0, 0, 0] }, 'b');

        expect(box.rotation).toBeUndefined();
        expect(checkPhysics(JSON.stringify({ colliders: [box, entryOf(formOf({ shape: 'capsule', from: [0, 1, 0], to: [0, -1, 0], radius: 1 }), 'b')] }), ['b']).warnings).toEqual([]);
    });

    test('fitting wraps the bone: a box is its bounds, a capsule runs along its longest side', () => {
        const bone = { name: 'arm', parent: null, origin: [2, 10, 0] as V3, cubes: [cube([1, 0, -1], [3, 10, 1])], meshVertices: [], hidden: false };
        const box = fitForm('box', bone);
        const capsule = fitForm('capsule', bone);

        expect(box.center).toEqual([0, -5, 0]);
        expect(box.size).toEqual([2, 10, 2]);
        expect(Math.abs(qrotate(qfromEulerDegrees(capsule.rotation), [0, 1, 0])[1])).toBeCloseTo(1, 6);
        expect(capsule.radius).toBeCloseTo(1, 6);
        expect(capsule.length).toBeCloseTo(8, 6);
        expect(fitForm('sphere', undefined).radius).toBe(2);
    });

    test('colliders are listed per bone, added, changed and removed by their place in the list', () => {
        let doc: Record<string, any> = { colliders: [{ bone: 'x', shape: 'sphere', center: [0, 0, 0], radius: 1 }] };
        const added = addColliderForm(doc, 'y', fitForm('box', undefined));

        doc = added.doc;
        expect(added.index).toBe(1);
        expect(collidersOn(doc, 'y').map(c => c.index)).toEqual([1]);

        doc = updateColliderAt(doc, 1, { ...collidersOn(doc, 'y')[0].form, center: [1, 2, 3] });
        expect(doc.colliders[1].center).toEqual([1, 2, 3]);
        expect(doc.colliders[1].bone).toBe('y');
        expect(removeColliderAt(doc, 0).colliders.map((c: any) => c.bone)).toEqual(['y']);
    });
});

describe('tagging bones for the made shapes', () => {
    test('a bone can be tagged off, exact or simple, and back to auto, keeping the model-wide switch', () => {
        let doc: Record<string, any> = { autoColliders: false };

        doc = setAutoMode(doc, 'hair', 'off');
        expect(doc.autoColliders).toEqual({ enabled: false, bones: { hair: 'off' } });
        expect(autoModeOf(doc, 'hair')).toBe('off');
        expect(autoModeOf(doc, 'torso')).toBe('auto');

        doc = setAutoEnabled(doc, null);
        expect(doc.autoColliders).toEqual({ bones: { hair: 'off' } });
        doc = setAutoMode(doc, 'hair', 'auto');
        expect(doc.autoColliders).toBeUndefined();
        expect(setAutoEnabled({}, false).autoColliders).toBe(false);
        expect(checkPhysics(JSON.stringify(setAutoMode({}, 'a', 'exact')), ['a']).warnings).toEqual([]);
    });

    test('the modes decide what is made: off makes nothing, exact a box per cube, simple one proxy, and a mode overrides the armor rule', () => {
        const bones = [
            { name: 'hair', parent: null, origin: [0, 0, 0] as V3, cubes: [0, 1, 2, 3, 4].map(i => cube([i * 2, 0, 0], [i * 2 + 2, 2, 2])), meshVertices: [], hidden: false },
            { name: 'armorChest', parent: null, origin: [0, 0, 0] as V3, cubes: [cube([0, 0, 0], [8, 8, 8])], meshVertices: [], hidden: false },
        ];
        const count = (modes: Record<string, any>, skip: string[] = []): Record<string, number> => {
            const out: Record<string, number> = {};

            for (const c of generateAutoColliders(bones, { maxCubes: 3, exclude: [], layer: 'body', maxShapes: 99, modes, skip })) out[c.bone] = (out[c.bone] ?? 0) + 1;

            return out;
        };

        expect(count({})).toEqual({ hair: 1 });
        expect(count({ hair: 'exact' })).toEqual({ hair: 5 });
        expect(count({ hair: 'off' })).toEqual({});
        expect(count({ armorChest: 'simple' })).toEqual({ hair: 1, armorChest: 1 });
        expect(count({}, ['hair'])).toEqual({});
    });

    test('in the rig, a bone with its own shape gets no made one, and the rest still do', () => {
        const defs = [{ name: 'a', parent: null }, { name: 'b', parent: 'a' }];
        const made = (options: any) => generateAutoColliders(defs.map(d => ({ ...d, origin: [0, 0, 0] as V3, cubes: [cube([0, 0, 0], [4, 4, 4])], meshVertices: [], hidden: false })), options);
        const rig = new PhysicsRig(defs, { chains: { c: { bones: ['b'] } }, colliders: [{ bone: 'a', shape: 'sphere', center: [0, 0, 0], radius: 3 }] }, made);

        expect(rig.colliders().map(c => c.bone).sort()).toEqual(['a', 'b']);
    });
});

describe('spring limits and their drawings', () => {
    test('limits are read and written per axis in whole degrees, min before max, and removed when all are free', () => {
        let doc: Record<string, any> = { bones: { chest: { frequency: 2 } } };

        doc = setSpringLimits(doc, 'chest', { x: [30, -20.4], y: null, z: [-10, 10] });
        expect(doc.bones.chest.limit).toEqual({ x: [-20, 30], z: [-10, 10] });
        expect(springLimits(doc, 'chest')).toEqual({ x: [-20, 30], y: null, z: [-10, 10] });
        expect(setSpringLimits(doc, 'chest', { x: null, y: null, z: null }).bones.chest.limit).toBeUndefined();
        expect(checkPhysics(JSON.stringify(doc), ['chest']).warnings).toEqual([]);
    });

    test('an arc runs from the lever at the smallest angle to the largest, around the right axis, and a cone opens at its angle', () => {
        const frame = { origin: [0, 0, 0] as V3, orientation: QI, local: QI };
        const arc = limitArc(frame, [0, -1, 0], 0, -90, 90, 10);
        // about x (right-handed), -90 degrees turns straight down to point along +z, and +90 along -z
        const first = arc[0][0];
        const last = arc[9][1];

        expect(length(sub(first, [0, 0, 1]))).toBeLessThan(1e-9);
        expect(length(sub(last, [0, 0, -1]))).toBeLessThan(1e-9);
        expect(arc.length).toBe(12);

        const cone = limitCone([0, 0, 0], [0, -1, 0], 45, 8);

        // every ring point is 45 degrees from straight down, a block from the apex
        for (const [a] of cone.slice(0, 8)) {
            expect(length(a)).toBeCloseTo(1, 9);
            expect(-a[1]).toBeCloseTo(Math.cos(Math.PI / 4), 9);
        }

        expect(limitCone([0, 0, 0], [0, -1, 0], 0)).toEqual([]);
    });
});

describe('which of its own bones a part collides with', () => {
    const defs = [{ name: 'body', parent: null }, { name: 'head', parent: 'body' }, { name: 'hair1', parent: 'head' }, { name: 'hair2', parent: 'hair1' }, { name: 'torso', parent: 'body' }];
    const made = () => [
        { bone: 'head', shape: 'sphere' as const, a: [0, 0, 0] as V3, b: [0, 0, 0] as V3, radius: 4, layer: 'body' },
        { bone: 'torso', shape: 'box' as const, a: [0, 0, 0] as V3, b: [8, 8, 8] as V3, radius: 0, layer: 'body' },
        { bone: 'hair2', shape: 'sphere' as const, a: [0, 0, 0] as V3, b: [0, 0, 0] as V3, radius: 1, layer: 'body' },
    ];

    test('a hair chain feels the torso but not the head when told to, and never the made shapes on its own bones', () => {
        const plain = new PhysicsRig(defs, { chains: { hair: { bones: ['hair1', 'hair2'] } } }, made);

        // the head is the chain's parent, so its made shape is left out already; the torso is felt
        expect(plain.candidateBones('hair2')).toEqual(['torso']);

        const authoredHead = { bone: 'head', shape: 'sphere', center: [0, 0, 0], radius: 4, layer: 'body' };
        const both = new PhysicsRig(defs, { chains: { hair: { bones: ['hair1', 'hair2'] } }, colliders: [authoredHead] }, made);

        expect(both.candidateBones('hair1')).toEqual(['head', 'torso']);

        const denied = new PhysicsRig(defs, { chains: { hair: { bones: ['hair1', 'hair2'], ignoreBones: ['head'] } }, colliders: [authoredHead] }, made);
        const headSpec = { bone: 'head', shape: 'sphere' as const, a: [0, 0, 0] as V3, b: [0, 0, 0] as V3, radius: 4, layer: 'body' };
        const torsoSpec = made()[1];

        expect(denied.feels('hair1', headSpec, false)).toBe(false);
        expect(denied.feels('hair1', torsoSpec, true)).toBe(true);

        const only = new PhysicsRig(defs, { chains: { hair: { bones: ['hair1', 'hair2'], collideBones: ['head'] } }, colliders: [authoredHead] }, made);

        expect(only.feels('hair1', headSpec, false)).toBe(true);
        expect(only.feels('hair1', torsoSpec, true)).toBe(false);
        expect(only.feels('body', torsoSpec, true)).toBe(false);
    });

    test('ticking bones writes a deny list, or an allow list, and switching keeps what is ticked', () => {
        let doc: Record<string, any> = { chains: { hair: { bones: ['hair1', 'hair2'] } } };
        let filter = boneFilterOf(doc, 'hair2');

        filter = tickBone(filter, 'head', false, false);
        expect(filter).toEqual({ only: [], ignore: ['head'] });

        doc = setBoneFilter(doc, 'hair1', filter);
        expect(doc.chains.hair.ignoreBones).toEqual(['head']);
        expect(checkPhysics(JSON.stringify(doc), ['hair1', 'hair2', 'head']).warnings).toEqual([]);

        const only = switchFilterMode(filter, ['head', 'torso'], true);

        expect(only).toEqual({ only: ['torso'], ignore: [] });
        expect(switchFilterMode(only, ['head', 'torso'], false)).toEqual({ only: [], ignore: ['head'] });
        expect(setBoneFilter(doc, 'hair1', { only: [], ignore: [] }).chains.hair.ignoreBones).toBeUndefined();
        expect(setBoneFilter({ bones: { a: {} } }, 'a', { only: ['b'], ignore: [] }).bones.a.collideBones).toEqual(['b']);
    });
});
