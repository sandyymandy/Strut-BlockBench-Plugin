/**
 * The Physics tab: a mode beside Edit, Paint and Animate. Pick a bone in the panel's own bone list, turn it into a spring (jiggle) or a chain (hair, tail) with
 * sliders, add colliders and test shapes, and press Simulate to watch the real model move with the same physics the game runs, driven by a scripted motion or
 * by one of the model's own animations. The settings are the JSON the game reads (kept in the project and written into the .strutmodel); this file only wires
 * Blockbench to the tested modules in {@code physics/}: it reads each bone's matrix from three.js, asks {@link PhysicsRig} for new local rotations, and writes
 * them back. Test shapes exist only on this screen: they are three.js meshes in the scene, never elements of the project
 * <p>
 * Everything here that touches Blockbench or three.js needs a live Blockbench to check; the physics it drives is tested
 */
import { PROPERTY_PHYSICS } from './constants';
import { AutoBone, AutoMode, ColliderSpec, generateAutoColliders } from './physics/autoColliders';
import {
    addColliderForm, autoModeOf, BoneFilter, boneFilterOf, ColliderForm, collidersOn, setBoneFilter, switchFilterMode, tickBone, fitForm, Limits, removeColliderAt, setAutoEnabled, setAutoMode, setSpringLimits, Shape, springLimits,
    updateColliderAt,
} from './physics/colliderEdit';
import {
    autoCollidersOf, chainControls, chainFrom, chainNameOf, CHAIN_DEFAULTS, Doc, kindOf, LOOKS, PartControls, PartKind, readDoc,
    removePart, setChain, setSoft, SoftControls, SOFT_LOOKS, softControls, softLook, setSpring, SPRING_DEFAULTS, springControls, summarise, withLook, writeDoc,
} from './physics/edit';
import { resolveSpring } from './physics/preview';
import { Q4, qaxisY, V3 } from './physics/math';
import { colliderLines, limitArc, limitCone, MotionKind, MOTIONS, motionAt, Segment } from './physics/motion';
import { BoneFrame, ClothMeshInput, PhysicsRig } from './physics/rig';
import { Placed } from './physics/solvers';
import { checkPhysics } from './physics/config';
import { History } from './physics/history';
import { openPhysicsDialog } from './physicsUi';

const G = globalThis as any;
const MODE_ID = 'strut_physics';
const PANEL_ID = 'strut_physics_panel';
/** Blockbench units per block */
const U = 16;

interface Snapshot { readonly q: any; readonly s: any; readonly p: any }

/** A shape that exists only on this screen, for parts to bump into */
interface PropDef {
    id: number;
    kind: 'sphere' | 'box' | 'capsule' | 'wall';
    /** Blocks, in the scene */
    x: number;
    y: number;
    z: number;
    /** Blocks: a ball's diameter, a block's side, a pole's length, a wall's height */
    size: number;
    /** Slides back and forth along x so a moving thing can be tried against the model */
    sweep: boolean;
}

interface TreeNode { name: string; depth: number; hasKids: boolean; kind: PartKind; parent: string | null; auto: AutoMode }

const SHAPE_NAMES: Record<Shape, string> = { sphere: 'Sphere', capsule: 'Capsule', box: 'Box' };

/** Everything the panel shows and edits; reactive, shared with the Vue component */
const ui = {
    selected: '' as string,
    kind: 'none' as PartKind,
    controls: { ...SPRING_DEFAULTS } as PartControls,
    /** The picked bone as cloth or flesh */
    soft: softControls({}, '', 'cloth') as SoftControls,
    /** Whether the picked bone has a mesh of its own (cloth and flesh are made from one), and the other bones that have meshes */
    hasMesh: false,
    meshBones: [] as string[],
    softLooks: Object.entries(SOFT_LOOKS).map(([id, l]) => ({ id, label: l.label, kind: l.kind })),
    running: false,
    motion: 'walk' as MotionKind,
    animation: '' as string,
    speed: 1,
    animations: [] as string[],
    showColliders: true,
    showDebug: true,
    autoColliders: null as boolean | null,
    summary: '',
    problems: [] as string[],
    notice: '',
    query: '',
    tree: [] as TreeNode[],
    open: {} as Record<string, boolean>,
    sections: { test: true, bones: true, feel: true, more: false, limits: false, shapes: true, props: false, zone: true, carry: true } as Record<string, boolean>,
    /** The selected bone's own collision shapes: their places in the document's list, and names */
    shapes: [] as { index: number; label: string }[],
    /** The one being edited, by its place in the document's list, or -1 */
    shapeIndex: -1,
    form: null as ColliderForm | null,
    autoMode: 'auto' as AutoMode,
    limits: { x: null, y: null, z: null } as Limits,
    showLimits: true,
    /** Draw every shape, not only those the selected bone bumps into */
    showAllShapes: false,
    /** The bones with shapes the selected part could bump into, and its allow or deny list */
    candidates: [] as string[],
    filter: { only: [], ignore: [] } as BoneFilter,
    onlyTicked: false,
    props: [] as PropDef[],
    canUndo: false,
    canRedo: false,
    looks: Object.entries(LOOKS).map(([id, l]) => ({ id, label: l.label, kind: l.kind })),
    motions: MOTIONS,
};

// ---------------- reading the project ----------------

function groups(): any[] {
    return (G.Group?.all ?? []) as any[];
}

function groupName(node: any): string | null {
    return node && node !== 'root' && typeof node.name === 'string' ? node.name : null;
}

function childGroups(group: any): any[] {
    return (group.children ?? []).filter((c: any) => c instanceof G.Group);
}

function physicsText(): string {
    return String(G.Project?.[PROPERTY_PHYSICS] ?? '');
}

function savePhysicsText(text: string): void {
    G.Project[PROPERTY_PHYSICS] = text;
    G.Project.saved = false;
}

function selectedGroupName(): string {
    const g = G.Group?.first_selected ?? G.Group?.selected;

    return groupName(g) ?? '';
}

function autoBones(): AutoBone[] {
    const THREE = G.THREE;

    return groups().map((g): AutoBone => {
        const cubes: V3[][] = [];
        const meshVertices: V3[] = [];

        for (const child of g.children ?? []) {
            if (child.export === false) continue;

            if (child instanceof G.Cube) {
                const from = child.from as V3;
                const to = child.to as V3;
                const o = (child.origin ?? [0, 0, 0]) as V3;
                const r = (child.rotation ?? [0, 0, 0]) as V3;
                const euler = new THREE.Euler(r[0] * Math.PI / 180, r[1] * Math.PI / 180, r[2] * Math.PI / 180, 'ZYX');
                const corners: V3[] = [];

                for (const x of [from[0], to[0]]) for (const y of [from[1], to[1]]) for (const z of [from[2], to[2]]) {
                    const v = new THREE.Vector3(x - o[0], y - o[1], z - o[2]).applyEuler(euler);

                    corners.push([v.x + o[0], v.y + o[1], v.z + o[2]]);
                }

                cubes.push(corners);
            }
            else if (child instanceof G.Mesh) {
                const o = (child.origin ?? [0, 0, 0]) as V3;

                for (const v of Object.values(child.vertices ?? {}) as V3[]) meshVertices.push([v[0] + o[0], v[1] + o[1], v[2] + o[2]]);
            }
        }

        return { name: g.name, parent: groupName(g.parent), origin: (g.origin ?? [0, 0, 0]) as V3, cubes, meshVertices, hidden: g.export === false };
    });
}

/** The mesh elements of the project, with the bone each is in */
function meshElements(): { element: any; bone: string }[] {
    const out: { element: any; bone: string }[] = [];

    for (const g of groups()) {
        for (const child of g.children ?? []) {
            if (child instanceof G.Mesh && child.export !== false) out.push({ element: child, bone: g.name as string });
        }
    }

    return out;
}

/** Each mesh as cloth and flesh see it: vertices in blocks in the game's mesh space (the vertex and the mesh's origin, over 16), faces as indices */
function meshInputs(): ClothMeshInput[] {
    return meshElements().map(({ element, bone }): ClothMeshInput => {
        const keys = Object.keys(element.vertices ?? {});
        const o = (element.origin ?? [0, 0, 0]) as V3;
        const index = new Map(keys.map((k, i) => [k, i]));

        return {
            key: String(element.uuid),
            bone,
            rest: keys.map((k): V3 => [(element.vertices[k][0] + o[0]) / U, (element.vertices[k][1] + o[1]) / U, (element.vertices[k][2] + o[2]) / U]),
            faces: (Object.values(element.faces ?? {}) as any[]).map(f => (f.vertices as string[]).map(v => index.get(v) ?? 0)).filter(f => f.length >= 3),
        };
    });
}

// ---------------- the session: rig, pose capture, overlay, simulation loop ----------------

class Session {
    doc: Doc = {};
    rig: PhysicsRig | null = null;
    private snapshots = new Map<string, Snapshot>();
    private overlay: any = null;
    private propMeshes: any[] = [];
    private nextProp = 1;
    private raf = 0;
    private started = 0;
    private modelSnapshot: { p: any; ry: number } | null = null;

    /** Reads the document from the project, rebuilds the rig and redraws */
    reload(): void {
        this.doc = readDoc(physicsText());
        this.rebuild();
        this.refreshSelection();
        this.syncProps();
    }

    rebuild(): void {
        const bones = groups().map(g => ({ name: g.name as string, parent: groupName(g.parent) }));

        this.rig = new PhysicsRig(bones, this.doc, options => generateAutoColliders(autoBones(), options), meshInputs());

        const check = checkPhysics(writeDoc(this.doc), bones.map(b => b.name));

        ui.problems = [...check.warnings, ...this.rig.problems];
        ui.summary = summarise(this.doc);
        ui.autoColliders = autoCollidersOf(this.doc);
        this.refreshTags();
        this.refreshTree();
        this.drawOverlay();
    }

