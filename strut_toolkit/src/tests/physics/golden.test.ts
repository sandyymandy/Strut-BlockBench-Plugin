import * as fs from 'fs';
import * as path from 'path';
import { ChainState, chainStep, Placed, springStep, SpringState, STEP, V3 } from '../../ts/physics/solvers';
import { chainResponse, resolveChain, resolveSpring, respond, springResponse } from '../../ts/physics/preview';
import { ClothParams, clothStep, ClothState, Topology } from '../../ts/physics/cloth';

// The Java record: physics/src/test/resources/golden/solvers.json, written by GoldenSolverTest from the Java SpringSolver and ChainSolver
const golden = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../../src/test/resources/golden/solvers.json'), 'utf8'));

describe('the TypeScript solvers agree with the Java ones', () => {
    test('a spring bone thrown about for five seconds follows the Java rotation, velocity and translation step by step', () => {
        const p = golden.spring.params;
        const params = {
            frequency: p.frequency, dampingRatio: p.dampingRatio, rotate: true, translate: true, tip: p.tip as V3, length: p.length,
            rotationLimit: p.rotationLimit as ([number, number] | null)[], translationLimit: p.translationLimit,
        };
        const state = new SpringState();
        let worst = 0;

        golden.spring.forces.forEach((force: V3, i: number) => {
            springStep(state, params, STEP, force);

            const expected = golden.spring.steps[i];

            for (let a = 0; a < 3; a++) {
                worst = Math.max(worst, Math.abs(state.rot[a] - expected.rot[a]), Math.abs(state.rotVel[a] - expected.rotVel[a]) * 0.01,
                    Math.abs(state.pos[a] - expected.pos[a]) * 0.1);
            }
        });

        // Java runs this in 32-bit floats and the port in doubles, so a difference of a few millionths of a radian is expected, not a disagreement
        expect(worst).toBeLessThan(1e-3);
    });

    test('a chain over a floor follows the Java particle positions step by step, contact and friction included', () => {
        const c = golden.chain.params;
        const params = {
            frequency: c.frequency, dampingRatio: c.dampingRatio, inertia: c.inertia, gravity: c.gravity, radius: c.radius, maxAngle: c.maxAngle,
            friction: c.friction,
        };
        const box: Placed = {
            shape: 'box', p: golden.chain.box.p, q: [0, 0, 0], radius: 0, half: golden.chain.box.half, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        };
        const state = new ChainState(4);
        let worst = 0;

        golden.chain.anim.forEach((anim: V3[], i: number) => {
            if (!state.initialised) state.snapTo(anim);

            chainStep(state, params, STEP, anim, golden.chain.rest, golden.chain.delta[i], [box]);

            golden.chain.steps[i].forEach((expected: V3, k: number) => {
                for (let a = 0; a < 3; a++) worst = Math.max(worst, Math.abs(state.x[k][a] - expected[a]));
            });
        });

        expect(worst).toBeLessThan(1e-5);
    });
});

function runCloth(record: any, shapes: Placed[]): number {
    const c = record.params;
    const params: ClothParams = {
        stiffness: c.stiffness, bend: c.bend, damping: c.damping, inertia: c.inertia, gravity: c.gravity, radius: c.radius, pinHeight: 0, anchor: c.anchor, weight: 1,
        collidesWith: [], friction: c.friction, iterations: c.iterations, maxParticles: 600, volume: c.volume, softCenter: null, softRadius: 0, carry: [], mesh: -1, bone: 'x',
    };
    const topo = new Topology(record.rest as V3[], record.triangles);
    const state = new ClothState(record.rest.length);
    let worst = 0;

    record.pin.forEach((pin: number, k: number) => { state.pin[k] = pin; });
    record.anim.forEach((anim: V3[], i: number) => {
        if (!state.initialised) state.snapTo(anim);

        clothStep(topo, state, params, STEP, anim, record.delta[i], shapes);

        record.steps[i].forEach((expected: V3, k: number) => {
            for (let a = 0; a < 3; a++) worst = Math.max(worst, Math.abs(state.x[k][a] - expected[a]));
        });
    });

    return worst;
}

describe('the TypeScript cloth agrees with the Java one', () => {
    test('a curtain sewn along its top and swung over a floor follows the Java particles step by step, contact and friction included', () => {
        const box: Placed = {
            shape: 'box', p: golden.curtain.box.p, q: [0, 0, 0], radius: 0, half: golden.curtain.box.half, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        };

        expect(runCloth(golden.curtain, [box])).toBeLessThan(1e-5);
    });

    test('a soft ball with partial pins, an anchor and a volume to keep follows the Java particles step by step', () => {
        expect(runCloth(golden.ball, [])).toBeLessThan(1e-5);
    });
});

describe('the preview response', () => {
    const params = { frequency: 1.7, dampingRatio: 0.24, rotate: true, translate: false, tip: [0, -1, 0] as V3, length: 0.2, rotationLimit: null, translationLimit: 0 };

    test('a soft spring swings on the scripted walk and settles; a stiffer one swings less', () => {
        const soft = springResponse(params, 1, 0);
        const stiff = springResponse({ ...params, frequency: 4 }, 1, 0);

        expect(soft.peak).toBeGreaterThan(0.01);
        expect(stiff.peak).toBeLessThan(soft.peak);
        expect(soft.settle).toBeLessThan(2.5);
    });

    test('no inertia means the bone never lags, and a chain follows its animated tip more closely when stiffer', () => {
        expect(springResponse(params, 0, 0).peak).toBeLessThan(1e-6);

        const chain = { frequency: 1.5, dampingRatio: 0.2, inertia: 1, gravity: 9.8, radius: 0.05, maxAngle: 0, friction: 0 };
        const loose = chainResponse(chain, 3, 0.3);
        const tight = chainResponse({ ...chain, frequency: 6 }, 3, 0.3);

        expect(loose.peak).toBeGreaterThan(tight.peak);
    });
});

describe('config entries resolve like the games do', () => {
    test('a preset supplies the values and an explicit key overrides it', () => {
        const soft = resolveSpring({ preset: 'jiggle-soft' });
        const tuned = resolveSpring({ preset: 'jiggle-soft', frequency: 3, limit: { x: [-20, 20] } });

        expect([soft.params.frequency, soft.params.dampingRatio, soft.params.length]).toEqual([1.7, 0.24, 0.15]);
        expect(tuned.params.frequency).toBe(3);
        expect(tuned.params.rotationLimit![0]![1]).toBeCloseTo(20 * Math.PI / 180, 9);
        expect(tuned.params.rotationLimit![1]).toBeNull();
        expect(resolveSpring({ preset: 'soft-bone' }).params.translate).toBe(true);
        expect(resolveSpring({ preset: 'soft-bone', translate: false }).params.translate).toBe(false);
    });

    test('a chain preset gives its bend limit in radians, and the segment count is the bone count', () => {
        const tail = resolveChain({ preset: 'tail', bones: ['a', 'b', 'c'] });

        expect(tail.segments).toBe(3);
        expect(tail.params.maxAngle).toBeCloseTo(70 * Math.PI / 180, 9);
        expect(resolveChain({ bones: ['a'] }).params.maxAngle).toBe(0);
    });

    test('a whole document answers with one trace per bone and chain', () => {
        const traces = respond({ bones: { boobL: { preset: 'jiggle-soft' } }, chains: { hair: { preset: 'hair', bones: ['h1', 'h2'] } } });

        expect(traces.map(t => [t.kind, t.name])).toEqual([['bone', 'boobL'], ['chain', 'hair']]);
        expect(traces.every(t => t.trace.peak > 0)).toBe(true);
    });
});
