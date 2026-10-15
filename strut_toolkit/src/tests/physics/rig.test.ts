import { generateAutoColliders, isRelated } from '../../ts/physics/autoColliders';
import { add, length, Q4, qaxisY, qmul, qrotate, sub, V3 } from '../../ts/physics/math';
import { BoneFrame, PhysicsRig } from '../../ts/physics/rig';

/** A hand-built skeleton: each bone's pivot is {@code offset} from its parent's pivot in the parent's frame */
interface TestBone { name: string; parent: string | null; offset: V3 }

const BONES: TestBone[] = [
    { name: 'root', parent: null, offset: [0, 1, 0] },
    { name: 'chest', parent: 'root', offset: [0, 0.4, 0.1] },
    { name: 'h1', parent: 'root', offset: [0, 0.6, -0.1] },
    { name: 'h2', parent: 'h1', offset: [0, -0.3, 0] },
    { name: 'h3', parent: 'h2', offset: [0, -0.3, 0] },
];

const IDENTITY: Q4 = [0, 0, 0, 1];

/** Forward kinematics: world pivots and orientations from local rotations and the entity's place and turn */
function frames(pos: V3, yaw: number, locals: ReadonlyMap<string, Q4> = new Map()): { map: Map<string, BoneFrame>; root: Q4 } {
    const map = new Map<string, BoneFrame>();
    const root = qaxisY(yaw);

    for (const bone of BONES) {
        const parent = bone.parent ? map.get(bone.parent)! : null;
        const parentQ = parent ? parent.orientation : root;
        const parentOrigin = parent ? parent.origin : pos;
        const local = locals.get(bone.name) ?? IDENTITY;

        map.set(bone.name, { origin: add(parentOrigin, qrotate(parentQ, bone.offset)), orientation: qmul(parentQ, local), local });
    }

    return { map, root };
}

const defs = BONES.map(b => ({ name: b.name, parent: b.parent }));
const noAuto = (): never[] => [];

/** Runs the rig for {@code seconds} with the entity moving as {@code motion(t)} says, at 60 frames a second */
function run(rig: PhysicsRig, seconds: number, motion: (t: number) => { pos: V3; yaw: number }, start = 0): Map<string, { local: Q4; scale: V3 }> {
    let last: ReadonlyMap<string, { local: Q4; scale: V3 }> = new Map();

    for (let i = 0; i <= Math.round(seconds * 60); i++) {
        const t = start + i / 60;
        const m = motion(t);
        const f = frames(m.pos, m.yaw);

        last = rig.update(f.map, m, f.root, t);
    }

    return new Map(last);
}

const still = (): { pos: V3; yaw: number } => ({ pos: [0, 0, 0], yaw: 0 });
const HAIR = { chains: { hair: { bones: ['h1', 'h2', 'h3'], preset: 'hair', frequency: 2, maxAngle: 0, collidesWith: ['world'] } } };