    /**
     * The picked bone's tag, its allow or deny list and the bones it could bump into. Recomputed on every rebuild, not only when a bone is picked: toggling
     * "bumps into its own body" or editing a shape changes what is on offer without changing the selection
     */
    private refreshTags(): void {
        ui.autoMode = ui.selected ? autoModeOf(this.doc, ui.selected) : 'auto';
        ui.candidates = ui.selected && this.rig ? this.rig.candidateBones(ui.selected) : [];
        ui.filter = ui.selected ? boneFilterOf(this.doc, ui.selected) : { only: [], ignore: [] };
        ui.onlyTicked = ui.filter.only.length > 0;
        ui.limits = ui.selected && ui.kind === 'spring' ? springLimits(this.doc, ui.selected) : { x: null, y: null, z: null };
    }

    private readonly history = new History();

    private syncHistory(): void {
        ui.canUndo = this.history.canUndo;
        ui.canRedo = this.history.canRedo;
    }

    /** Forgets the undo steps (another project was opened) */
    clearHistory(): void {
        this.history.clear();
        this.syncHistory();
    }

    /** Notes the text as it is now so an edit made outside this tab (the JSON dialog) can be undone */
    noteExternalEdit(): void {
        this.history.record(physicsText(), 'json', performance.now());
        this.syncHistory();
    }

    undo(): void {
        this.step(this.history.undo(physicsText()));
    }

    redo(): void {
        this.step(this.history.redo(physicsText()));
    }

    private step(text: string | null): void {
        if (text === null) return;

        savePhysicsText(text);
        this.syncHistory();
        this.doc = readDoc(text);

        const was = ui.running;

        this.rebuild();

        if (was) this.rig?.reset();

        this.refreshSelection();
    }

    /** Puts a changed document into the project and the rig (a running simulation carries on with it); {@code key} groups the edits of one control into one undo step */
    commit(doc: Doc, key = 'edit'): void {
        this.history.record(physicsText(), key, performance.now());
        this.syncHistory();
        this.doc = doc;
        savePhysicsText(writeDoc(doc));

        const was = ui.running;

        this.rebuild();

        if (was) this.rig?.reset();
    }

    refreshSelection(): void {
        ui.selected = selectedGroupName();
        ui.kind = ui.selected ? kindOf(this.doc, ui.selected) : 'none';

        if (ui.kind === 'spring') ui.controls = springControls(this.doc, ui.selected);
        else if (ui.kind === 'chain') ui.controls = chainControls(this.doc, ui.selected);
        else if (ui.kind === 'cloth' || ui.kind === 'flesh') ui.soft = softControls(this.doc, ui.selected, ui.kind);

        const withMesh = meshElements().map(m => m.bone);

        ui.hasMesh = !!ui.selected && withMesh.includes(ui.selected);
        ui.meshBones = [...new Set(withMesh)].filter(b => b !== ui.selected);

        this.refreshShapes();
        this.refreshTags();

        ui.animations = ((G.Animation?.all ?? []) as any[]).map(a => a.name as string);

        // the bones above the selection are opened so it can be seen in the list
        for (let g = groups().find(x => x.name === ui.selected)?.parent; g && g !== 'root'; g = g.parent) ui.open[g.name] = true;

        this.refreshTree();
        this.drawOverlay();
    }

    /**
     * Only bones are ever selected here: a click on a cube in the view selects the bone it belongs to instead. Selecting a bone in Blockbench also selects the
     * cubes inside it, so a selected element is only a stray when no bone is selected at all; anything else would select the bone again forever
     */
    keepBonesSelected(): boolean {
        if (G.Group?.first_selected ?? G.Group?.selected) return false;

        const stray = ((G.Outliner?.selected ?? []) as any[]).find(n => !(n instanceof G.Group));

        if (!stray) return false;

        if (this.correcting) return true;

        this.correcting = true;

        try {
            const parent = stray.parent;

            if (parent && parent !== 'root') parent.select?.();
            else G.unselectAllElements?.();
        }
        catch { /* the selection changed under us */ }
        finally {
            this.correcting = false;
        }

        return true;
    }

    private correcting = false;
    private refreshQueued = false;

    /** Refreshes the panel once after a burst of selection events, not once per event */
    queueRefresh(): void {
        if (this.refreshQueued) return;

        this.refreshQueued = true;
        requestAnimationFrame(() => {
            this.refreshQueued = false;
            this.refreshSelection();
        });
    }

    pick(name: string): void {
        const g = groups().find(x => x.name === name);

        try {
            g?.select?.();
        }
        catch { /* not selectable right now */ }

        this.queueRefresh();
    }

    private refreshTree(): void {
        const nodes: TreeNode[] = [];
        const visit = (g: any, depth: number, parent: string | null): void => {
            const kids = childGroups(g);

            nodes.push({ name: g.name, depth, hasKids: kids.length > 0, kind: kindOf(this.doc, g.name), parent, auto: autoModeOf(this.doc, g.name) });

            for (const k of kids) visit(k, depth + 1, g.name);
        };

        for (const n of (G.Outliner?.root ?? []) as any[]) if (n instanceof G.Group) visit(n, 0, null);

        for (const n of nodes) if (ui.open[n.name] === undefined && n.depth < 1) ui.open[n.name] = true;

        // frozen so Vue does not build watchers for every bone of a big model on each refresh
        ui.tree = Object.freeze(nodes) as TreeNode[];
    }

    // ---- controls ----

    setKind(kind: PartKind): void {
        const name = ui.selected;

        if (!name || kind === ui.kind) return;

        if (kind === 'none') {
            this.commit(removePart(this.doc, name), `kind:${name}`);
        }
        else if (kind === 'spring') {
            this.commit(setSpring(removePart(this.doc, name), name, withLook(SPRING_DEFAULTS, 'jiggle-soft')), `kind:${name}`);
        }
        else if (kind === 'cloth' || kind === 'flesh') {
            if (!ui.hasMesh) {
                ui.notice = 'This bone has no mesh. Cloth and flesh are made from the vertices of a mesh, not from cubes.';

                return;
            }

            const look = kind === 'cloth' ? 'cloth' : 'flesh-soft';

            this.commit(setSoft(removePart(this.doc, name), name, kind, softLook(look, name)), `kind:${name}`);
        }
        else {
            const bones = chainFrom(name, n => childGroups(groups().find(x => x.name === n)).map(c => c.name as string));

            ui.notice = bones.length === 1 ? 'This bone has no child bones, so the chain is only its tip. A chain needs child bones to swing along.' : `Chain of ${bones.length} bones: ${bones.join(' > ')}`;
            this.commit(setChain(removePart(this.doc, name), bones, withLook(CHAIN_DEFAULTS, 'hair')), `kind:${name}`);
        }

        this.refreshSelection();
    }

    applyControls(): void {
        const name = ui.selected;

        if (!name) return;

        if (ui.kind === 'spring') this.commit(setSpring(this.doc, name, ui.controls), `controls:${name}`);
        else if (ui.kind === 'chain') {
            const chain = chainNameOf(this.doc, name);

            if (chain !== null) this.commit(setChain(this.doc, this.doc.chains[chain].bones, ui.controls), `controls:${name}`);
        }
    }

    applySoft(): void {
        const name = ui.selected;

        if (!name || (ui.kind !== 'cloth' && ui.kind !== 'flesh')) return;

        this.commit(setSoft(this.doc, name, ui.kind, ui.soft), `soft:${name}`);
    }

    applySoftLook(look: string): void {
        if (!ui.selected || (ui.kind !== 'cloth' && ui.kind !== 'flesh')) return;

        const next = softLook(look, ui.selected);

        // the zone, the carried bones and the collisions are the bone's own choices, a look does not undo them
        ui.soft = { ...next, softCenter: ui.soft.softCenter, softRadius: ui.soft.softRadius, carry: ui.soft.carry };
        this.history.record(physicsText(), `softlook:${look}:${performance.now()}`, performance.now());
        this.applySoft();
    }

    /** Puts the soft zone's middle at the middle of the bone's meshes and its radius at half their reach */
    softZoneFromMesh(): void {
        const own = meshInputs().filter(m => m.bone === ui.selected);
        const all = own.flatMap(m => m.rest);

        if (all.length === 0) {
            ui.notice = 'This bone has no mesh to take a soft zone from.';

            return;
        }

        const lo: V3 = [Infinity, Infinity, Infinity];
        const hi: V3 = [-Infinity, -Infinity, -Infinity];

        for (const v of all) for (let a = 0; a < 3; a++) {
            lo[a] = Math.min(lo[a], v[a]);
            hi[a] = Math.max(hi[a], v[a]);
        }

        const centre: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];

