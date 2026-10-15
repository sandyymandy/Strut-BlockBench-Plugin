import { checkPhysics } from '../../ts/physics/config';
import { rigidFit, applyRotation, resolveCloth, weld, fitParticles } from '../../ts/physics/cloth';
import { kindOf, removePart, setSoft, SOFT_LOOKS, softControls, softLook, summarise } from '../../ts/physics/edit';
import { add, length, Q4, qaxisY, sub, V3 } from '../../ts/physics/math';
import { BoneFrame, ClothMeshInput, PhysicsRig } from '../../ts/physics/rig';

const IDENTITY: Q4 = [0, 0, 0, 1];
const BONES = [{ name: 'root', parent: null }, { name: 'skirt', parent: 'root' }, { name: 'tip', parent: 'skirt' }, { name: 'plain', parent: 'root' }];
const noAuto = (): never[] => [];

/** A curtain of quads, 6 x 6, hanging from y = 1 to 0.2 at z = 0.3 */
function curtain(key = 'curtain', bone = 'skirt'): ClothMeshInput {
    const cols = 6;
    const rows = 6;
    const rest: V3[] = [];
    const faces: number[][] = [];

    for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) rest.push([-0.4 + 0.8 * i / cols, 1 - 0.8 * j / rows, 0.3]);

    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const a = j * (cols + 1) + i;

        faces.push([a, a + cols + 1, a + cols + 2, a + 1]);
    }

    return { key, bone, rest, faces };
}

/** A closed ball, 12 around and 6 from pole to pole; the quads at the poles repeat the pole as a corner */
function ball(key: string, bone: string, cx: number, cy: number, cz: number, radius: number): ClothMeshInput {
    const around = 12;
    const rows = 6;
    const rest: V3[] = [];
    const faces: number[][] = [];

    for (let j = 0; j <= rows; j++) {
        for (let i = 0; i < around; i++) {
            const lat = Math.PI * j / rows;
            const angle = Math.PI * 2 * i / around;

            rest.push([cx + Math.sin(angle) * Math.sin(lat) * radius, cy + Math.cos(lat) * radius, cz + Math.cos(angle) * Math.sin(lat) * radius]);
        }
    }

    for (let j = 0; j < rows; j++) for (let i = 0; i < around; i++) {
        const a = j * around + i;
        const b = j * around + (i + 1) % around;

        faces.push([a, a + around, b + around, b]);
    }

    return { key, bone, rest, faces };
}

function frames(): ReadonlyMap<string, BoneFrame> {
    const map = new Map<string, BoneFrame>();

    for (const b of BONES) map.set(b.name, { origin: [0, 1, 0], orientation: IDENTITY, local: IDENTITY });

    return map;
}

