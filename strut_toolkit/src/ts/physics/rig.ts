/**
 * The physics of one model in the plugin: springs, chains, colliders and squish over a bone hierarchy, the TypeScript twin of the game's
 * {@code PhysicsInstance}, {@code ChainInstance} and {@code ColliderRig}. It works in world space in blocks: each frame the caller says where every bone is
 * (its pivot, its world orientation, its local rotation) as the animation left it, and the rig answers with a new local rotation (and scale) for the bones it
 * drives. The Blockbench tab feeds it three.js matrices; the tests feed it a hand-built skeleton. No Blockbench globals
 */
import { AutoOptions, ColliderSpec, DEFAULT_AUTO, isRelated, matches } from './autoColliders';
import {
    add, cross, dot, length, normalize, Q4, qaxisY, qfromEulerDegrees, qfromRotationVector, qinv, qmul, qnormalize, qrotate, qrotationTo, qslerp, scale, sub, V3,
} from './math';
import { applyRotation, ClothMesh, ClothParams, clothStep, ClothState, fitParticles, resolveCloth, rigidFit, Topology, weld } from './cloth';
import { resolveChain, resolveSpring, ResolvedChain, ResolvedSpring } from './preview';
import { ChainState, chainStep, Placed, pushOut, SpringState, springStep, STEP } from './solvers';

export interface BoneDef { readonly name: string; readonly parent: string | null }

/** Where the animation leaves a bone: pivot and orientation in the world (blocks), and its local rotation in its parent's frame */
export interface BoneFrame { readonly origin: V3; readonly orientation: Q4; readonly local: Q4 }

export interface EntityFrame {
    /** The model's position in the world, blocks */
    readonly pos: V3;
    /** Its turn about +Y, radians (counter-clockwise seen from above) */
    readonly yaw: number;
}

export interface BoneResult { readonly local: Q4; readonly scale: V3 }

/** One mesh of the model for cloth and flesh: the bone it is on, its vertices at rest (blocks, the game's mesh space) and its faces as vertex indices */
export interface ClothMeshInput {
    readonly key: string;
    readonly bone: string;
    readonly rest: readonly V3[];
    readonly faces: readonly (readonly number[])[];
}

export interface DebugLine { readonly a: V3; readonly b: V3; readonly kind: 'chain' | 'rest' | 'moved' }

const MAX_STEPS = 6;
const MAX_GAP_SECONDS = 0.5;
const BACKWARDS_JITTER_SECONDS = 0.25;
const TELEPORT_DISTANCE = 16;

/** What the entity's own motion does to a mass riding on it (the twin of the game's {@code Kinematics}), about +Y */
class Kinematics {
    private started = false;
    private p: V3 = [0, 0, 0];
    private yaw = 0;
    private velocity: V3 = [0, 0, 0];
    private angularVelocity = 0;
    acceleration: V3 = [0, 0, 0];
    omega = 0;
    alpha = 0;

    reset(): void {
        this.started = false;
        this.velocity = [0, 0, 0];
        this.angularVelocity = 0;
        this.acceleration = [0, 0, 0];
        this.omega = 0;
        this.alpha = 0;
    }

    advance(pos: V3, yaw: number, h: number): void {
        if (!this.started) {
            this.p = [...pos];
            this.yaw = yaw;
            this.started = true;

            return;
        }

        const v = scale(sub(pos, this.p), 1 / h);
        let d = yaw - this.yaw;

        d = Math.atan2(Math.sin(d), Math.cos(d));

        const w = d / h;

        this.acceleration = scale(sub(v, this.velocity), 1 / h);
        this.alpha = (w - this.angularVelocity) / h;
        this.omega = w;
        this.velocity = v;
        this.angularVelocity = w;
        this.p = [...pos];
        this.yaw = yaw;
    }

    /** The push on a mass at {@code lever} (world offset from the entity's origin), times {@code inertia} */
    force(lever: V3, inertia: number): V3 {
        const c = this.omega * this.omega;

        return scale([
            this.acceleration[0] + this.alpha * lever[2] - c * lever[0],
            this.acceleration[1],
            this.acceleration[2] - this.alpha * lever[0] - c * lever[2],
        ], -inertia);
    }
}

interface SpringPart {
    readonly name: string;
    readonly settings: ResolvedSpring;
    readonly state: SpringState;
    squishAmount: number;
    squishNormal: V3;
    pull: V3 | null;
}

/** A mesh that rides on a cloth or flesh as one rigid piece (a nipple on a breast) */
interface CarriedPart {
    readonly input: ClothMeshInput;
    /** The particles whose movement it follows */
    readonly fit: number[];
}