        ui.soft = { ...ui.soft, softCenter: centre, softRadius: Math.max(0.05, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 4) };
        this.applySoft();
    }

    setSoftCentre(axis: number, value: number): void {
        const c = [...ui.soft.softCenter] as V3;

        c[axis] = value;
        ui.soft = { ...ui.soft, softCenter: c };
        this.applySoft();
    }

    setSoftValue(key: keyof SoftControls, value: number): void {
        (ui.soft as any)[key] = value;
        this.applySoft();
    }

    toggleCarry(bone: string, on: boolean): void {
        const carry = ui.soft.carry.filter(b => b !== bone);

        if (on) carry.push(bone);

        ui.soft = { ...ui.soft, carry };
        this.applySoft();
    }

    applyLook(look: string): void {
        ui.controls = withLook(ui.controls, look);
        this.history.record(physicsText(), `look:${look}:${performance.now()}`, performance.now());
        this.applyControls();
    }

    setAuto(value: boolean | null): void {
        this.commit(setAutoEnabled(this.doc, value), 'auto');
    }

    // ---- the selected bone's collision shapes ----

    /** Lists the selected bone's own shapes and keeps the one being edited if it is still there */
    private refreshShapes(): void {
        const own = ui.selected ? collidersOn(this.doc, ui.selected) : [];
        const counts: Record<string, number> = {};

        ui.shapes = own.map(c => {
            counts[c.form.shape] = (counts[c.form.shape] ?? 0) + 1;

            return { index: c.index, label: `${SHAPE_NAMES[c.form.shape]} ${counts[c.form.shape]}` };
        });

        if (!own.some(c => c.index === ui.shapeIndex)) ui.shapeIndex = own.length > 0 ? own[0].index : -1;

        ui.form = own.find(c => c.index === ui.shapeIndex)?.form ?? null;
    }

    selectShape(index: number): void {
        ui.shapeIndex = index;
        this.refreshShapes();
        this.drawOverlay();
    }

    /** Adds a shape to the selected bone, already fitted around the bone's own cubes */
    addShape(shape: Shape): void {
        if (!ui.selected) return;

        const added = addColliderForm(this.doc, ui.selected, fitForm(shape, autoBones().find(b => b.name === ui.selected)));

        ui.shapeIndex = added.index;
        this.commit(added.doc, `shape:${performance.now()}`);
        this.refreshSelection();
    }

    /** One number of the shape being edited: {@code key} is the field, {@code axis} its component for a vector */
    setShapeValue(key: 'center' | 'size' | 'rotation' | 'radius' | 'length', axis: number, value: number): void {
        if (!ui.form || ui.shapeIndex < 0 || !Number.isFinite(value)) return;

        const form: ColliderForm = { ...ui.form, center: [...ui.form.center], size: [...ui.form.size], rotation: [...ui.form.rotation] };

        if (key === 'radius' || key === 'length') form[key] = value;
        else form[key][axis] = value;

        ui.form = form;
        this.commit(updateColliderAt(this.doc, ui.shapeIndex, form), `collider:${ui.shapeIndex}:${key}${axis}`);
        this.refreshShapes();
    }

    setShapeKind(shape: Shape): void {
        if (!ui.form || ui.form.shape === shape) return;

        const fitted = fitForm(shape, autoBones().find(b => b.name === ui.selected));

        this.commit(updateColliderAt(this.doc, ui.shapeIndex, { ...fitted, center: ui.form.center }), `collider:${ui.shapeIndex}:kind`);
        this.refreshShapes();
    }

    fitShape(): void {
        if (!ui.form) return;

        this.commit(updateColliderAt(this.doc, ui.shapeIndex, fitForm(ui.form.shape, autoBones().find(b => b.name === ui.selected))), `collider:${performance.now()}`);
        this.refreshShapes();
    }

    duplicateShape(): void {
        if (!ui.form || !ui.selected) return;

        const moved: ColliderForm = { ...ui.form, center: [ui.form.center[0] + 1, ui.form.center[1], ui.form.center[2]] };
        const added = addColliderForm(this.doc, ui.selected, moved);

        ui.shapeIndex = added.index;
        this.commit(added.doc, `shape:${performance.now()}`);
        this.refreshShapes();
    }

    deleteShape(): void {
        if (ui.shapeIndex < 0) return;

        this.commit(removeColliderAt(this.doc, ui.shapeIndex), `shape:${performance.now()}`);
        ui.shapeIndex = -1;
        this.refreshShapes();
    }

    setMode(mode: AutoMode): void {
        if (!ui.selected) return;

        this.commit(setAutoMode(this.doc, ui.selected, mode), `mode:${ui.selected}:${performance.now()}`);
        ui.autoMode = mode;
    }

    // ---- which of its own bones the selected part bumps into ----

    isTicked(bone: string): boolean {
        return ui.onlyTicked ? ui.filter.only.includes(bone) : !ui.filter.ignore.includes(bone);
    }

    tick(bone: string, ticked: boolean): void {
        if (!ui.selected) return;

        if (ui.onlyTicked && !ticked && ui.filter.only.length === 1 && ui.filter.only[0] === bone) {
            ui.notice = 'At least one bone stays ticked here. To bump into none of its own body, untick "Bumps into its own body".';
            this.refreshSelection();

            return;
        }

        this.commit(setBoneFilter(this.doc, ui.selected, tickBone(ui.filter, bone, ticked, ui.onlyTicked)), `filter:${performance.now()}`);
        this.refreshSelection();
    }

    setOnlyTicked(onlyTicked: boolean): void {
        if (!ui.selected || onlyTicked === ui.onlyTicked) return;

        const next = switchFilterMode(ui.filter, ui.candidates, onlyTicked);

        this.commit(setBoneFilter(this.doc, ui.selected, next), `filter:${performance.now()}`);
        this.refreshSelection();
        ui.onlyTicked = onlyTicked;
    }

    // ---- limits ----

    toggleLimit(axis: 'x' | 'y' | 'z', on: boolean): void {
        if (!ui.selected || ui.kind !== 'spring') return;

        const limits: Limits = { ...ui.limits, [axis]: on ? [-30, 30] : null };

        ui.limits = limits;
        this.commit(setSpringLimits(this.doc, ui.selected, limits), `limits:${performance.now()}`);
    }

    setLimit(axis: 'x' | 'y' | 'z', end: 0 | 1, value: number): void {
        const current = ui.limits[axis];

        if (!ui.selected || !current || !Number.isFinite(value)) return;

        const next: [number, number] = [current[0], current[1]];

        next[end] = value;

        const limits: Limits = { ...ui.limits, [axis]: next };

        ui.limits = limits;
        this.commit(setSpringLimits(this.doc, ui.selected, limits), `limits:${ui.selected}:${axis}${end}`);
    }

    poke(): void {
        if (!ui.running || !ui.selected || !this.rig) return;

        const a = Math.random() * Math.PI * 2;

        this.rig.impulse(ui.selected, [Math.cos(a) * 3, 1.5, Math.sin(a) * 3]);
    }

    // ---- test shapes (never part of the project) ----

    addProp(kind: PropDef['kind']): void {
        const frame = ui.selected ? this.captureFrames().get(ui.selected) : undefined;
        const at: V3 = frame ? [frame.origin[0] + 0.45, frame.origin[1], frame.origin[2]] : [0.6, 0.8, 0];

        ui.props.push({ id: this.nextProp++, kind, x: at[0], y: at[1], z: at[2], size: kind === 'wall' ? 1.5 : kind === 'capsule' ? 1.2 : 0.5, sweep: false });
        this.syncProps();
    }

    removeProp(id: number): void {
        ui.props = ui.props.filter(p => p.id !== id);
        this.syncProps();
    }

    clearProps(): void {
        ui.props = [];
        this.syncProps();
    }

    /** The physics shape of a test shape at time {@code t}, in blocks */
    private propShape(p: PropDef, t: number): Placed {
        const x = p.x + (p.sweep ? Math.sin(t * 2.2) * 0.7 : 0);
        const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

        switch (p.kind) {
            case 'sphere':
                return { shape: 'sphere', p: [x, p.y, p.z], q: [0, 0, 0], radius: p.size / 2, half: [0, 0, 0], axes };
            case 'capsule': {
                const r = p.size * 0.15;
                const half = Math.max(0, p.size / 2 - r);

                return { shape: 'capsule', p: [x, p.y - half, p.z], q: [x, p.y + half, p.z], radius: r, half: [0, 0, 0], axes };
            }
            case 'wall':
                return { shape: 'box', p: [x, p.y, p.z], q: [0, 0, 0], radius: 0, half: [p.size * 0.6, p.size / 2, 0.04], axes };
            default:
                return { shape: 'box', p: [x, p.y, p.z], q: [0, 0, 0], radius: 0, half: [p.size / 2, p.size / 2, p.size / 2], axes };
        }
    }

    private clearPropMeshes(): void {
        for (const m of this.propMeshes) {
            m.parent?.remove(m);
            m.traverse?.((o: any) => {
                o.geometry?.dispose?.();
                o.material?.dispose?.();
            });
        }

        this.propMeshes = [];
    }

    /** Rebuilds the meshes of the test shapes (drawn in the scene, not the project) and hands their shapes to the rig */
    syncProps(): void {
        this.clearPropMeshes();

        if (G.Mode?.selected?.id === MODE_ID && G.THREE && G.Canvas?.scene) {
            const THREE = G.THREE;

            for (const p of ui.props) {
                const material = new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.35, depthWrite: false });
                let mesh: any;

                if (p.kind === 'sphere') {
                    mesh = new THREE.Mesh(new THREE.SphereGeometry(p.size / 2 * U, 24, 16), material);
                }
                else if (p.kind === 'capsule') {
                    const r = p.size * 0.15 * U;
                    const len = Math.max(0, p.size * U - 2 * r);

                    mesh = new THREE.Group();
                    mesh.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 16), material));

                    for (const s of [-1, 1]) {
                        const cap = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 10), material);

                        cap.position.y = s * len / 2;
                        mesh.add(cap);
                    }
                }
                else {
                    const [w, h, d] = p.kind === 'wall' ? [p.size * 1.2, p.size, 0.08] : [p.size, p.size, p.size];

                    mesh = new THREE.Mesh(new THREE.BoxGeometry(w * U, h * U, d * U), material);
                }

                mesh.userData.propId = p.id;
                mesh.renderOrder = 9000;
                G.Canvas.scene.add(mesh);
                this.propMeshes.push(mesh);
            }
        }

        this.placePropMeshes(0);

        if (this.rig) this.rig.props = ui.props.map(p => this.propShape(p, 0));

        this.render();
    }

    private placePropMeshes(t: number): void {
        for (const m of this.propMeshes) {
            const p = ui.props.find(x => x.id === m.userData.propId);

            if (p) m.position.set((p.x + (p.sweep ? Math.sin(t * 2.2) * 0.7 : 0)) * U, p.y * U, p.z * U);
        }
    }

    // ---- pose ----

    private captureFrames(): Map<string, BoneFrame> {
        const THREE = G.THREE;
        const frames = new Map<string, BoneFrame>();
        const p = new THREE.Vector3();
        const q = new THREE.Quaternion();
        const s = new THREE.Vector3();

        for (const g of groups()) {
            const mesh = g.mesh;

            if (!mesh) continue;

            mesh.matrixWorld.decompose(p, q, s);
            frames.set(g.name, {
                origin: [p.x / U, p.y / U, p.z / U],
                orientation: [q.x, q.y, q.z, q.w],
                local: [mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w],
            });
        }

        return frames;
    }

    private snapshot(): void {
        this.snapshots.clear();

        for (const g of groups()) {
            if (g.mesh) this.snapshots.set(g.name, { q: g.mesh.quaternion.clone(), s: g.mesh.scale.clone(), p: g.mesh.position.clone() });
        }
    }

    private restore(): void {
        for (const g of groups()) {
            const snap = this.snapshots.get(g.name);

            if (g.mesh && snap) {
                g.mesh.quaternion.copy(snap.q);
                g.mesh.scale.copy(snap.s);
                g.mesh.position.copy(snap.p);
            }
        }
    }

    private render(): void {
        try {
            for (const preview of (G.Preview?.all ?? []) as any[]) preview.render?.();
        }
        catch { /* a preview that is not ready yet */ }
    }

    // ---- overlay ----

    private ensureOverlay(): any {
        if (this.overlay || !G.THREE || !G.Canvas?.scene) return this.overlay;

        const THREE = G.THREE;
        const geometry = new THREE.BufferGeometry();
        const material = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 });

        this.overlay = new THREE.LineSegments(geometry, material);
        this.overlay.renderOrder = 10000;
        this.overlay.frustumCulled = false;
        G.Canvas.scene.add(this.overlay);

        return this.overlay;
    }

    private removeOverlay(): void {
        if (!this.overlay) return;

        this.overlay.parent?.remove(this.overlay);
        this.overlay.geometry?.dispose();
        this.overlay.material?.dispose();
        this.overlay = null;
    }

    /** Draws the colliders, and the springs and chains as lines, at the pose the model is in now */
    drawOverlay(): void {
        if (!this.rig || G.Mode?.selected?.id !== MODE_ID) return;

        const overlay = this.ensureOverlay();

        if (!overlay) return;

        const frames = this.captureFrames();

        if (!ui.running) this.rig.observe(frames);

        const positions: number[] = [];
        const colors: number[] = [];
        const push = (s: Segment, rgb: number): void => {
            for (const v of s) {
                positions.push(v[0] * U, v[1] * U, v[2] * U);
                colors.push(((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255);
            }
        };

        if (ui.showColliders) {
            const rig = this.rig;
            const part = ui.selected ? rig.partOf(ui.selected) : null;
            // with a bone picked, only what matters to it: for a spring or chain the shapes it bumps into, for any other bone the shapes it carries
            const shown = (spec: ColliderSpec, generated: boolean): boolean => ui.showAllShapes || !ui.selected || spec.bone === ui.selected
                || (part !== null && rig.feels(ui.selected, spec, generated));

            for (const spec of rig.madeColliders()) {
                const f = frames.get(spec.bone);

                if (f && shown(spec, true)) for (const seg of colliderLines(spec, f)) push(seg, spec.bone === ui.selected ? 0x7fe6ff : 0x2f8fa6);
            }

            (Array.isArray(this.doc.colliders) ? this.doc.colliders : []).forEach((c: any, index: number) => {
                const f = c ? frames.get(c.bone) : undefined;

                if (!f) return;

                const spec: ColliderSpec = {
                    bone: c.bone, shape: c.shape, a: c.center ?? c.from ?? [0, 0, 0], b: c.size ?? c.to ?? [0, 0, 0], radius: c.radius ?? 0, layer: c.layer ?? 'body',
                    ...(Array.isArray(c.rotation) ? { rotation: c.rotation } : {}),
                };
                if (!shown(spec, false)) return;

                const colour = index === ui.shapeIndex && c.bone === ui.selected ? 0xffffff : c.bone === ui.selected ? 0xffd040 : 0xb08a20;

                for (const seg of colliderLines(spec, f)) push(seg, colour);
            });
        }

        if (ui.showLimits && ui.selected) {
            const f = frames.get(ui.selected);

            if (ui.kind === 'spring' && f) {
                const r = resolveSpring(this.doc.bones?.[ui.selected] ?? {});
                const lever: V3 = [r.params.tip[0] * r.params.length, r.params.tip[1] * r.params.length, r.params.tip[2] * r.params.length];
                const colours = [0xff5050, 0x50e050, 0x5080ff];

                (['x', 'y', 'z'] as const).forEach((axis, i) => {
                    const range = ui.limits[axis];

                    if (range) for (const seg of limitArc(f, lever, i as 0 | 1 | 2, range[0], range[1])) push(seg, colours[i]);
                });
            }

            if (ui.kind === 'chain') {
                const chain = this.rig.chainSegments(ui.selected);

                if (chain) for (const [a, b] of chain.segments) for (const seg of limitCone(a, b, chain.maxAngle)) push(seg, 0xc080ff);
            }
        }

        if (ui.showDebug) {
            for (const l of this.rig.debugLines()) push([l.a, l.b], l.kind === 'rest' ? 0x40e040 : 0xf04040);
        }

        const THREE = G.THREE;

        overlay.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        overlay.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        overlay.geometry.computeBoundingSphere?.();
        this.render();
    }

    // ---- simulation ----

    start(): void {
        if (!this.rig || ui.running) return;

        try {
            G.Canvas.updateAllBones?.();
            this.snapshot();

            const model = G.Project?.model_3d;

            this.modelSnapshot = model ? { p: model.position.clone(), ry: model.rotation.y } : null;
            this.rig.reset();
            ui.running = true;
            ui.notice = '';
            this.started = performance.now();
            this.raf = requestAnimationFrame(() => this.frame());
        }
        catch (error) {
            ui.notice = `Could not start the simulation: ${(error as Error).message}`;
            ui.running = false;
        }
    }

    /** Where the animation puts every vertex of every mesh in the world now, in blocks */
    private captureCloth(): Map<string, V3[]> {
        const out = new Map<string, V3[]>();
        const THREE = G.THREE;
        const wanted = new Set(this.rig?.clothKeys() ?? []);

        if (wanted.size === 0) return out;

        for (const { element } of meshElements()) {
            const key = String(element.uuid);
            const object = element.mesh;

            if (!wanted.has(key) || !object) continue;

            object.updateMatrixWorld(true);
            out.set(key, Object.values(element.vertices ?? {}).map((v: any): V3 => {
                const p = new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(object.matrixWorld);

                return [p.x / U, p.y / U, p.z / U];
            }));
        }

        return out;
    }

    private clothObjects = new Map<string, any>();
    private hiddenMeshes: any[] = [];

    /** Draws the simulated cloth and flesh as meshes in the scene, in place of the originals (which are hidden while the simulation runs) */
    private drawCloth(): void {
        if (!this.rig || !G.THREE || !G.Canvas?.scene) return;

        const THREE = G.THREE;
        const inputs = new Map(meshInputs().map(m => [m.key, m]));
        const elements = new Map(meshElements().map(m => [String(m.element.uuid), m.element]));

        for (const key of this.rig.clothKeys()) {
            const verts = this.rig.clothVertices(key);
            const input = inputs.get(key);

            if (!verts || !input) continue;

            let mesh = this.clothObjects.get(key);

            if (!mesh) {
                const geometry = new THREE.BufferGeometry();
                const index: number[] = [];

                for (const face of input.faces) for (let k = 1; k + 1 < face.length; k++) index.push(face[0], face[k], face[k + 1]);

                geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts.length * 3), 3));
                geometry.setIndex(index);
                mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color: 0xe9b7a5, side: THREE.DoubleSide }));
                mesh.frustumCulled = false;
                G.Canvas.scene.add(mesh);
                this.clothObjects.set(key, mesh);

                const original = elements.get(key)?.mesh;

                if (original && original.visible !== false) {
                    original.visible = false;
                    this.hiddenMeshes.push(original);
                }
            }

            const position = mesh.geometry.getAttribute('position');

            verts.forEach((v, i) => position.setXYZ(i, v[0] * U, v[1] * U, v[2] * U));
            position.needsUpdate = true;
            mesh.geometry.computeVertexNormals();
            mesh.geometry.computeBoundingSphere();
        }
    }

    private removeCloth(): void {
        for (const mesh of this.clothObjects.values()) {
            mesh.parent?.remove(mesh);
            mesh.geometry?.dispose();
            mesh.material?.dispose();
        }

        this.clothObjects.clear();

        for (const original of this.hiddenMeshes) original.visible = true;

        this.hiddenMeshes = [];
    }

    stop(): void {
        if (!ui.running && !this.raf) return;

        cancelAnimationFrame(this.raf);
        this.raf = 0;
        ui.running = false;

        try {
            const model = G.Project?.model_3d;

            if (model && this.modelSnapshot) {
                model.position.copy(this.modelSnapshot.p);
                model.rotation.y = this.modelSnapshot.ry;
            }

            this.removeCloth();
            this.restore();
            G.Canvas.updateAllBones?.();

            if (ui.animation) G.Animator?.showDefaultPose?.();

            this.placePropMeshes(0);

            if (this.rig) this.rig.props = ui.props.map(p => this.propShape(p, 0));
        }
        catch { /* leaving the tab mid-load */ }

        this.drawOverlay();
    }

    resetSim(): void {
        this.rig?.reset();
        this.started = performance.now();
    }

    private frame(): void {
        if (!ui.running || !this.rig) return;

        try {
            const t = (performance.now() - this.started) / 1000 * ui.speed;
            const m = motionAt(ui.motion, t);
            const model = G.Project?.model_3d;

            if (model) {
                model.position.set(this.modelSnapshot!.p.x + m.pos[0] * U, this.modelSnapshot!.p.y + m.pos[1] * U, this.modelSnapshot!.p.z + m.pos[2] * U);
                model.rotation.y = this.modelSnapshot!.ry + m.yaw;
            }

            // bones back to the rest pose, then the chosen animation over it, then the physics over that
            this.restore();

            const animation = ui.animation ? ((G.Animation?.all ?? []) as any[]).find(a => a.name === ui.animation) : null;

            if (animation) {
                if (G.Animation.selected !== animation) animation.select?.();

                G.Timeline?.setTime?.(t % Math.max(0.05, animation.length || 1));
                G.Animator?.preview?.();
            }

            model?.updateMatrixWorld(true);

            this.placePropMeshes(t);
            this.rig.props = ui.props.map(p => this.propShape(p, t));

            const frames = this.captureFrames();
            const root: Q4 = qaxisY(m.yaw);

            this.rig.clothAnimated = this.captureCloth();

            const results = this.rig.update(frames, { pos: m.pos, yaw: m.yaw }, root, t);

            for (const g of groups()) {
                const r = results.get(g.name);

                if (!r || !g.mesh) continue;

                g.mesh.quaternion.set(r.local[0], r.local[1], r.local[2], r.local[3]);

                const snap = this.snapshots.get(g.name);
                const base = snap ? snap.s : g.mesh.scale;

                g.mesh.scale.set(base.x * r.scale[0], base.y * r.scale[1], base.z * r.scale[2]);
            }

            model?.updateMatrixWorld(true);
            this.drawCloth();
            this.drawOverlay();
        }
        catch (error) {
            ui.notice = `The simulation stopped: ${(error as Error).message}`;
            this.stop();

            return;
        }

        this.raf = requestAnimationFrame(() => this.frame());
    }

    dispose(): void {
        this.stop();
        this.removeCloth();
        this.removeOverlay();
        this.clearPropMeshes();
    }
}