describe('cloth and flesh in the rig', () => {
    test('a mesh is welded into particles and a bone without a mesh, or a missing one, is reported', () => {
        const mesh = curtain();
        const rig = new PhysicsRig(BONES, { cloth: { skirt: { bone: 'skirt', preset: 'cloth' } } }, noAuto, [mesh]);

        expect(rig.clothCount).toBe(1);
        expect(rig.problems).toEqual([]);
        expect(weld(mesh.rest, mesh.faces).rest.length).toBe(49);

        const bad = new PhysicsRig(BONES, { cloth: { a: { bone: 'plain' }, b: { bone: 'nope' } }, flesh: { c: { bone: 'skirt', maxParticles: 10 } } }, noAuto, [mesh]);

        expect(bad.clothCount).toBe(0);
        expect(bad.problems.length).toBe(3);
        expect(bad.problems.join('\n')).toMatch(/has no mesh/);
        expect(bad.problems.join('\n')).toMatch(/not in the model/);
        expect(bad.problems.join('\n')).toMatch(/maxParticles 10/);
    });

    test('the sewn top stays where the animation puts it and the hem trails a walking model', () => {
        const mesh = curtain();
        const rig = new PhysicsRig(BONES, { cloth: { skirt: { bone: 'skirt', preset: 'cloth', pinHeight: 0.1, inertia: 1, collidesWith: [] } } }, noAuto, [mesh]);
        let lag = 0;
        let topError = 0;

        for (let i = 0; i <= 180; i++) {
            const t = i / 60;
            const pos: V3 = [0, 0, 3 * t];

            rig.clothAnimated = new Map([[mesh.key, mesh.rest.map(v => add(v, pos))]]);
            rig.update(frames(), { pos, yaw: 0 }, qaxisY(0), t);

            const now = rig.clothVertices(mesh.key);

            if (now && i > 60) {
                // vertex 0 is the top left, vertex 42 the bottom left
                lag = Math.min(lag, now[45][2] - (mesh.rest[45][2] + pos[2]));
                topError = Math.max(topError, length(sub(now[3], add(mesh.rest[3], pos))));
            }
        }

        expect(lag).toBeLessThan(-0.15);
        // within a step of the animation (3 blocks a second is 5 cm a step)
        expect(topError).toBeLessThan(0.07);
    });

    test('a jelly ball wobbles with a carried nipple that stays one rigid piece', () => {
        const breast = ball('breast', 'skirt', 0, 0.6, 0.3, 0.12);
        const nipple = ball('nipple', 'tip', 0, 0.6, 0.18, 0.03);
        const rig = new PhysicsRig(BONES, { flesh: { skirt: { bone: 'skirt', preset: 'jelly', carry: ['tip'], collidesWith: [] } } }, noAuto, [breast, nipple]);

        expect(rig.problems).toEqual([]);

        const motion = (t: number): number => 0.5 * Math.sin(t * 7);
        let worstSpread = 0;

        for (let i = 0; i <= 180; i++) {
            const t = i / 60;
            const pos: V3 = [0, 0, motion(t)];

            rig.clothAnimated = new Map([[breast.key, breast.rest.map(v => add(v, pos))], [nipple.key, nipple.rest.map(v => add(v, pos))]]);
            rig.update(frames(), { pos, yaw: 0 }, qaxisY(0), t);

            const moved = rig.clothVertices('nipple');

            if (moved && i > 10) {
                // a rigid piece: every distance between its vertices is what it was
                for (const [a, b] of [[0, 5], [3, 40], [20, 60]]) {
                    worstSpread = Math.max(worstSpread, Math.abs(length(sub(moved[a], moved[b])) - length(sub(nipple.rest[a], nipple.rest[b]))));
                }
            }
        }

        expect(worstSpread).toBeLessThan(0.005);
        expect(rig.clothKeys().sort()).toEqual(['breast', 'nipple']);
        expect(rig.clothReport()[0].flesh).toBe(true);
    });
});

describe('a mesh of two merged parts', () => {
    test('is two bodies: pressing one leaves the other where it is and as big as it was', () => {
        const a = ball('a', 'skirt', -0.3, 0.6, 0.3, 0.12);
        const b = ball('b', 'skirt', 0.3, 0.6, 0.3, 0.12);
        const merged: ClothMeshInput = { key: 'both', bone: 'skirt', rest: [...a.rest, ...b.rest], faces: [...a.faces, ...b.faces.map(f => f.map(i => i + a.rest.length))] };
        const rig = new PhysicsRig(BONES, { flesh: { skirt: { bone: 'skirt', preset: 'jelly', volume: 0.9, collidesWith: [] } } }, noAuto, [merged]);

        expect(rig.clothCount).toBe(1);
        expect(weld(merged.rest, merged.faces).rest.length).toBeGreaterThan(100);

        // ball A is squeezed in from above by hand: its top vertices are pulled down, the animation keeps ball B as modelled
        for (let i = 0; i <= 120; i++) {
            const t = i / 60;
            const animated = merged.rest.map((v): V3 => (v[0] < 0 && v[1] > 0.66 ? [v[0], v[1] - 0.08, v[2]] : v));

            rig.clothAnimated = new Map([['both', animated]]);
            rig.update(frames(), { pos: [0, 0, 0], yaw: 0 }, qaxisY(0), t);
        }

        const now = rig.clothVertices('both')!;
        const bVerts = now.filter((v, i) => merged.rest[i][0] > 0);
        const cx = bVerts.reduce((sum, v) => sum + v[0], 0) / bVerts.length;
        const wide = Math.max(...bVerts.map(v => Math.abs(v[0] - cx)));

        expect(cx).toBeGreaterThan(0.29);
        expect(cx).toBeLessThan(0.31);
        expect(wide).toBeLessThan(0.13);
    });
});