interface ClothPart {
    readonly name: string;
    readonly bone: string;
    readonly params: ClothParams;
    readonly flesh: boolean;
    readonly input: ClothMeshInput;
    readonly welded: ClothMesh;
    readonly topology: Topology;
    readonly state: ClothState;
    /** The first input vertex of each particle, to read where the animation puts it */
    readonly vertexOfParticle: number[];
    readonly carried: CarriedPart[];
    /** Where the animation puts each particle now, and as it was at the last step (world, blocks), and the carried meshes' vertices at the last step */
    animNow: V3[];
    animStep: V3[];
    carriedStep: Map<string, V3[]>;
}

interface ChainPart {
    readonly name: string;
    readonly bones: readonly string[];
    readonly settings: ResolvedChain;
    readonly state: ChainState;
    readonly n: number;
    // per frame
    points: V3[];
    orientation: Q4[];
    animatedLocal: Q4[];
    tipLocal: V3[];
    rest: number[];
    parentOrientation: Q4;
    output: Q4[] | null;
}

export class PhysicsRig {
    /** Things the config asked for that the model cannot do, for the panel to show */
    readonly problems: string[] = [];
    private readonly bones: readonly BoneDef[];
    private readonly parents = new Map<string, string | null>();
    private readonly springs: SpringPart[] = [];
    private readonly chains: ChainPart[] = [];
    private readonly cloths: ClothPart[] = [];
    /** Where the animation puts every vertex of every mesh in the world now (blocks), by the mesh's key: the caller sets it before each update or observe */
    clothAnimated: ReadonlyMap<string, readonly V3[]> = new Map();
    private readonly authored: ColliderSpec[] = [];
    private readonly auto: ColliderSpec[] = [];
    private readonly kinematics = new Kinematics();
    /** Per spring bone or chain name: the only bones of its own model it feels (when not empty), and the ones it ignores */
    private readonly filters = new Map<string, { only: string[]; ignore: string[] }>();
    private last: { pos: V3; yaw: number; seconds: number } | null = null;
    private frames: ReadonlyMap<string, BoneFrame> = new Map();
    private rootOrientation: Q4 = [0, 0, 0, 1];
    private results = new Map<string, BoneResult>();
    private placed: { spec: ColliderSpec; shape: Placed }[] = [];
    /** Whether blocks are modelled: a floor at {@code floorY} (blocks) that parts listing {@code world} collide with */
    floor = true;
    floorY = 0;
    /** Test shapes in the world (blocks), which parts that collide with {@code world} are pushed out of, like blocks */
    props: Placed[] = [];
    /** Slow motion factor, 1 is real time */
    timeScale = 1;
    /** How many fixed steps the last update took (a frame shorter than a step takes none) */
    lastSteps = 0;