const session = new Session();

// ---------------- the mode and the panel ----------------

interface Field { key: keyof PartControls; label: string; min: number; max: number; step: number; kinds: PartKind[]; hint: string }

/** The four sliders that matter most; everything else is under "More" */
const MAIN_FIELDS: Field[] = [
    { key: 'stiffness', label: 'Stiffness', min: 0, max: 1, step: 0.01, kinds: ['spring', 'chain'], hint: 'How hard it pulls back to where the animation puts it' },
    { key: 'bounce', label: 'Bounciness', min: 0, max: 1, step: 0.01, kinds: ['spring', 'chain'], hint: 'How long it keeps wobbling' },
    { key: 'weight', label: 'Amount', min: 0, max: 1, step: 0.01, kinds: ['spring', 'chain'], hint: 'How much of the physics shows. 0 is the animation alone' },
    { key: 'inertia', label: 'Lag', min: 0, max: 1, step: 0.01, kinds: ['spring', 'chain'], hint: 'How much it trails behind when the model moves or turns' },
];

const MORE_FIELDS: Field[] = [
    { key: 'gravity', label: 'Gravity', min: 0, max: 15, step: 0.1, kinds: ['spring', 'chain'], hint: '0 for jiggle, about 10 for hair' },
    { key: 'length', label: 'Reach', min: 0.02, max: 1.2, step: 0.01, kinds: ['spring', 'chain'], hint: 'Spring: distance from the pivot to the swinging mass. Chain: how far the last bone reaches (blocks)' },
    { key: 'radius', label: 'Thickness', min: 0, max: 0.5, step: 0.01, kinds: ['spring', 'chain'], hint: 'Its size when it bumps into things (blocks)' },
    { key: 'squish', label: 'Squish', min: 0, max: 1, step: 0.01, kinds: ['spring'], hint: 'How much it flattens when pressed' },
    { key: 'friction', label: 'Grip', min: 0, max: 1, step: 0.01, kinds: ['chain'], hint: 'How much it grips what it lies on' },
];

