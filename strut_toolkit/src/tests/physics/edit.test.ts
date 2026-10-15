import { addCollider, bounceFromDamping, chainControls, chainFrom, chainNameOf, dampingFromBounce, hertzFromStiffness, kindOf, readDoc, removeColliders, removePart, setAutoColliders, setChain, setSpring, springControls, stiffnessFromHertz, summarise, withLook, writeDoc } from '../../ts/physics/edit';
import { checkPhysics } from '../../ts/physics/config';
import { colliderLines, motionAt } from '../../ts/physics/motion';
import { PhysicsRig } from '../../ts/physics/rig';
import { QI } from '../../ts/physics/math';

describe('editing physics with controls', () => {
    test('the friendly sliders and the real numbers convert both ways', () => {
        for (const s of [0, 0.25, 0.5, 1]) expect(stiffnessFromHertz(hertzFromStiffness(s))).toBeCloseTo(s, 9);
        for (const b of [0, 0.4, 1]) expect(bounceFromDamping(dampingFromBounce(b))).toBeCloseTo(b, 9);

        expect(hertzFromStiffness(0)).toBeLessThan(hertzFromStiffness(1));
        expect(dampingFromBounce(1)).toBeLessThan(dampingFromBounce(0));
    });

    test('a spring is written as numbers the game reads without warnings, and reads back to the same controls', () => {
        let doc = readDoc('');

        doc = setSpring(doc, 'chest', { ...springControls(doc, 'chest'), ...withLook(springControls(doc, 'chest'), 'soft-bone'), radius: 0.12 });

        const text = writeDoc(doc);
        const check = checkPhysics(text, ['chest']);
        const back = springControls(readDoc(text), 'chest');

        expect(check.warnings).toEqual([]);
        expect(doc.bones.chest.collidesWith).toEqual(['body', 'other', 'players', 'mobs']);
        expect(back.squish).toBeCloseTo(0.3, 3);
        expect(back.radius).toBeCloseTo(0.12, 3);
        expect(kindOf(doc, 'chest')).toBe('spring');
    });

    test('a chain is made from a bone downward, follows the first child that has children, and is edited and removed as a whole', () => {
        const kids: Record<string, string[]> = { a: ['b', 'twig'], b: ['c'], c: ['d'], d: [], twig: [] };
        const bones = chainFrom('a', n => kids[n] ?? []);

        expect(bones).toEqual(['a', 'b', 'c', 'd']);
        expect(chainFrom('a', n => kids[n] ?? [], 2)).toEqual(['a', 'b']);

        let doc = setChain(readDoc(''), bones, withLook(chainControls(readDoc(''), 'a'), 'tail'));

        expect(chainNameOf(doc, 'c')).toBe('a');
        expect(kindOf(doc, 'd')).toBe('chain');
        expect(checkPhysics(writeDoc(doc), ['a', 'b', 'c', 'd']).warnings).toEqual([]);
        expect(chainControls(doc, 'b').maxAngle).toBeCloseTo(70, 1);

        doc = setChain(doc, bones, { ...chainControls(doc, 'a'), stiffness: 1 });
        expect(Object.keys(doc.chains)).toEqual(['a']);
        expect(removePart(doc, 'c').chains).toEqual({});
        expect(kindOf(removePart(doc, 'c'), 'a')).toBe('none');
    });

    test('other parts of the document survive an edit, and colliders are added and removed by bone', () => {
        let doc = readDoc('{"version": 1, "bones": {"x": {"frequency": 2, "translate": true}}, "colliders": [{"bone": "x", "shape": "sphere", "center": [0,0,0], "radius": 2}]}');

        doc = setSpring(doc, 'y', springControls(doc, 'y'));
        doc = addCollider(doc, 'y', 'capsule', [0, 0, 0], 8);
        doc = setAutoColliders(doc, false);

        expect(doc.version).toBe(1);
        expect(doc.bones.x.translate).toBe(true);
        expect(doc.colliders.length).toBe(2);
        expect(doc.autoColliders).toBe(false);
        expect(checkPhysics(writeDoc(doc), ['x', 'y']).warnings).toEqual([]);
        expect(removeColliders(doc, 'y').colliders.length).toBe(1);
        expect(setAutoColliders(doc, null).autoColliders).toBeUndefined();
        expect(summarise(doc)).toBe('2 spring bones, 0 chains, 2 colliders');
    });

    test('what the controls write drives the rig: a stiffer spring swings less than a floppy one', () => {
        const names = [{ name: 'chest', parent: null }];
        const peak = (stiffness: number): number => {
            const doc = setSpring({}, 'chest', { ...springControls({}, 'chest'), stiffness, length: 0.2 });
            const rig = new PhysicsRig(names, doc, () => []);
            let worst = 0;

            for (let i = 0; i <= 90; i++) {
                const t = i / 60;
                const frames = new Map([['chest', { origin: [3 * t * t, 1, 0] as [number, number, number], orientation: QI, local: QI }]]);

                rig.update(frames, { pos: [3 * t * t, 0, 0], yaw: 0 }, QI, t);
                worst = Math.max(worst, Math.hypot(...(rig as any).springs[0].state.rot as number[]));
            }

            return worst;
        };

        expect(peak(0.1)).toBeGreaterThan(peak(0.9));
    });
});

describe('scripted motion and collider drawings', () => {
    test('every motion starts at the origin or somewhere sensible and idle never moves', () => {
        expect(motionAt('idle', 5)).toEqual({ pos: [0, 0, 0], yaw: 0 });
        expect(motionAt('spin', 2).yaw).toBeCloseTo(6.4, 9);
        expect(motionAt('jump', 0.3).pos[1]).toBeGreaterThan(0);
        expect(motionAt('walk', 0).pos).toEqual([0, 0, 0]);
        expect(Math.abs(motionAt('run', 1).pos[2])).toBeGreaterThan(0);
    });

    test('a box is twelve edges, a sphere three rings, a capsule two rings and four sides', () => {
        const frame = { origin: [0, 1, 0] as [number, number, number], orientation: QI, local: QI };

        expect(colliderLines({ bone: 'b', shape: 'box', a: [0, 0, 0], b: [16, 16, 16], radius: 0, layer: 'body' }, frame).length).toBe(12);
        expect(colliderLines({ bone: 'b', shape: 'sphere', a: [0, 0, 0], b: [0, 0, 0], radius: 8, layer: 'body' }, frame).length).toBe(48);
        expect(colliderLines({ bone: 'b', shape: 'capsule', a: [0, 0, 0], b: [0, -16, 0], radius: 4, layer: 'body' }, frame).length).toBe(36);

        // a unit box (16 units) is one block: its edges are one block long
        const edge = colliderLines({ bone: 'b', shape: 'box', a: [0, 0, 0], b: [16, 16, 16], radius: 0, layer: 'body' }, frame)[0];

        expect(Math.hypot(edge[0][0] - edge[1][0], edge[0][1] - edge[1][1], edge[0][2] - edge[1][2])).toBeCloseTo(1, 9);
    });
});