    constructor(bones: readonly BoneDef[], doc: Record<string, any>, makeAuto: (options: AutoOptions) => ColliderSpec[], meshes: readonly ClothMeshInput[] = []) {
        this.bones = bones;

        for (const b of bones) this.parents.set(b.name, b.parent);

        const names = new Set(bones.map(b => b.name));
        const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

        for (const group of [doc.bones ?? {}, doc.chains ?? {}, doc.cloth ?? {}, doc.flesh ?? {}]) {
            for (const [part, entry] of Object.entries(group)) {
                const e = (entry ?? {}) as Record<string, any>;
                const only = list(e.collideBones);
                const ignore = list(e.ignoreBones);

                if (only.length || ignore.length) this.filters.set(part, { only, ignore });
            }
        }

        for (const [name, entry] of Object.entries(doc.bones ?? {})) {
            if (!names.has(name)) {
                this.problems.push(`bone "${name}" is not in the model`);

                continue;
            }

            this.springs.push({ name, settings: resolveSpring((entry ?? {}) as Record<string, any>), state: new SpringState(), squishAmount: 0, squishNormal: [0, 1, 0], pull: null });
        }

        for (const [name, entry] of Object.entries(doc.chains ?? {})) {
            const list: string[] = Array.isArray((entry as any)?.bones) ? (entry as any).bones.map(String) : [];
            let ok = list.length > 0;

            list.forEach((b, i) => {
                if (!names.has(b)) {
                    this.problems.push(`chain "${name}": bone "${b}" is not in the model`);
                    ok = false;
                }
                else if (i > 0 && this.parents.get(b) !== list[i - 1]) {
                    this.problems.push(`chain "${name}": "${b}" is not a child of "${list[i - 1]}"`);
                    ok = false;
                }
            });

            if (!ok) continue;

            const settings = resolveChain(entry as Record<string, any>);
            const n = list.length;

            this.chains.push({
                name, bones: list, settings, state: new ChainState(n + 1), n,
                points: [], orientation: [], animatedLocal: [], tipLocal: [], rest: [], parentOrientation: [0, 0, 0, 1], output: null,
            });
        }

        for (const flesh of [false, true]) {
            for (const [name, entry] of Object.entries((flesh ? doc.flesh : doc.cloth) ?? {})) {
                const params = resolveCloth({ bone: name, ...((entry ?? {}) as Record<string, any>) }, flesh);
                const where = `${flesh ? 'flesh' : 'cloth'} "${name}"`;

                if (!names.has(params.bone)) {
                    this.problems.push(`${where}: bone "${params.bone}" is not in the model`);

                    continue;
                }

                const own = meshes.filter(m => m.bone === params.bone);

                if (own.length === 0) {
                    this.problems.push(`${where}: bone "${params.bone}" has no mesh (cloth and flesh are made from a mesh, not from cubes)`);

                    continue;
                }

                own.forEach((input, index) => {
                    if (params.mesh >= 0 && params.mesh !== index) return;

                    const welded = weld(input.rest, input.faces);

                    if (welded.rest.length > params.maxParticles) {
                        this.problems.push(`${where}: its mesh has ${welded.rest.length} vertices, more than maxParticles ${params.maxParticles}; it is left as modelled`);

                        return;
                    }

                    if (welded.rest.length < 3) return;

                    const state = new ClothState(welded.rest.length);
                    const vertexOfParticle = new Array<number>(welded.rest.length).fill(-1);

                    welded.particleOfVertex.forEach((k, v) => { if (vertexOfParticle[k] < 0) vertexOfParticle[k] = v; });
                    state.setPins(welded.rest, params);

                    const carried: CarriedPart[] = [];

                    for (const boneName of params.carry) {
                        if (!names.has(boneName)) {
                            this.problems.push(`${where}: carries bone "${boneName}", which is not in the model`);

                            continue;
                        }

                        for (const other of meshes.filter(m => m.bone === boneName)) carried.push({ input: other, fit: fitParticles(welded.rest, other.rest) });
                    }

                    this.cloths.push({
                        name: own.length > 1 ? `${name}#${index}` : name, bone: params.bone, params, flesh, input, welded, topology: new Topology(welded.rest, welded.triangles), state,
                        vertexOfParticle, carried, animNow: [], animStep: [], carriedStep: new Map(),
                    });
                });
            }
        }

        for (const c of Array.isArray(doc.colliders) ? doc.colliders : []) {
            if (c && names.has(c.bone) && ['sphere', 'capsule', 'box'].includes(c.shape)) {
                this.authored.push({
                    bone: c.bone, shape: c.shape, a: (c.center ?? c.from ?? [0, 0, 0]) as V3, b: (c.size ?? c.to ?? [0, 0, 0]) as V3,
                    radius: typeof c.radius === 'number' ? c.radius : 0, layer: typeof c.layer === 'string' ? c.layer : 'body',
                    ...(c.shape === 'box' && Array.isArray(c.rotation) ? { rotation: c.rotation as V3 } : {}),
                });
            }
        }

        const wantsBody = this.springs.some(s => s.settings.collidesWith.includes('body')) || this.chains.some(c => c.settings.collidesWith.includes('body'))
            || this.cloths.some(c => c.params.collidesWith.includes('body'));
        const auto = doc.autoColliders;
        const options: AutoOptions = typeof auto === 'object' && auto !== null
            ? {
                maxCubes: typeof auto.maxCubes === 'number' ? auto.maxCubes : DEFAULT_AUTO.maxCubes,
                exclude: Array.isArray(auto.exclude) ? auto.exclude.map(String) : [],
                layer: typeof auto.layer === 'string' ? auto.layer : DEFAULT_AUTO.layer,
                maxShapes: typeof auto.maxShapes === 'number' ? auto.maxShapes : DEFAULT_AUTO.maxShapes,
                modes: typeof auto.bones === 'object' && auto.bones !== null ? auto.bones : {},
            }
            : DEFAULT_AUTO;
        const forced = typeof auto === 'boolean' ? auto : typeof auto === 'object' && auto !== null && typeof auto.enabled === 'boolean' ? auto.enabled : null;

        // made whenever a part collides with the body, except on bones that have shapes of their own (the game's rule)
        if (forced ?? wantsBody) this.auto.push(...makeAuto({ ...options, skip: [...new Set(this.authored.map(c => c.bone))] }));
    }

    get springCount(): number { return this.springs.length; }
    get chainCount(): number { return this.chains.length; }
    get clothCount(): number { return this.cloths.length; }
    get colliderCount(): number { return this.authored.length + this.auto.length; }

    /** The shapes made from the model, for drawing them apart from the authored ones */
    madeColliders(): readonly ColliderSpec[] {
        return this.auto;
    }

    /** Every collider, authored first, for drawing */
    colliders(): readonly ColliderSpec[] {
        return [...this.authored, ...this.auto];
    }

    reset(): void {
        for (const s of this.springs) {
            s.state.rot = [0, 0, 0];
            s.state.rotVel = [0, 0, 0];
            s.state.pos = [0, 0, 0];
            s.state.posVel = [0, 0, 0];
            s.squishAmount = 0;
        }

        for (const c of this.chains) {
            c.state.initialised = false;
            c.output = null;
        }

        for (const c of this.cloths) c.state.initialised = false;

        this.kinematics.reset();
        this.last = null;
        this.history = [];
        this.stepKnown = false;
        this.results = new Map();
    }