interface SoftField { key: keyof SoftControls; label: string; min: number; max: number; step: number; kinds: PartKind[]; hint: string }

const SOFT_FIELDS: SoftField[] = [
    { key: 'stiffness', label: 'Stretch', min: 0, max: 1, step: 0.01, kinds: ['cloth', 'flesh'], hint: 'How firmly each edge keeps its length. 1 does not stretch at all' },
    { key: 'bend', label: 'Fold', min: 0, max: 1, step: 0.01, kinds: ['cloth'], hint: 'How much a fold resists: 0 is silk, 1 is card' },
    { key: 'anchor', label: 'Pull back', min: 0, max: 30, step: 0.5, kinds: ['cloth', 'flesh'], hint: 'How firmly it is pulled back to the animated shape, per second. 0 lets cloth hang free' },
    { key: 'volume', label: 'Keeps volume', min: 0, max: 1, step: 0.01, kinds: ['flesh'], hint: 'A closed mesh bulges where it is pressed in' },
    { key: 'pinHeight', label: 'Sewn on at top', min: 0, max: 1, step: 0.01, kinds: ['cloth'], hint: 'The share of the mesh height, from the top, that is sewn to the bone' },
    { key: 'damping', label: 'Settling', min: 0, max: 8, step: 0.1, kinds: ['cloth', 'flesh'], hint: 'How quickly it stops moving' },
    { key: 'inertia', label: 'Lag', min: 0, max: 1, step: 0.01, kinds: ['cloth', 'flesh'], hint: 'How much it trails behind when the model moves or turns' },
    { key: 'gravity', label: 'Gravity', min: 0, max: 15, step: 0.1, kinds: ['cloth', 'flesh'], hint: '9.8 for cloth, about 2 for flesh' },
    { key: 'radius', label: 'Thickness', min: 0, max: 0.2, step: 0.005, kinds: ['cloth', 'flesh'], hint: 'How thick it is when it bumps into things (blocks)' },
    { key: 'weight', label: 'Amount', min: 0, max: 1, step: 0.01, kinds: ['cloth', 'flesh'], hint: 'How much of the physics shows. 0 is the mesh as modelled' },
];