describe('the pieces of the port', () => {
    test('a rigid fit finds the turn and the shift of a set of points', () => {
        const from: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0.3, 0.2, -0.5]];
        // turned a quarter about +y (x to -z, z to x) and shifted
        const to = from.map((p): V3 => [p[2] + 2, p[1] + 1, -p[0] + 3]);
        const fit = rigidFit(from, to);

        for (let k = 0; k < from.length; k++) {
            const mapped = add(fit.centreTo, applyRotation(fit.rotation, sub(from[k], fit.centreFrom)));

            expect(length(sub(mapped, to[k]))).toBeLessThan(1e-6);
        }
    });

    test('the particles a carried mesh follows are those around it, at least six', () => {
        const rest: V3[] = Array.from({ length: 30 }, (_, i) => [i * 0.05, 0, 0] as V3);

        expect(fitParticles(rest, [[0.5, 0, 0], [0.55, 0, 0]]).length).toBeGreaterThanOrEqual(6);
        expect(fitParticles(rest, [])).toEqual([]);
    });

    test('presets resolve like the game does and an explicit key overrides one', () => {
        const jelly = resolveCloth({ bone: 'b', preset: 'jelly' }, true);

        expect([jelly.anchor, jelly.volume, jelly.gravity]).toEqual([4, 0.9, 1.5]);
        expect(jelly.collidesWith).toContain('players');
        expect(resolveCloth({ bone: 'b', preset: 'jelly', anchor: 9 }, true).anchor).toBe(9);
        expect(resolveCloth({ bone: 'b' }, false).pinHeight).toBeCloseTo(0.1, 9);
        expect(resolveCloth({ bone: 'b', softCenter: [0, 1, 0], softRadius: 0.2 }, true).softCenter).toEqual([0, 1, 0]);
    });
});

describe('editing cloth and flesh', () => {
    test('a bone becomes cloth or flesh, reads back, and is removed', () => {
        let doc: Record<string, any> = {};
        const c = softLook('cloth-stiff', 'skirt');

        doc = setSoft(doc, 'skirt', 'cloth', c);
        expect(kindOf(doc, 'skirt')).toBe('cloth');
        expect(doc.cloth.skirt.bone).toBe('skirt');
        expect(doc.cloth.skirt.preset).toBeUndefined();
        expect(doc.cloth.skirt.pinHeight).toBeDefined();
        expect(softControls(doc, 'skirt', 'cloth').stiffness).toBeCloseTo(1, 6);

        // switching to flesh moves the entry
        doc = setSoft(doc, 'skirt', 'flesh', { ...softLook('jelly', 'skirt'), carry: ['tip'], softRadius: 0.2, softCenter: [0, 1, 0] });
        expect(kindOf(doc, 'skirt')).toBe('flesh');
        expect(doc.cloth).toBeUndefined();
        expect(doc.flesh.skirt.carry).toEqual(['tip']);
        expect(doc.flesh.skirt.softRadius).toBe(0.2);
        expect(doc.flesh.skirt.volume).toBeCloseTo(0.9, 6);
        expect(summarise(doc)).toMatch(/1 cloth or flesh/);

        // a soft zone of 0 leaves no zone in the document
        doc = setSoft(doc, 'skirt', 'flesh', { ...softControls(doc, 'skirt', 'flesh'), softRadius: 0 });
        expect(doc.flesh.skirt.softRadius).toBeUndefined();
        expect(removePart(doc, 'skirt').flesh).toBeUndefined();
        expect(Object.keys(SOFT_LOOKS).length).toBe(6);

        // what the controls write is what the game reads: no warnings from the checker, with the bones known
        const full = setSoft(setSoft({}, 'skirt', 'cloth', softLook('cloth', 'skirt')), 'tip', 'flesh', { ...softLook('jelly', 'tip'), carry: ['skirt'], softRadius: 0.2, softCenter: [0, 1, 0] });

        expect(checkPhysics(JSON.stringify(full), ['skirt', 'tip']).warnings).toEqual([]);
    });
});