    /** Tells the rig where the bones are without stepping it, so its debug lines and shapes can be drawn for a model that is standing still */
    observe(frames: ReadonlyMap<string, BoneFrame>): void {
        this.frames = frames;
        this.prepareChains();
        this.prepareCloth();
    }

    /** Where the animation puts each segment of the chain holding {@code bone} (world blocks), and its bend limit in degrees, for drawing the limit cones */
    chainSegments(bone: string): { segments: [V3, V3][]; maxAngle: number } | null {
        const c = this.chains.find(x => x.bones.includes(bone));

        if (!c || c.points.length < 2) return null;

        const segments: [V3, V3][] = [];

        for (let i = 0; i + 1 < c.points.length; i++) segments.push([c.points[i], c.points[i + 1]]);

        return { segments, maxAngle: c.settings.params.maxAngle * 180 / Math.PI };
    }

    /** A kick to a bone or chain, a world velocity in blocks per second */
    impulse(name: string, v: V3): void {
        const chain = this.chains.find(c => c.name === name || c.bones.includes(name));

        if (chain && chain.state.initialised) {
            for (let k = 1; k <= chain.n; k++) for (let a = 0; a < 3; a++) chain.state.prev[k][a] -= v[a] * STEP;
        }

        for (const c of this.cloths) {
            if (c.bone !== name || !c.state.initialised) continue;

            for (let k = 0; k < c.state.x.length; k++) {
                if (c.state.pin[k] >= 0.999) continue;

                for (let a = 0; a < 3; a++) c.state.prev[k][a] -= v[a] * STEP;
            }
        }

        const spring = this.springs.find(s => s.name === name);
        const frame = this.frames.get(name);

        if (spring && frame) {
            const local = qrotate(qinv(frame.orientation), v);
            const t = cross(spring.settings.params.tip, local);
            const lever = Math.max(1e-4, spring.settings.params.length);

            for (let i = 0; i < 3; i++) {
                spring.state.rotVel[i] += t[i] / lever;
                spring.state.posVel[i] += local[i] * 16;
            }
        }
    }

    /** Holds a spring bone's mass at a world point (or lets go with null) */
    pull(name: string, target: V3 | null): void {
        const spring = this.springs.find(s => s.name === name);

        if (spring) spring.pull = target;
    }

    /**
     * Advances to {@code seconds} and returns the new local rotation and scale of every bone the rig drives
     *
     * @param frames Where the animation leaves each bone this frame (bones not listed are not driven)
     * @param rootOrientation The world orientation of what the top-level bones hang from (the model's own turn)
     */
    update(frames: ReadonlyMap<string, BoneFrame>, entity: EntityFrame, rootOrientation: Q4, seconds: number): ReadonlyMap<string, BoneResult> {
        this.frames = frames;
        this.nowFrames = frames;
        this.rootOrientation = rootOrientation;
        this.entity = entity;

        let now = seconds;

        if (this.last !== null && now < this.last.seconds && this.last.seconds - now <= BACKWARDS_JITTER_SECONDS) now = this.last.seconds;

        const l = this.last;

        if (l === null || now < l.seconds || now - l.seconds > MAX_GAP_SECONDS || length(sub(entity.pos, l.pos)) > TELEPORT_DISTANCE) {
            this.reset();
            this.kinematics.advance(entity.pos, entity.yaw, STEP);
            this.last = { pos: entity.pos, yaw: entity.yaw, seconds: now };
            this.history.push(this.last);
            this.simTime = now;
            this.prepareChains();
            this.prepareCloth();
            this.results = this.output();

            return this.results;
        }

        this.history.push({ pos: entity.pos, yaw: entity.yaw, seconds: now });

        // The physics runs on its own clock of fixed steps, and the entity's place at each step is read off its path between the frames' samples, so the
        // speed the springs see does not depend on how the frames happen to fall against the steps
        const h = STEP / this.timeScale;
        const steps = Math.min(Math.floor((now - this.simTime) / h + 1e-9), MAX_STEPS);

        this.lastSteps = steps;
        this.prepareChains();
        this.prepareCloth();

        let previous: V3 = this.stepKnown ? this.stepPos : entity.pos;

        for (let s = 1; s <= steps; s++) {
            this.simTime += h;

            const at = this.pathAt(this.simTime);

            this.kinematics.advance(at.pos, at.yaw, h);
            this.frames = this.framesAtStep(at.pos, at.yaw);
            this.stepSprings(at.pos);
            this.stepChains(at.pos, at.yaw, sub(at.pos, previous));
            this.stepCloth(at.pos, at.yaw, sub(at.pos, previous));
            previous = at.pos;
            this.stepPos = at.pos;
            this.stepYaw = at.yaw;
            this.stepKnown = true;
        }

        this.frames = frames;

        if (now - this.simTime > MAX_STEPS * h) this.simTime = now - h;

        while (this.history.length > 2 && this.history[1].seconds <= this.simTime) this.history.shift();

        this.last = { pos: entity.pos, yaw: entity.yaw, seconds: now };
        this.results = this.output();

        return this.results;
    }