const TEMPLATE = `
<div class="strut-phys">
  <div class="strut-phys-banner" :class="ui.running ? 'on' : 'off'">
    <div class="strut-phys-banner-text" v-if="ui.running"><b>Simulating.</b> The model is moving on its own. Edit settings and watch it change.</div>
    <div class="strut-phys-banner-text" v-else><b>Not simulating.</b> The model is standing still. Press Simulate to see the physics.</div>
    <div class="strut-phys-row">
      <button class="strut-phys-btn" :disabled="!ui.canUndo" @click="undo" title="Undo the last change to the physics (Ctrl+Z)">Undo</button>
      <button class="strut-phys-btn" :disabled="!ui.canRedo" @click="redo" title="Redo (Ctrl+Y)">Redo</button>
    </div>
    <div class="strut-phys-row">
      <button class="strut-phys-btn strut-phys-big" :class="ui.running ? 'stop' : 'go'" @click="toggle">{{ ui.running ? 'Stop' : 'Simulate' }}</button>
      <button class="strut-phys-btn" :disabled="!ui.running" @click="reset" title="Start the motion again from the beginning">Restart</button>
      <button class="strut-phys-btn" :disabled="!ui.running || !ui.selected" @click="poke" title="Kick the selected bone while it is simulating">Poke</button>
    </div>
  </div>
  <div class="strut-phys-notice" v-if="ui.notice">{{ ui.notice }}</div>

  <div class="strut-phys-h" @click="tog('test')"><span>{{ ui.sections.test ? '▾' : '▸' }}</span> Test motion</div>
  <div v-if="ui.sections.test" class="strut-phys-body">
    <div class="strut-phys-row"><label>Move</label>
      <select v-model="ui.motion"><option v-for="m in ui.motions" :value="m.id">{{ m.label }}</option></select></div>
    <div class="strut-phys-row"><label>Animation</label>
      <select v-model="ui.animation"><option value="">None (rest pose)</option><option v-for="a in ui.animations" :value="a">{{ a }}</option></select></div>
    <div class="strut-phys-row"><label>Speed</label>
      <input type="range" min="0.1" max="1.5" step="0.05" v-model.number="ui.speed"><span class="strut-phys-num">{{ ui.speed.toFixed(2) }}x</span></div>
  </div>

  <div class="strut-phys-h" @click="tog('bones')"><span>{{ ui.sections.bones ? '▾' : '▸' }}</span> Bones</div>
  <div v-if="ui.sections.bones" class="strut-phys-body">
    <input class="strut-phys-search" type="text" v-model="ui.query" placeholder="Search bones">
    <div class="strut-phys-tree">
      <div v-for="n in visibleTree" :key="n.name" class="strut-phys-node" :class="{ sel: n.name === ui.selected }" :style="{ paddingLeft: (6 + n.depth * 12) + 'px' }" @click="pick(n.name)">
        <span class="strut-phys-twist" @click.stop="fold(n)">{{ n.hasKids && !ui.query ? (ui.open[n.name] ? '▾' : '▸') : '' }}</span>
        <span class="strut-phys-name">{{ n.name }}</span>
        <span class="strut-phys-pill spring" v-if="n.kind === 'spring'">spring</span>
        <span class="strut-phys-pill chain" v-if="n.kind === 'chain'">chain</span>
        <span class="strut-phys-pill spring" v-if="n.kind === 'cloth'">cloth</span>
        <span class="strut-phys-pill chain" v-if="n.kind === 'flesh'">flesh</span>
        <span class="strut-phys-pill tag" v-if="n.auto !== 'auto'" :title="'Shape made from the model: ' + n.auto">{{ n.auto === 'off' ? 'no shape' : n.auto }}</span>
      </div>
      <div class="strut-phys-hint" v-if="!visibleTree.length">No bones match.</div>
    </div>
  </div>

  <div class="strut-phys-h" @click="tog('feel')"><span>{{ ui.sections.feel ? '▾' : '▸' }}</span> {{ ui.selected ? ui.selected : 'Selected bone' }}</div>
  <div v-if="ui.sections.feel" class="strut-phys-body">
    <div class="strut-phys-hint" v-if="!ui.selected">Pick a bone in the list above.</div>
    <div v-else>
      <div class="strut-phys-seg">
        <button :class="{ on: ui.kind === 'none' }" @click="kind('none')" title="This bone just follows the animation">None</button>
        <button :class="{ on: ui.kind === 'spring' }" @click="kind('spring')" title="One bone that jiggles: pouches, jowls, belly">Spring</button>
        <button :class="{ on: ui.kind === 'chain' }" @click="kind('chain')" title="This bone and the bones under it swing like rope: hair, tails, ears">Chain</button>
        <button v-if="ui.hasMesh || ui.kind === 'cloth'" :class="{ on: ui.kind === 'cloth' }" @click="kind('cloth')" title="The vertices of this bone mesh hang and swing like cloth: a skirt, a cape">Cloth</button>
        <button v-if="ui.hasMesh || ui.kind === 'flesh'" :class="{ on: ui.kind === 'flesh' }" @click="kind('flesh')" title="The vertices of this bone mesh are soft: pulled back to shape, bulging when pressed. Pouches, belly">Flesh</button>
      </div>
      <div v-if="ui.kind === 'spring' || ui.kind === 'chain'">
        <div class="strut-phys-chips"><button class="strut-phys-chip" v-for="l in looksFor" :key="l.id" @click="look(l.id)">{{ l.label }}</button></div>
        <div class="strut-phys-slider" v-for="f in mainFields" :key="f.key" :title="f.hint">
          <label>{{ f.label }}</label>
          <input type="range" :min="f.min" :max="f.max" :step="f.step" v-model.number="ui.controls[f.key]" @input="apply">
          <span class="strut-phys-num">{{ Number(ui.controls[f.key]).toFixed(2) }}</span>
        </div>
        <div class="strut-phys-sub" @click="tog('more')">{{ ui.sections.more ? '▾' : '▸' }} More settings</div>
        <div v-if="ui.sections.more">
          <div class="strut-phys-slider" v-for="f in moreFields" :key="f.key" :title="f.hint">
            <label>{{ f.label }}</label>
            <input type="range" :min="f.min" :max="f.max" :step="f.step" v-model.number="ui.controls[f.key]" @input="apply">
            <span class="strut-phys-num">{{ Number(ui.controls[f.key]).toFixed(2) }}</span>
          </div>
          <div class="strut-phys-checks">
            <label><input type="checkbox" v-model="ui.controls.collideBody" @change="apply"> Bumps into its own body</label>
            <label><input type="checkbox" v-model="ui.controls.collideWorld" @change="apply"> Bumps into the floor and test shapes</label>
            <label><input type="checkbox" v-model="ui.controls.collideOthers" @change="apply"> Bumps into other models and players (in game)</label>
          </div>
          <div class="strut-phys-hint" v-if="ui.controls.collideBody && !ui.candidates.length">No other bone has a shape for it to bump into yet: turn on "Make shapes from the model" under Collision shapes, or add shapes of your own.</div>
          <div v-if="ui.controls.collideBody && ui.candidates.length">
            <div class="strut-phys-hint">Which bones of its own body it bumps into:</div>
            <div class="strut-phys-seg">
              <button :class="{ on: !ui.onlyTicked }" @click="onlyTicked(false)" title="Every bone with a shape, except the ones you untick (new bones are included)">All but unticked</button>
              <button :class="{ on: ui.onlyTicked }" @click="onlyTicked(true)" title="Only the bones you tick (new bones are left out)">Only ticked</button>
            </div>
            <div class="strut-phys-bonelist">
              <label v-for="b in ui.candidates" :key="b"><input type="checkbox" :checked="isTicked(b)" @change="tick(b, $event)"> {{ b }}</label>
            </div>
          </div>
        </div>
        <div class="strut-phys-sub" @click="tog('limits')">{{ ui.sections.limits ? '▾' : '▸' }} Angle limits</div>
        <div v-if="ui.sections.limits">
          <label class="strut-phys-inline"><input type="checkbox" v-model="ui.showLimits" @change="redraw"> Show them on the model</label>
          <div v-if="ui.kind === 'spring'">
            <div class="strut-phys-hint">How far the physics may turn this bone about each of its axes, in degrees. The arcs show the range (x red, y green, z blue).</div>
            <div v-for="axis in ['x', 'y', 'z']" :key="axis" class="strut-phys-limit">
              <label class="strut-phys-inline"><input type="checkbox" :checked="!!ui.limits[axis]" @change="limitOn(axis, $event)"> Limit {{ axis.toUpperCase() }}</label>
              <div v-if="ui.limits[axis]">
                <phys-num label="From" :min="-180" :max="0" :step="1" :value="ui.limits[axis][0]" @input="setLimit(axis, 0, $event)"></phys-num>
                <phys-num label="To" :min="0" :max="180" :step="1" :value="ui.limits[axis][1]" @input="setLimit(axis, 1, $event)"></phys-num>
              </div>
            </div>
          </div>
          <div v-else>
            <div class="strut-phys-hint">How far each segment may swing away from where the animation puts it. The cones show it. 0 is no limit.</div>
            <phys-num label="Bend limit" :min="0" :max="150" :step="1" :value="ui.controls.maxAngle" @input="setControl('maxAngle', $event)"></phys-num>
          </div>
        </div>
      </div>
      <div v-if="ui.kind === 'cloth' || ui.kind === 'flesh'">
        <div class="strut-phys-hint" v-if="ui.kind === 'cloth'">The vertices of this bone mesh are the cloth: the top is sewn on, the rest hangs and swings. Pick the look, then press Simulate.</div>
        <div class="strut-phys-hint" v-else>The vertices of this bone mesh are soft flesh: pulled back to the animated shape, keeping their volume. A soft zone keeps the rest firm. Press Simulate to see it.</div>
        <div class="strut-phys-chips"><button class="strut-phys-chip" v-for="l in softLooksFor" :key="l.id" @click="softLook(l.id)">{{ l.label }}</button></div>
        <div class="strut-phys-slider" v-for="f in softFields" :key="f.key" :title="f.hint">
          <label>{{ f.label }}</label>
          <input type="range" :min="f.min" :max="f.max" :step="f.step" v-model.number="ui.soft[f.key]" @input="applySoft">
          <span class="strut-phys-num">{{ Number(ui.soft[f.key]).toFixed(2) }}</span>
        </div>
        <div class="strut-phys-sub" @click="tog('zone')">{{ ui.sections.zone ? '▾' : '▸' }} Soft zone</div>
        <div v-if="ui.sections.zone">
          <div class="strut-phys-hint">Only the vertices inside the zone are soft; they blend to sewn on beyond it. Radius 0 makes all of the mesh soft. Blocks, in the game mesh space.</div>
          <phys-num label="Radius" :min="0" :max="1.5" :step="0.01" :value="ui.soft.softRadius" @input="setSoft('softRadius', $event)"></phys-num>
          <phys-num label="Centre x" :min="-2" :max="2" :step="0.01" :value="ui.soft.softCenter[0]" @input="softCentre(0, $event)"></phys-num>
          <phys-num label="Centre y" :min="-1" :max="3" :step="0.01" :value="ui.soft.softCenter[1]" @input="softCentre(1, $event)"></phys-num>
          <phys-num label="Centre z" :min="-2" :max="2" :step="0.01" :value="ui.soft.softCenter[2]" @input="softCentre(2, $event)"></phys-num>
          <button class="strut-phys-btn" @click="softZone" title="Put the zone in the middle of this bone mesh, with half its reach as the radius">Zone from the mesh</button>
        </div>
        <div class="strut-phys-sub" @click="tog('carry')">{{ ui.sections.carry ? '▾' : '▸' }} Meshes that ride on it</div>
        <div v-if="ui.sections.carry">
          <div class="strut-phys-hint">Other bones whose meshes move with this one as a rigid piece: a tip on a pouch. They are drawn with it in the preview and in the game.</div>
          <div class="strut-phys-bonelist">
            <label v-for="b in ui.meshBones" :key="b"><input type="checkbox" :checked="ui.soft.carry.includes(b)" @change="carryOn(b, $event)"> {{ b }}</label>
          </div>
        </div>
        <div class="strut-phys-checks">
          <label><input type="checkbox" v-model="ui.soft.collideBody" @change="applySoft"> Bumps into its own body</label>
          <label><input type="checkbox" v-model="ui.soft.collideWorld" @change="applySoft"> Bumps into the floor and test shapes</label>
          <label><input type="checkbox" v-model="ui.soft.collideOthers" @change="applySoft"> Bumps into other models and players (in game)</label>
        </div>
        <div class="strut-phys-hint">The preview draws the simulated mesh in one plain colour, without its texture, in place of the original while it runs.</div>
      </div>
    </div>
  </div>

  <div class="strut-phys-h" @click="tog('shapes')"><span>{{ ui.sections.shapes ? '▾' : '▸' }}</span> Collision shapes</div>
  <div v-if="ui.sections.shapes" class="strut-phys-body">
    <div class="strut-phys-checks">
      <label><input type="checkbox" :checked="ui.autoColliders !== false" @change="auto($event)"> Make shapes from the model</label>
      <label><input type="checkbox" v-model="ui.showColliders" @change="redraw"> Show shapes</label>
      <label><input type="checkbox" v-model="ui.showDebug" @change="redraw"> Show springs and chains</label>
      <label><input type="checkbox" v-model="ui.showAllShapes" @change="redraw"> Show every shape (otherwise only those the picked bone bumps into)</label>
    </div>
    <div class="strut-phys-hint" v-if="!ui.selected">Pick a bone to tag it or give it its own shapes.</div>
    <div v-else>
      <div class="strut-phys-title">{{ ui.selected }}</div>
      <div class="strut-phys-hint">Shape made from this bone's cubes:</div>
      <div class="strut-phys-seg">
        <button :class="{ on: ui.autoMode === 'auto' }" @click="setMode('auto')" title="By the rules: a box per cube for a few cubes, one simple shape for many">Auto</button>
        <button :class="{ on: ui.autoMode === 'exact' }" @click="setMode('exact')" title="A box around every cube">Exact</button>
        <button :class="{ on: ui.autoMode === 'simple' }" @click="setMode('simple')" title="One capsule or box around the whole bone">Simple</button>
        <button :class="{ on: ui.autoMode === 'off' }" @click="setMode('off')" title="No shape for this bone">None</button>
      </div>
      <div class="strut-phys-hint" v-if="ui.shapes.length">It has shapes of its own below, so none is made for it.</div>
      <div class="strut-phys-hint">Its own shapes:</div>
      <div class="strut-phys-chips">
        <button class="strut-phys-chip" v-for="s in ui.shapes" :key="s.index" :class="{ on: s.index === ui.shapeIndex }" @click="selectShape(s.index)">{{ s.label }}</button>
        <button class="strut-phys-chip" @click="shape('sphere')">+ Sphere</button>
        <button class="strut-phys-chip" @click="shape('capsule')">+ Capsule</button>
        <button class="strut-phys-chip" @click="shape('box')">+ Box</button>
      </div>
      <div class="strut-phys-prop" v-if="ui.form">
        <div class="strut-phys-seg">
          <button v-for="k in ['sphere', 'capsule', 'box']" :key="k" :class="{ on: ui.form.shape === k }" @click="shapeKind(k)">{{ k[0].toUpperCase() + k.slice(1) }}</button>
        </div>
        <div class="strut-phys-hint">Position (from the bone's pivot, in pixels)</div>
        <phys-num v-for="(axis, i) in ['X', 'Y', 'Z']" :key="'c' + i" :label="axis" :min="-32" :max="32" :step="0.1" :value="ui.form.center[i]" @input="val('center', i, $event)"></phys-num>
        <template v-if="ui.form.shape === 'box'">
          <div class="strut-phys-hint">Size</div>
          <phys-num v-for="(axis, i) in ['X', 'Y', 'Z']" :key="'s' + i" :label="axis" :min="0.1" :max="32" :step="0.1" :value="ui.form.size[i]" @input="val('size', i, $event)"></phys-num>
          <div class="strut-phys-hint">Turn (degrees)</div>
          <phys-num v-for="(axis, i) in ['X', 'Y', 'Z']" :key="'r' + i" :label="axis" :min="-180" :max="180" :step="1" :value="ui.form.rotation[i]" @input="val('rotation', i, $event)"></phys-num>
        </template>
        <template v-if="ui.form.shape === 'sphere'">
          <phys-num label="Radius" :min="0.1" :max="16" :step="0.1" :value="ui.form.radius" @input="val('radius', 0, $event)"></phys-num>
        </template>
        <template v-if="ui.form.shape === 'capsule'">
          <phys-num label="Length" :min="0" :max="32" :step="0.1" :value="ui.form.length" @input="val('length', 0, $event)"></phys-num>
          <phys-num label="Radius" :min="0.1" :max="16" :step="0.1" :value="ui.form.radius" @input="val('radius', 0, $event)"></phys-num>
          <div class="strut-phys-hint">Tilt (degrees)</div>
          <phys-num label="X" :min="-180" :max="180" :step="1" :value="ui.form.rotation[0]" @input="val('rotation', 0, $event)"></phys-num>
          <phys-num label="Z" :min="-180" :max="180" :step="1" :value="ui.form.rotation[2]" @input="val('rotation', 2, $event)"></phys-num>
        </template>
        <div class="strut-phys-chips">
          <button class="strut-phys-chip" @click="fitShape" title="Wrap it around this bone's cubes again">Fit to bone</button>
          <button class="strut-phys-chip" @click="duplicateShape">Duplicate</button>
          <button class="strut-phys-chip" @click="deleteShape">Delete</button>
        </div>
      </div>
    </div>
    <div class="strut-phys-hint">Lines: dim cyan are shapes made from the model, yellow are your own, white is the one you are editing.</div>
  </div>

  <div class="strut-phys-h" @click="tog('props')"><span>{{ ui.sections.props ? '▾' : '▸' }}</span> Test shapes</div>
  <div v-if="ui.sections.props" class="strut-phys-body">
    <div class="strut-phys-hint">Things to bump into, only on this screen (not part of the model). Parts that bump into the floor and test shapes feel them.</div>
    <div class="strut-phys-chips">
      <button class="strut-phys-chip" @click="prop('sphere')">+ Ball</button>
      <button class="strut-phys-chip" @click="prop('box')">+ Block</button>
      <button class="strut-phys-chip" @click="prop('capsule')">+ Pole</button>
      <button class="strut-phys-chip" @click="prop('wall')">+ Wall</button>
      <button class="strut-phys-chip" v-if="ui.props.length" @click="clearProps">Clear all</button>
    </div>
    <div class="strut-phys-prop" v-for="p in ui.props" :key="p.id">
      <div class="strut-phys-prop-head"><b>{{ p.kind === 'sphere' ? 'Ball' : p.kind === 'box' ? 'Block' : p.kind === 'capsule' ? 'Pole' : 'Wall' }}</b>
        <label><input type="checkbox" v-model="p.sweep" @change="propsChanged"> Sweeps</label>
        <button class="strut-phys-x" @click="dropProp(p.id)">Remove</button></div>
      <div class="strut-phys-slider"><label>Left / right</label><input type="range" min="-3" max="3" step="0.02" v-model.number="p.x" @input="propsChanged"><span class="strut-phys-num">{{ p.x.toFixed(2) }}</span></div>
      <div class="strut-phys-slider"><label>Up / down</label><input type="range" min="-1" max="4" step="0.02" v-model.number="p.y" @input="propsChanged"><span class="strut-phys-num">{{ p.y.toFixed(2) }}</span></div>
      <div class="strut-phys-slider"><label>Forward / back</label><input type="range" min="-3" max="3" step="0.02" v-model.number="p.z" @input="propsChanged"><span class="strut-phys-num">{{ p.z.toFixed(2) }}</span></div>
      <div class="strut-phys-slider"><label>Size</label><input type="range" min="0.1" max="2.5" step="0.02" v-model.number="p.size" @input="propsChanged"><span class="strut-phys-num">{{ p.size.toFixed(2) }}</span></div>
    </div>
  </div>

  <div class="strut-phys-footer">
    <div class="strut-phys-hint">{{ ui.summary }}</div>
    <div class="strut-phys-problems" v-if="ui.problems.length"><div v-for="p in ui.problems.slice(0, 6)">{{ p }}</div></div>
    <button class="strut-phys-chip" @click="json">Edit as JSON...</button>
  </div>
</div>`;