describe('the rig', () => {
    test('a standing model is exactly as animated, chain and spring alike', () => {
        const rig = new PhysicsRig(defs, { ...HAIR, bones: { chest: { preset: 'jiggle-soft' } } }, noAuto);
        const out = run(rig, 1, still);

        for (const name of ['h1', 'h2', 'h3']) {
            const q = out.get(name)!.local;

            expect(Math.abs(q[3])).toBeCloseTo(1, 3);
        }

        expect(rig.problems).toEqual([]);
        expect(out.get('chest')!.scale).toEqual([1, 1, 1]);
    });

    test('the rotations written to the bones put every pivot where the chain solver put its particle', () => {
        const rig = new PhysicsRig(defs, HAIR, noAuto);
        const walk = (t: number): { pos: V3; yaw: number } => ({ pos: [Math.sin(t * 3) * 0.8, 0, Math.cos(t * 2) * 0.3], yaw: Math.sin(t * 1.7) * 0.6 });
        let worst = 0;

        for (let i = 0; i <= 240; i++) {
            const t = i / 60;
            const m = walk(t);
            const f = frames(m.pos, m.yaw);
            const out = rig.update(f.map, m, f.root, t);
            const locals = new Map<string, Q4>();

            out.forEach((r, name) => locals.set(name, r.local));

            const fk = frames(m.pos, m.yaw, locals).map;
            const particles = rig.chainPoints('hair');

            if (i > 5) {
                ['h1', 'h2', 'h3'].forEach((name, k) => {
                    worst = Math.max(worst, length(sub(fk.get(name)!.origin, particles[k])));
                });
            }
        }

        expect(worst).toBeLessThan(2e-3);
    });

    test('an accelerating model swings its hair backward, and it hangs straight again after it stops', () => {
        const rig = new PhysicsRig(defs, HAIR, noAuto);

        // speeds up along +x for a second, then stops dead
        const motion = (t: number): { pos: V3; yaw: number } => ({ pos: [t < 1 ? 2 * t * t : 2 + 4 * (t - 1) * 0 + (t < 1.2 ? 0 : 0), 0, 0], yaw: 0 });
        let extreme = 0;

        for (let i = 0; i <= 90; i++) {
            const t = i / 60;
            const m = motion(t);
            const f = frames(m.pos, m.yaw);

            rig.update(f.map, m, f.root, t);

            const tip = rig.chainPoints('hair')[3];

            if (!tip) continue;

            extreme = Math.min(extreme, tip[0] - m.pos[0] - 0);
        }

        expect(extreme).toBeLessThan(-0.005);

        const out = run(rig, 4, () => ({ pos: [2, 0, 0], yaw: 0 }), 1.6);
        const tip = rig.chainPoints('hair')[3];

        expect(Math.abs(tip[0] - 2)).toBeLessThan(0.02);
        expect(out.get('h3')).toBeDefined();
    });

    test('uneven frame pacing does not jolt hair that is carried at a constant speed', () => {
        const rig = new PhysicsRig(defs, HAIR, noAuto);
        let t = 0;
        let z = 0;
        let lowest = Infinity;
        let highest = -Infinity;

        // 3 blocks a second, frames 1/144 and 1/40 s apart in an irregular pattern, so steps and frames never line up
        for (let i = 0; i < 900; i++) {
            const dt = (i % 3 === 0 ? 1 / 40 : 1 / 144) * (1 + 0.15 * Math.sin(i));

            t += dt;
            z += 3 * dt;

            const f = frames([0, 0, z], 0);

            rig.update(f.map, { pos: [0, 0, z], yaw: 0 }, f.root, t);

            const tip = rig.chainPoints('hair')[3];

            if (t > 4 && tip) {
                // where the tip is drawn relative to the model: at a constant speed this settles to one value and must stay there
                lowest = Math.min(lowest, tip[2] - z);
                highest = Math.max(highest, tip[2] - z);
            }
        }

        expect(highest - lowest).toBeLessThan(0.004);
    });

    test('weight 0 gives the animation back exactly', () => {
        const rig = new PhysicsRig(defs, { chains: { hair: { ...HAIR.chains.hair, weight: 0 } }, bones: { chest: { preset: 'jiggle-soft', weight: 0 } } }, noAuto);
        const out = run(rig, 1, t => ({ pos: [Math.sin(t * 4), 0, 0], yaw: 0 }));

        expect(out.has('chest')).toBe(false);

        for (const name of ['h1', 'h2', 'h3']) expect(out.get(name)!.local).toEqual(IDENTITY);
    });

    test('a spring bone lags behind an accelerating model and settles again', () => {
        const rig = new PhysicsRig(defs, { bones: { chest: { preset: 'jiggle-soft', length: 0.2 } } }, noAuto);
        let peak = 0;

        for (let i = 0; i <= 60; i++) {
            const t = i / 60;
            const m = { pos: [3 * t * t, 0, 0] as V3, yaw: 0 };
            const f = frames(m.pos, m.yaw);

            rig.update(f.map, m, f.root, t);
            peak = Math.max(peak, length((rig as any).springs[0].state.rot));
        }

        expect(peak).toBeGreaterThan(0.01);

        run(rig, 4, () => ({ pos: [3, 0, 0], yaw: 0 }), 1.1);
        expect(length((rig as any).springs[0].state.rot)).toBeLessThan(0.01);
    });

    test('a floor holds the hair up: no particle goes below it', () => {
        const rig = new PhysicsRig(defs, HAIR, noAuto);

        rig.floorY = 0.85;

        let lowest = Infinity;

        for (let i = 0; i <= 120; i++) {
            const t = i / 60;
            const m = { pos: [Math.sin(t * 5) * 0.5, 0, 0] as V3, yaw: 0 };
            const f = frames(m.pos, m.yaw);

            rig.update(f.map, m, f.root, t);

            if ((rig as any).chains[0].state.initialised) {
                for (const p of (rig as any).chains[0].state.x as V3[]) lowest = Math.min(lowest, p[1]);
            }
        }

        expect(lowest).toBeGreaterThan(0.85 + 0.05 - 0.01);
    });

    test('a test shape in the world holds the hair up like a block would', () => {
        const rig = new PhysicsRig(defs, HAIR, noAuto);

        rig.floor = false;
        // a ball right under where the hair hangs (its tip is 0.9 below h1's pivot, at y = 1.6)
        rig.props = [{ shape: 'sphere', p: [0, 0.55, -0.1], q: [0, 0, 0], radius: 0.3, half: [0, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }];

        let deepest = Infinity;

        for (let i = 0; i <= 120; i++) {
            const t = i / 60;
            const f = frames([0, 0, 0], 0);

            rig.update(f.map, { pos: [0, 0, 0], yaw: 0 }, f.root, t);

            for (const p of rig.chainPoints('hair').slice(1)) deepest = Math.min(deepest, length(sub(p, [0, 0.55, -0.1])) - (0.3 + 0.05));
        }

        expect(deepest).toBeGreaterThan(-0.01);
    });

    test('a spring bone pressed by an authored collider is pushed and flattened, then recovers', () => {
        const doc = {
            bones: { chest: { preset: 'jiggle-soft', length: 0.2, radius: 0.15, squish: 0.5, collidesWith: ['body'] } },
            // a big ball on the root with the chest inside it
            colliders: [{ bone: 'root', shape: 'sphere', center: [0, 0.45, 0.1], radius: 9, layer: 'body' }],
        };
        const rig = new PhysicsRig(defs, doc, noAuto);

        run(rig, 1, still);

        const spring = (rig as any).springs[0];

        expect(spring.squishAmount).toBeGreaterThan(0.01);
        expect(length(spring.state.rot)).toBeGreaterThan(1e-3);

        const relaxed = new PhysicsRig(defs, { bones: doc.bones }, noAuto);

        run(relaxed, 1, still);
        expect(length((relaxed as any).springs[0].state.rot)).toBeLessThan(1e-9);
    });

    test('a bone or chain the model lacks is reported, not thrown', () => {
        const rig = new PhysicsRig(defs, { bones: { ghost: {} }, chains: { bad: { bones: ['h1', 'h3'] }, worse: { bones: ['nope'] } } }, noAuto);

        expect(rig.problems.join('\n')).toMatch(/bone "ghost" is not in the model/);
        expect(rig.problems.join('\n')).toMatch(/"h3" is not a child of "h1"/);
        expect(rig.problems.join('\n')).toMatch(/bone "nope" is not in the model/);
        expect(rig.chainCount).toBe(0);
    });

    test('shapes are made from the model when a part collides with body and nothing is authored', () => {
        const made = jest.fn(() => [{ bone: 'root', shape: 'box' as const, a: [0, 0, 0] as V3, b: [1, 1, 1] as V3, radius: 0, layer: 'body' }]);

        expect(new PhysicsRig(defs, { chains: { hair: { bones: ['h1'] } } }, () => made()).colliderCount).toBe(1);
        expect(new PhysicsRig(defs, { chains: { hair: { bones: ['h1'], collidesWith: ['world'] } } }, () => made()).colliderCount).toBe(0);
        expect(new PhysicsRig(defs, { autoColliders: false, chains: { hair: { bones: ['h1'] } } }, () => made()).colliderCount).toBe(0);
        expect(new PhysicsRig(defs, { autoColliders: true, chains: { hair: { bones: ['h1'], collidesWith: ['world'] } } }, () => made()).colliderCount).toBe(1);
    });
});

describe('collision shapes made from cubes', () => {
    const cube = (min: V3, max: V3): V3[] => {
        const c: V3[] = [];

        for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) c.push([x, y, z]);

        return c;
    };
    const bone = (name: string, cubes: V3[][], extra: Partial<{ parent: string | null; hidden: boolean; meshVertices: V3[] }> = {}) =>
        ({ name, parent: extra.parent ?? null, origin: [0, 0, 0] as V3, cubes, meshVertices: extra.meshVertices ?? [], hidden: extra.hidden ?? false });

    test('a few cubes keep a box each, a detailed bone becomes one proxy, long and thin ones a capsule', () => {
        const shapes = generateAutoColliders([
            bone('torso', [cube([-4, 0, -2], [4, 12, 2]), cube([-2, 12, -1], [2, 14, 1])]),
            bone('arm', Array.from({ length: 6 }, (_, i) => cube([-1, -i * 2, -1], [1, -i * 2 - 2, 1]))),
            bone('block', Array.from({ length: 6 }, (_, i) => cube([i, 0, 0], [i + 1, 4, 4]))),
        ]);

        expect(shapes.filter(s => s.bone === 'torso').length).toBe(2);
        expect(shapes.filter(s => s.bone === 'arm').length).toBe(1);
        expect(shapes.find(s => s.bone === 'arm')!.shape).toBe('capsule');
        expect(shapes.filter(s => s.bone === 'block').length).toBe(1);
        expect(shapes.find(s => s.bone === 'block')!.shape).toBe('box');
    });

    test('armor and hidden bones are left out, tiny bones too, and the cap keeps the biggest', () => {
        const shapes = generateAutoColliders([
            bone('armorChest', [cube([0, 0, 0], [8, 8, 8])]),
            bone('ghost', [cube([0, 0, 0], [8, 8, 8])], { hidden: true }),
            bone('speck', [cube([0, 0, 0], [0.5, 0.5, 0.5])]),
            bone('big', [cube([0, 0, 0], [10, 10, 10])]),
            bone('small', [cube([0, 0, 0], [3, 3, 3])]),
        ], { maxCubes: 3, exclude: [], layer: 'body', maxShapes: 1 });

        expect(shapes.map(s => s.bone)).toEqual(['big']);
    });

    test('relatedness follows parents and children by name', () => {
        const parents = new Map<string, string | null>([['a', null], ['b', 'a'], ['c', 'b'], ['d', 'a']]);

        expect(isRelated('a', 'c', parents)).toBe(true);
        expect(isRelated('c', 'a', parents)).toBe(true);
        expect(isRelated('d', 'c', parents)).toBe(false);
        expect(isRelated('b', 'b', parents)).toBe(true);
    });
});