    private history: { pos: V3; yaw: number; seconds: number }[] = [];
    private simTime = 0;
    private stepPos: V3 = [0, 0, 0];
    private stepYaw = 0;
    private stepKnown = false;
    private nowFrames: ReadonlyMap<string, BoneFrame> = new Map();
    private entity: EntityFrame = { pos: [0, 0, 0], yaw: 0 };

    private pathAt(seconds: number): { pos: V3; yaw: number } {
        let from = this.history[0];
        let to = from;

        for (let i = 1; i < this.history.length; i++) {
            from = this.history[i - 1];
            to = this.history[i];

            if (to.seconds >= seconds) break;
        }

        const span = to.seconds - from.seconds;
        const f = span <= 1e-9 ? 1 : Math.max(0, Math.min(1, (seconds - from.seconds) / span));
        const dyaw = Math.atan2(Math.sin(to.yaw - from.yaw), Math.cos(to.yaw - from.yaw));

        return { pos: [from.pos[0] + (to.pos[0] - from.pos[0]) * f, from.pos[1] + (to.pos[1] - from.pos[1]) * f, from.pos[2] + (to.pos[2] - from.pos[2]) * f], yaw: from.yaw + dyaw * f };
    }

    /** The frame's bones as they were when the entity was at {@code pos} facing {@code yaw}: the same skeleton, carried and turned with the entity */
    private framesAtStep(pos: V3, yaw: number): ReadonlyMap<string, BoneFrame> {
        const turn = qaxisY(yaw - this.entity.yaw);
        const out = new Map<string, BoneFrame>();

        this.nowFrames.forEach((f, name) => {
            out.set(name, { origin: add(pos, qrotate(turn, sub(f.origin, this.entity.pos))), orientation: qmul(turn, f.orientation), local: f.local });
        });

        return out;
    }

    /** A point solved at the last step, as it is placed on the entity where it is drawn now */
    private toNow(p: V3): V3 {
        if (!this.stepKnown) return p;

        const back = qaxisY(this.entity.yaw - this.stepYaw);

        return add(this.entity.pos, qrotate(back, sub(p, this.stepPos)));
    }

    /** The particles of a chain (by its name or one of its bones) placed on the model where it is drawn now, for drawing and tests */
    chainPoints(name: string): V3[] {
        const c = this.chains.find(x => x.name === name || x.bones.includes(name));

        return c && c.state.initialised ? c.state.x.map(p => this.toNow(p as V3)) : [];
    }

    // ---------------- shapes ----------------

    private placeShapes(offset: V3): void {
        this.placed = [];

        const all: { spec: ColliderSpec; generated: boolean }[] = [...this.authored.map(spec => ({ spec, generated: false })), ...this.auto.map(spec => ({ spec, generated: true }))];

        for (const { spec, generated } of all) {
            const frame = this.frames.get(spec.bone);

            if (!frame) continue;

            const at = (local: V3): V3 => add(add(frame.origin, qrotate(frame.orientation, scale(local, 1 / 16))), offset);
            const turn = spec.rotation ? qmul(frame.orientation, qfromEulerDegrees(spec.rotation)) : frame.orientation;
            const shape: Placed = {
                shape: spec.shape, p: at(spec.a), q: spec.shape === 'capsule' ? at(spec.b) : [0, 0, 0], radius: spec.radius / 16,
                half: [Math.abs(spec.b[0]) / 32, Math.abs(spec.b[1]) / 32, Math.abs(spec.b[2]) / 32],
                axes: [qrotate(turn, [1, 0, 0]), qrotate(turn, [0, 1, 0]), qrotate(turn, [0, 0, 1])],
            };

            (shape as any).generated = generated;
            this.placed.push({ spec, shape });
        }
    }