const CSS = `
.strut-phys { padding: 6px 8px 12px; font-size: 12px; max-height: calc(100vh - 150px); overflow-y: auto; overscroll-behavior: contain; box-sizing: border-box; }
#panel_strut_physics_panel .panel_vue_wrapper, #panel_strut_physics_panel .panel_inside { overflow-y: auto; }
.strut-phys-numbox { width: 100%; box-sizing: border-box; text-align: right; }
.strut-phys-slider.num { grid-template-columns: 70px 1fr 56px; }
.strut-phys-chip.on { background: var(--color-accent); color: var(--color-light); }
.strut-phys-inline { display: block; margin: 4px 0; }
.strut-phys-limit { margin: 4px 0 6px; }
.strut-phys-pill.tag { background: #6b6f7a; }
.strut-phys-bonelist { display: flex; flex-direction: column; gap: 2px; max-height: 180px; overflow-y: auto; background: var(--color-back); padding: 4px 6px; }
.strut-phys-banner { border-left: 4px solid var(--color-border); background: var(--color-back); padding: 6px 8px; margin-bottom: 6px; }
.strut-phys-banner.on { border-left-color: #43c463; }
.strut-phys-banner.off { border-left-color: #7a7f8a; }
.strut-phys-banner-text { margin-bottom: 6px; line-height: 1.35; }
.strut-phys-row { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
.strut-phys-row > label { min-width: 62px; opacity: .8; }
.strut-phys-row select { flex: 1; min-width: 0; }
.strut-phys-row input[type=range] { flex: 1; }
.strut-phys-h { font-weight: bold; padding: 6px 2px; margin-top: 4px; border-top: 1px solid var(--color-border); cursor: pointer; user-select: none; }
.strut-phys-h span { display: inline-block; width: 14px; opacity: .7; }
.strut-phys-body { padding: 0 2px 4px; }
.strut-phys-btn, .strut-phys-chip, .strut-phys-x { background: var(--color-button); color: var(--color-text); border: 0; padding: 4px 10px; cursor: pointer; }
.strut-phys-btn:hover, .strut-phys-chip:hover, .strut-phys-x:hover { background: var(--color-accent); color: var(--color-light); }
.strut-phys-btn:disabled, .strut-phys-chip:disabled { opacity: .35; cursor: default; background: var(--color-button); color: var(--color-text); }
.strut-phys-big { flex: 1; padding: 7px 10px; font-weight: bold; font-size: 13px; }
.strut-phys-big.go { background: #2f9e4f; color: #fff; }
.strut-phys-big.stop { background: #c2453f; color: #fff; }
.strut-phys-chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
.strut-phys-chip { padding: 3px 8px; }
.strut-phys-seg { display: flex; margin: 4px 0 6px; }
.strut-phys-seg button { flex: 1; background: var(--color-button); color: var(--color-text); border: 0; padding: 5px 0; cursor: pointer; }
.strut-phys-seg button.on { background: var(--color-accent); color: var(--color-light); }
.strut-phys-slider { display: grid; grid-template-columns: 78px 1fr 38px; align-items: center; gap: 6px; margin: 3px 0; }
.strut-phys-slider input { width: 100%; min-width: 0; }
.strut-phys-num { text-align: right; opacity: .8; }
.strut-phys-sub { margin: 6px 0 2px; opacity: .8; cursor: pointer; user-select: none; }
.strut-phys-checks { display: flex; flex-direction: column; gap: 3px; margin: 4px 0; }
.strut-phys-search { width: 100%; box-sizing: border-box; margin-bottom: 4px; }
.strut-phys-tree { max-height: 240px; overflow-y: auto; background: var(--color-back); }
.strut-phys-node { display: flex; align-items: center; gap: 4px; padding: 2px 6px 2px 6px; cursor: pointer; white-space: nowrap; }
.strut-phys-node:hover { background: var(--color-button); }
.strut-phys-node.sel { background: var(--color-accent); color: var(--color-light); }
.strut-phys-twist { display: inline-block; width: 12px; opacity: .8; }
.strut-phys-name { overflow: hidden; text-overflow: ellipsis; }
.strut-phys-pill { font-size: 10px; padding: 0 5px; border-radius: 8px; color: #fff; margin-left: auto; }
.strut-phys-pill.spring { background: #d0559a; }
.strut-phys-pill.chain { background: #4d8fd6; }
.strut-phys-prop { background: var(--color-back); padding: 4px 6px; margin: 4px 0; }
.strut-phys-prop-head { display: flex; align-items: center; gap: 8px; }
.strut-phys-x { margin-left: auto; padding: 1px 6px; }
.strut-phys-hint { opacity: .65; margin: 4px 0; line-height: 1.35; }
.strut-phys-notice { color: var(--color-accent); margin: 4px 0; }
.strut-phys-problems { color: #e0a040; margin: 4px 0; line-height: 1.35; }
.strut-phys-footer { border-top: 1px solid var(--color-border); margin-top: 6px; padding-top: 4px; }
`;

let mode: any = null;
let panel: any = null;
let css: any = null;
let onSelection: (() => void) | null = null;
let onProject: (() => void) | null = null;
let onKey: ((event: KeyboardEvent) => void) | null = null;

export function loadPhysicsTab(): void {
    if (!G.Mode || !G.Panel) return;

    css = G.Blockbench.addCSS(CSS);

    panel = new G.Panel(PANEL_ID, {
        name: 'Physics',
        icon: 'waves',
        growable: true,
        resizable: true,
        condition: { modes: [MODE_ID] },
        default_position: { slot: 'right_bar', float_position: [0, 0], float_size: [340, 720], height: 720 },
        component: {
            template: TEMPLATE,
            data() {
                return { ui };
            },
            computed: {
                looksFor(): { id: string; label: string }[] {
                    return ui.looks.filter(l => l.kind === ui.kind);
                },
                mainFields(): Field[] {
                    return MAIN_FIELDS.filter(f => f.kinds.includes(ui.kind));
                },
                moreFields(): Field[] {
                    return MORE_FIELDS.filter(f => f.kinds.includes(ui.kind));
                },
                softFields(): SoftField[] {
                    return SOFT_FIELDS.filter(f => f.kinds.includes(ui.kind));
                },
                softLooksFor(): { id: string; label: string }[] {
                    return ui.softLooks.filter(l => l.kind === ui.kind);
                },
                /** The bones shown: all whose parents are open, or every match while searching */
                visibleTree(): TreeNode[] {
                    const q = ui.query.trim().toLowerCase();

                    if (q) return ui.tree.filter(n => n.name.toLowerCase().includes(q));

                    const byName = new Map(ui.tree.map(n => [n.name, n]));

                    return ui.tree.filter(n => {
                        for (let p = n.parent; p; p = byName.get(p)?.parent ?? null) if (!ui.open[p]) return false;

                        return true;
                    });
                },
            },
            methods: {
                toggle() { if (ui.running) session.stop(); else session.start(); },
                reset() { session.resetSim(); },
                poke() { session.poke(); },
                tog(section: string) { (this as any).$set(ui.sections, section, !ui.sections[section]); },
                pick(name: string) { session.pick(name); },
                fold(n: TreeNode) { (this as any).$set(ui.open, n.name, !ui.open[n.name]); },
                kind(k: PartKind) { session.setKind(k); },
                look(id: string) { session.applyLook(id); },
                softLook(id: string) { session.applySoftLook(id); },
                applySoft() { session.applySoft(); },
                setSoft(key: keyof SoftControls, value: number) { session.setSoftValue(key, value); },
                softCentre(axis: number, value: number) { session.setSoftCentre(axis, value); },
                softZone() { session.softZoneFromMesh(); },
                carryOn(bone: string, event: Event) { session.toggleCarry(bone, (event.target as HTMLInputElement).checked); },
                apply() { session.applyControls(); },
                auto(event: Event) { session.setAuto((event.target as HTMLInputElement).checked ? null : false); },
                redraw() { session.drawOverlay(); },
                shape(s: Shape) { session.addShape(s); },
                prop(kind: PropDef['kind']) { session.addProp(kind); },
                propsChanged() { session.syncProps(); },
                dropProp(id: number) { session.removeProp(id); },
                clearProps() { session.clearProps(); },
                undo() { session.undo(); },
                redo() { session.redo(); },
                json() { session.noteExternalEdit(); openPhysicsDialog(); session.reload(); },
                selectShape(index: number) { session.selectShape(index); },
                shapeKind(k: Shape) { session.setShapeKind(k); },
                val(key: 'center' | 'size' | 'rotation' | 'radius' | 'length', axis: number, value: number) { session.setShapeValue(key, axis, value); },
                fitShape() { session.fitShape(); },
                duplicateShape() { session.duplicateShape(); },
                deleteShape() { session.deleteShape(); },
                setMode(m: AutoMode) { session.setMode(m); },
                limitOn(axis: 'x' | 'y' | 'z', event: Event) { session.toggleLimit(axis, (event.target as HTMLInputElement).checked); },
                setLimit(axis: 'x' | 'y' | 'z', end: 0 | 1, value: number) { session.setLimit(axis, end, value); },
                isTicked(bone: string) { return session.isTicked(bone); },
                tick(bone: string, event: Event) { session.tick(bone, (event.target as HTMLInputElement).checked); },
                onlyTicked(v: boolean) { session.setOnlyTicked(v); },
                setControl(key: keyof PartControls, value: number) { (ui.controls as any)[key] = value; session.applyControls(); },
            },
            components: {
                'phys-num': {
                    props: ['label', 'min', 'max', 'step', 'value'],
                    template: `<div class="strut-phys-slider num"><label>{{ label }}</label>
                        <input type="range" :min="min" :max="max" :step="step" :value="value" @input="$emit('input', Number($event.target.value))">
                        <input class="strut-phys-numbox" type="number" :step="step" :value="Math.round(value * 100) / 100" @change="$emit('input', Number($event.target.value))"></div>`,
                },
            },
        },
    });

    mode = new G.Mode(MODE_ID, {
        name: 'Physics',
        icon: 'waves',
        default_tool: 'move_tool',
        selectElements: false,
        category: 'navigate',
        hidden_node_types: ['cube', 'mesh', 'locator', 'null_object', 'texture_mesh', 'spline'],
        condition: () => G.Format?.id === 'strut_model' || G.Format?.id === 'animated_entity_model',
        onSelect() {
            session.reload();
        },
        onUnselect() {
            session.dispose();
        },
    });

    try {
        G.Modes?.vue?.$forceUpdate?.();
    }
    catch { /* the mode list re-renders on its own */ }

    onSelection = () => {
        if (G.Mode?.selected?.id !== MODE_ID) return;

        if (!session.keepBonesSelected()) session.queueRefresh();
    };
    onProject = () => {
        session.stop();
        session.clearHistory();

        if (G.Mode?.selected?.id === MODE_ID) session.reload();
    };
    onKey = (event: KeyboardEvent) => {
        if (G.Mode?.selected?.id !== MODE_ID || !(event.ctrlKey || event.metaKey)) return;

        const target = event.target as HTMLElement | null;

        // typing in a text box keeps its own undo
        if (target && (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && ['text', 'number'].includes((target as HTMLInputElement).type)))) return;

        const key = event.key.toLowerCase();
        const redo = key === 'y' || (key === 'z' && event.shiftKey);
        const undo = key === 'z' && !event.shiftKey;

        if ((undo && ui.canUndo) || (redo && ui.canRedo)) {
            event.preventDefault();
            event.stopPropagation();

            if (undo) session.undo();
            else session.redo();
        }
    };
    document.addEventListener('keydown', onKey, true);
    G.Blockbench.on('update_selection', onSelection);
    G.Blockbench.on('select_project', onProject);
}

export function unloadPhysicsTab(): void {
    if (onSelection) G.Blockbench.removeListener?.('update_selection', onSelection);
    if (onProject) G.Blockbench.removeListener?.('select_project', onProject);
    if (onKey) document.removeEventListener('keydown', onKey, true);

    onSelection = null;
    onProject = null;
    onKey = null;
    session.dispose();
    mode?.delete?.();
    panel?.delete?.();
    css?.delete?.();
    mode = null;
    panel = null;
    css = null;
}