    private floorShape(): Placed | null {
        if (!this.floor) return null;

        return { shape: 'box', p: [0, this.floorY - 5, 0], q: [0, 0, 0], radius: 0, half: [200, 5, 200], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
    }

    /** The shapes a part made of {@code bones} collides with: the layers it lists, minus the generated shapes built on it, minus those it already overlaps at rest */
    /** Whether the part called {@code part} feels shapes on {@code bone} by its allow and deny lists */
    allows(part: string, bone: string): boolean {
        const f = this.filters.get(part);

        if (!f) return true;

        if (f.ignore.some(p => matches(p, bone))) return false;

        return f.only.length === 0 || f.only.some(p => matches(p, bone));
    }

    /** The spring bone or chain that {@code bone} is part of: its name, its bones and the layers it collides with, or null */
    partOf(bone: string): { name: string; bones: readonly string[]; layers: readonly string[] } | null {
        const spring = this.springs.find(s => s.name === bone);

        if (spring) return { name: spring.name, bones: [spring.name], layers: spring.settings.collidesWith };

        const chain = this.chains.find(c => c.bones.includes(bone));

        if (chain) return { name: chain.name, bones: chain.bones, layers: chain.settings.collidesWith };

        const soft = this.cloths.find(c => c.bone === bone);

        return soft ? { name: soft.name.split('#')[0], bones: [soft.bone], layers: soft.params.collidesWith } : null;
    }

    /**
     * Whether the part holding {@code bone} collides with a shape on {@code shapeBone} (made from the model or not), leaving aside what it only overlaps at
     * rest: the layer, the made shapes on its own bones and their relatives, and the allow and deny lists
     */
    feels(bone: string, spec: ColliderSpec, generated: boolean): boolean {
        const part = this.partOf(bone);

        if (!part || !part.layers.includes(spec.layer)) return false;

        if (generated && part.bones.some(b => isRelated(spec.bone, b, this.parents))) return false;

        return this.allows(part.name, spec.bone);
    }

    /** The bones with shapes that the part holding {@code bone} could collide with, before its allow and deny lists, in the order the shapes come */
    candidateBones(bone: string): string[] {
        const part = this.partOf(bone);

        if (!part) return [];

        const out: string[] = [];
        const look = (spec: ColliderSpec, generated: boolean): void => {
            if (!part.layers.includes(spec.layer) || out.includes(spec.bone)) return;

            if (generated && part.bones.some(b => isRelated(spec.bone, b, this.parents))) return;

            out.push(spec.bone);
        };

        this.authored.forEach(s => look(s, false));
        this.auto.forEach(s => look(s, true));

        return out;
    }

    private shapesFor(part: string, bones: readonly string[], layers: readonly string[], restPoints: readonly V3[], radius: number): Placed[] {
        const out: Placed[] = [];

        for (const { spec, shape } of this.placed) {
            if (!layers.includes(spec.layer) || !this.allows(part, spec.bone)) continue;

            if ((shape as any).generated) {
                if (bones.some(b => isRelated(spec.bone, b, this.parents))) continue;

                const probe: V3 = [0, 0, 0];
                let resting = false;

                for (const p of restPoints) {
                    probe[0] = p[0]; probe[1] = p[1]; probe[2] = p[2];
                    resting = pushOut(shape, probe, radius) || resting;
                }

                if (resting) continue;
            }

            out.push(shape);
        }

        if (layers.includes('world')) {
            const floor = this.floorShape();

            if (floor) out.push(floor);

            out.push(...this.props);
        }

        return out;
    }

    // ---------------- springs ----------------

    private stepSprings(entityPos: V3): void {
        const offset: V3 = [0, 0, 0];

        this.placeShapes(offset);

        for (const s of this.springs) {
            const frame = this.frames.get(s.name);
            const p = s.settings;

            if (!frame || p.weight <= 0 || !p.params.rotate) {
                s.state.rot = [0, 0, 0];
                s.state.rotVel = [0, 0, 0];
                s.squishAmount = 0;

                continue;
            }

            const lever = sub(frame.origin, entityPos);
            void offset;
            let force = add(this.kinematics.force(lever, p.inertia), [0, -p.gravity, 0]);

            if (s.pull) {
                const tip = add(add(frame.origin, offset), qrotate(frame.orientation, scale(p.params.tip, p.params.length)));
                const gain = 400;

                force = add(force, scale(sub(s.pull, tip), gain));
            }

            springStep(s.state, p.params, STEP, qrotate(qinv(frame.orientation), force));
            this.press(s, frame, offset);
        }
    }

    private press(s: SpringPart, frame: BoneFrame, offset: V3): void {
        const p = s.settings;
        const rest = scale(p.params.tip, p.params.length);
        const restWorld = add(add(frame.origin, offset), qrotate(frame.orientation, rest));
        const shapes = p.collidesWith.length > 0 ? this.shapesFor(s.name, [s.name], p.collidesWith, [restWorld], p.radius) : [];
        let target = 0;

        if (shapes.length > 0) {
            const moved = add(cross(s.state.rot, rest), rest);
            const worldPoint = add(add(frame.origin, offset), qrotate(frame.orientation, moved));
            const contact: V3 = [...worldPoint];
            let pressed = false;

            for (const shape of shapes) pressed = pushOut(shape, contact, p.radius) || pressed;

            if (pressed) {
                const pushBone = qrotate(qinv(frame.orientation), sub(contact, worldPoint));
                const goal = add(moved, pushBone);
                const swing = scale(cross(rest, sub(goal, rest)), 1 / Math.max(1e-6, dot(rest, rest)));
                const axis = normalize(rest);
                const twist = dot(s.state.rot, axis);
                const next = add(scale(axis, twist), swing);
                const before: V3 = [...s.state.rot];

                for (let i = 0; i < 3; i++) {
                    let v = next[i];
                    const limit = p.params.rotationLimit ? p.params.rotationLimit[i] : null;

                    if (limit) v = Math.max(limit[0], Math.min(limit[1], v));

                    s.state.rot[i] = v;
                }

                const d = sub(s.state.rot, before);
                const dl = length(d);

                if (dl > 1e-9) {
                    const into = dot(s.state.rotVel, d) / dl;

                    if (into < 0) for (let i = 0; i < 3; i++) s.state.rotVel[i] -= into * d[i] / dl;
                }
            }

            if (p.squish > 0) {
                const probe: V3 = [...restWorld];
                let inside = false;

                for (const shape of shapes) inside = pushOut(shape, probe, p.radius) || inside;

                if (inside) {
                    const out = qrotate(qinv(frame.orientation), sub(probe, restWorld));
                    const depth = length(out);

                    if (depth > 1e-6) {
                        s.squishNormal = normalize(out);
                        target = Math.min(1, depth / Math.max(1e-3, p.radius)) * p.squish;
                    }
                }
            }
        }

        const rate = target > s.squishAmount ? 40 : 10;

        s.squishAmount += (target - s.squishAmount) * (1 - Math.exp(-rate * STEP));

        if (s.squishAmount < 1e-4) s.squishAmount = 0;
    }

    // ---------------- chains ----------------

    private prepareChains(): void {
        for (const c of this.chains) {
            const n = c.n;
            const frames = c.bones.map(b => this.frames.get(b));

            if (frames.some(f => f === undefined)) {
                c.output = null;

                continue;
            }

            const fs = frames as BoneFrame[];

            c.points = fs.map(f => [...f.origin] as V3);
            c.orientation = fs.map(f => f.orientation);
            c.animatedLocal = fs.map(f => f.local);

            const first = this.parents.get(c.bones[0]);
            const parentFrame = first ? this.frames.get(first) : undefined;

            c.parentOrientation = parentFrame ? parentFrame.orientation : this.rootOrientation;

            c.tipLocal = Array.from({ length: n }, () => [0, -1, 0] as V3);

            if (n > 1) {
                let dir = sub(c.points[n - 1], c.points[n - 2]);

                if (dot(dir, dir) < 1e-10) dir = [0, -1, 0];

                c.tipLocal[n - 1] = qrotate(qinv(c.orientation[n - 1]), normalize(dir));
            }

            c.points.push(add(c.points[n - 1], qrotate(c.orientation[n - 1], scale(c.tipLocal[n - 1], c.settings.tipLength))));
            c.rest = [];

            for (let i = 0; i < n; i++) {
                const seg = sub(c.points[i + 1], c.points[i]);

                c.rest.push(Math.max(1e-6, length(seg)));

                if (i < n - 1) c.tipLocal[i] = qrotate(qinv(c.orientation[i]), normalize(seg));
            }
        }
    }

    private stepChains(stepPos: V3, stepYaw: number, entityDelta: V3): void {
        const turn = qaxisY(stepYaw - this.entity.yaw);

        for (const c of this.chains) {
            if (c.points.length === 0) continue;

            const anim = c.points.map(p => add(stepPos, qrotate(turn, sub(p, this.entity.pos))));

            if (!c.state.initialised) c.state.snapTo(anim);

            const restPoints = anim.slice(1);
            const shapes = this.shapesFor(c.name, c.bones, c.settings.collidesWith, restPoints, c.settings.params.radius);

            if (c.settings.weight > 0)
                chainStep(c.state, c.settings.params, STEP, anim, c.rest, entityDelta, shapes);
        }
    }

    // ---------------- cloth and flesh ----------------

    private prepareCloth(): void {
        for (const c of this.cloths) {
            const now = this.clothAnimated.get(c.input.key);

            c.animNow = now ? c.vertexOfParticle.map(v => now[v] as V3) : [];
        }
    }

    private stepCloth(stepPos: V3, stepYaw: number, entityDelta: V3): void {
        const turn = qaxisY(stepYaw - this.entity.yaw);
        const place = (p: V3): V3 => add(stepPos, qrotate(turn, sub(p, this.entity.pos)));

        for (const c of this.cloths) {
            if (c.animNow.length === 0) continue;

            const anim = c.animNow.map(place);

            if (!c.state.initialised) c.state.snapTo(anim);

            c.animStep = anim;
            c.carriedStep = new Map();

            for (const k of c.carried) {
                const now = this.clothAnimated.get(k.input.key);

                if (now) c.carriedStep.set(k.input.key, now.map(v => place(v as V3)));
            }

            const shapes = this.shapesFor(c.name.split('#')[0], [c.bone], c.params.collidesWith, anim, c.params.radius);

            if (c.params.weight > 0) clothStep(c.topology, c.state, c.params, STEP, anim, entityDelta, shapes);
        }
    }

    /**
     * Where each vertex of the mesh with this key is now, placed on the model where it is drawn (blocks), or null when it is not cloth, flesh or carried by
     * one, or has not been simulated yet. For a carried mesh: the animated vertices moved by the one rigid motion of the particles around it
     */
    clothVertices(key: string): V3[] | null {
        for (const c of this.cloths) {
            if (!c.state.initialised) continue;

            if (c.input.key === key) return c.welded.particleOfVertex.map(k => this.toNow(c.state.x[k] as V3));

            const carried = c.carried.find(k => k.input.key === key);
            const verts = c.carriedStep.get(key);

            if (carried && verts && carried.fit.length > 0) {
                const fit = rigidFit(carried.fit.map(k => c.animStep[k]), carried.fit.map(k => c.state.x[k] as V3));

                return verts.map(v => this.toNow(add(fit.centreTo, applyRotation(fit.rotation, sub(v, fit.centreFrom)))));
            }
        }

        return null;
    }

    /** Which input meshes are simulated or carried (their keys), for hiding the originals while the preview runs */
    clothKeys(): string[] {
        return this.cloths.flatMap(c => [c.input.key, ...c.carried.map(k => k.input.key)]);
    }

    /** A line per cloth or flesh for the panel: how many particles, and how far the worst edge has stretched */
    clothReport(): { name: string; flesh: boolean; particles: number; worstEdge: number }[] {
        return this.cloths.map(c => {
            let worst = 0;

            if (c.state.initialised) {
                for (let e = 0; e < c.topology.edgeA.length; e++) {
                    const r = c.topology.edgeRest[e];

                    if (r > 1e-9) worst = Math.max(worst, Math.abs(Math.hypot(...(sub(c.state.x[c.topology.edgeA[e]] as V3, c.state.x[c.topology.edgeB[e]] as V3))) - r) / r);
                }
            }

            return { name: c.name, flesh: c.flesh, particles: c.welded.rest.length, worstEdge: worst };
        });
    }

    // ---------------- output ----------------

    private output(): Map<string, BoneResult> {
        const out = new Map<string, BoneResult>();

        for (const c of this.chains) {
            if (!c.state.initialised || c.points.length === 0) continue;

            const w = c.settings.weight;
            const model = c.state.x.map(p => this.toNow(p as V3));
            let parentNew: Q4 = c.parentOrientation;

            for (let i = 0; i < c.n; i++) {
                const animatedTip = normalize(qrotate(c.orientation[i], c.tipLocal[i]));
                let simulated = sub(model[i + 1], model[i]);

                if (dot(simulated, simulated) < 1e-12) simulated = animatedTip;

                simulated = normalize(simulated);

                const swing = qrotationTo(animatedTip, simulated);
                const newWorld = qmul(swing, c.orientation[i]);
                const local = qnormalize(qmul(qinv(parentNew), newWorld));
                const blended = qslerp(c.animatedLocal[i], local, w);

                out.set(c.bones[i], { local: blended, scale: [1, 1, 1] });
                parentNew = qmul(parentNew, blended);
            }
        }

        for (const s of this.springs) {
            const frame = this.frames.get(s.name);
            const p = s.settings;

            if (!frame || p.weight <= 0) continue;

            const local = p.params.rotate ? qmul(frame.local, qfromRotationVector(scale(s.state.rot, p.weight))) : frame.local;
            let sc: V3 = [1, 1, 1];

            if (s.squishAmount > 0) {
                const a = s.squishAmount * p.weight;
                const n = s.squishNormal;
                const sx = 1 - a * n[0] * n[0];
                const sy = 1 - a * n[1] * n[1];
                const sz = 1 - a * n[2] * n[2];
                const k = 1 / Math.cbrt(sx * sy * sz);

                sc = [sx * k, sy * k, sz * k];
            }

            out.set(s.name, { local, scale: sc });
        }

        return out;
    }

    // ---------------- drawing ----------------

    /** Lines showing what the physics is doing: chains as their particles, springs from rest to where the mass is */
    debugLines(): DebugLine[] {
        const lines: DebugLine[] = [];

        for (const c of this.chains) {
            if (!c.state.initialised) continue;

            for (let k = 0; k < c.n; k++) lines.push({ a: this.toNow(c.state.x[k] as V3), b: this.toNow(c.state.x[k + 1] as V3), kind: 'chain' });
        }

        for (const s of this.springs) {
            const frame = this.frames.get(s.name);

            if (!frame) continue;

            const rest = scale(s.settings.params.tip, s.settings.params.length);
            const moved = add(cross(s.state.rot, rest), rest);

            lines.push({ a: frame.origin, b: add(frame.origin, qrotate(frame.orientation, rest)), kind: 'rest' });
            lines.push({ a: frame.origin, b: add(frame.origin, qrotate(frame.orientation, moved)), kind: 'moved' });
        }

        return lines;
    }
}

export { qaxisY };
